#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "colab"))
from lib.contract import ContractError, validate_result  # noqa: E402
from lib.synthetic import checksum, make_cases  # noqa: E402


def main() -> int:
    assert make_cases(7) == make_cases(7)
    assert checksum(make_cases(7)) == checksum(make_cases(7))
    old = json.loads((ROOT / "colab/jobs/synthetic-baseline/synthetic-baseline.ipynb").read_text())
    assert old["cells"]
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / "run"
        command = [sys.executable, str(ROOT / "scripts/colab/run-evaluation.py"), "scheduler-reliability",
                   "--seed", "7", "--run-id", "phase-a-001", "--output", str(output)]
        first = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
        result = json.loads((output / "result.json").read_text())
        validate_result(result)
        assert result["app"] == "scheduler"
        assert result["metric_units"]["latency_p95_ms"] == "ms"
        second = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        assert second.returncode == 2
        invalid = dict(result)
        invalid["extra"] = True
        try:
            validate_result(invalid)
        except ContractError:
            pass
        else:
            raise AssertionError("unknown field accepted")
    print("phase A: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
