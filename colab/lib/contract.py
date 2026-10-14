"""Offline contract and allowlist checks for Colab jobs.

This module deliberately uses only the Python standard library. It must remain
safe to run before installing any notebook dependency or enabling a GPU.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable


class ContractError(ValueError):
    """Raised when a job package or result violates the contract."""


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_METRIC = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,63}$")
_SENSITIVE_SEGMENTS = {
    ".env",
    ".env.local",
    ".env.production",
    "docs/research",
    "memory",
    "media",
    "logs",
    "__pycache__",
}
_ALLOWED_TOP_LEVELS = {"colab", "input"}
_RESULT_FIELDS = {
    "schema_version",
    "job",
    "run_id",
    "status",
    "metrics",
    "gpu",
    "duration_seconds",
    "commit",
    "source",
    "created_at",
    "app",
    "dataset_version",
    "seed",
    "metric_units",
}
_REQUIRED_RESULT_FIELDS = _RESULT_FIELDS - {"app", "dataset_version", "seed", "metric_units"}
_GPU_FIELDS = {"name", "available"}
_SOURCE_FIELDS = {"job_sha256", "dependencies", "dirty"}


def validate_identifier(value: Any, field: str = "identifier") -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value) or value in {".", ".."}:
        raise ContractError(f"{field} must match [A-Za-z0-9._-], with no path traversal")
    return value


def _is_sensitive(relative: Path) -> bool:
    segments = [part.casefold() for part in relative.parts]
    joined = "/".join(segments)
    if any(part in {".env", ".env.local", ".env.production", "memory", "media", "logs", "__pycache__"} for part in segments):
        return True
    if "docs/research" in joined:
        return True
    return any(part.startswith(".env") or part.endswith((".key", ".pem", ".token")) for part in segments)


def _assert_inside(root: Path, candidate: Path) -> None:
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ContractError(f"path escapes allowed root: {candidate}") from exc


def _assert_no_symlink_escape(root: Path, relative: Path) -> None:
    current = root
    for part in relative.parts:
        if part in {"", ".", ".."}:
            raise ContractError(f"unsafe path segment: {part!r}")
        current = current / part
        if current.is_symlink():
            raise ContractError(f"symlink is not allowed in job package: {relative}")


def validate_tree(root: str | os.PathLike[str], allowed_top_levels: set[str] | None = None) -> list[str]:
    """Validate a package tree and return sorted relative regular-file paths."""

    root_path = Path(root).expanduser()
    if not root_path.exists() or not root_path.is_dir() or root_path.is_symlink():
        raise ContractError(f"package root must be a real directory: {root_path}")
    root_real = root_path.resolve()
    allowed = allowed_top_levels or _ALLOWED_TOP_LEVELS
    files: list[str] = []
    for path in sorted(root_path.rglob("*")):
        relative = path.relative_to(root_path)
        _assert_inside(root_real, path.resolve(strict=False))
        _assert_no_symlink_escape(root_path, relative)
        if _is_sensitive(relative):
            raise ContractError(f"sensitive path is not allowlisted: {relative}")
        if relative.parts and relative.parts[0] not in allowed:
            raise ContractError(f"top-level path is not allowlisted: {relative}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ContractError(f"non-regular file is not allowed: {relative}")
        files.append(relative.as_posix())
    return files


def _require_fields(obj: dict[str, Any], expected: set[str], label: str) -> None:
    unknown = set(obj) - expected
    missing = expected - set(obj)
    if unknown:
        raise ContractError(f"{label} has unknown fields: {sorted(unknown)}")
    if missing:
        raise ContractError(f"{label} is missing fields: {sorted(missing)}")


def validate_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ContractError("result must be a JSON object")
    unknown = set(result) - _RESULT_FIELDS
    if unknown:
        raise ContractError(f"result has unknown fields: {sorted(unknown)}")
    missing_required = _REQUIRED_RESULT_FIELDS - set(result)
    if missing_required:
        raise ContractError(f"result is missing fields: {sorted(missing_required)}")
    if result["schema_version"] != 1:
        raise ContractError("unsupported schema_version")
    evaluation_fields = ("app", "dataset_version", "seed", "metric_units")
    present = [field in result for field in evaluation_fields]
    if any(present) and not all(present):
        raise ContractError("app, dataset_version, seed and metric_units must be provided together")
    if all(present):
        validate_identifier(result["app"], "app")
        validate_identifier(result["dataset_version"], "dataset_version")
        if not isinstance(result["seed"], int) or isinstance(result["seed"], bool) or not 0 <= result["seed"] <= 2**32 - 1:
            raise ContractError("seed must be an integer between 0 and 2^32-1")
        units = result["metric_units"]
        if not isinstance(units, dict) or any(not isinstance(k, str) or not _METRIC.fullmatch(k) or not isinstance(v, str) for k, v in units.items()):
            raise ContractError("metric_units must map metric names to unit strings")
    validate_identifier(result["job"], "job")
    validate_identifier(result["run_id"], "run_id")
    if result["status"] not in {"success", "failed"}:
        raise ContractError("status must be success or failed")
    metrics = result["metrics"]
    if not isinstance(metrics, dict):
        raise ContractError("metrics must be an object")
    for name, value in metrics.items():
        if not isinstance(name, str) or not _METRIC.fullmatch(name):
            raise ContractError(f"invalid metric name: {name!r}")
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
            raise ContractError(f"metric {name!r} must be a finite non-negative number")
        if all(present) and name not in result["metric_units"]:
            raise ContractError(f"metric {name!r} is missing a unit")
    gpu = result["gpu"]
    if not isinstance(gpu, dict):
        raise ContractError("gpu must be an object")
    _require_fields(gpu, _GPU_FIELDS, "gpu")
    if not isinstance(gpu["available"], bool) or (gpu["name"] is not None and not isinstance(gpu["name"], str)):
        raise ContractError("gpu has invalid name/available values")
    if not isinstance(result["duration_seconds"], (int, float)) or isinstance(result["duration_seconds"], bool):
        raise ContractError("duration_seconds must be a number")
    if not math.isfinite(result["duration_seconds"]) or result["duration_seconds"] < 0:
        raise ContractError("duration_seconds must be finite and non-negative")
    if not isinstance(result["commit"], str) or not re.fullmatch(r"[0-9a-f]{7,64}", result["commit"]):
        raise ContractError("commit must be a hexadecimal git revision")
    source = result["source"]
    if not isinstance(source, dict):
        raise ContractError("source must be an object")
    _require_fields(source, _SOURCE_FIELDS, "source")
    if not isinstance(source["job_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", source["job_sha256"]):
        raise ContractError("source.job_sha256 must be a SHA-256 hex digest")
    if not isinstance(source["dependencies"], dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in source["dependencies"].items()):
        raise ContractError("source.dependencies must map strings to strings")
    if not isinstance(source["dirty"], bool):
        raise ContractError("source.dirty must be boolean")
    if not isinstance(result["created_at"], str):
        raise ContractError("created_at must be an ISO-8601 string")
    try:
        _dt.datetime.fromisoformat(result["created_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError("created_at must be valid ISO-8601") from exc
    return result


def write_result_atomic(path: str | os.PathLike[str], result: dict[str, Any]) -> None:
    validate_result(result)
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
