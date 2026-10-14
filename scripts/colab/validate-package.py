#!/usr/bin/env python3
"""Validate an offline Colab package against the positive allowlist."""

from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "colab"))
from lib.contract import ContractError, validate_tree  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} PACKAGE_ROOT", file=sys.stderr)
        return 2
    try:
        root = Path(sys.argv[1])
        allowed = {"jobs", "lib", "README.md", "ALLOWLIST.md"} if root.name == "colab" else None
        for item in validate_tree(root, allowed):
            print(item)
    except ContractError as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
