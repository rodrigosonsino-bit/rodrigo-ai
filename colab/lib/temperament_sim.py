"""Deterministic temperament evaluation simulator and regression oracle.

Features:
- Reference non-clinical questionnaire with two dimensions (A, B) and 4 integer items (0..4)
- Scoring: sum per dimension (0..8); high >= 6, low <= 2, neutral == 4, mixed in {3, 5}
- Incomplete/invalid inputs yield inconclusive results without profile or diagnostic claims
- Fixed versioned synthetic expectations for extreme, neutral, conflicting, boundary and incomplete cases
- Mandatory explanation with dimension breakdowns, numerical evidence, and explicit non-clinical boundary disclaimer
- Independent oracle testing stability against versioned baseline
- Adversarial mutations (rule regression, missing disclaimer) triggering status=failed
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any, Literal

NON_CLINICAL_DISCLAIMER = "Limite não clínico: questionário sintético experimental, sem valor diagnóstico ou clínico."


@dataclass(frozen=True)
class QuestionnaireCase:
    case_id: str
    responses: list[int | None]  # Exactly 4 responses, expected range 0..4
    expected_dim_a_score: int | None
    expected_dim_b_score: int | None
    expected_profile: str
    is_inconclusive_expected: bool


VERSIONED_SYNTHETIC_V1_CASES: list[QuestionnaireCase] = [
    # 1. Extremes
    QuestionnaireCase("case-ext-high", [4, 4, 4, 4], 8, 8, "Alto-Alto", False),
    QuestionnaireCase("case-ext-low", [0, 0, 0, 0], 0, 0, "Baixo-Baixo", False),
    QuestionnaireCase("case-ext-mixed-cross", [4, 4, 0, 0], 8, 0, "Alto-Baixo", False),
    # 2. Neutral
    QuestionnaireCase("case-neutral-balanced", [2, 2, 2, 2], 4, 4, "Neutro-Neutro", False),
    QuestionnaireCase("case-neutral-balanced-alt", [1, 3, 0, 4], 4, 4, "Neutro-Neutro", False),
    # 3. Boundaries (exact thresholds: 6 is Alto, 2 is Baixo, 3 and 5 are Misto)
    QuestionnaireCase("case-boundary-high-low", [3, 3, 1, 1], 6, 2, "Alto-Baixo", False),
    QuestionnaireCase("case-boundary-mixed-low", [1, 2, 1, 0], 3, 1, "Misto-Baixo", False),
    QuestionnaireCase("case-boundary-mixed-high", [2, 3, 3, 3], 5, 6, "Misto-Alto", False),
    # 4. Incomplete / Invalid cases (must be inconclusive)
    QuestionnaireCase("case-incomp-missing-one", [2, None, 2, 2], None, None, "Inconclusivo", True),
    QuestionnaireCase("case-incomp-missing-two", [None, None, 3, 3], None, None, "Inconclusivo", True),
    QuestionnaireCase("case-incomp-out-of-range", [5, 2, 2, 2], None, None, "Inconclusivo", True),
]


def score_dimension(val1: int | None, val2: int | None) -> tuple[int | None, str]:
    if val1 is None or val2 is None:
        return None, "Inconclusivo"
    if not (isinstance(val1, int) and isinstance(val2, int)) or isinstance(val1, bool) or isinstance(val2, bool):
        return None, "Inconclusivo"
    if not (0 <= val1 <= 4 and 0 <= val2 <= 4):
        return None, "Inconclusivo"

    total = val1 + val2
    if total >= 6:
        category = "Alto"
    elif total <= 2:
        category = "Baixo"
    elif total == 4:
        category = "Neutro"
    else:
        category = "Misto"
    return total, category


class TemperamentEngine:
    def process_case(
        self,
        case: QuestionnaireCase,
        inject_regression: bool = False,
        omit_disclaimer: bool = False,
    ) -> dict[str, Any]:
        resp = case.responses
        if len(resp) != 4:
            dim_a_score, dim_a_cat = None, "Inconclusivo"
            dim_b_score, dim_b_cat = None, "Inconclusivo"
        else:
            dim_a_score, dim_a_cat = score_dimension(resp[0], resp[1])
            dim_b_score, dim_b_cat = score_dimension(resp[2], resp[3])

        if inject_regression:
            # Fault injection: shifts threshold or assigns profile to incomplete
            if dim_a_score is None:
                dim_a_score = 4
                dim_a_cat = "Neutro"
            elif dim_a_score == 6:
                dim_a_cat = "Misto"  # Corrupted classification

        if dim_a_cat == "Inconclusivo" or dim_b_cat == "Inconclusivo":
            profile = "Inconclusivo"
            is_inconclusive = True
            dim_a_score = None
            dim_b_score = None
        else:
            profile = f"{dim_a_cat}-{dim_b_cat}"
            is_inconclusive = False

        # Build documented explanation
        if is_inconclusive:
            explanation = (
                f"Caso {case.case_id}: Dados incompletos ou fora da escala permitida. "
                "Classificação inconclusiva sem perfil atribuído. "
            )
        else:
            explanation = (
                f"Caso {case.case_id}: Dimensão A pontuou {dim_a_score} ({dim_a_cat}); "
                f"Dimensão B pontuou {dim_b_score} ({dim_b_cat}). Perfil resultante: {profile}. "
            )

        if not omit_disclaimer:
            explanation += NON_CLINICAL_DISCLAIMER

        return {
            "case_id": case.case_id,
            "dim_a_score": dim_a_score,
            "dim_b_score": dim_b_score,
            "dim_a_cat": dim_a_cat,
            "dim_b_cat": dim_b_cat,
            "profile": profile,
            "is_inconclusive": is_inconclusive,
            "explanation": explanation,
        }


class TemperamentOracle:
    """Independent oracle checking regression against fixed synthetic expectations."""

    def __init__(self, cases: list[QuestionnaireCase]) -> None:
        self.cases = cases

    def evaluate(self, results: list[dict[str, Any]]) -> dict[str, float]:
        res_by_id = {r["case_id"]: r for r in results}
        changed_cases = 0
        stable_scores = 0
        consistent_dimensions = 0
        complete_explanations = 0
        inconclusive_count = 0
        total = max(1, len(self.cases))

        for c in self.cases:
            act = res_by_id.get(c.case_id)
            if not act:
                changed_cases += 1
                continue

            matches_scores = (
                act["dim_a_score"] == c.expected_dim_a_score
                and act["dim_b_score"] == c.expected_dim_b_score
            )
            matches_profile = (act["profile"] == c.expected_profile)
            matches_inconclusive = (act["is_inconclusive"] == c.is_inconclusive_expected)

            if matches_scores:
                stable_scores += 1
            if matches_profile and matches_inconclusive:
                consistent_dimensions += 1
            else:
                changed_cases += 1

            if act["is_inconclusive"]:
                inconclusive_count += 1

            # Explanation completeness checks: dimensions mentioned, scores/evidence, disclaimer present
            expl = act["explanation"]
            has_dim = "Dimensão" in expl or "Dados incompletos" in expl
            has_disclaimer = NON_CLINICAL_DISCLAIMER in expl
            if has_dim and has_disclaimer:
                complete_explanations += 1

        score_stability = stable_scores / total
        dimension_consistency = consistent_dimensions / total
        explanation_completeness = complete_explanations / total
        inconclusive_rate = inconclusive_count / total

        return {
            "score_stability": float(round(score_stability, 4)),
            "dimension_consistency": float(round(dimension_consistency, 4)),
            "changed_cases": float(changed_cases),
            "explanation_completeness": float(round(explanation_completeness, 4)),
            "inconclusive_rate": float(round(inconclusive_rate, 4)),
        }


def execute_temperament_simulation(
    seed: int,
    mutation: Literal["none", "regression", "explanation"] = "none",
) -> tuple[dict[str, float], str]:
    cases = list(VERSIONED_SYNTHETIC_V1_CASES)
    engine = TemperamentEngine()
    oracle = TemperamentOracle(cases)

    results: list[dict[str, Any]] = []
    for c in cases:
        inj_reg = (mutation == "regression")
        omit_disc = (mutation == "explanation")
        out = engine.process_case(c, inject_regression=inj_reg, omit_disclaimer=omit_disc)
        results.append(out)

    metrics = oracle.evaluate(results)
    is_success = (
        metrics["score_stability"] == 1.0
        and metrics["dimension_consistency"] == 1.0
        and metrics["changed_cases"] == 0.0
        and metrics["explanation_completeness"] == 1.0
    )
    status = "success" if is_success else "failed"
    return metrics, status
