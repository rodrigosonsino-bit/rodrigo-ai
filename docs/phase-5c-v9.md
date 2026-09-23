# Fase 5c — Mitigação do falso SIM sobre negação — v9

**APROVADO COM RESSALVAS** (rodada 2, `agy`, log completo em
`docs/audits/phase-5c-v8-agy-rodada2-2026-09-23.log`) — 6 dos 7 achados da rodada 1 confirmados
resolvidos, com execução real em Node.js contra 9 frases de colisão adversarial. Esta versão aplica
as 4 ressalvas vinculantes da rodada 2 sobre a lista de marcadores; nada mais muda. §0, §1, §3, §4
inalterados desde a v7 (ver `docs/phase-5c-v7.md`); a arquitetura do gate (achados 1 e 2 da rodada
1, ambos confirmados resolvidos) é a mesma da v8, só a lista de strings muda.

**Antes de escrever esta versão, consultei o Jev de novo**: vale gastar uma rodada 3 (exigiria
trocar de auditor, regra da skill) só para confirmar 4 adições mecânicas de string a listas já
testadas, ou aplicar direto e seguir pra implementação? `choice: aplicar_e_implementar`, confiança
0,98; risco residual estimado: `score 0.25` (baixo, 77% de probabilidade na categoria "baixo").
Decisão: aplicar direto, não gastar rodada 3.

## Ressalva 1 — marcadores cobriam só o verbo "criar", faltavam as outras 3 ferramentas

A v8 herdou `'pode sim'`, `'pode criar'`, `'pode marcar'`, `'pode fazer'` só das frases da amostra
já vista, todas sobre `LEMBRETE_CRIAR`. O sistema tem 4 ações (`LembreteTool`/`NotaTool`, cada uma
com `_CRIAR`/`_APAGAR`), e as perguntas de confirmação reais variam: *"Posso apagar o lembrete mais
recente?"*, *"Posso guardar a nota: X?"*, *"Posso apagar a nota mais recente?"*
(`src/backend/tools/mutatingTools.ts`). Um usuário respondendo `"pode apagar"`, `"pode guardar"`,
`"pode salvar"` ou `"pode anotar"` a qualquer uma dessas seria rebaixado por engano.

## Ressalva 2 — `'nada'` ausente do veto de negação

`"nada tá certo"` casa `certo` (afirmativo) e não casa nenhum marcador de `NEGATION_MARKERS` —
passaria pelo gate mesmo sendo uma recusa enfática comum em português.

## Ressalva 3 — Whisper expande "tá" para "está"

Caso #9 da amostra real (`docs/audits/phase-5c-v6-result-2026-09-23.json`): áudio "tá valendo",
transcrição Whisper "está valendo" — só não quebrou a v8 porque a frase também continha "sim". Uma
frase que dependesse só de "tá valendo" perderia o marcador.

## Ressalva 4 — prompt do §6 pedia palavras que a lista não reconhecia

O prompt congelado no §6 da v8 pede ao gerador (Hermes) frases SIM incluindo *"tá bom"*,
*"perfeito"*, *"combinado"* — nenhuma das três estava em `AFFIRMATIVE_MARKERS`. Isso garantiria
matematicamente reprovar a bateria (2 de 9 SIM sem marcador = 16/18 = 88,9%, abaixo da meta de
90%) antes mesmo dela rodar — a v8 pedia ao gerador exatamente os casos que o código não reconhece.

## Lista final (v9) — só o que mudou em relação à v8

```ts
const AFFIRMATIVE_MARKERS = [
  'sim', 'claro', 'confirmo', 'confirma', 'certo', 'certeza', 'exato', 'exatamente', 'positivo',
  'isso mesmo', 'bora', 'beleza', 'fechou', 'fechado', 'manda',
  'pode sim', 'pode criar', 'pode marcar', 'pode fazer',
  'pode apagar', 'pode guardar', 'pode salvar', 'pode anotar',        // ressalva 1
  'ta valendo', 'esta valendo',                                       // ressalva 3
  'perfeito', 'combinado', 'ta bom',                                  // ressalva 4
  'blz', 'ok'
];

const NEGATION_MARKERS = [
  'nao', 'nem', 'nunca', 'jamais', 'cancela', 'cancelar', 'esquece', 'esquecer', 'tira', 'tirar',
  'nada'                                                               // ressalva 2
];
```

`hasAffirmativeMarker`, `AFFIRMATIVE_REGEX`/`NEGATION_REGEX` pré-compilados, ponto de aplicação
dentro do `if (confirmed === null)` — tudo idêntico à v8 (achados 1, 2, 5 da rodada 1, confirmados
resolvidos na rodada 2). Não repito o pseudocódigo inteiro aqui; só a lista mudou.

Os 9 casos SIM conhecidos continuam cobertos (superset estrito da lista da v8 — nenhuma remoção,
só adição; nenhum dos 9 casos contém `'nada'`). §5 (arquivos afetados) e §6 (critérios de aceite,
protocolo de congelamento, prompt da amostra) inalterados da v8 — o prompt do §6 agora está
coerente com a lista.

## Rastreabilidade

- v7 — REJEITADO, rodada 1, `agy` (`docs/audits/phase-5c-v7-agy-rodada1-2026-09-23.log`).
- v8 — corrige os 7 achados da rodada 1. **APROVADO COM RESSALVAS**, rodada 2, `agy`
  (`docs/audits/phase-5c-v8-agy-rodada2-2026-09-23.log`) — 6/7 confirmados resolvidos por
  verificação real, 3 achados novos, 4 ressalvas vinculantes.
- **v9 (esta)** — aplica as 4 ressalvas. Nenhuma rodada 3 disparada (decisão informada por consulta
  ao Jev, §0 acima) — as mudanças são adições mecânicas a listas já testadas, sem alteração de
  arquitetura. **Pronta para implementação.**
