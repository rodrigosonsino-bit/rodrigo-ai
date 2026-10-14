# Fase F — psico-safety

Implementação local concluída em 2026-10-14 sem alterar o runtime de produção e somente após aprovação da Fase E.

## Escopo implementado

O avaliador de `psico-safety` foi implementado em `colab/lib/psico_sim.py`, integrado em `colab/lib/evaluators.py` e executável via `scripts/colab/run-evaluation.py`.

A simulação e oráculo implementam:
1. **Regras de Referência e Invariantes de Segurança**: detecção imediata de ideação ou autoagressão simulada com sinalização de risco e encaminhamento para revisão humana. Sinais de risco nunca são descartados silenciosamente (`false_negatives == 0.0`, `risk_recall == 1.0`).
2. **Recusa Explícita e Absoluta de Diagnóstico**: solicitações diretas ou indiretas de diagnóstico clínico/psicológico são rigorosamente recusadas com orientação para procurar profissional de saúde habilitado (`diagnosis_refusal_rate == 1.0`).
3. **Tratamento de Incompletude e Ambiguidade**: entradas vagas, fragmentadas ou truncadas são marcadas como incompletas e encaminhadas para triagem humana, sem inferência diagnóstica arbitrária.
4. **Controles Negativos Sintéticos com Negação**: fixtures negativas contendo termos de negação explícita testam que o sistema não gera falsos positivos indevidos (`false_positives == 0.0`).
5. **Aviso Explícito Não Clínico**: o relatório enfatiza expressamente que a suíte avalia barreiras heurísticas em fixtures sintéticas e não constitui validação clínica nem terapêutica.
6. **Mutações Adversariais**: injeção de descarte de risco (`mutation="drop_risk"`) ou concessão indevida de diagnóstico (`mutation="grant_diagnosis"`) é detectada pelo oráculo, resultando em `status="failed"` e código de saída 1.

## Validação executada

- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_f.py`: passou (recall de risco 1.0, zero falsos negativos, zero falsos positivos, recusa de diagnóstico 1.0, detecção de incompletos, mutações de risco descartado e concessão de diagnóstico falhando com exit 1);
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_e.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_d.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_c.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_b.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_a.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_contract.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/validate-package.py colab`: passou;
- `scripts/colab/read-result.py`: validou o JSON atômico com todas as métricas exigidas pelo registro;
- `npm run typecheck` e `npm run build`: passaram.
