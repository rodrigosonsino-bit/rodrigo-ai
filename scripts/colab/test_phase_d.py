#!/usr/bin/env python3
"""Validation suite for Phase D: temperament-regression evaluation."""

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
from lib.temperament_sim import (  # noqa: E402
    NON_CLINICAL_DISCLAIMER,
    VERSIONED_SYNTHETIC_V1_CASES,
    execute_temperament_simulation,
    score_dimension,
)


def test_dimension_scoring_rules() -> None:
    # High: >= 6
    assert score_dimension(4, 4) == (8, "Alto")
    assert score_dimension(3, 3) == (6, "Alto")
    # Low: <= 2
    assert score_dimension(0, 0) == (0, "Baixo")
    assert score_dimension(1, 1) == (2, "Baixo")
    # Neutral: == 4
    assert score_dimension(2, 2) == (4, "Neutro")
    assert score_dimension(1, 3) == (4, "Neutro")
    # Mixed: in {3, 5}
    assert score_dimension(1, 2) == (3, "Misto")
    assert score_dimension(2, 3) == (5, "Misto")
    # Incomplete or invalid: None or out of 0..4
    assert score_dimension(None, 2) == (None, "Inconclusivo")
    assert score_dimension(5, 2) == (None, "Inconclusivo")
    assert score_dimension(-1, 2) == (None, "Inconclusivo")


def test_temperament_simulation_determinism_and_acceptance() -> None:
    res1, status1 = execute_temperament_simulation(123)
    res2, status2 = execute_temperament_simulation(123)

    assert status1 == status2 == "success"
    assert res1 == res2, "Temperament metrics diverged across same seed"

    # Strict acceptance criteria
    assert res1["score_stability"] == 1.0
    assert res1["dimension_consistency"] == 1.0
    assert res1["changed_cases"] == 0.0
    assert res1["explanation_completeness"] == 1.0
    assert 0.0 < res1["inconclusive_rate"] < 1.0  # Confirms inconclusive cases handled properly


def test_runner_and_contract() -> None:
    with tempfile.TemporaryDirectory() as temp:
        out_dir = Path(temp) / "run_success"
        cmd = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "temperament-regression",
            "--seed", "7",
            "--run-id", "phase-d-success",
            "--output", str(out_dir),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        assert proc.returncode == 0, f"run-evaluation failed: {proc.stderr}"
        res_file = out_dir / "result.json"
        assert res_file.exists()
        result_data = json.loads(res_file.read_text(encoding="utf-8"))
        validate_result(result_data)
        assert result_data["status"] == "success"
        assert result_data["metrics"]["score_stability"] == 1.0
        assert result_data["metrics"]["changed_cases"] == 0.0


def test_adversarial_mutations() -> None:
    # 1. Injected regression mutation (rule deviation must trigger changed_cases and failure)
    with tempfile.TemporaryDirectory() as temp:
        out_reg = Path(temp) / "run_reg"
        cmd_reg = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "temperament-regression",
            "--seed", "7",
            "--run-id", "phase-d-reg",
            "--output", str(out_reg),
            "--mutation", "regression",
        ]
        proc_reg = subprocess.run(cmd_reg, cwd=ROOT, capture_output=True, text=True)
        assert proc_reg.returncode == 1, "Regression mutation should fail with exit code 1"
        res_reg = json.loads((out_reg / "result.json").read_text(encoding="utf-8"))
        validate_result(res_reg)
        assert res_reg["status"] == "failed"
        assert res_reg["metrics"]["changed_cases"] > 0.0

    # 2. Injected missing disclaimer mutation (explanation completeness fails)
    with tempfile.TemporaryDirectory() as temp:
        out_exp = Path(temp) / "run_exp"
        cmd_exp = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "temperament-regression",
            "--seed", "7",
            "--run-id", "phase-d-exp",
            "--output", str(out_exp),
            "--mutation", "explanation",
        ]
        proc_exp = subprocess.run(cmd_exp, cwd=ROOT, capture_output=True, text=True)
        assert proc_exp.returncode == 1, "Explanation disclaimer mutation should fail with exit code 1"
        res_exp = json.loads((out_exp / "result.json").read_text(encoding="utf-8"))
        validate_result(res_exp)
        assert res_exp["status"] == "failed"
        assert res_exp["metrics"]["explanation_completeness"] < 1.0


def main() -> int:
    test_dimension_scoring_rules()
    test_temperament_simulation_determinism_and_acceptance()
    test_runner_and_contract()
    test_adversarial_mutations()
    print("phase D: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
