"""T1 (camada em profundidade): guarda de saída no worker Python. Espelho de src/backend/privacy/outboundGuard.ts.

O Node já aplica o guarda antes de enviar ao worker; esta camada protege caso o Node falhe ou seja contornado (mesma ideia do
mestre RODRIGO_CLOUD, que o worker também reaplica). As duas implementações são mantidas em PARIDADE por um conjunto de casos
compartilhado: src/backend/__tests__/fixtures/outbound-cases.json (o TypeScript é a referência; os testes dos dois lados leem o
mesmo arquivo). Nunca registra nem devolve o conteúdo casado: só TIPO e posição.

Modos (RODRIGO_OUTBOUND_GUARD): off | warn | redact | block. Valor desconhecido => redact (o Node já valida estritamente).
"""
from __future__ import annotations

import os
import re
from typing import NamedTuple

MODES = ("off", "warn", "redact", "block")


class Finding(NamedTuple):
    kind: str
    start: int
    end: int


class OutboundBlocked(Exception):
    """Lançada no modo block; a mensagem cita só os TIPOS."""

    def __init__(self, kinds: list[str]) -> None:
        super().__init__(f"Envio à nuvem bloqueado pelo guarda de saída (RODRIGO_OUTBOUND_GUARD=block): {', '.join(kinds)}.")
        self.kinds = kinds


def current_mode() -> str:
    raw = (os.environ.get("RODRIGO_OUTBOUND_GUARD") or "").strip()
    return raw if raw in MODES else "redact"


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def luhn_valid(d: str) -> bool:
    if len(d) < 13 or len(d) > 19 or not d.isdigit():
        return False
    total, double = 0, False
    for ch in reversed(d):
        n = ord(ch) - 48
        if double:
            n *= 2
            if n > 9:
                n -= 9
        total += n
        double = not double
    return total % 10 == 0


def cpf_valid(d: str) -> bool:
    if not re.fullmatch(r"\d{11}", d) or re.fullmatch(r"(\d)\1{10}", d):
        return False

    def calc(length: int) -> int:
        s = sum(int(d[i]) * (length + 1 - i) for i in range(length))
        r = (s * 10) % 11
        return 0 if r == 10 else r

    return calc(9) == int(d[9]) and calc(10) == int(d[10])


def cnpj_valid(d: str) -> bool:
    if not re.fullmatch(r"\d{14}", d) or re.fullmatch(r"(\d)\1{13}", d):
        return False

    def calc(length: int) -> int:
        w = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] if length == 12 else [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        s = sum(int(d[i]) * w[i] for i in range(length))
        r = s % 11
        return 0 if r < 2 else 11 - r

    return calc(12) == int(d[12]) and calc(13) == int(d[13])


def looks_like_credential(value: str) -> bool:
    """Dígito, símbolo ou maiúscula depois da primeira letra (mesma heurística do TypeScript)."""
    if re.search(r"\d", value):
        return True
    if any(not c.isalpha() for c in value):
        return True
    if re.search(r"[a-zà-ÿ][A-ZÀ-Þ]", value):  # minúscula seguida de maiúscula
        return True
    return bool(re.match(r"^[A-ZÀ-Þ].*[A-ZÀ-Þ]", value))


_DETECTORS: list[tuple[str, re.Pattern[str], bool, int | None]] = [
    # (tipo, regex, valida_com_dígitos, grupo_a_mascarar)
    ("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?"), False, None),
    (
        "api-key",
        re.compile(
            r"\b(?:AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}"
            r"|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[0-9A-Za-z_]{20,}|A[SK]IA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})"
        ),
        False,
        None,
    ),
    ("bearer-token", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), False, None),
    ("bearer-token", re.compile(r"\bBearer\s+([A-Za-z0-9._~+/=-]{20,})", re.IGNORECASE), False, 1),
    (
        "spoken-password",
        re.compile(r"\b(?:senha|password|passwd)(?:\s+d[aoe]s?\s+[\w-]+)?\s*(?:(?:é|eh|e|is)\s+|[:=]\s*)[\"']?([^\s\"',;]{3,})", re.IGNORECASE),
        False,
        1,
    ),
    ("cnpj", re.compile(r"(?<!\d)\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}(?!\d)"), True, None),
    ("cpf", re.compile(r"(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)"), True, None),
    ("credit-card", re.compile(r"(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])"), True, None),
]


def scan_text(text: str) -> list[Finding]:
    found: list[Finding] = []
    for kind, rx, needs_digits, group in _DETECTORS:
        for m in rx.finditer(text):
            if m.end() == m.start():
                continue
            if group is not None:
                start, end = m.start(group), m.end(group)
                if kind == "spoken-password" and not looks_like_credential(m.group(group)):
                    continue
            else:
                start, end = m.start(), m.end()
            if needs_digits:
                d = _digits(m.group(0))
                ok = cnpj_valid(d) if kind == "cnpj" else cpf_valid(d) if kind == "cpf" else luhn_valid(d)
                if not ok:
                    continue
            if any(start < f.end and end > f.start for f in found):
                continue
            found.append(Finding(kind, start, end))
    return sorted(found, key=lambda f: f.start)


def mask_for(kind: str) -> str:
    return f"[{kind} omitido]"


def guard_text(text: str, mode: str | None = None) -> tuple[str, list[Finding], bool]:
    """Devolve (texto, achados, bloqueado). No modo block o chamador NÃO deve enviar."""
    mode = mode or current_mode()
    if mode == "off" or not text:
        return text, [], False
    findings = scan_text(text)
    if not findings:
        return text, findings, False
    if mode == "warn":
        return text, findings, False
    if mode == "block":
        return text, findings, True
    out = text
    for f in reversed(findings):
        out = out[: f.start] + mask_for(f.kind) + out[f.end :]
    return out, findings, False


def guard_messages(messages: list[dict], mode: str | None = None) -> list[dict]:
    """Aplica o guarda ao conteúdo de cada mensagem; no modo block lança OutboundBlocked (nada é enviado)."""
    mode = mode or current_mode()
    if mode == "off":
        return list(messages)
    out: list[dict] = []
    blocked: list[str] = []
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            text, findings, is_blocked = guard_text(content, mode)
            if is_blocked:
                blocked.extend(f.kind for f in findings)
            out.append({**m, "content": text})
        else:
            out.append(m)
    if blocked:
        raise OutboundBlocked(sorted(set(blocked)))
    return out
