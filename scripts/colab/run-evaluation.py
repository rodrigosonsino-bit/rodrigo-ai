#!/usr/bin/env python3
"""Run one registered synthetic evaluation entirely offline."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "colab"))
from lib.contract import ContractError, validate_result, write_result_atomic  # noqa: E402
from lib.evaluators import EVALUATORS  # noqa: E402
from lib.registry import get_job  # noqa: E402


def git_revision() -> tuple[str, bool]:
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--", "colab", "scripts/colab"], cwd=ROOT, text=True).strip())
        return commit, dirty
    except (OSError, subprocess.CalledProcessError):
        return "0000000", True


def job_hash() -> str:
    digest = hashlib.sha256()
    for path in sorted([* (ROOT / "colab").rglob("*.py"), *(ROOT / "scripts/colab").glob("run-evaluation.py")]):
        digest.update(path.relative_to(ROOT).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("job", choices=sorted(EVALUATORS))
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mutation", choices=["none", "loss", "duplicate", "balance", "regression", "explanation", "drop_risk", "grant_diagnosis"], default="none")
    args = parser.parse_args()
    spec = get_job(args.job)
    if not 0 <= args.seed <= 2**32 - 1 or not args.run_id.replace("-", "").replace("_", "").isalnum():
        parser.error("seed/run-id inválido")
    output = args.output.resolve()
    result_path = output / "result.json"
    if result_path.exists():
        print("run_id já possui resultado; use um novo diretório", file=sys.stderr)
        return 2
    started = time.perf_counter()
    try:
        if args.mutation != "none" and args.job in {"scheduler-reliability", "finance-validation", "temperament-regression", "psico-safety"}:
            payload = EVALUATORS[args.job](args.seed, mutation=args.mutation)
        else:
            payload = EVALUATORS[args.job](args.seed)
        commit, dirty = git_revision()
        status = payload.pop("status", "success")
        result = {"schema_version": 1, "job": args.job, "run_id": args.run_id,
                  "status": status, **payload, "gpu": {"name": None, "available": False},
                  "duration_seconds": round(time.perf_counter() - started, 6), "commit": commit,
                  "source": {"job_sha256": job_hash(), "dependencies": {"python": platform.python_version()}, "dirty": dirty},
                  "created_at": dt.datetime.now(dt.timezone.utc).isoformat()}
        validate_result(result)
        write_result_atomic(result_path, result)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if status == "success" else 1
    except (ContractError, ValueError, OSError) as exc:
        print(f"evaluation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
