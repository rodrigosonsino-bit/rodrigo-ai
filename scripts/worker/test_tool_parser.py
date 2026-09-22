#!/usr/bin/env python3
"""
Verificação standalone (sem framework de teste — mesmo estilo de test_repetition_detector.py)
das funções puras de parsing de ferramenta em worker.py.

Rodar com: .runtime/.venv/bin/python3 scripts/worker/test_tool_parser.py
(não depende de MLX carregado).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from worker import parse_tool_output  # noqa: E402

FAILURES = 0


def check(description: str, actual: str, expected: str) -> None:
    global FAILURES
    status = "OK" if actual == expected else "FALHOU"
    if actual != expected:
        FAILURES += 1
    print(f"[{status}] {description} -> obtido={actual!r} esperado={expected!r}")


def main() -> None:
    # Casos canônicos especificados em H2 (docs/phase-5b-v5.md §7):
    # HORA, hora,  DATA , NENHUMA, "", BANANA, HORA., quebra de linha. Inválido -> NENHUMA.
    check("saída HORA maiúscula", parse_tool_output("HORA"), "HORA")
    check("saída hora minúscula", parse_tool_output("hora"), "HORA")
    check("saída DATA com espaços", parse_tool_output(" DATA "), "DATA")
    check("saída NENHUMA canônica", parse_tool_output("NENHUMA"), "NENHUMA")
    check("saída string vazia", parse_tool_output(""), "NENHUMA")
    check("saída palavra desconhecida BANANA", parse_tool_output("BANANA"), "NENHUMA")
    check("saída HORA com ponto final", parse_tool_output("HORA."), "HORA")
    check("saída DATA com quebra de linha", parse_tool_output("DATA\n"), "DATA")
    check("saída apenas quebra de linha", parse_tool_output("\n"), "NENHUMA")

    # Casos complementares de borda / robustez:
    check("saída apenas espaços", parse_tool_output("   "), "NENHUMA")
    check("saída None degrada para NENHUMA", parse_tool_output(None), "NENHUMA")
    check("saída HORA com exclamação", parse_tool_output("HORA!"), "HORA")
    check("saída DATA com interrogação", parse_tool_output("DATA?"), "DATA")
    check("saída texto arbitrário longo", parse_tool_output("não sei as horas"), "NENHUMA")

    print()
    if FAILURES:
        print(f"{FAILURES} caso(s) falharam.")
        sys.exit(1)
    print("Todos os casos passaram.")


if __name__ == "__main__":
    main()
