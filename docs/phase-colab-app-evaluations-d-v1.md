# Fase D — temperament-regression

Implementação local concluída em 2026-10-14 sem alterar o runtime de produção.

## Escopo implementado

O avaliador de `temperament-regression` foi substituído por uma suíte de regressão determinística e oráculo independente em `colab/lib/temperament_sim.py`, integrada em `colab/lib/evaluators.py` e executável via `scripts/colab/run-evaluation.py`.

A simulação implementa:
1. **Questionário de Referência Não Clínico**: questionário com duas dimensões (A e B) e quatro itens com valores inteiros de 0 a 4. Pontuação documentada por soma de dimensão: Alto (>= 6), Baixo (<= 2), Neutro (4), Misto (3 ou 5).
2. **Tratamento de Incompletude sem Diagnóstico**: entradas incompletas (`None`), de tipo inválido ou fora do intervalo `0..4` resultam estritamente em perfil `Inconclusivo` com escores nulos, sem atribuição de perfil ou alegações diagnósticas.
3. **Casos Versionados de Referência (`synthetic-v1`)**: catálogo cobrindo extremos, neutro equilibrado, fronteiras limítrofes e casos incompletos, com expectativas independentes e imutáveis.
4. **Explicação com Limites Explícitos**: geração de justificativa detalhada contendo a pontuação por dimensão, a evidência numérica e a menção obrigatória ao aviso de limite não clínico ("Limite não clínico: questionário sintético experimental, sem valor diagnóstico ou clínico.").
5. **Oráculo Independente e Mutações Adversariais**: verificação estrita de estabilidade de escores (`score_stability`), consistência de dimensão (`dimension_consistency`), ausência de casos alterados (`changed_cases == 0`) e completude da explicação (`explanation_completeness == 1.0`). Mutações adversariais de desvio de regras (`mutation="regression"`) ou remoção do disclaimer (`mutation="explanation"`) falham fechado com `status="failed"` e código de saída 1.

## Validação executada

- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_d.py`: passou (pontuação por dimensão, casos incompletos, completude de explicação, determinismo de seed, contrato, oráculo, regressão injetada e disclaimer ausente falhando com exit 1);
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_c.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_b.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_a.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_contract.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/validate-package.py colab`: passou;
- `scripts/colab/read-result.py`: validou o JSON atômico com todas as métricas exigidas pelo registro;
- `npm run typecheck` e `npm run build`: passaram.
