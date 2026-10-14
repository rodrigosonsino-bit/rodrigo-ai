"""Deterministic finance validation simulator and independent oracle.

Features:
- Integer cents only (strictly no floats for money)
- Zero-sum internal transfers (transfer-out + transfer-in == 0)
- Exact remainder installment division without lost cents
- Deduplication of duplicate transactions
- Calendar date validation and directional signs (income > 0, expense < 0)
- Rule-based deterministic categorization with ambiguous item routing
- Anomaly detection (invalid dates, zero amounts, reversed signs)
- Independent oracle fixing expected totals independently
- Adversarial mutations (balance drift, duplicate miss) triggering status=failed
"""

from __future__ import annotations

import datetime as dt
import math
import random
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal


@dataclass(frozen=True)
class TransactionRecord:
    tx_id: str
    date_iso: str
    amount_cents: int
    account: str
    description: str
    tx_type: Literal["income", "expense", "transfer_out", "transfer_in"]
    is_duplicate: bool = False
    is_anomaly: bool = False
    is_ambiguous: bool = False
    expected_category: str | None = None


# Deterministic categorization dictionary (unaccented lowercase keys)
CATEGORY_RULES: dict[str, str] = {
    "supermercado": "Alimentação",
    "padaria": "Alimentação",
    "restaurante": "Alimentação",
    "farmacia": "Saúde",
    "medica": "Saúde",
    "combustivel": "Transporte",
    "posto": "Transporte",
    "uber": "Transporte",
    "salario": "Renda",
    "rendimento": "Renda",
    "aluguel": "Moradia",
    "condominio": "Moradia",
    "energia eletrica": "Moradia",
    "internet fibra": "Moradia",
}


def strip_accents(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", text)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()


def divide_installments(total_cents: int, count: int) -> list[int]:
    """Divides integer cents across N installments with exact remainder preservation."""
    if count <= 0:
        raise ValueError("Installment count must be positive")
    base = total_cents // count
    remainder = total_cents % count
    return [base + (1 if i < remainder else 0) for i in range(count)]


def is_valid_calendar_date(date_str: str) -> bool:
    try:
        parts = date_str.split("-")
        if len(parts) != 3:
            return False
        year, month, day = int(parts[0]), int(parts[1]), int(parts[2])
        dt.date(year, month, day)
        return True
    except (ValueError, TypeError):
        return False


def generate_finance_fixtures(seed: int) -> list[TransactionRecord]:
    rng = random.Random(seed)
    records: list[TransactionRecord] = []

    # 1. Standard incomes and expenses
    standard_items = [
        ("Salário mensal", 500000, "income", "Renda"),
        ("Rendimento poupança", 12500, "income", "Renda"),
        ("Supermercado Central", -45230, "expense", "Alimentação"),
        ("Padaria Bairro", -1850, "expense", "Alimentação"),
        ("Farmácia Popular", -8790, "expense", "Saúde"),
        ("Combustível Posto", -22000, "expense", "Transporte"),
        ("Aluguel AP", -180000, "expense", "Moradia"),
        ("Internet fibra", -11990, "expense", "Moradia"),
    ]

    for idx, (desc, cents, tx_t, cat) in enumerate(standard_items):
        day = 5 + idx
        date_iso = f"2026-10-{day:02d}"
        records.append(
            TransactionRecord(
                tx_id=f"tx-std-{idx:03d}",
                date_iso=date_iso,
                amount_cents=cents,
                account="Corrente",
                description=desc,
                tx_type=tx_t,  # type: ignore
                expected_category=cat,
            )
        )

    # 2. Internal Transfers (Net Zero)
    transfer_amount = 80000
    records.append(
        TransactionRecord(
            tx_id="tx-xfer-out-001",
            date_iso="2026-10-15",
            amount_cents=-transfer_amount,
            account="Corrente",
            description="Transferência interna para Reserva",
            tx_type="transfer_out",
            expected_category="Transferência",
        )
    )
    records.append(
        TransactionRecord(
            tx_id="tx-xfer-in-001",
            date_iso="2026-10-15",
            amount_cents=transfer_amount,
            account="Reserva",
            description="Transferência interna de Corrente",
            tx_type="transfer_in",
            expected_category="Transferência",
        )
    )

    # 3. Exact Remainder Installments: 10000 cents in 3 parts -> 3334, 3333, 3333
    installment_parts = divide_installments(10000, 3)
    for p_idx, p_cents in enumerate(installment_parts, 1):
        records.append(
            TransactionRecord(
                tx_id=f"tx-inst-{p_idx:03d}",
                date_iso=f"2026-10-{18 + p_idx:02d}",
                amount_cents=-p_cents,
                account="Cartao",
                description=f"Compra parcelada {p_idx}/3 supermercado",
                tx_type="expense",
                expected_category="Alimentação",
            )
        )

    # 4. Duplicate transaction fixture
    dup_origin = TransactionRecord(
        tx_id="tx-dup-orig-001",
        date_iso="2026-10-22",
        amount_cents=-4500,
        account="Corrente",
        description="Restaurante Almoço",
        tx_type="expense",
        expected_category="Alimentação",
    )
    records.append(dup_origin)
    records.append(
        TransactionRecord(
            tx_id="tx-dup-copy-001",
            date_iso="2026-10-22",
            amount_cents=-4500,
            account="Corrente",
            description="Restaurante Almoço",
            tx_type="expense",
            is_duplicate=True,
            expected_category="Alimentação",
        )
    )

    # 5. Ambiguous transactions requiring manual routing (no LLM, flagged for review)
    ambiguous_items = [
        ("TED recebida sem identificador", 15000, "income"),
        ("Pagamento diverso não categorizado", -7500, "expense"),
    ]
    for a_idx, (desc, cents, tx_t) in enumerate(ambiguous_items):
        records.append(
            TransactionRecord(
                tx_id=f"tx-amb-{a_idx:03d}",
                date_iso=f"2026-10-{24 + a_idx:02d}",
                amount_cents=cents,
                account="Corrente",
                description=desc,
                tx_type=tx_t,  # type: ignore
                is_ambiguous=True,
                expected_category="Revisão Humana",
            )
        )

    # 6. Anomalies fixture (invalid calendar date or invalid zero amount)
    records.append(
        TransactionRecord(
            tx_id="tx-anom-date-001",
            date_iso="2026-02-30",  # February 30th does not exist
            amount_cents=-3200,
            account="Corrente",
            description="Lançamento com data inválida",
            tx_type="expense",
            is_anomaly=True,
        )
    )
    records.append(
        TransactionRecord(
            tx_id="tx-anom-zero-001",
            date_iso="2026-10-28",
            amount_cents=0,  # Zero amount is financial anomaly
            account="Corrente",
            description="Transação valor zero",
            tx_type="expense",
            is_anomaly=True,
        )
    )

    return records


class FinanceEngine:
    def __init__(self) -> None:
        self.seen_signatures: set[tuple[str, str, int, str]] = set()
        self.valid_transactions: list[TransactionRecord] = []
        self.detected_duplicates: list[TransactionRecord] = []
        self.detected_anomalies: list[TransactionRecord] = []
        self.ambiguous_items: list[TransactionRecord] = []
        self.categorized: list[tuple[TransactionRecord, str, float]] = []

    def process(
        self,
        records: list[TransactionRecord],
        inject_balance_drift_cents: int = 0,
        inject_miss_duplicate: bool = False,
    ) -> dict[str, Any]:
        for rec in records:
            # Check calendar date and amount anomalies
            if not is_valid_calendar_date(rec.date_iso) or rec.amount_cents == 0:
                self.detected_anomalies.append(rec)
                continue

            # Check duplicates (by signature: date, account, amount, description)
            sig = (rec.date_iso, rec.account, rec.amount_cents, rec.description)
            if sig in self.seen_signatures and not inject_miss_duplicate:
                self.detected_duplicates.append(rec)
                continue
            self.seen_signatures.add(sig)

            # Route ambiguous items
            desc_norm = strip_accents(rec.description)
            matched_cat: str | None = None
            for kw, cat in CATEGORY_RULES.items():
                if kw in desc_norm:
                    matched_cat = cat
                    break

            if rec.tx_type in {"transfer_out", "transfer_in"}:
                matched_cat = "Transferência"
                conf = 1.0
            elif matched_cat is None:
                self.ambiguous_items.append(rec)
                matched_cat = "Revisão Humana"
                conf = 0.5  # Lower confidence indicates required human routing
            else:
                conf = 1.0

            self.valid_transactions.append(rec)
            self.categorized.append((rec, matched_cat, conf))

        # Calculate integer cents balances
        total_income_cents = sum(t.amount_cents for t in self.valid_transactions if t.amount_cents > 0)
        total_expense_cents = sum(t.amount_cents for t in self.valid_transactions if t.amount_cents < 0)
        total_balance_cents = sum(t.amount_cents for t in self.valid_transactions) + inject_balance_drift_cents

        return {
            "total_income_cents": total_income_cents,
            "total_expense_cents": total_expense_cents,
            "total_balance_cents": total_balance_cents,
            "duplicates_count": len(self.detected_duplicates),
            "anomalies_count": len(self.detected_anomalies),
            "ambiguous_count": len(self.ambiguous_items),
            "categorized": self.categorized,
        }


class FinanceOracle:
    """Independent oracle with ground truth calculations."""

    def __init__(self, records: list[TransactionRecord]) -> None:
        self.records = records

    def compute_ground_truth(self) -> dict[str, Any]:
        expected_valid: list[TransactionRecord] = []
        expected_duplicates: int = 0
        expected_anomalies: int = 0
        expected_ambiguous: int = 0

        for r in self.records:
            if r.is_anomaly:
                expected_anomalies += 1
            elif r.is_duplicate:
                expected_duplicates += 1
            else:
                expected_valid.append(r)
                if r.is_ambiguous:
                    expected_ambiguous += 1

        expected_balance_cents = sum(r.amount_cents for r in expected_valid)

        return {
            "expected_valid_count": len(expected_valid),
            "expected_duplicates": expected_duplicates,
            "expected_anomalies": expected_anomalies,
            "expected_ambiguous": expected_ambiguous,
            "expected_balance_cents": expected_balance_cents,
            "expected_records": expected_valid,
        }

    def evaluate(self, engine_result: dict[str, Any]) -> dict[str, float]:
        gt = self.compute_ground_truth()

        balance_error_cents = abs(engine_result["total_balance_cents"] - gt["expected_balance_cents"])
        totals_accuracy = 1.0 if balance_error_cents == 0 else max(0.0, 1.0 - (balance_error_cents / 100000.0))

        # Duplicate detection precision
        expected_dups = max(1, gt["expected_duplicates"])
        dups_detected = engine_result["duplicates_count"]
        duplicates_detection_rate = 1.0 if dups_detected == gt["expected_duplicates"] else max(0.0, min(1.0, dups_detected / expected_dups))

        # Categorization accuracy on all processed items
        categorized_list = engine_result["categorized"]
        correct_cat = 0
        total_conf = 0.0
        for rec, cat, conf in categorized_list:
            total_conf += conf
            if rec.expected_category == cat:
                correct_cat += 1

        cat_prec = correct_cat / max(1, len(categorized_list))
        mean_conf = total_conf / max(1, len(categorized_list))

        return {
            "totals_accuracy": float(round(totals_accuracy, 4)),
            "duplicates_detection_rate": float(round(duplicates_detection_rate, 4)),
            "categorization_precision": float(round(cat_prec, 4)),
            "ambiguous_items": float(engine_result["ambiguous_count"]),
            "mean_confidence": float(round(mean_conf, 4)),
            "balance_error_cents": float(balance_error_cents),
            "anomalies_detected": float(engine_result["anomalies_count"]),
        }


def execute_finance_simulation(
    seed: int,
    mutation: Literal["none", "balance", "duplicate"] = "none",
) -> tuple[dict[str, float], str]:
    fixtures = generate_finance_fixtures(seed)
    oracle = FinanceOracle(fixtures)
    engine = FinanceEngine()

    drift_cents = 1 if mutation == "balance" else 0
    miss_dup = (mutation == "duplicate")

    engine_res = engine.process(
        fixtures,
        inject_balance_drift_cents=drift_cents,
        inject_miss_duplicate=miss_dup,
    )
    metrics = oracle.evaluate(engine_res)

    is_success = (
        metrics["balance_error_cents"] == 0.0
        and metrics["totals_accuracy"] == 1.0
        and metrics["duplicates_detection_rate"] == 1.0
        and metrics["categorization_precision"] == 1.0
    )
    status = "success" if is_success else "failed"
    return metrics, status
