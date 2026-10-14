"""Small deterministic fixture generator shared by local jobs."""

from __future__ import annotations

import random
from typing import Any


def make_cases(seed: int, count: int = 16) -> list[dict[str, Any]]:
    if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2**32 - 1:
        raise ValueError("seed must be an integer between 0 and 2^32-1")
    rng = random.Random(seed)
    return [{"case_id": f"case-{index:03d}", "value": rng.randrange(0, 100), "flag": rng.choice([True, False])}
            for index in range(count)]


def checksum(cases: list[dict[str, Any]]) -> int:
    return sum(int(case["value"]) for case in cases)
