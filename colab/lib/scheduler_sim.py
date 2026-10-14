"""Deterministic scheduler reliability simulator and independent oracle.

Simulates an offline scheduling engine featuring:
- Idempotency ledger with duplicate webhook suppression
- Event operations: create, update, cancel
- Timeouts before apply (mutation discarded before persistence, retried)
- Timeouts after apply (mutation committed, response lost, retried via ledger)
- Bounded retries tracking retries_until_success
- Snapshot and restart resumption
- Timezone offset normalization to UTC epoch
- Serialized concurrency protected by re-entrant mutex
- Fault injection / mutation mode for adversarial test gates
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import math
import random
import statistics
import threading
import time
from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class ScheduleEvent:
    event_id: str
    idempotency_key: str
    action: Literal["create", "update", "cancel"]
    schedule_id: str
    scheduled_time_iso: str
    payload: dict[str, Any]
    is_duplicate_webhook: bool = False
    simulate_timeout_before: bool = False
    simulate_timeout_after: bool = False
    is_concurrent: bool = False
    is_post_restart: bool = False


@dataclass
class ScheduleItem:
    schedule_id: str
    version: int
    status: Literal["active", "cancelled"]
    utc_timestamp: float
    payload: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schedule_id": self.schedule_id,
            "version": self.version,
            "status": self.status,
            "utc_timestamp": self.utc_timestamp,
            "payload": dict(self.payload),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ScheduleItem:
        return cls(
            schedule_id=data["schedule_id"],
            version=data["version"],
            status=data["status"],
            utc_timestamp=float(data["utc_timestamp"]),
            payload=dict(data["payload"]),
        )


class IdempotencyLedger:
    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}

    def get(self, idempotency_key: str) -> dict[str, Any] | None:
        rec = self._records.get(idempotency_key)
        return dict(rec) if rec is not None else None

    def record(self, idempotency_key: str, response: dict[str, Any], action: str, schedule_id: str) -> None:
        self._records[idempotency_key] = {
            "response": dict(response),
            "action": action,
            "schedule_id": schedule_id,
        }

    def snapshot(self) -> dict[str, Any]:
        return {k: dict(v) for k, v in self._records.items()}

    def restore(self, data: dict[str, Any]) -> None:
        self._records = {k: dict(v) for k, v in data.items()}

    def __len__(self) -> int:
        return len(self._records)


def parse_iso_to_utc_timestamp(iso_str: str) -> float:
    cleaned = iso_str.replace("Z", "+00:00")
    dt_obj = dt.datetime.fromisoformat(cleaned)
    if dt_obj.tzinfo is None:
        dt_obj = dt_obj.replace(tzinfo=dt.timezone.utc)
    return dt_obj.astimezone(dt.timezone.utc).timestamp()


class SchedulerEngine:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.ledger = IdempotencyLedger()
        self.schedules: dict[str, ScheduleItem] = {}
        self.applied_mutations: list[dict[str, Any]] = []
        self.idempotency_hits = 0

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "ledger": self.ledger.snapshot(),
                "schedules": {k: v.to_dict() for k, v in self.schedules.items()},
                "applied_mutations": list(self.applied_mutations),
                "idempotency_hits": self.idempotency_hits,
            }

    def restore(self, state: dict[str, Any]) -> None:
        with self._lock:
            self.ledger.restore(state["ledger"])
            self.schedules = {k: ScheduleItem.from_dict(v) for k, v in state["schedules"].items()}
            self.applied_mutations = list(state["applied_mutations"])
            self.idempotency_hits = int(state["idempotency_hits"])

    def process_request(
        self,
        event: ScheduleEvent,
        attempt: int = 0,
        inject_loss: bool = False,
        inject_duplicate: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            if inject_loss:
                # Simulates lost event: silent drop without recording or applying
                return {"status": "dropped_by_mutation", "schedule_id": event.schedule_id}

            # Simulate timeout before apply on first attempt
            if event.simulate_timeout_before and attempt == 0:
                raise TimeoutError("Simulated network timeout before applying mutation to scheduler")

            # Idempotency check (unless mutation bypasses it)
            if not inject_duplicate:
                cached = self.ledger.get(event.idempotency_key)
                if cached is not None:
                    self.idempotency_hits += 1
                    resp = dict(cached["response"])
                    resp["cached"] = True
                    return resp

            # Execute actual state mutation
            utc_ts = parse_iso_to_utc_timestamp(event.scheduled_time_iso)
            if event.action == "create":
                item = ScheduleItem(
                    schedule_id=event.schedule_id,
                    version=1,
                    status="active",
                    utc_timestamp=utc_ts,
                    payload=dict(event.payload),
                )
                self.schedules[event.schedule_id] = item
                response = {
                    "status": "success",
                    "action": "create",
                    "schedule_id": event.schedule_id,
                    "version": 1,
                    "utc_timestamp": utc_ts,
                }
            elif event.action == "update":
                existing = self.schedules.get(event.schedule_id)
                if existing is None or existing.status == "cancelled":
                    response = {
                        "status": "rejected",
                        "action": "update",
                        "schedule_id": event.schedule_id,
                        "error": "not_found_or_cancelled",
                    }
                else:
                    existing.version += 1
                    existing.utc_timestamp = utc_ts
                    existing.payload.update(event.payload)
                    response = {
                        "status": "success",
                        "action": "update",
                        "schedule_id": event.schedule_id,
                        "version": existing.version,
                        "utc_timestamp": utc_ts,
                    }
            elif event.action == "cancel":
                existing = self.schedules.get(event.schedule_id)
                if existing is None:
                    response = {
                        "status": "rejected",
                        "action": "cancel",
                        "schedule_id": event.schedule_id,
                        "error": "not_found",
                    }
                else:
                    existing.status = "cancelled"
                    existing.version += 1
                    response = {
                        "status": "success",
                        "action": "cancel",
                        "schedule_id": event.schedule_id,
                        "version": existing.version,
                    }
            else:
                raise ValueError(f"Unknown action: {event.action}")

            self.applied_mutations.append({
                "event_id": event.event_id,
                "idempotency_key": event.idempotency_key,
                "action": event.action,
                "schedule_id": event.schedule_id,
                "response": dict(response),
            })

            # Commit to ledger
            self.ledger.record(event.idempotency_key, response, event.action, event.schedule_id)

            # Simulate timeout after apply on first attempt
            if event.simulate_timeout_after and attempt == 0:
                raise TimeoutError("Simulated network timeout after applying mutation (response lost)")

            return response


class SchedulerOracle:
    """Independent oracle that computes expected final state and metrics directly."""

    def __init__(self, events: list[ScheduleEvent]) -> None:
        self.events = events
        self.expected_schedules: dict[str, dict[str, Any]] = {}
        self.expected_unique_applied: int = 0
        self.expected_idempotency_hits: int = 0
        self.expected_retries: int = 0
        self._compute_expected()

    def _compute_expected(self) -> None:
        seen_keys: set[str] = set()
        for event in self.events:
            # Retries expected for timeouts
            if event.simulate_timeout_before:
                self.expected_retries += 1
            if event.simulate_timeout_after:
                self.expected_retries += 1

            if event.is_duplicate_webhook:
                self.expected_idempotency_hits += 1
                continue

            if event.simulate_timeout_after:
                # The retry will hit the ledger cache
                self.expected_idempotency_hits += 1

            if event.idempotency_key in seen_keys:
                self.expected_idempotency_hits += 1
                continue

            seen_keys.add(event.idempotency_key)
            self.expected_unique_applied += 1

            utc_ts = parse_iso_to_utc_timestamp(event.scheduled_time_iso)
            if event.action == "create":
                self.expected_schedules[event.schedule_id] = {
                    "version": 1,
                    "status": "active",
                    "utc_timestamp": utc_ts,
                    "payload": dict(event.payload),
                }
            elif event.action == "update":
                cur = self.expected_schedules.get(event.schedule_id)
                if cur and cur["status"] == "active":
                    cur["version"] += 1
                    cur["utc_timestamp"] = utc_ts
                    cur["payload"].update(event.payload)
            elif event.action == "cancel":
                cur = self.expected_schedules.get(event.schedule_id)
                if cur:
                    cur["version"] += 1
                    cur["status"] = "cancelled"

    def evaluate(
        self,
        engine: SchedulerEngine,
        client_latencies: list[float],
        retries_recorded: int,
    ) -> dict[str, float]:
        lost_events = 0
        duplicate_events = 0
        idempotency_violations = 0
        correct_operations = 0
        total_checks = max(1, len(self.expected_schedules))

        # Check all expected schedules exist with exact matching fields
        for sched_id, expected in self.expected_schedules.items():
            actual = engine.schedules.get(sched_id)
            if actual is None:
                lost_events += 1
                continue
            matches_version = actual.version == expected["version"]
            matches_status = actual.status == expected["status"]
            matches_time = math.isclose(actual.utc_timestamp, expected["utc_timestamp"], abs_tol=1e-3)
            if matches_version and matches_status and matches_time:
                correct_operations += 1
            else:
                if actual.version > expected["version"]:
                    duplicate_events += (actual.version - expected["version"])
                elif actual.version < expected["version"]:
                    lost_events += (expected["version"] - actual.version)

        # Check for unexpected extra schedules in engine
        extra = set(engine.schedules.keys()) - set(self.expected_schedules.keys())
        if extra:
            duplicate_events += len(extra)

        # Check applied mutations against ledger
        key_counts: dict[str, int] = {}
        for mut in engine.applied_mutations:
            k = mut["idempotency_key"]
            key_counts[k] = key_counts.get(k, 0) + 1

        for k, count in key_counts.items():
            if count > 1:
                idempotency_violations += (count - 1)
                duplicate_events += (count - 1)

        operations_correct_rate = max(0.0, min(1.0, correct_operations / total_checks))
        if lost_events > 0 or duplicate_events > 0 or idempotency_violations > 0:
            operations_correct_rate = max(0.0, min(operations_correct_rate, 1.0 - ((lost_events + duplicate_events) / total_checks)))

        sorted_latencies = sorted(client_latencies) if client_latencies else [0.0]
        p50 = float(statistics.median(sorted_latencies))
        p95_idx = max(0, int(len(sorted_latencies) * 0.95) - 1)
        p95 = float(sorted_latencies[p95_idx])

        return {
            "operations_correct_rate": float(round(operations_correct_rate, 4)),
            "duplicate_events": float(duplicate_events),
            "lost_events": float(lost_events),
            "retries_until_success": float(retries_recorded),
            "latency_p50_ms": float(round(p50, 4)),
            "latency_p95_ms": float(round(p95, 4)),
            "idempotency_violations": float(idempotency_violations),
        }


def generate_scheduler_scenarios(seed: int) -> list[ScheduleEvent]:
    rng = random.Random(seed)
    tz_offsets = ["+00:00", "-03:00", "+02:00", "-05:00", "+09:00", "Z"]
    events: list[ScheduleEvent] = []

    # 1. Normal create, update, cancel sequence for 5 distinct schedules
    for i in range(5):
        sched_id = f"sched-norm-{i:03d}"
        tz = tz_offsets[i % len(tz_offsets)]
        iso = f"2026-10-14T{10 + i:02d}:00:00{tz}"
        events.append(
            ScheduleEvent(
                event_id=f"evt-create-{i}",
                idempotency_key=f"idem-create-{i}-{seed}",
                action="create",
                schedule_id=sched_id,
                scheduled_time_iso=iso,
                payload={"title": f"Normal event {i}", "priority": rng.choice(["high", "medium", "low"])},
            )
        )
        # Update 3 of them
        if i % 2 == 0:
            tz2 = tz_offsets[(i + 1) % len(tz_offsets)]
            iso2 = f"2026-10-14T{11 + i:02d}:30:00{tz2}"
            events.append(
                ScheduleEvent(
                    event_id=f"evt-upd-{i}",
                    idempotency_key=f"idem-upd-{i}-{seed}",
                    action="update",
                    schedule_id=sched_id,
                    scheduled_time_iso=iso2,
                    payload={"title": f"Updated event {i}"},
                )
            )
        # Cancel 1 of them
        if i == 4:
            events.append(
                ScheduleEvent(
                    event_id=f"evt-cancel-{i}",
                    idempotency_key=f"idem-cancel-{i}-{seed}",
                    action="cancel",
                    schedule_id=sched_id,
                    scheduled_time_iso=iso,
                    payload={},
                )
            )

    # 2. Webhook duplicate scenario: create an event, then re-send exact same event
    for i in range(2):
        sched_id = f"sched-webhook-{i:03d}"
        key = f"idem-webhook-{i}-{seed}"
        iso = f"2026-10-14T14:00:00-03:00"
        evt = ScheduleEvent(
            event_id=f"evt-webhook-{i}",
            idempotency_key=key,
            action="create",
            schedule_id=sched_id,
            scheduled_time_iso=iso,
            payload={"source": "webhook"},
        )
        events.append(evt)
        # Duplicate delivery
        dup = ScheduleEvent(
            event_id=f"evt-webhook-dup-{i}",
            idempotency_key=key,
            action="create",
            schedule_id=sched_id,
            scheduled_time_iso=iso,
            payload={"source": "webhook"},
            is_duplicate_webhook=True,
        )
        events.append(dup)

    # 3. Timeout before apply scenario: failure prior to engine mutation, retry succeeds
    for i in range(2):
        sched_id = f"sched-tmo-before-{i:03d}"
        key = f"idem-tmo-before-{i}-{seed}"
        iso = f"2026-10-14T16:00:00+01:00"
        events.append(
            ScheduleEvent(
                event_id=f"evt-tmo-before-{i}",
                idempotency_key=key,
                action="create",
                schedule_id=sched_id,
                scheduled_time_iso=iso,
                payload={"retry_test": "before"},
                simulate_timeout_before=True,
            )
        )

    # 4. Timeout after apply scenario: mutation committed, response timed out, retry retrieves cached
    for i in range(2):
        sched_id = f"sched-tmo-after-{i:03d}"
        key = f"idem-tmo-after-{i}-{seed}"
        iso = f"2026-10-14T17:00:00-04:00"
        events.append(
            ScheduleEvent(
                event_id=f"evt-tmo-after-{i}",
                idempotency_key=key,
                action="create",
                schedule_id=sched_id,
                scheduled_time_iso=iso,
                payload={"retry_test": "after"},
                simulate_timeout_after=True,
            )
        )

    # 5. Events after snapshot/restart
    for i in range(2):
        sched_id = f"sched-post-restart-{i:03d}"
        key = f"idem-restart-{i}-{seed}"
        iso = f"2026-10-14T18:00:00Z"
        events.append(
            ScheduleEvent(
                event_id=f"evt-restart-{i}",
                idempotency_key=key,
                action="create",
                schedule_id=sched_id,
                scheduled_time_iso=iso,
                payload={"restart": True},
                is_post_restart=True,
            )
        )

    # 6. Concurrent events: a batch executed across threads
    for i in range(4):
        sched_id = f"sched-concurrent-{i:03d}"
        key = f"idem-concurrent-{i}-{seed}"
        iso = f"2026-10-14T19:{i * 10:02d}:00-03:00"
        events.append(
            ScheduleEvent(
                event_id=f"evt-concurrent-{i}",
                idempotency_key=key,
                action="create",
                schedule_id=sched_id,
                scheduled_time_iso=iso,
                payload={"concurrency_batch": 1},
                is_concurrent=True,
            )
        )

    return events


def execute_scheduler_simulation(
    seed: int,
    mutation: Literal["none", "loss", "duplicate"] = "none",
) -> tuple[dict[str, float], str]:
    """Execute the simulation with the independent oracle and optional adversarial mutation."""
    events = generate_scheduler_scenarios(seed)
    oracle = SchedulerOracle(events)
    engine = SchedulerEngine()

    latencies: list[float] = []
    total_retries = 0
    max_retries = 3

    standard_events = [e for e in events if not e.is_post_restart and not e.is_concurrent]
    post_restart_events = [e for e in events if e.is_post_restart]
    concurrent_events = [e for e in events if e.is_concurrent]

    def run_event_with_retry(
        target_engine: SchedulerEngine,
        evt: ScheduleEvent,
        inject_l: bool = False,
        inject_d: bool = False,
    ) -> None:
        nonlocal total_retries
        for attempt in range(max_retries):
            t0 = time.perf_counter()
            try:
                target_engine.process_request(
                    evt,
                    attempt=attempt,
                    inject_loss=inject_l,
                    inject_duplicate=inject_d,
                )
                latencies.append((time.perf_counter() - t0) * 1000.0)
                break
            except TimeoutError:
                latencies.append((time.perf_counter() - t0) * 1000.0)
                total_retries += 1
                if attempt == max_retries - 1:
                    raise

    # Phase 1: Sequential standard events
    for idx, evt in enumerate(standard_events):
        inject_l = (mutation == "loss" and idx == 0)
        inject_d = (mutation == "duplicate" and evt.is_duplicate_webhook)
        run_event_with_retry(engine, evt, inject_l, inject_d)

    # Phase 2: Snapshot and restart engine
    snapshot = engine.snapshot()
    new_engine = SchedulerEngine()
    new_engine.restore(snapshot)

    for idx, evt in enumerate(post_restart_events):
        inject_l = (mutation == "loss" and idx == 0 and not any(e.is_duplicate_webhook for e in standard_events))
        run_event_with_retry(new_engine, evt, inject_l, False)

    # Phase 3: Concurrent batch protected by mutex
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(run_event_with_retry, new_engine, evt, False, False)
            for evt in concurrent_events
        ]
        concurrent.futures.wait(futures)

    metrics = oracle.evaluate(new_engine, latencies, total_retries)

    is_success = (
        metrics["operations_correct_rate"] == 1.0
        and metrics["duplicate_events"] == 0.0
        and metrics["lost_events"] == 0.0
        and metrics["idempotency_violations"] == 0.0
    )
    status = "success" if is_success else "failed"
    return metrics, status
