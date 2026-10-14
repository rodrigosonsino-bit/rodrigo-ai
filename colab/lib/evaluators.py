"""Reference evaluators for synthetic app fixtures.

These functions are intentionally small and self-contained. They test the
laboratory harness and safety invariants; they do not claim to implement any
of the proprietary apps named in the roadmap.
"""

from __future__ import annotations

import statistics
import time
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from .audio_eval import calculate_cer, calculate_wer, edit_distance, execute_audio_evaluation
from .finance_sim import execute_finance_simulation
from .psico_sim import execute_psico_simulation
from .registry import get_job
from .scheduler_sim import execute_scheduler_simulation
from .synthetic import make_cases
from .temperament_sim import execute_temperament_simulation


def _result(job: str, seed: int, metrics: dict[str, float]) -> dict[str, Any]:
    spec = get_job(job)
    if set(metrics) != set(spec.metrics):
        raise ValueError(f"metrics do not match registry for {job}")
    for name, value in metrics.items():
        if not spec.metrics[name].accepts(value):
            raise ValueError(f"metric outside registry limits: {name}")
    return {"app": spec.app, "dataset_version": spec.dataset_version, "seed": seed,
            "metric_units": {name: item.unit for name, item in spec.metrics.items()},
            "metrics": metrics}


def scheduler(seed: int, mutation: str = "none") -> dict[str, Any]:
    metrics, status = execute_scheduler_simulation(seed, mutation=mutation)
    result = _result("scheduler-reliability", seed, metrics)
    result["status"] = status
    return result


def finance(seed: int, mutation: str = "none") -> dict[str, Any]:
    metrics, status = execute_finance_simulation(seed, mutation=mutation)
    result = _result("finance-validation", seed, metrics)
    result["status"] = status
    return result


def temperament(seed: int, mutation: str = "none") -> dict[str, Any]:
    metrics, status = execute_temperament_simulation(seed, mutation=mutation)
    result = _result("temperament-regression", seed, metrics)
    result["status"] = status
    return result


def psico(seed: int, mutation: str = "none") -> dict[str, Any]:
    metrics, status = execute_psico_simulation(seed, mutation=mutation)
    result = _result("psico-safety", seed, metrics)
    result["status"] = status
    return result


def audio_self_test(seed: int) -> dict[str, Any]:
    metrics, status = execute_audio_evaluation(seed)
    result = _result("audio-transcriber", seed, metrics)
    result["status"] = status
    return result


EVALUATORS = {"scheduler-reliability": scheduler, "finance-validation": finance,
              "temperament-regression": temperament, "psico-safety": psico,
              "audio-transcriber": audio_self_test}
