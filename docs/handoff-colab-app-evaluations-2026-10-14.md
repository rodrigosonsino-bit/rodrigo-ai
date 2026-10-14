# Handoff — avaliações Colab dos apps

Data: 2026-10-14. Repositório: `/Users/rodrigosonsino/Documents/Codex/2026-09-11/referenced-chatgpt-conversation-this-is-an/outputs/rodrigo-ai`.

## Instrução de continuidade

Continuar a implementação do plano `docs/plan-colab-app-evaluations-v1.md` na
ordem B, C, D, E, F. O usuário autorizou explicitamente continuar sem nova
auditoria. Preservar: somente CPU/local/sintético por padrão; nenhuma API paga,
rede, upload, `.env`, segredo, áudio pessoal, prontuário, produção ou runtime de
voz; não fazer commit, merge, push ou upload.

## Estado concluído

Fase A está implementada em `colab/lib/contract.py`, `registry.py`,
`synthetic.py`, `evaluators.py`, `scripts/colab/run-evaluation.py`,
`compare-results.py` e `test_phase_a.py`. O contrato v1 legado permanece
compatível. Jobs novos exigem `app`, `dataset_version`, `seed` e
`metric_units`. O registro cobre `scheduler-reliability`, `finance-validation`,
`temperament-regression`, `audio-transcriber` e `psico-safety`. Os avaliadores
atuais são referências sintéticas, não integrações reais com os apps.

Documentação: `docs/colab-app-evaluations-spec-v1.md`,
`docs/phase-colab-app-evaluations-a-v1.md` e
`docs/audits/colab-app-evaluations-v1-audit-status.md`.

## Validação já feita

```bash
PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_phase_a.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/test_contract.py
PYTHONDONTWRITEBYTECODE=1 python3 scripts/colab/validate-package.py colab
npm run typecheck
npm run build
npm test
```

Resultado final de `npm test`: 874 testes, 874 passando, 0 falhas. Em sandbox
restrita os sockets locais retornam `EPERM`; repetir com permissão de loopback
quando necessário. A primeira execução teve colisão transitória de porta; a
segunda passou completamente.

## Próximo trabalho — Fase B

Substituir o avaliador superficial de `scheduler-reliability` por uma simulação
determinística com ledger de idempotência, eventos create/update/cancel,
webhook duplicado, timeout antes/depois de aplicar, retry limitado, restart,
offsets de fuso e concorrência serializada. Criar oráculo independente e teste
de mutação que injete perda/duplicata e exija `status=failed`/exit diferente de
zero. Manter métricas do registro: taxa correta, duplicatas, perdas, retries,
p50/p95 e violações de idempotência.

## Fases C–F

- C: ledger em centavos inteiros, transferências líquidas zero, parcelas com
  resto exato, deduplicação, datas/sinais/categorias e ambíguos encaminhados;
  qualquer erro de saldo interrompe aprovação.
- D: questionário sintético não clínico com expectativas versionadas,
  incompletos inconclusivos, comparação de commits/hashes e explicação com
  limites explícitos.
- E: implementar WER/CER e pipeline de WAV sintético. O runtime local possui
  `.runtime/.venv/bin/mlx_whisper` e cache de
  `mlx-community/whisper-small-mlx` (manifesto `.runtime/models-manifest.json`).
  Verificar pesos offline antes de benchmark. Não baixar modelo, não usar
  áudio pessoal e não importar o runtime de voz. Se o modelo não carregar em
  CPU, produzir relatório `not_executed` e manter a fase pendente; nunca
  inventar métricas.
- F: somente depois de E aprovado; casos sintéticos de risco simulado,
  incompletos, ambíguos, fora do escopo e pedidos de diagnóstico. Risco nunca é
  descartado silenciosamente, diagnóstico é recusado e inconclusivos vão para
  revisão humana. Não apresentar como validação clínica.

## Gate por fase

Após cada implementação, adicionar teste específico e documento de aceite,
rodar os dois testes Python Colab, `validate-package`, `read-result`,
`npm test`, `npm run typecheck` e `npm run build`. Não avançar com falha real.
Use `PYTHONDONTWRITEBYTECODE=1`; remova caches Python gerados antes da
allowlist se necessário. Não altere arquivos fora do laboratório e documentos
relacionados.
