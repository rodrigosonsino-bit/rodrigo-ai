#!/usr/bin/env python3
"""Compare two validated synthetic results without executing their content."""

import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "colab"))
from lib.contract import ContractError, validate_result  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {Path(sys.argv[0]).name} OLD.json NEW.json", file=sys.stderr)
        return 2
    try:
        old = validate_result(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
        new = validate_result(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
        for field in ("job", "app", "dataset_version", "seed", "metric_units"):
            if old.get(field) != new.get(field):
                raise ContractError(f"incompatible comparison field: {field}")
        delta = {name: new["metrics"][name] - old["metrics"][name] for name in old["metrics"]}
        print(json.dumps({"job": new["job"], "run_ids": [old["run_id"], new["run_id"]],
                          "commits": [old["commit"], new["commit"]], "delta": delta}, indent=2, sort_keys=True))
        return 0
    except (OSError, json.JSONDecodeError, ContractError, KeyError) as exc:
        print(f"INVALID COMPARISON: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
