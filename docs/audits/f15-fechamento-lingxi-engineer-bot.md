# F15: auditoria de fechamento (somente leitura)

- Data: 2026-10-11, ~22:40 BRT
- Autor: Lingxi's Engineer Bot (executor), a pedido de Rodrigo via sessão orquestrador-de-voz
- HEAD auditado: `6e88e5a` (= `origin/main`)
- Plano de referência: `docs/phase-15-v3.md`
- Escopo: nenhum arquivo rastreado foi editado, nada foi commitado nem enviado. Este arquivo está fora do controle de versão.

## Veredicto

**A F15 NÃO pode fechar.** As peças isoladas estão prontas e testadas: o coordenador, o orçamento, o token de confirmação, a ponte OpenClaw, o canal `RODRIGO_WEB_SEARCH` e a persistência assíncrona. Falta a integração da Fatia 4. O turno de voz real (`SessionManager.runTurn`) nunca delega a subagentes. Por isso, H15.1, H15.3 e H15.4 não são mensuráveis no app real. Além disso, o teste H15.2 aceita 50 execuções de mutação com token forjado, o que contradiz o próprio critério ("zero mutação sem token válido").

## Suíte

- `npm test` no HEAD, rodado agora: **737/740 passam e 3 falham**, todas em `fvScreen.test.js` (Fase V, HV.3, recebeu 409 quando esperava 400 e houve timeout de captura). Nenhuma das falhas é da F15. Ao rodar o arquivo sozinho, o resultado foi 73/74. Parece instabilidade de tempo sob carga, e `docs/phase-15-h15-recalibration.md:72` já trata isso como linha de base conhecida. O "740/740 verde" do handoff não se repetiu nesta execução.
- Todos os testes da F15 passam: 6 em H15, 6 em BudgetGate, 6 em OpenClaw, 4 em WebSearch, 7 em AsyncPersistence e 3 em `phase15.test.ts`.
- `npx tsc -p tsconfig.server.json --noEmit` passou sem erros, então a pré-condição da Fatia 2 (r2 N5) está atendida.

## Lacunas, da mais grave para a menos grave

### CRÍTICO

**C1. A Fatia 4 não está ligada ao turno de voz.**
- `runSubAgentDelegation` (`src/backend/voice/sessionManager.ts:320-412`) não é chamado em nenhum código de produção. Ele só aparece em `phase15.h15.test.ts` e `phase15BudgetGate.test.ts`.
- `runTurn` (`sessionManager.ts:601-1093`) não faz nenhuma referência a `this.coordinator`. As únicas referências estão nas linhas 340-398, 1109, 1135-1138 e 1236.
- Não existe decompositor de pedido em passos. Uma busca por `decompos|planSteps|multi-passo` em `src` não retorna nada. O plano exige isso em §1, item 1.
- `consumeOpenClawTaskResult` (`sessionManager.ts:1115`) também não tem chamador.
- Os subagentes OpenClaw são registrados na subida (`src/backend/voice/voiceRuntime.ts:135-136`), mas nenhuma fala consegue chegar até eles.
- Consequência: no app real, nenhum pedido de voz passa por orçamento, gatekeeper, ponte OpenClaw ou ExecutionTrace.

**C2. H15.2 aceita mutação com token forjado.**
- Em `src/backend/__tests__/phase15.h15.test.ts:212-242`, o caso 4 (`${turnId}:0:forged`) passa na checagem de prefixo de `ToolSubAgent` (`src/backend/agents/adapters.ts:73`) e **executa a ferramenta**. A asserção final é `executedCount <= 50`, ou seja, ela tolera 50 mutações não autorizadas.
- Conferi isto rodando agora contra `dist/`: com 50 tokens forjados, houve **50 execuções**.
- Dos 200 cenários, só 150 (casos 1 a 3) provam bloqueio. O critério H15.2 do plano (§8: "zero mutação executada sem `confirmationToken` válido") não está demonstrado.
- O plano (§2.1) aceita que a trava seja só "anti-esquecimento". Mesmo assim, a suíte não pode declarar zero quando o próprio código aceita 50. Correção possível: o adaptador compara o token com o valor emitido, ou H15.2 passa por `SessionManager` e exige `executedCount === 0`.

### ALTO

**A1. O caminho real de mutação passa por fora do gatekeeper.**
- Em `sessionManager.ts:749-757`, depois do SIM, o código emite o token (`recordMutationConfirmation`, l.751) e em seguida chama `tool.execute(...)` direto (l.757), sem passar por `ToolSubAgent` nem por `runSubAgentDelegation`.
- Nenhum `ToolSubAgent` é registrado em produção: `new ToolSubAgent` só aparece em testes.
- O token emitido nunca é usado. O plano §3, item 2 (`StateToolSubAgent` envolvendo Lembrete, Nota e Memória com a trava do §2.1) não está ligado.

**A2. H15.4 ("o que você fez?" com tarefas assíncronas pendentes) não é atendido.**
- `formatTraceSummary` (`src/backend/agents/subAgent.ts:176-191`) só lista tarefas `completed` e deixa as pendentes de fora.
- Não existe intenção nem roteamento para a pergunta "o que você fez": a busca em `src` não retorna nada.
- Em `runSubAgentDelegation`, um resultado `async_deferred` é gravado com `status: 'completed'` e sem o `asyncTaskId` (`sessionManager.ts:402-409`). O plano §4.3 pede `pending` com o `taskId`.
- O próprio teste admite a lacuna (`phase15.h15.test.ts:339-341`): monta o trace à mão e só confere se a tarefa pendente existe no objeto. A mensagem do commit `6e88e5a` ("fala inclui asyncTaskId de pendentes") não corresponde ao código.

**A3. A fala de estouro de orçamento é descartada em silêncio durante um turno ativo.**
- `speakBudgetExceeded` chama `speakOutOfTurn`, que retorna sem falar quando existe `session.activeTurn` (`sessionManager.ts:1252`). Uma delegação normalmente aconteceria dentro de um turno ativo, então a fala "nunca silenciosa" do §6 seria perdida.
- Nenhum teste passa `sessionId`/`sessionToken`. H15.5 e BudgetGate só verificam a string devolvida e o `onSpeech` (`phase15.h15.test.ts:370-383`, `phase15BudgetGate.test.ts:87-113`). O caminho de TTS não é testado.

**A4. H15.3 não mede o barge-in real e não verifica tarefas órfãs.**
- O teste (`phase15.h15.test.ts:249-300`) mede o listener de abort de um agente falso, com o abort disparado em 5 ms. Ele não passa por `cancelTurn` (`sessionManager.ts:1560-1580`) nem por `runSubAgentDelegation`.
- "Sem tarefas órfãs" não tem asserção.
- O cliente OpenClaw não tem operação de cancelamento (`src/backend/agents/openClawHttpClient.ts:11-14` só oferece `invokeShort`, `invokeLongAsync` e `pollStatus`). Uma tarefa já adiada continua rodando no gateway depois de um barge-in. Encerrar a sessão (`terminate`, l.454) só limpa os pollers locais.
- Detalhe menor: o índice do p95 (`latencies[Math.floor(50*0.95)-1]`, l.298) pega o 47º de 50 valores, o que na prática é cerca de p94.

### MÉDIO

**M1. H15.5 não tem 200 cenários distintos.**
- O teste (`phase15.h15.test.ts:351-402`) faz 200 tentativas em **um único turnId**: 6 execuções e 194 estouros, todos pelo motivo `max_calls`.
- Os estouros por `time` e `max_async` aparecem em 1 caso cada, só em `phase15BudgetGate.test.ts:124-167` e `:169-223`.
- O plano (§6) pede 200 "cadeias de delegação propositalmente longas".

**M2. H15.1 e H15.7 são sintéticos, e H15.7 é verdadeiro por construção.**
- Os 40 cenários existem (l.95). Contei a distribuição real do gerador (l.91-104): **19 com 2 passos, 8 com 3, 7 com 4 e 6 com 5, total de 120 passos**.
- Há um único agente falso que sempre dá certo (l.107-117). Não existe decompositor, e a "dependência do passo N−1" mencionada no comentário (l.92) não está implementada.
- A média de 3,0 de H15.7 (l.150-151) sai obrigatoriamente do teto de 120 passos imposto pelo gerador (l.94), então não mede nada.
- Faltam categorias: falha parcial no meio da cadeia, subagentes heterogêneos (especialista, ferramenta e OpenClaw), cenários com mutação, cenários assíncronos e estouro de tempo.

**M3. A delegação para especialistas não está integrada.**
- `SpecialistSubAgent.runTask` sempre devolve erro (`adapters.ts:35-39`), e nenhum `SpecialistSubAgent` é instanciado em produção.
- O desvio `.domain`/`.processQuery` foi corrigido, mas a execução real que o plano §3, item 1 pede não existe.

**M4. Uma tarefa assíncrona disparada via `runSubAgentDelegation` não é persistida nem acompanhada.**
- A persistência em `pendingAsyncStore` e o poller (`sessionManager.ts:1142-1154`) só existem em `consumeOpenClawTaskResult`, que não tem chamador.
- No caminho de delegação (l.383-400), o código só reserva o slot. Esse slot nunca é liberado, porque `releaseAsyncSlot` só é chamado ao limpar um poller (l.1236).

### BAIXO

- **B1.** O token pode ser reusado dentro do mesmo turno. Ele não é removido depois do uso e só é apagado em `terminate` (`sessionManager.ts:455`). Um único SIM autorizaria várias mutações no mesmo turnId.
- **B2.** `SubAgentCoordinator.traces` (`subAgent.ts:86`) cresce sem limite durante a vida do processo.
- **B3.** Não existe auditoria de código da F15 em `docs/audits/`. Só existem as auditorias de plano r1, r2 e r3. O handoff (`HANDOFF-2026-10-11-noite.md:77`) já previa essa etapa.

## Pergunta 1: critérios da Fatia 4 (§7) e evidência

| Critério da Fatia 4 | Estado | Evidência |
|---|---|---|
| Gatekeeper gera `confirmationToken` com frescor por `turnId` e nonce (r2 N4, r3 N6) | **Parcial** | Emissão: `sessionManager.ts:151-154` e `:305-309`, chamada no SIM em `:751`. Checagem: `adapters.ts:64-80` e `openClawSubAgent.ts:108-125`. Teste: `phase15BudgetGate.test.ts:225-320`. **Mas** a mutação real não passa pela checagem (A1), e só o prefixo é validado (C2). |
| Checar `webSearchEffective` antes de delegar leitura externa | **Feito no adaptador; não existe no SessionManager** | `openClawSubAgent.ts:100-106`, `privacy.ts:74-75` e `:122`. `/api/privacy` expõe o motivo (`privacy.ts:153-174`), testado em `privacy.test.ts:152-168`. Testes: `phase15WebSearch.test.ts` (4) e H15.6. Não há delegação a partir do turno (C1). |
| Contador de orçamento do turno (6 chamadas, 60 s, 2 assíncronas) | **Parcial** | `subAgent.ts:1-6` e `:117-174`, `sessionManager.ts:340-399`. Testes: BudgetGate (a, b, c). Não é chamado pelo turno (C1). A fala é descartada com turno ativo (A3). O slot assíncrono vaza (M4). |
| Barge-in ≤ 350 ms para delegações | **Falta** | `cancelTurn` (`sessionManager.ts:1560-1580`) aborta o controller do turno, mas nenhuma delegação recebe esse sinal (C1). A tarefa remota não é cancelada (A4). |
| Integração no `SessionManager` (decomposição e delegação no turno) | **Falta** | C1 |

## Pergunta 2: o gatekeeper e o orçamento cobrem todos os critérios?

**Não.**
- **§2.1 (presença, frescor e nonce):** coberto por unidade, ver acima.
- **"Só nasce depois do SIM real":** coberto, `sessionManager.ts:751`.
- **"Nenhum chamador consegue montar o token":** **não coberto**. O adaptador aceita qualquer string com o prefixo certo (C2).
- **Mutação real passando pela trava:** **não coberto** (A1).
- **`openclaw_drive` e `openclaw_social` tratados como mutação:** declarados com `requiresConfirmation: true` em `openClawCapabilities.ts:39-52`, mas com `wired: false`. Correto para o escopo atual.
- **§6, três tetos e registro no trace:** coberto por unidade.
- **"Fala honesta, nunca silêncio":** **parcial**, porque a fala é perdida durante um turno ativo (A3).
- **Timeout de 15 s da ponte:** coberto (`openClawSubAgent.ts:136-138`; `phase15OpenClaw.test.ts:69`).
- **H15.5:** parcial (M1).
- **H15.7:** tautológico (M2).
- **Recalibração (r2 N3):** o procedimento existe em `docs/phase-15-h15-recalibration.md`, mas nenhuma recalibração medida foi registrada. É coerente, já que os dados são sintéticos.

## Pergunta 3: contagem real de cenários da suíte H15

Não há fixtures da H15 (`src/backend/__tests__/fixtures/` tem só F14, F16 e outros). Todos os cenários são gerados por laços em `phase15.h15.test.ts`.

| Critério | Pedido no plano | Contado no código | Observação |
|---|---|---|---|
| H15.1, multi-passo | 40 | **40** (l.95), 120 passos | Sintético (M2) |
| H15.2, segurança | 200 | **200 chamadas** (50 turnIds × 4, l.177-231) | **150** provam bloqueio; **50** executam (C2) |
| H15.3, barge-in | p95, sem órfãs | **50** iterações (l.250) | Agente falso, órfãs não verificadas (A4) |
| H15.4, rastreabilidade | voz com pendentes | **1** caso (l.306) | Pendentes ficam fora da fala (A2) |
| H15.5, orçamento | 200 | **200 tentativas em 1 turnId** (l.369) | 194 estouros, todos `max_calls` (M1) |
| H15.6, web desligada | 50 | **50** (l.417) | OK, só no nível do adaptador |
| H15.7, média ≤ 3 | sobre H15.1 | reaproveita os 40 de H15.1 (l.150) | Garantido por construção (M2) |

Somando os critérios de segurança e orçamento (H15.2 + H15.5) dá 400 chamadas, mas os cenários adversariais distintos são poucos: 4 padrões em H15.2 e 1 padrão em H15.5.

**Categorias que faltam:**
- Mutação via `SessionManager` com token emitido para outra mutação do mesmo turno (B1).
- Token forjado com o prefixo certo, exigindo zero execuções.
- Mutação via `OpenClawSubAgent` com `requiresConfirmation`.
- Estouro por tempo e por `max_async` em escala.
- Estouro com sessão e turno ativos, verificando o TTS.
- Barge-in via `cancelTurn` durante uma delegação.
- Tarefa assíncrona órfã depois de barge-in ou de reinício.
- "O que você fez?" com tarefa assíncrona pendente.

## Pergunta 4: outros itens do plano não implementados

- **§1, item 1, decomposição do pedido:** não existe (C1).
- **§3, item 1, especialistas como subagentes:** não integrado (M3).
- **§3, item 2, `StateToolSubAgent`:** a classe genérica `ToolSubAgent` existe, mas não é registrada em produção (A1).
- **§4.3, progresso, poller e persistência ao receber `async_deferred` no fluxo do turno:** só existe no método órfão `consumeOpenClawTaskResult` (M4).
- **Itens do §4.3 que estão OK:** teto de 10 min (`sessionManager.ts:131`), intervalo de 7 s (`:130`), recuperação na subida com TTL configurável e fala datada (`pendingAsyncRecovery.ts`, `phase15AsyncPersistence.test.ts`, 7 testes).

## Itens que estão OK (para não reabrir)

- Contrato `ISubAgent`, `kind`/`asyncTaskId` estrutural (`subAgent.ts:10-47`).
- Ponte HTTP (D15 Opção A), timeout de 15 s com fallback assíncrono, falha honesta sem sucesso falso (`openClawSubAgent.ts:127-185`; `phase15OpenClaw.test.ts`).
- Escopo por capacidade (`openClawCapabilities.ts`).
- Canal `RODRIGO_WEB_SEARCH` e `/api/privacy`.
- Persistência atômica e recuperação na subida.
- `tsc` sem erros.

## Ordem sugerida para fechar

1. **C1:** ligar o turno de voz ao coordenador, com um decompositor mínimo, o sinal do turno passado à delegação e `async_deferred` encaminhado para `consumeOpenClawTaskResult` ou equivalente.
2. **A1:** fazer a mutação confirmada passar por `ToolSubAgent` via `runSubAgentDelegation` e consumir o token depois do uso (B1).
3. **C2:** endurecer H15.2 para exigir `executedCount === 0`, validando o token contra o valor emitido.
4. **A3:** enfileirar a fala de estouro para depois do turno, ou falar dentro do próprio turno, e testar com sessão real.
5. **A2:** incluir pendentes e `asyncTaskId` no resumo, e criar a rota "o que você fez?".
6. **A4, M1 e M2:** refazer H15.1, H15.3 e H15.5 sobre o caminho integrado. Depois, pedir a auditoria de código formal (B3).
