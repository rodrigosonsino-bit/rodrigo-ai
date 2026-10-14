#!/usr/bin/env python3
"""Validation suite for Phase C: finance-validation evaluation."""

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
from lib.finance_sim import (  # noqa: E402
    divide_installments,
    execute_finance_simulation,
    generate_finance_fixtures,
    is_valid_calendar_date,
)


def test_installment_remainder_preservation() -> None:
    # 1000 cents in 3 installments -> 334 + 333 + 333 == 1000
    parts3 = divide_installments(1000, 3)
    assert sum(parts3) == 1000, f"Sum mismatch: {sum(parts3)} != 1000"
    assert parts3 == [334, 333, 333]

    # 10000 cents in 7 installments -> exact sum 10000
    parts7 = divide_installments(10000, 7)
    assert sum(parts7) == 10000, f"Sum mismatch: {sum(parts7)} != 10000"


def test_calendar_validation() -> None:
    assert is_valid_calendar_date("2026-10-14") is True
    assert is_valid_calendar_date("2024-02-29") is True  # Leap year
    assert is_valid_calendar_date("2026-02-29") is False  # Not leap year
    assert is_valid_calendar_date("2026-02-30") is False  # Invalid date
    assert is_valid_calendar_date("invalid-date") is False


def test_finance_simulation_determinism_and_acceptance() -> None:
    res1, status1 = execute_finance_simulation(123)
    res2, status2 = execute_finance_simulation(123)

    assert status1 == status2 == "success"
    assert res1 == res2, "Finance simulation metrics diverged across same seed"

    # Strict acceptance criteria
    assert res1["balance_error_cents"] == 0.0
    assert res1["totals_accuracy"] == 1.0
    assert res1["duplicates_detection_rate"] == 1.0
    assert res1["categorization_precision"] == 1.0
    assert res1["ambiguous_items"] > 0.0  # Confirms ambiguous routing occurs
    assert res1["anomalies_detected"] > 0.0  # Confirms anomaly detection occurs
    assert 0.0 <= res1["mean_confidence"] <= 1.0


def test_runner_and_contract() -> None:
    with tempfile.TemporaryDirectory() as temp:
        out_dir = Path(temp) / "run_success"
        cmd = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "finance-validation",
            "--seed", "7",
            "--run-id", "phase-c-success",
            "--output", str(out_dir),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        assert proc.returncode == 0, f"run-evaluation failed: {proc.stderr}"
        res_file = out_dir / "result.json"
        assert res_file.exists()
        result_data = json.loads(res_file.read_text(encoding="utf-8"))
        validate_result(result_data)
        assert result_data["status"] == "success"
        assert result_data["metrics"]["balance_error_cents"] == 0.0
        assert result_data["metrics"]["totals_accuracy"] == 1.0


def test_adversarial_mutations() -> None:
    # 1. Injected balance drift mutation (1 cent difference must fail approval)
    with tempfile.TemporaryDirectory() as temp:
        out_bal = Path(temp) / "run_bal"
        cmd_bal = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "finance-validation",
            "--seed", "7",
            "--run-id", "phase-c-bal",
            "--output", str(out_bal),
            "--mutation", "balance",
        ]
        proc_bal = subprocess.run(cmd_bal, cwd=ROOT, capture_output=True, text=True)
        assert proc_bal.returncode == 1, "Balance drift mutation should fail with exit code 1"
        res_bal = json.loads((out_bal / "result.json").read_text(encoding="utf-8"))
        validate_result(res_bal)
        assert res_bal["status"] == "failed"
        assert res_bal["metrics"]["balance_error_cents"] > 0.0

    # 2. Injected missed duplicate mutation
    with tempfile.TemporaryDirectory() as temp:
        out_dup = Path(temp) / "run_dup"
        cmd_dup = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "finance-validation",
            "--seed", "7",
            "--run-id", "phase-c-dup",
            "--output", str(out_dup),
            "--mutation", "duplicate",
        ]
        proc_dup = subprocess.run(cmd_dup, cwd=ROOT, capture_output=True, text=True)
        assert proc_dup.returncode == 1, "Missed duplicate mutation should fail with exit code 1"
        res_dup = json.loads((out_dup / "result.json").read_text(encoding="utf-8"))
        validate_result(res_dup)
        assert res_dup["status"] == "failed"
        assert res_dup["metrics"]["duplicates_detection_rate"] < 1.0


def main() -> int:
    test_installment_remainder_preservation()
    test_calendar_validation()
    test_finance_simulation_determinism_and_acceptance()
    test_runner_and_contract()
    test_adversarial_mutations()
    print("phase C: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
