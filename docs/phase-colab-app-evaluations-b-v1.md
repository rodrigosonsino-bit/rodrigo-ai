# Fase B — scheduler-reliability

Implementação local concluída em 2026-10-14 sem alterar o runtime de produção.

## Escopo implementado

O avaliador sintético de `scheduler-reliability` foi substituído por uma simulação determinística e modular em `colab/lib/scheduler_sim.py`, integrada em `colab/lib/evaluators.py` e executável via `scripts/colab/run-evaluation.py`.

A simulação implementa:
1. **Ledger de Idempotência**: armazenamento de respostas por `idempotency_key`, evitando dupla execução de requisições idênticas e suprimindo webhooks duplicados.
2. **Ciclo de Vida de Agendamentos**: operações sintéticas de `create`, `update` e `cancel` com versionamento de estado e payload estruturado.
3. **Timeouts e Retries Limitados**: simulação determinística de timeouts antes da mutação (persistência não realizada, reprocessamento no retry) e timeouts após a mutação (resposta perdida na rede, retry interceptado pelo ledger retornando resposta em cache).
4. **Snapshot e Reinício**: serialização atômica do estado completo do motor (ledger, agendamentos, histórico de mutações) e recarregamento em nova instância mantendo idempotência ininterrupta.
5. **Normalização de Fuso Horário**: conversão precisa de múltiplos offsets (`+00:00`, `-03:00`, `+02:00`, `-05:00`, `Z`) para epoch UTC canônico.
6. **Concorrência Serializada**: execução de lote concorrente com proteção de mutex reentrante (`threading.RLock`) garantindo ausência de race conditions.
7. **Oráculo Independente**: computação funcional do estado esperado de agendamentos e contagem de operações, comparando diretamente com o motor e medindo violações de idempotência, eventos perdidos e duplicatas.
8. **Modo Adversarial de Mutação**: suporte a injeções de perda (`mutation="loss"`) e duplicata (`mutation="duplicate"`). Quando ativadas, o oráculo identifica a divergência, resulta em `status="failed"` e o runner termina com exit code 1.

## Validação executada

- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_b.py`: passou (normalização de fuso, ledger/restart, determinismo da seed, contrato e oráculo, injeção de mutação de perda e duplicata retornando exit 1 e `status="failed"`);
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_a.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_contract.py`: passou;
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/validate-package.py colab`: passou;
- `scripts/colab/read-result.py`: validou o JSON atômico com todas as métricas exigidas pelo registro;
- `npm run typecheck` e `npm run build`: passaram.
