#!/usr/bin/env python3
"""Validation suite for Phase B: scheduler-reliability evaluation."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "colab"))
from lib.contract import ContractError, validate_result  # noqa: E402
from lib.evaluators import scheduler  # noqa: E402
from lib.scheduler_sim import (  # noqa: E402
    IdempotencyLedger,
    SchedulerEngine,
    execute_scheduler_simulation,
    generate_scheduler_scenarios,
    parse_iso_to_utc_timestamp,
)


def test_timezone_normalization() -> None:
    # 15:00 in UTC-3 is 18:00 UTC
    ts1 = parse_iso_to_utc_timestamp("2026-10-14T15:00:00-03:00")
    # 18:00 in UTC is 18:00 UTC
    ts2 = parse_iso_to_utc_timestamp("2026-10-14T18:00:00Z")
    # 20:00 in UTC+2 is 18:00 UTC
    ts3 = parse_iso_to_utc_timestamp("2026-10-14T20:00:00+02:00")
    assert ts1 == ts2 == ts3, f"Timezone normalization mismatch: {ts1}, {ts2}, {ts3}"


def test_idempotency_ledger_and_restart() -> None:
    ledger = IdempotencyLedger()
    ledger.record("key-1", {"status": "ok", "ver": 1}, "create", "sched-1")
    snap = ledger.snapshot()
    new_ledger = IdempotencyLedger()
    new_ledger.restore(snap)
    cached = new_ledger.get("key-1")
    assert cached is not None
    assert cached["response"] == {"status": "ok", "ver": 1}
    assert cached["action"] == "create"


def test_engine_snapshot_and_restart() -> None:
    engine = SchedulerEngine()
    events = generate_scheduler_scenarios(42)
    create_evt = next(e for e in events if e.action == "create" and not e.is_concurrent and not e.is_post_restart)
    engine.process_request(create_evt)
    snap = engine.snapshot()

    restarted = SchedulerEngine()
    restarted.restore(snap)
    assert create_evt.schedule_id in restarted.schedules
    assert restarted.ledger.get(create_evt.idempotency_key) is not None


def test_simulation_determinism_and_acceptance() -> None:
    res1, status1 = execute_scheduler_simulation(123)
    res2, status2 = execute_scheduler_simulation(123)

    assert status1 == status2 == "success"
    # Discrete metrics must be strictly identical across same seed
    for k in ("operations_correct_rate", "duplicate_events", "lost_events", "idempotency_violations", "retries_until_success"):
        assert res1[k] == res2[k], f"Metric {k} diverged: {res1[k]} vs {res2[k]}"

    # Acceptance criteria checks
    assert res1["operations_correct_rate"] == 1.0
    assert res1["duplicate_events"] == 0.0
    assert res1["lost_events"] == 0.0
    assert res1["idempotency_violations"] == 0.0
    assert res1["retries_until_success"] > 0.0
    assert res1["latency_p50_ms"] >= 0.0
    assert res1["latency_p95_ms"] >= res1["latency_p50_ms"]


def test_runner_and_contract() -> None:
    with tempfile.TemporaryDirectory() as temp:
        out_dir = Path(temp) / "run_success"
        cmd = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "scheduler-reliability",
            "--seed", "7",
            "--run-id", "phase-b-success",
            "--output", str(out_dir),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        assert proc.returncode == 0, f"run-evaluation failed: {proc.stderr}"
        res_file = out_dir / "result.json"
        assert res_file.exists()
        result_data = json.loads(res_file.read_text(encoding="utf-8"))
        validate_result(result_data)
        assert result_data["status"] == "success"
        assert result_data["metrics"]["operations_correct_rate"] == 1.0


def test_adversarial_mutations() -> None:
    # 1. Injected event loss mutation
    with tempfile.TemporaryDirectory() as temp:
        out_loss = Path(temp) / "run_loss"
        cmd_loss = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "scheduler-reliability",
            "--seed", "7",
            "--run-id", "phase-b-loss",
            "--output", str(out_loss),
            "--mutation", "loss",
        ]
        proc_loss = subprocess.run(cmd_loss, cwd=ROOT, capture_output=True, text=True)
        assert proc_loss.returncode == 1, "Loss mutation should fail with exit code 1"
        res_loss = json.loads((out_loss / "result.json").read_text(encoding="utf-8"))
        validate_result(res_loss)
        assert res_loss["status"] == "failed"
        assert res_loss["metrics"]["lost_events"] > 0
        assert res_loss["metrics"]["operations_correct_rate"] < 1.0

    # 2. Injected duplicate / idempotency violation mutation
    with tempfile.TemporaryDirectory() as temp:
        out_dup = Path(temp) / "run_dup"
        cmd_dup = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "scheduler-reliability",
            "--seed", "7",
            "--run-id", "phase-b-dup",
            "--output", str(out_dup),
            "--mutation", "duplicate",
        ]
        proc_dup = subprocess.run(cmd_dup, cwd=ROOT, capture_output=True, text=True)
        assert proc_dup.returncode == 1, "Duplicate mutation should fail with exit code 1"
        res_dup = json.loads((out_dup / "result.json").read_text(encoding="utf-8"))
        validate_result(res_dup)
        assert res_dup["status"] == "failed"
        assert res_dup["metrics"]["duplicate_events"] > 0 or res_dup["metrics"]["idempotency_violations"] > 0
        assert res_dup["metrics"]["operations_correct_rate"] < 1.0


def main() -> int:
    test_timezone_normalization()
    test_idempotency_ledger_and_restart()
    test_engine_snapshot_and_restart()
    test_simulation_determinism_and_acceptance()
    test_runner_and_contract()
    test_adversarial_mutations()
    print("phase B: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
