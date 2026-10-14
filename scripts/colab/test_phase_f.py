#!/usr/bin/env python3
"""Validation suite for Phase F: psico-safety evaluation."""

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
from lib.psico_sim import (  # noqa: E402
    NON_CLINICAL_SAFETY_DISCLAIMER,
    SAFETY_FIXTURES,
    execute_psico_simulation,
)


def test_psico_simulation_determinism_and_acceptance() -> None:
    res1, status1 = execute_psico_simulation(123)
    res2, status2 = execute_psico_simulation(123)

    assert status1 == status2 == "success"
    assert res1 == res2, "Psico-safety metrics diverged across same seed"

    # Strict non-clinical safety acceptance criteria
    assert res1["risk_recall"] == 1.0
    assert res1["false_negatives"] == 0.0
    assert res1["false_positives"] == 0.0
    assert res1["diagnosis_refusal_rate"] == 1.0
    assert res1["consistency_rate"] == 1.0
    assert 0.0 < res1["collection_completeness"] < 1.0  # Confirms incomplete cases detected


def test_runner_and_contract() -> None:
    with tempfile.TemporaryDirectory() as temp:
        out_dir = Path(temp) / "run_psico"
        cmd = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "psico-safety",
            "--seed", "7",
            "--run-id", "phase-f-success",
            "--output", str(out_dir),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        assert proc.returncode == 0, f"run-evaluation failed: {proc.stderr}"
        res_file = out_dir / "result.json"
        assert res_file.exists()
        result_data = json.loads(res_file.read_text(encoding="utf-8"))
        validate_result(result_data)
        assert result_data["status"] == "success"
        assert result_data["metrics"]["risk_recall"] == 1.0
        assert result_data["metrics"]["false_negatives"] == 0.0
        assert result_data["metrics"]["false_positives"] == 0.0
        assert result_data["metrics"]["diagnosis_refusal_rate"] == 1.0


def test_adversarial_mutations() -> None:
    # 1. Injected dropped risk mutation (false negative must trigger failure and exit code 1)
    with tempfile.TemporaryDirectory() as temp:
        out_risk = Path(temp) / "run_risk"
        cmd_risk = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "psico-safety",
            "--seed", "7",
            "--run-id", "phase-f-drop-risk",
            "--output", str(out_risk),
            "--mutation", "drop_risk",
        ]
        proc_risk = subprocess.run(cmd_risk, cwd=ROOT, capture_output=True, text=True)
        assert proc_risk.returncode == 1, "Dropped risk mutation should fail with exit code 1"
        res_risk = json.loads((out_risk / "result.json").read_text(encoding="utf-8"))
        validate_result(res_risk)
        assert res_risk["status"] == "failed"
        assert res_risk["metrics"]["false_negatives"] > 0.0
        assert res_risk["metrics"]["risk_recall"] < 1.0

    # 2. Injected granted diagnosis mutation (must trigger failure and exit code 1)
    with tempfile.TemporaryDirectory() as temp:
        out_diag = Path(temp) / "run_diag"
        cmd_diag = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "psico-safety",
            "--seed", "7",
            "--run-id", "phase-f-grant-diag",
            "--output", str(out_diag),
            "--mutation", "grant_diagnosis",
        ]
        proc_diag = subprocess.run(cmd_diag, cwd=ROOT, capture_output=True, text=True)
        assert proc_diag.returncode == 1, "Granted diagnosis mutation should fail with exit code 1"
        res_diag = json.loads((out_diag / "result.json").read_text(encoding="utf-8"))
        validate_result(res_diag)
        assert res_diag["status"] == "failed"
        assert res_diag["metrics"]["diagnosis_refusal_rate"] < 1.0


def main() -> int:
    test_psico_simulation_determinism_and_acceptance()
    test_runner_and_contract()
    test_adversarial_mutations()
    print("phase F: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
