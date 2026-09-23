# Fase 5c — Lembretes e notas com confirmação obrigatória: relatório de implementação

Data: 2026-09-23
Base: commit `1ed8b33` (`Rodrigo AI v0.3.0` — versão do `package.json` não foi bumpada)
Plano implementado: `docs/phase-5c-v5.md`, combinação de 5 versões (v1 define o desenho; v2-v5
corrigem achados de auditoria em cima da anterior — cada versão só documenta o que mudou).

---

## 1. O que foi entregue

`LembreteTool` e `NotaTool` (`src/backend/tools/mutatingTools.ts`) criam e apagam lembretes/notas
por voz — a primeira capacidade do projeto que **muta estado** (tudo antes, Fases 1-5b, só lê).
Persistência em `data/lembretes.json`/`data/notas.json` (fora de `.runtime/`, que é regenerado por
`npm run setup:voice`, e fora do controle de versão). Nenhuma mutação executa sem confirmação
falada: o sistema detecta a intenção, faz a pergunta, e só executa depois de um "sim" real.

**A garantia central, e como ela é sustentada:** a pergunta de confirmação não autoriza a mutação
diretamente — ela arma um estado intermediário (`session.armedMutation`) que só é promovido a
`session.pendingMutation` **dentro de `markPlayed()`**, o método que o projeto já usa desde a Fase
2 para nunca gravar no histórico de conversa uma fala que o usuário não ouviu (proteção contra
barge-in). A Fase 5c reusa essa garantia já testada em vez de inventar uma paralela mais fraca —
decisão que só surgiu na 3ª rodada de auditoria, depois de duas tentativas com um mecanismo próprio
mais frágil (ver §2).

**Novos:** `src/backend/tools/mutatingTools.ts`, `src/backend/storage/jsonStore.ts`,
`src/backend/__tests__/{mutatingTools,storage}.test.ts`, `scripts/worker/test_mutation_parser.py`
(standalone, mesmo padrão de `test_tool_parser.py`). **Modificados:** `worker.py`
(`detect_mutation`/`detect_confirmation`, despacho nos dois pontos de
`stdin_reader_loop`/`work_loop`), `mlxWorkerEngine.ts`/`fakeEngine.ts`/`engine.ts` (mesmo padrão de
`detectTool` da 5b — timeout sem `SIGKILL`), `sessionManager.ts` (`armedMutation`/`pendingMutation`
em `Session`, `markPlayed()` estendido), `voiceRuntime.ts`, `registry.ts`, `.gitignore` (`data/`).

---

## 2. Processo: 5 versões, 4 rodadas de auditoria, 3 fornecedores diferentes

| Versão | Auditor / modelo | Veredito | Achado central |
|---|---|---|---|
| v1 | Hermes / longcat-2.0 | REJEITADO (1 ALTA + 6 média/baixa) | pseudocódigo incompleto, nada de desenho |
| v2 | agy / Gemini 3.8 Flash | REJEITADO (2 ALTA + 6 média/baixa) | camada de palavra-chave usava substring — "Isso tá errado" e "Pode esquecer" (recusas) casavam como confirmação positiva |
| v3 | Codex / gpt-5.6-sol | REJEITADO (2 ALTA + 4 média + 3 baixa) | **o achado mais profundo da fase**: "entrega confirmada" da v3 provava só que a síntese TTS tinha terminado, não que o usuário tinha ouvido a pergunta |
| v4 | Hermes / longcat-2.0 | APROVADO COM RESSALVAS | correção central (reuso de `markPlayed()`) confirmada sólida por execução; 3 dos 6 achados de "parte B" eram falsos — citavam estado de versões já superadas (ver nota abaixo) |
| v5 | — | aprovada para implementação | corrige os 2 achados reais da v4 (try/catch em `preview()`; mitigação de duplicata em `*_CRIAR`) |

**Nota metodológica desta fase, sem precedente nas anteriores:** na rodada 4, três dos seis achados
de auditoria aberta foram **conferidos contra o texto atual dos documentos antes de qualquer ação**
— e revelaram-se falsos, citando arquivo:linha de conteúdo que já tinha sido corrigido em versões
anteriores. A disciplina "não aceitar autodeclaração do subagente" (já em vigor para
implementação) foi estendida aqui para "não aceitar achado de auditoria sem reler o arquivo que ele
cita" — um achado com citação precisa de arquivo:linha não é, por si, prova de que o arquivo ainda
diz aquilo. Detalhe completo em `docs/phase-5c-v5.md` §1.

Quatro fornecedores/modelos diferentes auditaram esta fase ao todo (Hermes, agy, Codex, Hermes de
novo) — nenhum fechou sozinho todas as rodadas.

---

## 3. Implementação: uma rodada de correção necessária

Implementado por `agy` (modo `accept-edits`). A primeira execução produziu 3 testes falhando e um
bug de infraestrutura real: um teste que falha não fechava o servidor HTTP que tinha aberto,
travando `npm test` para sempre (confirmado com `kill -SIGUSR2` e inspeção de handles TCP
referenciados — mesmo padrão de falha silenciosa já catalogado no `CLAUDE.md` global do usuário).
Devolvido ao `agy` com os três defeitos nomeados, não corrigido diretamente:

1. Texto de `preview()` divergia do texto esperado pelo próprio teste que o `agy` escreveu —
   cosmético, alinhado.
2. Teste do achado central (barge-in) esperava HTTP 400; o real era 401. **Confirmado contra
   `routes.ts` real antes de aceitar a correção**: `markPlayed()` retornando `false` gera 401, não
   400 — o teste tinha o valor errado, não o código. `agy` corrigiu o teste com a justificativa
   correta, verificada.
3. `tool.preview()` sem `try/catch` deixava uma falha cair no caminho normal (resposta genérica do
   modelo) em vez de falar `MUTATION_FAILURE_TEXT` — bug real de implementação, corrigido.
4. Todos os testes da Fase 5c ganharam `afterEach()` para fechar o harness mesmo quando a asserção
   lança — resolve o travamento.

**Verificado de forma independente antes do commit** (não a autodeclaração do `agy`): `npm run
build` limpo; `npm test` rodado do zero por mim, terminou sozinho sem travar, **100/100** (era
76/76 antes da 5c); `test_mutation_parser.py` **32/32**; os dois pontos de despacho no `worker.py`
confirmados por `grep`; timeout sem `SIGKILL` confirmado; `performance.now()` confirmado;
`package.json` e `docs/` intocados.

---

## 4. Auditoria de código: aprovado com mutation testing

Hermes rodou a suíte, leu `sessionManager.ts` inteiro à procura de qualquer escrita de
`pendingMutation` fora de `markPlayed()` (achou uma única, na linha correta), e quebrou 3
propriedades de propósito para confirmar que a suíte acusa cada uma:

| Mutação | Pega pela suíte? |
|---|---|
| Remove a checagem de `lastTurnId` em `markPlayed()` (proteção contra barge-in) | ✅ |
| `JsonStore.read()` engole qualquer erro como "vazio" | ✅ |
| `keywordConfirmation` vira substring em vez de whitelist exata | ✅ |

**Veredito: APROVADO COM RESSALVAS**, ambas BAIXA e sem afetar a garantia central:

1. Normalização Unicode (NFD) permite contornar a whitelist de confirmação com grafemas raros
   (`"sïm"` → `"sim"`) — superfície de ataque praticamente nula numa pipeline só de voz (Whisper
   nunca produz isso de fala natural). Aceito, não mitigado.
2. `markPlayed()` duplica entrada no histórico de conversa se chamado duas vezes para o mesmo
   `turnId` — **comportamento herdado da Fase 2**, não introduzido pela 5c (a função já fazia isso
   antes; a 5c só estendeu o corpo, por decisão deliberada do plano de não arriscar reescrever o que
   já funciona — v4 §5, achado 1). Fora do escopo desta fase.

Log completo: `docs/audits/phase-5c-codigo-hermes-2026-09-23.log`.

---

## 5. Estado da fase

**IMPLEMENTADA E COM CÓDIGO AUDITADO, PENDENTE DE MEDIÇÃO COM MLX REAL.** Mesmo padrão da Fase 5b:
tudo que pode ser verificado sem o modelo real (build, suíte automatizada, mutation testing, leitura
exaustiva da garantia central) está feito e aprovado. Falta:

- **Cobertura de `detect_mutation`** — o sistema reconhece pedidos de lembrete/nota em fala
  coloquial real, na mesma proporção medida pela H11 da 5b (meta ≥80%, `docs/phase-5c-v5.md` §7)?
- **Cobertura de `detect_confirmation`** — sim/não coloquial é reconhecido corretamente (meta ≥90%,
  **tolerância zero para falso "sim" sobre negação clara** — um único caso reprova a fase, não
  importa a porcentagem)?
- Ambas exigem o mesmo protocolo de congelamento já usado na 5b: prompts já estão congelados desde
  a v4 (nenhuma mudança de conteúdo desde então); falta compor uma amostra de validação nova (não
  reaproveitar a da 5b) e medir com áudio real.

Nenhum bloqueio técnico impede essa medição — só não foi feita ainda nesta sessão.
