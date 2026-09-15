#!/usr/bin/env python3
"""
Verificação standalone (sem framework de teste — mesmo estilo de scripts/bench-voice.mjs)
das funções puras de detecção de loop de repetição em worker.py.

Rodar com: .runtime/.venv/bin/python3 scripts/worker/test_repetition_detector.py
(qualquer Python 3 com biblioteca padrão serve — não depende de MLX carregado).

Ver docs/fix-generation-repetition-loop-v2.md para a decisão de projeto e os números
recalculados com Python real.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from worker import _is_near_duplicate_sentence, _normalize_for_dedup  # noqa: E402

FAILURES = 0


def check(description: str, actual: bool, expected: bool) -> None:
    global FAILURES
    status = "OK" if actual == expected else "FALHOU"
    if actual != expected:
        FAILURES += 1
    print(f"[{status}] {description} -> obtido={actual} esperado={expected}")


def main() -> None:
    # Positivo: variação leve no meio da frase — o caso que quebrou a v1 com Jaccard de trigramas.
    a = "Para calcular 17% de 850, você multiplica 850 por 0,17."
    b = "Para calcular 17% de 850, multiplica 850 por 0,17."
    check(
        "variação leve (uma palavra removida no meio) detectada como duplicata",
        _is_near_duplicate_sentence(b, [_normalize_for_dedup(a)]),
        True,
    )

    # Positivo: repetição exata, frase real observada na Fase 4.
    c = "Isso é senso comum."
    check(
        "repetição exata detectada como duplicata",
        _is_near_duplicate_sentence(c, [_normalize_for_dedup(c)]),
        True,
    )

    # Positivo: piso de 3 palavras — exatamente 3 não cai no escape de curtas.
    d = "Deus é amor."
    check(
        "frase de exatamente 3 palavras, repetida, é detectada (não cai no escape de curtas)",
        _is_near_duplicate_sentence(d, [_normalize_for_dedup(d)]),
        True,
    )

    # Negativo: frases abaixo do piso de 3 palavras nunca disparam, mesmo idênticas.
    check(
        "frase de 1 palavra repetida NÃO dispara (abaixo do piso mínimo)",
        _is_near_duplicate_sentence("Entendo.", [_normalize_for_dedup("Entendo.")]),
        False,
    )
    check(
        "frase de 2 palavras repetida NÃO dispara (abaixo do piso mínimo)",
        _is_near_duplicate_sentence("Sem dúvida.", [_normalize_for_dedup("Sem dúvida.")]),
        False,
    )

    # Negativo: mesmo tema, conteúdo realmente diferente.
    e = "Na Virtologia, a aceitação é a prática de acolher ativamente o que não pode ser mudado no passado."
    f = "É diferente do conformismo."
    check(
        "frases de conteúdo claramente diferente NÃO disparam falso positivo",
        _is_near_duplicate_sentence(f, [_normalize_for_dedup(e)]),
        False,
    )

    # Negativo: variação real observada de execuções DIFERENTES (Hebreus 5, Fase 4) — não é
    # uma repetição real dentro do mesmo turno, e a similaridade fica abaixo do limiar.
    g = (
        "O capítulo Hebreus 5 é central no entendimento da natureza e função do Messias "
        "como médio entre Deus e os homens."
    )
    h = (
        "O capítulo Hebreus 5 é crucial no entendimento da natureza do ministério "
        "messiânico e da função dos servos de Deus."
    )
    check(
        "variação de execuções diferentes (mesmo tema, texto bem diferente) NÃO dispara",
        _is_near_duplicate_sentence(h, [_normalize_for_dedup(g)]),
        False,
    )

    # Negativo: primeira ocorrência, lista vazia.
    check(
        "primeira frase do turno (lista vazia) nunca dispara",
        _is_near_duplicate_sentence("Qualquer coisa aqui, sem histórico ainda.", []),
        False,
    )

    print()
    if FAILURES:
        print(f"{FAILURES} caso(s) falharam.")
        sys.exit(1)
    print("Todos os casos passaram.")


if __name__ == "__main__":
    main()
