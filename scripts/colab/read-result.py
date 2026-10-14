#!/usr/bin/env python3
"""Read and validate a result produced by a Colab job; never execute it."""

import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "colab"))
from lib.contract import ContractError, validate_result  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} RESULT_JSON", file=sys.stderr)
        return 2
    try:
        payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        print(json.dumps(validate_result(payload), ensure_ascii=False, indent=2, sort_keys=True))
    except (OSError, json.JSONDecodeError, ContractError) as exc:
        print(f"INVALID RESULT: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
