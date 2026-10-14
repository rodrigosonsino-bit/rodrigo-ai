# Fase C — finance-validation

Implementação local concluída em 2026-10-14 sem alterar o runtime de produção.

## Escopo implementado

O avaliador de `finance-validation` foi substituído por uma simulação determinística de validação financeira em `colab/lib/finance_sim.py`, integrada em `colab/lib/evaluators.py` e executável via `scripts/colab/run-evaluation.py`.

A simulação implementa:
1. **Centavos Inteiros sem Floats**: valores monetários operados estritamente em centavos inteiros (`int`), eliminando imprecisão de ponto flutuante.
2. **Transferências Internas de Saldo Líquido Zero**: validação de pares `transfer_out` e `transfer_in` garantindo que transferências entre contas não alteram o patrimônio total.
3. **Divisão de Parcelas com Resto Exato**: divisão de montantes em N parcelas preservando o resto centavo a centavo (`total // n` e distribuição dos centavos restantes).
4. **Deduplicação de Transações**: detecção de assinaturas duplicadas (data, conta, valor, descrição).
5. **Validação de Calendário e Sinais**: verificação de datas reais (dias 1..31, meses 1..12, anos bissextos, rejeição de 30 de fevereiro) e coerência direcional de sinal (receitas > 0, despesas < 0).
6. **Classificação Determinística com Encaminhamento de Ambíguos**: categorização por regras sem dependência de LLM ou APIs pagas; transações ambíguas ou sem regras claras são roteadas para "Revisão Humana" com nível de confiança reduzido (0.5), sendo contabilizadas em `ambiguous_items`.
7. **Detecção de Anomalias**: identificação de datas inexistentes ou quantias zero.
8. **Oráculo Independente e Mutação Adversarial**: o oráculo fixa o saldo esperado e testa integridade. Mutações adversariais de saldo (`mutation="balance"`, drift de 1 centavo) ou duplicata perdida (`mutation="duplicate"`) resultam obrigatoriamente em `status="failed"` e código de saída 1.

## Validação executada

- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_c.py`: passou (parcelamento com resto exato, validação de calendário, determinismo da seed, contrato, oráculo, injeção de saldo incorreto e duplicata retornando exit 1 e `status="failed"`);
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_b.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_a.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_contract.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/validate-package.py colab`: passou;
- `scripts/colab/read-result.py`: validou o resultado com todas as métricas exigidas;
- `npm run typecheck` e `npm run build`: passaram.
