#!/usr/bin/env python3
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "colab"))
from lib.contract import ContractError, validate_identifier, validate_result, validate_tree, write_result_atomic  # noqa: E402


def valid_result():
    return {
        "schema_version": 1, "job": "synthetic-baseline", "run_id": "run-001",
        "status": "success", "metrics": {"items": 100.0},
        "gpu": {"name": None, "available": False}, "duration_seconds": 0.1,
        "commit": "0123456789abcdef", "source": {
            "job_sha256": "0" * 64, "dependencies": {"python": "3"}, "dirty": False,
        }, "created_at": "2026-10-14T12:00:00+00:00",
    }


def must_fail(value):
    try:
        validate_result(value)
    except ContractError:
        return
    raise AssertionError("expected contract failure")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "package"
        (root / "colab" / "jobs").mkdir(parents=True)
        (root / "colab" / "jobs" / "job.yaml").write_text("job: synthetic\n")
        assert validate_tree(root) == ["colab/jobs/job.yaml"]
        result_path = root / "result.json"
        write_result_atomic(result_path, valid_result())
        assert json.loads(result_path.read_text())["status"] == "success"
        for mutate in (
            lambda x: x.pop("metrics"),
            lambda x: x.update(metrics={"bad": float("nan")}),
            lambda x: x.update(run_id="../escape"),
            lambda x: x.update(extra=True),
            lambda x: x.update(source={**x["source"], "job_sha256": "bad"}),
            lambda x: x.update(created_at="truncated"),
        ):
            candidate = valid_result()
            mutate(candidate)
            must_fail(candidate)
        try:
            validate_identifier("..", "run_id")
        except ContractError:
            pass
        else:
            raise AssertionError("path traversal identifier was accepted")
        outside = Path(tmp) / "outside.txt"
        outside.write_text("private")
        escape = root / "colab" / "jobs" / "escape"
        try:
            escape.symlink_to(outside)
        except (OSError, NotImplementedError):
            pass
        else:
            try:
                validate_tree(root)
            except ContractError:
                pass
            else:
                raise AssertionError("symlink escape was accepted")
        (root / "colab" / ".env.secret").write_text("secret")
        try:
            validate_tree(root)
        except ContractError:
            pass
        else:
            raise AssertionError("sensitive file was accepted")
    print("colab contract tests: ok")


if __name__ == "__main__":
    main()
