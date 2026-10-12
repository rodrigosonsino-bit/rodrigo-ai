# F15 Fatia 4: plano de integração (antes do código)

- Autor: Lingxi's Engineer Bot, a pedido do Rodrigo, 2026-10-11 ~23:10 BRT. Substitui a versão anterior deste arquivo, que estava ilegível.
- Base: HEAD `3feccb8`, branch `main`. Os números de linha foram conferidos no código atual.
- Entradas: `docs/phase-15-v3.md` §2.1, §6, §7 e §8; `docs/audits/f15-fechamento-lingxi-engineer-bot.md` (C1, C2, A1, A2, A3, A4 e B1); `docs/orquestracao/ESTADO.md`; `docs/roadmap-2026-10-09.md:31`.
- Estado: **proposta**. Nenhum código foi escrito. Precisa da aprovação do Rodrigo antes de começar.

## 0. Definição (§7) e o que este plano entrega

Fatia 4 (`phase-15-v3.md:371-373`): integração no `SessionManager`, com gatekeeper que gera o `confirmationToken` com frescor, `webSearchEffective` antes da leitura externa, orçamento por turno e barge-in em até 350 ms.

Este plano entrega o **menor corte honesto**:
- Todo caminho de ferramenta que já existe no `runTurn` passa a ir pelo coordenador, com orçamento, trace, gatekeeper e o sinal do turno.
- Toda mutação passa a exigir o token **emitido**, comparado pelo valor exato, e não só pelo prefixo.
- A fala de estouro deixa de se perder durante o turno.
- "O que você fez?" responde a partir do trace, incluindo as tarefas pendentes com seu id.

Ficam fora, para decisão separada: o decompositor multi-passo e uma rota de voz até o OpenClaw (ver §5).

## 1. Subtrair primeiro: o que reaproveitar, o que não criar

Reaproveitar sem mudança de contrato:
- `SubAgentCoordinator`: `beginDelegation`, trace e slots assíncronos (`subAgent.ts:84-174`).
- `runSubAgentDelegation` (`sessionManager.ts:320-412`), que já faz orçamento, busca do token e trace. É **ele** o ponto de entrada no `runTurn`.
- Emissão do token: `mintMutationConfirmationToken` (`:151-154`), `recordMutationConfirmation` (`:305-309`) e o mapa `confirmedMutationTokens` (`:261`).
- `ToolSubAgent` (`adapters.ts:43-106`). Ele já chama `execute(action, prompt)` com `context.action` (`:87-89`), que é o mesmo formato do `tool.execute(mutation.kind, mutation.content)` de `sessionManager.ts:757`.
- O `AbortController` do turno (`ActiveTurn.abortController`, `:159`), que `cancelTurn` já aborta (`:1575`).
- O helper `formatBudgetExceededSpeech` (`subAgent.ts:71-82`).

Não criar:
- Nenhum módulo novo e nenhum tipo novo.
- Nenhuma fila de falas: a fala de estouro é dita dentro do próprio turno, ver §2.4.
- Nenhum `StateToolSubAgent` separado (§3, item 2 do plano). O `ToolSubAgent` com verificador já cobre Lembrete, Nota e Memória.
- Nenhuma chamada ao `SpecialistSubAgent`: ele continua devolvendo erro (`adapters.ts:35-39`) e não é registrado.

Remover:
- O comentário e a asserção `executedCount <= 50` de H15.2 (`phase15.h15.test.ts:223-242`).
- O comentário que justifica a lacuna em H15.4 (`:339-341`).

## 2. Menor diff (estimativa: cerca de 90 linhas de produção a mais e 25 a menos)

**2.1 Comparar com o token emitido (C2 e B1).** Arquivos: `adapters.ts` e `openClawSubAgent.ts`, cerca de 20 linhas.
- `ToolSubAgent` ganha um 2º parâmetro opcional no construtor: `verifyMutationToken?: (turnId, token) => boolean`.
- Ordem das checagens: presença (`:65`), depois prefixo (`:73`, mantido, porque a mensagem é usada em testes), depois `verifyMutationToken?.(turnId, token) === true`.
- **Sem verificador, a mutação fica bloqueada** (fail-closed), com a mensagem `Mutação bloqueada: confirmationToken não emitido pelo gatekeeper`.
- O mesmo vale para `OpenClawSubAgent`, pelo campo `opts` (`openClawSubAgent.ts:37-41`) e pela checagem em `:108-125`. Hoje nenhuma capacidade mutante do OpenClaw está ligada (`openClawCapabilities.ts:39-52`, `wired: false`), então o fail-closed não muda nada em produção.

**2.2 Gatekeeper no `SessionManager`.** Arquivo: `sessionManager.ts`, cerca de 15 linhas.
- Novo método `consumeMutationToken(turnId, token): boolean`. Ele devolve `true` só se `confirmedMutationTokens.get(turnId) === token`, e então apaga o token. Assim o token vale **uma vez** (B1).
- No construtor (depois de `:297`), registrar `new ToolSubAgent(t, (a, b) => this.consumeMutationToken(a, b))` para cada item de `this.tools` e `this.mutatingTools`. Isso dá os ids `tool_hora`, `tool_data`, `tool_lembrete`, `tool_nota` e `tool_memoria`, sem colisão com os ids `openclaw_*`.
- `voiceRuntime.ts:134-151` não muda.

**2.3 Pontos de chamada no `runTurn`.** Arquivo: `sessionManager.ts`, cerca de 35 linhas a mais e 20 a menos.
- Um helper privado, `delegateToolInTurn(session, turn, transcript, tool, action, content, isMutation)`, que devolve `{ text, budgetSpeech? }`.
- Ele chama `runSubAgentDelegation` com `subAgentId: tool_${tool.name.toLowerCase()}`, `prompt: content ?? ''`, `context: { action }` e `signal: turn.abortController.signal`. **Não** passa `sessionId`/`sessionToken`, para que `speakBudgetExceeded` (`:414-423`) não seja chamado no meio do turno.
- Ele é justificado por substituir três chamadas diretas a `execute`:
  1. SIM: `:751-762`. Em `:751`, guardar o token emitido e trocar `tool.execute(...)` por `delegateToolInTurn(..., isMutation: true)`. Em caso de falha, o texto continua `MUTATION_FAILURE_TEXT`.
  2. `*_CONSULTAR`: `:838-844`, com `isMutation: false`. Em caso de falha, `MUTATION_FAILURE_TEXT`, como hoje.
  3. HORA/DATA: `:919-926`, com `isMutation: false`. Em caso de falha, `TOOL_FAILURE_TEXT`.
- Os `console.error` atuais continuam, agora lendo `result.error`.
- Ponto de atenção: hoje o `execute` recebe `content` como `null`, e o `ToolSubAgent` passa `req.prompt` como string (`adapters.ts:89`). Tratar `''` de volta como `null` no próprio `ToolSubAgent` (1 linha), para não mudar o comportamento das ferramentas (`shared/extensions/tools.ts:23`).

**2.4 Fala de estouro dentro do turno (A3).** Sem arquivo novo.
- Quando `delegateToolInTurn` recebe `budgetExceeded`, o `runTurn` fala `r.speech` pelo mesmo `synthesizeSentence` do turno, no lugar do texto da ferramenta.
- `speakOutOfTurn` (`:1249-1252`) **não muda**. Ele continua servindo as falas realmente fora do turno, como o poller e a recuperação.

**2.5 Trace com pendentes e a pergunta "o que você fez?" (A2).** Arquivos: `subAgent.ts` (cerca de 15 linhas) e `sessionManager.ts` (cerca de 20 linhas).
- `TaskTraceItem` ganha `asyncTaskId?: string`. É o único campo novo, e espelha `SubAgentTaskResult.asyncTaskId` (`subAgent.ts:35`).
- Em `runSubAgentDelegation` (`:402-409`), quando o resultado é `async_deferred`, gravar `status: 'pending'` e o `asyncTaskId`, como pede o §4.3.
- `formatTraceSummary` (`subAgent.ts:176-191`) acrescenta: "Ainda em andamento: <prompt> (tarefa <asyncTaskId>)".
- `SubAgentCoordinator.latestTraceWithTasks()`, cerca de 6 linhas: devolve o último trace com tarefas, pela ordem de inserção do `Map`.
- No `runTurn`, logo depois do bloco de `pendingMutation` (`:788`), um detector determinístico de "o que você fez". Ele **só responde** se `latestTraceWithTasks()` existir. Se não existir, o turno segue o caminho normal (ver o risco R1).

**2.6 Barge-in.** O sinal do turno já chega à delegação pela §2.3. As ferramentas locais são síncronas, então não há cancelamento para medir nelas. O cancelamento remoto fica fora do escopo (§5).

## 3. Testes que falham primeiro, nesta ordem e sem enfraquecer nada

Os testes seguem os padrões existentes: `makeSessionManager` e `SilentTts` (`phase15BudgetGate.test.ts:23-58`) e o harness HTTP com SSE (`voice.test.ts:75-107`, com o fluxo do SIM em `:1318-1373`).

1. **H15.2, token forjado** (`phase15.h15.test.ts:212-242`):
   - O caso 4 passa a exigir `r4.success === false` e `/Mutação bloqueada/`.
   - No fim, `assert.equal(executedCount, 0)`.
   - Novo bloco com o `SessionManager`: `recordMutationConfirmation(turnId)` emite o token verdadeiro, e um token forjado com o prefixo certo continua bloqueado, mesmo assim. O token verdadeiro executa uma vez, e reusá-lo bloqueia (B1).
   - Deve falhar hoje: 50 execuções.
2. **`runTurn` usa o coordenador**, no `voice.test.ts`, pelo fluxo HORA (`setupHarness` com `createSystemTools`): depois do turno, `h.sessionManager.coordinator.getTrace(turnId)` tem 1 tarefa `tool_hora` com status `completed`. Deve falhar hoje: não existe trace.
3. **Mutação depois do SIM passa pelo gatekeeper.** É o mesmo fluxo de `voice.test.ts:1318-1373`:
   - O trace do turno do SIM tem `tool_lembrete` com `isMutation: true`.
   - O token desse turno foi consumido: `peekMutationConfirmationToken(turnId) === undefined`.
   - A fala continua `Lembrete criado.`.
4. **Fala de estouro com o turno ativo.** No fluxo do SIM, ocupar os 2 slots assíncronos e registrar, com o id `tool_lembrete`, um agente falso que devolve `async_deferred`. O TTS do turno deve dizer `/Não consegui terminar/`. Deve falhar hoje: a fala é perdida (`:1252`).
5. **H15.4** (substitui `phase15.h15.test.ts:306-345`):
   - Via `runSubAgentDelegation`, rodar 2 tarefas concluídas e 1 `async_deferred` com o id `async-42`.
   - O trace tem a tarefa `pending` com o `asyncTaskId`.
   - A fala contém `async-42`.
   - Pelo harness, "o que você fez?" depois de uma delegação responde com esse resumo.
   - Deve falhar hoje: a tarefa assíncrona é gravada como `completed`, sem id.

Ajuste necessário, sem afrouxar nada: `phase15BudgetGate.test.ts:233-236` passa a construir o `ToolSubAgent` com o verificador do `sm`. As asserções de `:253-282` ficam idênticas. O `F11 D.claim`/`D.24` (`f11Scenarios.test.ts:2114-2167`) tem que continuar verde sem nenhuma mudança.

## 4. Commits na branch `f15-fatia4-integracao`

Cada commit deixa `tsc` e `npm test` verdes. Teste e código vão no mesmo commit, e cada commit reproduz primeiro a falha no seu teste.

1. `F15 F4.1: token comparado com o emitido, uso único (C2, B1)`: §2.1, §2.2 e os testes 1 e o ajuste do BudgetGate.
2. `F15 F4.2: runTurn delega ferramentas pelo coordenador (C1 parcial)`: §2.3 para HORA/DATA e `*_CONSULTAR`, com o teste 2.
3. `F15 F4.3: mutação pós-SIM passa pelo gatekeeper (A1)`: §2.3 para o SIM, com o teste 3.
4. `F15 F4.4: fala de estouro dentro do turno (A3)`: §2.4, com o teste 4.
5. `F15 F4.5: trace com pendentes e "o que você fez?" (A2)`: §2.5, com o teste 5.

Nada de push nem merge sem aprovação do Rodrigo. Atualizar o `ESTADO.md` ao fim de cada commit.

## 5. Fora do escopo (sinalizado)

- **Fase V Fatia 5:** é a próxima prioridade (`ESTADO.md`), não entra aqui.
- **H15.3 com cancelamento real:** o `OpenClawHttpClient` não tem operação de cancelamento (`openClawHttpClient.ts:11-15`). Medir o barge-in "sem órfãs" contra o OpenClaw **depende de uma API de cancelamento no gateway**, que ainda não existe. Isso fica para uma fatia própria. O ajuste do p95 (`phase15.h15.test.ts:298`) pode entrar junto.
- **Decompositor multi-passo (§1, item 1) e rota de voz até o OpenClaw ou os especialistas:** nenhuma intenção leva a eles hoje (`voiceProtocol.ts:167`, `IntentName = MutationName | ToolName`). Criá-los é **peça nova**, que exige decisão, e não cabe no menor diff. Sem isso, H15.1 e H15.7 continuam sintéticos (auditoria M2).
- **M4:** ligar `consumeOpenClawTaskResult` (`:1115`) e o poller a partir do turno, e mudar a tarefa de `pending` para `completed` quando ela conclui. Isso só faz sentido depois da rota até o OpenClaw.
- **M1, M2 e B2** (trace sem limite): ficam para a auditoria de código formal (B3).

## 6. Riscos e perguntas para o Rodrigo

- **R1.** O detector de "o que você fez?" pode capturar falas que hoje vão para o LLM. Mitigação: ele só responde quando já existe um trace com tarefas, e a suíte F11 (`f11Scenarios.test.ts:2123` e `:2151`) tem que continuar sem mudança.
- **R2.** Com o fail-closed sem verificador, qualquer `ToolSubAgent`/`OpenClawSubAgent` mutante construído fora do `SessionManager` passa a ser bloqueado. Isso é intencional.
- **R3.** O `coordinator` é do processo, não da sessão. Por isso "o que você fez?" pode citar o trace de uma sessão anterior. Aceitável agora?
- **P1.** A Fatia 4 fecha com este corte (ferramentas existentes pelo coordenador), e o decompositor e a rota até o OpenClaw viram uma "Fatia 4b" com plano próprio? Ou precisam entrar já?
- **P2.** Para H15.3 real: abrimos uma tarefa no OpenClaw para expor o cancelamento, ou aceitamos "cancelamento local apenas" e registramos isso como limitação?
