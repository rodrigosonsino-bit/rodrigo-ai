"""Registry for deterministic, offline app evaluation jobs."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MetricSpec:
    unit: str
    minimum: float = 0.0
    maximum: float | None = None

    def accepts(self, value: float) -> bool:
        return value >= self.minimum and (self.maximum is None or value <= self.maximum)


@dataclass(frozen=True)
class JobSpec:
    job: str
    app: str
    dataset_version: str
    timeout_seconds: int
    gpu: bool
    metrics: dict[str, MetricSpec]


JOB_REGISTRY: dict[str, JobSpec] = {
    "scheduler-reliability": JobSpec("scheduler-reliability", "scheduler", "synthetic-v1", 30, False, {
        "operations_correct_rate": MetricSpec("ratio", 0, 1), "duplicate_events": MetricSpec("count"),
        "lost_events": MetricSpec("count"), "retries_until_success": MetricSpec("count"),
        "latency_p50_ms": MetricSpec("ms"), "latency_p95_ms": MetricSpec("ms"),
        "idempotency_violations": MetricSpec("count"),
    }),
    "finance-validation": JobSpec("finance-validation", "finance", "synthetic-v1", 30, False, {
        "totals_accuracy": MetricSpec("ratio", 0, 1), "duplicates_detection_rate": MetricSpec("ratio", 0, 1),
        "categorization_precision": MetricSpec("ratio", 0, 1), "ambiguous_items": MetricSpec("count"),
        "mean_confidence": MetricSpec("ratio", 0, 1), "balance_error_cents": MetricSpec("cents"),
        "anomalies_detected": MetricSpec("count"),
    }),
    "temperament-regression": JobSpec("temperament-regression", "temperament", "synthetic-v1", 30, False, {
        "score_stability": MetricSpec("ratio", 0, 1), "dimension_consistency": MetricSpec("ratio", 0, 1),
        "changed_cases": MetricSpec("count"), "explanation_completeness": MetricSpec("ratio", 0, 1),
        "inconclusive_rate": MetricSpec("ratio", 0, 1),
    }),
    "audio-transcriber": JobSpec("audio-transcriber", "audio-transcriber", "synthetic-v1", 120, False, {
        "wer": MetricSpec("ratio", 0), "cer": MetricSpec("ratio", 0), "latency_ms": MetricSpec("ms"),
        "audio_duration_seconds": MetricSpec("seconds"), "seconds_per_audio_minute": MetricSpec("ratio", 0),
        "peak_memory_bytes": MetricSpec("bytes"), "model_size_bytes": MetricSpec("bytes"),
        "gpu_available": MetricSpec("boolean-as-number", 0, 1),
    }),
    "psico-safety": JobSpec("psico-safety", "psico", "synthetic-v1", 30, False, {
        "risk_recall": MetricSpec("ratio", 0, 1), "false_negatives": MetricSpec("count"),
        "false_positives": MetricSpec("count"), "collection_completeness": MetricSpec("ratio", 0, 1),
        "diagnosis_refusal_rate": MetricSpec("ratio", 0, 1), "consistency_rate": MetricSpec("ratio", 0, 1),
    }),
}


def get_job(job: str) -> JobSpec:
    try:
        return JOB_REGISTRY[job]
    except KeyError as exc:
        raise KeyError(f"unknown evaluation job: {job}") from exc
