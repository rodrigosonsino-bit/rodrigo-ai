#!/usr/bin/env python3
"""
Verificação standalone (sem framework de teste — mesmo estilo de test_tool_parser.py)
das funções puras de parsing de mutação e confirmação em worker.py.

Rodar com: .runtime/.venv/bin/python3 scripts/worker/test_mutation_parser.py
(não depende de MLX carregado).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from worker import parse_confirmation_output, parse_mutation_output  # noqa: E402

FAILURES = 0


def check(description: str, actual: any, expected: any) -> None:
    global FAILURES
    status = "OK" if actual == expected else "FALHOU"
    if actual != expected:
        FAILURES += 1
    print(f"[{status}] {description} -> obtido={actual!r} esperado={expected!r}")


def main() -> None:
    print("=== Testes de parse_mutation_output ===")
    # Casos canônicos e extração de conteúdo
    check(
        "LEMBRETE_CRIAR canônico",
        parse_mutation_output("LEMBRETE_CRIAR|Comprar leite amanhã", truncated=False),
        ("LEMBRETE_CRIAR", "Comprar leite amanhã"),
    )
    check(
        "NOTA_CRIAR canônico",
        parse_mutation_output("NOTA_CRIAR|Reunião muito produtiva", truncated=False),
        ("NOTA_CRIAR", "Reunião muito produtiva"),
    )
    check(
        "LEMBRETE_CRIAR em minúsculas e com espaços",
        parse_mutation_output(" lembrete_criar | Ligar pro médico ", truncated=False),
        ("LEMBRETE_CRIAR", "Ligar pro médico"),
    )

    # Achado 4 da rodada 1: conteúdo contendo '|'
    check(
        "conteúdo contendo caractere pipe (|)",
        parse_mutation_output("LEMBRETE_CRIAR|Comprar leite | pão | queijo", truncated=False),
        ("LEMBRETE_CRIAR", "Comprar leite | pão | queijo"),
    )

    # Conteúdo vazio / ausente em *_CRIAR
    check(
        "LEMBRETE_CRIAR com conteúdo vazio",
        parse_mutation_output("LEMBRETE_CRIAR|", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "LEMBRETE_CRIAR com conteúdo só de espaços",
        parse_mutation_output("LEMBRETE_CRIAR|   ", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "LEMBRETE_CRIAR sem separador de conteúdo",
        parse_mutation_output("LEMBRETE_CRIAR", truncated=False),
        ("NENHUMA", None),
    )

    # Achado 5 da rodada 1: teto de MAX_MUTATION_CONTENT_CHARS (200)
    check(
        "conteúdo com exatamente 200 caracteres",
        parse_mutation_output("LEMBRETE_CRIAR|" + "a" * 200, truncated=False),
        ("LEMBRETE_CRIAR", "a" * 200),
    )
    check(
        "conteúdo excedendo 200 caracteres (201) degrada para NENHUMA",
        parse_mutation_output("LEMBRETE_CRIAR|" + "a" * 201, truncated=False),
        ("NENHUMA", None),
    )

    # Achado 9 da rodada 3: truncated=True degrada para NENHUMA
    check(
        "truncated=True com formato sintaticamente válido degrada para NENHUMA",
        parse_mutation_output("LEMBRETE_CRIAR|Comprar leite", truncated=True),
        ("NENHUMA", None),
    )
    check(
        "truncated=True com APAGAR degrada para NENHUMA",
        parse_mutation_output("LEMBRETE_APAGAR", truncated=True),
        ("NENHUMA", None),
    )

    # Ações de APAGAR e ESQUECER
    check(
        "LEMBRETE_APAGAR canônico",
        parse_mutation_output("LEMBRETE_APAGAR", truncated=False),
        ("LEMBRETE_APAGAR", None),
    )
    check(
        "NOTA_APAGAR canônico",
        parse_mutation_output("NOTA_APAGAR", truncated=False),
        ("NOTA_APAGAR", None),
    )
    check(
        "MEMORIA_ESQUECER canônico",
        parse_mutation_output("MEMORIA_ESQUECER", truncated=False),
        ("MEMORIA_ESQUECER", None),
    )
    check(
        "LEMBRETE_APAGAR mesmo se vier com conteúdo extra descarta o conteúdo",
        parse_mutation_output("LEMBRETE_APAGAR|ignorado", truncated=False),
        ("LEMBRETE_APAGAR", None),
    )
    check(
        "MEMORIA_ESQUECER mesmo se vier com conteúdo extra descarta o conteúdo",
        parse_mutation_output("MEMORIA_ESQUECER|ignorado", truncated=False),
        ("MEMORIA_ESQUECER", None),
    )

    # Fase 7: testes dedicados para MEMORIA_GUARDAR
    check(
        "MEMORIA_GUARDAR canônico",
        parse_mutation_output("MEMORIA_GUARDAR|seu nome é Rodrigo", truncated=False),
        ("MEMORIA_GUARDAR", "seu nome é Rodrigo"),
    )
    check(
        "MEMORIA_GUARDAR em minúsculas e com espaços",
        parse_mutation_output(" memoria_guardar | prefere respostas curtas ", truncated=False),
        ("MEMORIA_GUARDAR", "prefere respostas curtas"),
    )
    check(
        "MEMORIA_GUARDAR contendo caractere pipe (|)",
        parse_mutation_output("MEMORIA_GUARDAR|gosta de café | chá", truncated=False),
        ("MEMORIA_GUARDAR", "gosta de café | chá"),
    )
    check(
        "MEMORIA_GUARDAR com conteúdo vazio",
        parse_mutation_output("MEMORIA_GUARDAR|", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "MEMORIA_GUARDAR com conteúdo só de espaços",
        parse_mutation_output("MEMORIA_GUARDAR|   ", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "MEMORIA_GUARDAR sem separador de conteúdo",
        parse_mutation_output("MEMORIA_GUARDAR", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "MEMORIA_GUARDAR com exatamente 200 caracteres",
        parse_mutation_output("MEMORIA_GUARDAR|" + "a" * 200, truncated=False),
        ("MEMORIA_GUARDAR", "a" * 200),
    )
    check(
        "MEMORIA_GUARDAR excedendo 200 caracteres (201) degrada para NENHUMA",
        parse_mutation_output("MEMORIA_GUARDAR|" + "a" * 201, truncated=False),
        ("NENHUMA", None),
    )
    check(
        "truncated=True com MEMORIA_GUARDAR degrada para NENHUMA",
        parse_mutation_output("MEMORIA_GUARDAR|prefere respostas curtas", truncated=True),
        ("NENHUMA", None),
    )
    check(
        "truncated=True com MEMORIA_ESQUECER degrada para NENHUMA",
        parse_mutation_output("MEMORIA_ESQUECER", truncated=True),
        ("NENHUMA", None),
    )

    # Fase 8: testes dedicados para LEMBRETE_EDITAR, NOTA_EDITAR, MEMORIA_EDITAR
    check(
        "LEMBRETE_EDITAR canônico",
        parse_mutation_output("LEMBRETE_EDITAR|Ligar pro médico", truncated=False),
        ("LEMBRETE_EDITAR", "Ligar pro médico"),
    )
    check(
        "LEMBRETE_EDITAR em minúsculas e com espaços",
        parse_mutation_output(" lembrete_editar | trocar texto ", truncated=False),
        ("LEMBRETE_EDITAR", "trocar texto"),
    )
    check(
        "LEMBRETE_EDITAR contendo pipe (|)",
        parse_mutation_output("LEMBRETE_EDITAR|café solúvel | em pó", truncated=False),
        ("LEMBRETE_EDITAR", "café solúvel | em pó"),
    )
    check(
        "LEMBRETE_EDITAR com conteúdo vazio",
        parse_mutation_output("LEMBRETE_EDITAR|", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "LEMBRETE_EDITAR com conteúdo só de espaços",
        parse_mutation_output("LEMBRETE_EDITAR|   ", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "LEMBRETE_EDITAR sem separador de conteúdo",
        parse_mutation_output("LEMBRETE_EDITAR", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "LEMBRETE_EDITAR com exatamente 200 caracteres",
        parse_mutation_output("LEMBRETE_EDITAR|" + "a" * 200, truncated=False),
        ("LEMBRETE_EDITAR", "a" * 200),
    )
    check(
        "LEMBRETE_EDITAR excedendo 200 caracteres (201) degrada para NENHUMA",
        parse_mutation_output("LEMBRETE_EDITAR|" + "a" * 201, truncated=False),
        ("NENHUMA", None),
    )
    check(
        "truncated=True com LEMBRETE_EDITAR degrada para NENHUMA",
        parse_mutation_output("LEMBRETE_EDITAR|Ligar pro médico", truncated=True),
        ("NENHUMA", None),
    )

    check(
        "NOTA_EDITAR canônico",
        parse_mutation_output("NOTA_EDITAR|Comprar materiais na segunda", truncated=False),
        ("NOTA_EDITAR", "Comprar materiais na segunda"),
    )
    check(
        "NOTA_EDITAR em minúsculas e com espaços",
        parse_mutation_output(" nota_editar | texto da nota ", truncated=False),
        ("NOTA_EDITAR", "texto da nota"),
    )
    check(
        "NOTA_EDITAR com conteúdo vazio",
        parse_mutation_output("NOTA_EDITAR|", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "truncated=True com NOTA_EDITAR degrada para NENHUMA",
        parse_mutation_output("NOTA_EDITAR|Comprar materiais", truncated=True),
        ("NENHUMA", None),
    )

    check(
        "MEMORIA_EDITAR canônico",
        parse_mutation_output("MEMORIA_EDITAR|seu nome é Rodrigo Sonsino", truncated=False),
        ("MEMORIA_EDITAR", "seu nome é Rodrigo Sonsino"),
    )
    check(
        "MEMORIA_EDITAR em minúsculas e com espaços",
        parse_mutation_output(" memoria_editar | prefere café sem açúcar ", truncated=False),
        ("MEMORIA_EDITAR", "prefere café sem açúcar"),
    )
    check(
        "MEMORIA_EDITAR com conteúdo vazio",
        parse_mutation_output("MEMORIA_EDITAR|", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "truncated=True com MEMORIA_EDITAR degrada para NENHUMA",
        parse_mutation_output("MEMORIA_EDITAR|seu nome é Rodrigo Sonsino", truncated=True),
        ("NENHUMA", None),
    )

    # Casos inválidos e bordas
    check(
        "NENHUMA canônico",
        parse_mutation_output("NENHUMA", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "string vazia",
        parse_mutation_output("", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "string de espaços",
        parse_mutation_output("   ", truncated=False),
        ("NENHUMA", None),
    )
    check(
        "None degrada para NENHUMA",
        parse_mutation_output(None, truncated=False),
        ("NENHUMA", None),
    )
    check(
        "ação desconhecida BANANA",
        parse_mutation_output("BANANA|teste", truncated=False),
        ("NENHUMA", None),
    )

    print()
    print("=== Testes de parse_confirmation_output ===")
    check("SIM canônico", parse_confirmation_output("SIM"), "SIM")
    check("sim minúsculo", parse_confirmation_output("sim"), "SIM")
    check("SIM com espaços", parse_confirmation_output(" SIM "), "SIM")
    check("SIM com ponto final", parse_confirmation_output("SIM."), "SIM")
    check("SIM com exclamação", parse_confirmation_output("SIM!"), "SIM")
    check("NAO canônico", parse_confirmation_output("NAO"), "NAO")
    check("nao minúsculo", parse_confirmation_output("nao"), "NAO")
    check("não com acento (formato inesperado do LLM degrada para NAO)", parse_confirmation_output("não"), "NAO")
    check("string vazia degrada para NAO", parse_confirmation_output(""), "NAO")
    check("None degrada para NAO", parse_confirmation_output(None), "NAO")
    check("palavra aleatória TALVEZ degrada para NAO", parse_confirmation_output("TALVEZ"), "NAO")
    check("frase longa degrada para NAO", parse_confirmation_output("acho que sim"), "NAO")

    print()
    if FAILURES:
        print(f"{FAILURES} caso(s) falharam.")
        sys.exit(1)
    print("Todos os casos de teste de parser passaram.")


if __name__ == "__main__":
    main()
