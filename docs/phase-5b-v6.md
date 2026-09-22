# Fase 5b — Ferramentas de leitura (`ITool`) — v6 (híbrida, pseudocódigo completo)

Versão: v6
Data: 2026-09-22
Base: commit `612140d`
Antecessores: v1 (REJEITADO, 24 achados), v2 (REJEITADO, ~12), v3 (REJEITADO, 8), v4 (REJEITADO, 9),
v5 (REJEITADO, 2 ALTA + 4 média/baixa — ver §1).

---

## 0. Protocolo de congelamento — inalterado, e ainda respeitado

A amostra de validação de H11 já foi selada em `docs/audits/phase-5b-v5-h11-sample-2026-09-22.md`
(commit `612140d`), **antes** desta versão existir. `DETECT_TOOL_SYSTEM_PROMPT` (§4.9, herdado da
v5 sem nenhuma mudança) continua exatamente como estava quando a amostra foi congelada — nenhum
achado da rodada 5 tocou o conteúdo do prompt. Isso importa registrar explicitamente: se algum
achado futuro pedisse mudança no prompt, o protocolo exigiria decidir se isso invalida a amostra já
selada antes de agir. Não é o caso aqui.

---

## 1. A quinta rejeição, e os achados que esta versão corrige

Disparada a pedido do usuário com o Hermes CLI (`docker exec hermes hermes -z`, modelo
`longcat-2.0:free`), rodando contra o código-fonte real do repositório (não só lendo o plano) —
workspace preparado em `~/hermes-workspace/phase-5b-v5-audit-2026-09-22/` com o plano, o código
atual e os logs das rodadas 2–4 para referência, e **sem** a amostra de H11, com instrução explícita
para o auditor não tentar reproduzi-la. Log completo em
`docs/audits/phase-5b-v6-hermes-2026-09-22.log`.

**Parte A da auditoria — os nove achados da rodada 4 foram checados de novo, por execução real, e
confirmados corrigidos.** O auditor extraiu e rodou de verdade o `TIME_GATE` (§4.1), o
`parse_tool_output` (§4.9) e o `HoraAtualTool.execute()` (§4.7) contra casos de teste próprios
(não os do plano) — todos passaram, incluindo os casos de borda 00:00, 00:01 e 23:59 que nenhuma
versão anterior tinha verificado. Não houve achado novo nessa parte.

**Parte B — auditoria adversarial normal sobre o texto inteiro da v5, à procura do que a correção
dos nove achados pode ter deixado passar.** Encontrou 2 achados ALTA e 4 média/baixa — todos sobre
**lacunas de pseudocódigo** (a decisão estava certa, mas o trecho de código que a implementa não
foi mostrado, ou foi mostrado incompleto), nunca sobre uma decisão de desenho errada:

| # | Achado | Gravidade | Resolvido em |
|---|---|---|---|
| 1 | `stdin_reader_loop()` do worker (`scripts/worker/worker.py:460`) só aceita `("transcribe", "classify", "generate")` no gate que enfileira comandos para `work_loop()`; a v5 mostrava `handle_detect_tool()` e o despacho dentro de `work_loop()`, mas não atualizava esse gate anterior — `detect_tool` cairia no `else` de "comando desconhecido" (`worker.py:472`) e nunca chegaria ao handler | ALTA | §6.2 |
| 2 | `cancel()` do `FakeVoiceEngine` não limpa `detectToolGates` — a v5 (§6.8) tinha um comentário dizendo que isso precisava acontecer, mas nunca mostrou o código; sem ele, H8 verificaria `isDetectToolPending(turnId)` como `true` depois de um cancelamento, porque o gate só é liberado por `releaseDetectToolGate()` ou pelo timer | ALTA | §6.8 |
| 3 | `getModuleStatuses()` em `registry.ts` (`registry.ts:100-105`, módulo `tools` com `available: false` fixo hoje) não tinha pseudocódigo na v5 — só uma frase em §5 dizendo que mudaria | MÉDIA | §6.9 (nova) |
| 4 | Interface `VoiceEngine` (`engine.ts:13-37`) não tinha pseudocódigo para o novo método `detectTool()` — só uma frase em §5 | MÉDIA | §6.10 (nova) |
| 5 | `failAllPending()` já aparecia corrigido em §6.4 da v5, mas o texto não deixava claro que era uma mudança em relação ao código atual (que não trata `detect_tool`) — risco de leitura apressada | BAIXA | §6.4 (nota adicionada) |
| 6 | `handle_detect_tool()` não documentava, como decisão deliberada, que segue exatamente o padrão de `handle_classify()` em dois pontos não óbvios: não checa `cancel_event` antes de iniciar a geração (só dentro do loop), e não emite evento `cancelled` (o Node já resolve localmente) | BAIXA | §6.2 (nota adicionada) |

Nenhum achado atacou §4 (Decisões) — a rodada 5 não encontrou nenhum problema de desenho, só de
completude de pseudocódigo. §4 desta versão é **idêntica à v5**, não repetida abaixo além de
referência.

### As quatro rejeições anteriores, em uma frase cada

v1: classificador ganhava rótulo+ferramenta, regressão no componente validado. v2: modelo detectava
e o próprio modelo respondia — obediência probabilística do mesmo 4B que já alucina a hora. v3:
regex de enunciado inteiro tinha cobertura de 3% em fala real. v4: híbrido certo no desenho, mas com
vazamento de dado de teste no prompt e um timeout que matava o worker que o próprio fallback
precisava usar em seguida. Tabela completa de achados de cada rodada nos respectivos documentos
(`docs/phase-5b-v1.md` a `v5.md` e `docs/audits/`).

---

## 2. Premissa medida

Inalterado — servidor real (MLX, `Qwen3-4B-Instruct-2507-4bit`), áudio sintetizado, 2026-09-21:

```
hora real do sistema: 10:54 de Monday, 21 de September de 2026
"Que horas são agora?"  -> GERAL -> "Agora são seis e meia."
"Que dia é hoje?"       -> GERAL -> "Hoje é quinta-feira, 21 de abril."
```

**Pronto** exige: as duas corretas com áudio real; cobertura medida contra amostra que eu não
escolhi (§7, H11); turno sem ferramenta byte a byte idêntico à Fase 5a; nenhum falso positivo;
latência dentro das metas; suíte sem regressão.

---

## 3. Escopo

Inalterado da v5.

**Dentro:** `ITool` com `execute()`; `HoraAtualTool` e `DataAtualTool`; filtro permissivo em Node;
comando `detect_tool` no worker; resposta determinística sintetizada direto; `registerTool()`.

**Fora:** ações que mutam estado (Fase 5c); ferramentas com argumento; alteração do classificador;
rede/nuvem/API paga; conversão de numeral para extenso na fala (ver §8).

---

## 4. Decisões

**Idêntico à v5 — nenhum achado da rodada 5 atacou uma decisão de desenho.** As nove subseções
(4.1–4.9: filtro permissivo com "século", `detect_tool` no `pending`, falha de execução fechada,
falha de detecção sem matar o worker, reuso do encerramento, classificador pulado sem recuo em
runtime, `HoraAtualTool` com concordância corrigida, `VOICE_LIMITS`/`error` corrigidos,
`DETECT_TOOL_SYSTEM_PROMPT` limpo) permanecem exatamente como em `docs/phase-5b-v5.md` §4 — não
repetidas aqui para não duplicar 300 linhas inalteradas. Toda referência a "§4.x" no resto deste
documento aponta para a v5.

---

## 5. Arquivos afetados

Mesma lista da v5, com duas entradas agora **com pseudocódigo mostrado** (achados 3 e 4 da rodada
5 — antes só descritas em prosa):

**Novos:** `src/backend/tools/systemTools.ts`, `src/backend/tools/index.ts`,
`src/backend/__tests__/tools.test.ts`, `scripts/worker/test_tool_parser.py` (standalone, mesmo
padrão de `scripts/worker/test_repetition_detector.py` — não entra em `package.json`).

**Modificados:**
- `src/shared/extensions/tools.ts` — `execute(): string`.
- `src/shared/extensions/registry.ts` — `registerTool()` idempotente por `name`; **`getModuleStatuses()`
  atualizado com pseudocódigo completo em §6.9** (achado 3 da rodada 5 — a v5 só descrevia isso em
  prosa).
- `src/shared/voiceProtocol.ts` — `TOOL_NAMES`, `ToolName`, `isToolName()`, `DETECT_TOOL_TIMEOUT_MS`
  em `VOICE_LIMITS`.
- `scripts/worker/worker.py` — `TOOL_NAMES`, `DETECT_TOOL_SYSTEM_PROMPT`, `parse_tool_output()`,
  `handle_detect_tool()`, **e o gate de `stdin_reader_loop()` que decide o que entra na fila de
  trabalho** (achado 1 da rodada 5, ALTA — ausente na v5). O classificador não é tocado.
- `src/backend/voice/engine.ts` — **`detectTool()` na interface `VoiceEngine`, pseudocódigo
  completo em §6.10** (achado 4 da rodada 5 — a v5 só descrevia isso em prosa).
- `src/backend/voice/mlxWorkerEngine.ts` — `kind: 'detect_tool'` no `pending`; timeout sem
  `SIGKILL`; `detect_tool` incluído na limpeza de timer em `event === 'error'` e em
  `failAllPending`; rejeição em `cancel()`.
- `src/backend/voice/fakeEngine.ts` — `detectTool()` + `toolToReturn` + `detectToolCalls` +
  mecanismo de barreira completo, **e `cancel()` atualizado para limpar `detectToolGates`,
  com pseudocódigo mostrado** (achado 2 da rodada 5, ALTA — a v5 só tinha um comentário dizendo que
  isso precisava acontecer, sem o código).
- `src/backend/voice/sessionManager.ts` — filtro, chamada condicional, caminho determinístico.
- `src/backend/voice/voiceRuntime.ts` — cria, registra e passa as ferramentas.
- `src/backend/__tests__/extensions.test.ts`, `voice.test.ts`.

`package.json` continua fora desta lista (v5, achado 8 da rodada 4).

---

## 6. Pseudocódigo completo

Seções 6.1, 6.3, 6.5, 6.6, 6.7 são **idênticas à v5** — reproduzidas por referência, não copiadas
de novo. As seções 6.2, 6.4 e 6.8 ganharam correção ou reforço; 6.9 e 6.10 são novas.

### 6.1 `voiceProtocol.ts` — inalterado, ver `docs/phase-5b-v5.md` §6.1

### 6.2 `worker.py` — **corrigido o despacho (Achado 1 da rodada 5, ALTA)**, com notas de paridade

`handle_detect_tool()` continua idêntico ao mostrado na v5 §6.2 (espelha `handle_classify()`,
`worker.py:252-312`) — não repetido aqui. O que faltava, e o que a v5 tinha errado, é o **ponto de
entrada anterior**: o worker tem duas etapas de despacho, não uma.

```
stdin_reader_loop() (worker.py:444-476, thread dedicada, lê stdin)
  └─ decide o que ENFILEIRA em work_queue        <- a v5 não tocou aqui; é o bug
       │
       ▼
work_loop() (worker.py:427-440, thread principal)
  └─ decide o que EXECUTA, a partir da fila       <- a v5 mostrou o handler aqui, corretamente
```

A v5 mostrou corretamente o acréscimo dentro de `work_loop()` (`elif cmd == "detect_tool":
self.handle_detect_tool(msg)`), mas a frase "despacho, nos dois pontos onde `classify` aparece
hoje" citava só essa etapa. `stdin_reader_loop()` tem seu **próprio** gate, uma linha antes de
colocar a mensagem na fila:

```python
# scripts/worker/worker.py:460, ANTES (código atual — não aceita detect_tool):
elif cmd in ("transcribe", "classify", "generate"):
    ...

# DEPOIS (v6 — detect_tool precisa entrar nesta tupla, ou nunca chega à fila):
elif cmd in ("transcribe", "classify", "generate", "detect_tool"):
    ...
```

Sem essa linha, uma mensagem `{"cmd": "detect_tool", ...}` chega ao worker, é lida, cai no `else`
de `stdin_reader_loop()` (`worker.py:472`, `log_diag(f"Comando desconhecido ignorado: {cmd!r}")`) e
é descartada em silêncio — o `handle_detect_tool()` da v5, corretíssimo, nunca seria chamado. Este é
o achado 1 (ALTA) da rodada 5, confirmado por leitura do código atual (`worker.py:444-472`).

**Duas decisões de paridade com `handle_classify()`, documentadas por não serem óbvias (achado 6 da
rodada 5, BAIXA):**

1. `handle_detect_tool()` verifica `handle.cancel_event.is_set()` **dentro** do loop de
   `stream_generate` (como no pseudocódigo da v5), não antes de iniciar a geração. Isso é o mesmo
   padrão de `handle_classify()` — se o cancelamento chegar entre o comando ser lido e a geração
   começar, o worker ainda inicia a geração, e o resultado é descartado porque o Node já resolveu
   localmente. É desperdício de um ciclo de inferência no pior caso, não um bug — decisão herdada,
   não nova.
2. `handle_detect_tool()` não emite um evento `cancelled` quando `cancel_event` interrompe o loop —
   de novo, o mesmo padrão de `handle_classify()`. O Node nunca espera essa confirmação (`cancel()`
   em `mlxWorkerEngine.ts` resolve/rejeita localmente, sem esperar o worker), então o evento seria
   cosmético.

### 6.3 `systemTools.ts` — inalterado, ver `docs/phase-5b-v5.md` §6.3

### 6.4 `mlxWorkerEngine.ts` — inalterado em conteúdo; nota de clareza adicionada (Achado 5, BAIXA)

Todo o pseudocódigo é idêntico ao da v5 §6.4 (`PendingDetectTool`, `failAllPending()`,
`handleLine()`, `detectTool()`, `cancel()`) — não repetido aqui. Único acréscimo: uma nota explícita
de que **cada um** desses quatro trechos é uma **modificação** do código atual, não uma descrição de
como o código já está. Em particular, `failAllPending()` hoje (`mlxWorkerEngine.ts:129-140`) não
tem `detect_tool` na cláusula de `clearTimeout` — o bloco mostrado na v5 §6.4 já é a versão corrigida,
a ser aplicada por cima do que existe, não uma citação do estado atual.

### 6.5 `HoraAtualTool.execute()` — inalterado, ver `docs/phase-5b-v5.md` §4.7 e §6.5

### 6.6 `sessionManager.ts` — inalterado, ver `docs/phase-5b-v5.md` §6.6

### 6.7 `voiceRuntime.ts` — inalterado, ver `docs/phase-5b-v5.md` §6.7

### 6.8 `fakeEngine.ts` — **`cancel()` agora com pseudocódigo completo (Achado 2 da rodada 5, ALTA)**

A parte nova de `FakeVoiceEngine` (interface `DetectToolGate`, campos, `detectTool()`,
`releaseDetectToolGate()`, `isDetectToolPending()`) é idêntica à v5 §6.8 — não repetida. O que
faltava era o código de `cancel()`, que a v5 só descrevia em comentário
("`cancel(turnId)` ganha o mesmo bloco de limpeza que já existe para `classifyGates`, repetido
para `detectToolGates`") sem mostrar. Achado 2 (ALTA) apontou exatamente isso: sem o código, a
implementação literal do plano deixaria `detectToolGates` sem limpeza em `cancel()`, e H8
verificaria `isDetectToolPending(turnId)` como `true` depois de um cancelamento — o próprio teste
que a v5 prometia fazer passar.

```ts
cancel(turnId: string): void {
  this.cancelledSet.add(turnId);
  this.cancelledTurnIds.push(turnId);

  // Bloco já existente (fakeEngine.ts:107-114), para classifyGates — inalterado:
  const classifyGate = this.classifyGates.get(turnId);
  if (classifyGate) {
    if (classifyGate.timer) clearTimeout(classifyGate.timer);
    this.classifyGates.delete(turnId);
    classifyGate.resolve();
  }

  // Achado 2 (ALTA) da rodada 5 — o mesmo bloco, repetido para detectToolGates. Sem isto,
  // isDetectToolPending(turnId) continua true depois de cancel(), e H8 falha.
  const detectToolGate = this.detectToolGates.get(turnId);
  if (detectToolGate) {
    if (detectToolGate.timer) clearTimeout(detectToolGate.timer);
    this.detectToolGates.delete(turnId);
    detectToolGate.resolve();
  }
}
```

### 6.9 `registry.ts` — `getModuleStatuses()` (Achado 3 da rodada 5, MÉDIA — ausente na v5)

Código atual (`registry.ts:99-105`) tem o módulo `tools` com `available` fixo em `false`:

```ts
// ANTES (código atual):
{
  id: 'tools',
  name: 'Ferramentas do Sistema',
  phase: 5,
  available: false,
  description: 'Integrações e ferramentas operacionais não habilitadas nesta fase (previsto para Fase 5).'
}
```

```ts
// DEPOIS (v6) — mesmo padrão dos módulos voice/agents, que já derivam available do array real:
{
  id: 'tools',
  name: 'Ferramentas do Sistema',
  phase: 5,
  available: this.tools.length > 0,
  description:
    this.tools.length > 0
      ? `${this.tools.length} ferramentas ativas: ${this.tools.map((t) => t.name).join(', ')}.`
      : 'Nenhuma ferramenta conectada — depende do runtime de voz (rode "npm run setup:voice").'
}
```

`getTools()` (`registry.ts:53-55`) e `registerTool()` (§6 da v5, idempotente por `name`, mesmo
padrão de `registerAgent()`) não mudam além do já especificado na v5.

### 6.10 `engine.ts` — `detectTool()` na interface `VoiceEngine` (Achado 4 da rodada 5, MÉDIA — ausente na v5)

```ts
export interface VoiceEngine {
  isReadySync(): boolean;
  waitUntilReady(timeoutMs: number): Promise<void>;
  transcribe(audioPath: string): Promise<string>;
  classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel>;
  /**
   * Fase 5b: decide se o texto pede uma ferramenta do sistema (HORA/DATA) ou nenhuma.
   * Nunca lança por "não reconheci a intenção" — isso é NENHUMA, não erro (ver
   * parse_tool_output, §4.9). Só rejeita por falha real do motor (timeout, worker
   * indisponível) — mesma semântica de classify().
   */
  detectTool(turnId: string, epoch: number, text: string): Promise<ToolName>;
  generate(
    turnId: string,
    epoch: number,
    messages: ConversationMessage[],
    callbacks: GenerateCallbacks
  ): Promise<void>;
  cancel(turnId: string): void;
  shutdown(): Promise<void>;
}
```

`import type { ToolName } from '../../shared/voiceProtocol.js';` acrescentado ao topo do arquivo,
junto de `ConversationMessage` e `OrchestratorLabel` já importados (`engine.ts:1`). Tanto
`MlxWorkerEngine` (§6.4) quanto `FakeVoiceEngine` (§6.8) implementam esta interface — sem este
acréscimo, um `tsc` isolado sobre `engine.ts` não pegaria a ausência (interfaces em TypeScript não
obrigam implementação em outro arquivo a existir), mas a implementação de `SessionManager` chamando
`this.engine.detectTool(...)` (v5 §6.6, herdado) não compilaria contra a interface antiga — é esse
o elo que faltava explicitar.

---

## 7. Critérios de aceite

Inalterado da v5 (`docs/phase-5b-v5.md` §7, H1–H16) — nenhum achado da rodada 5 mudou um critério
de aceite, só o pseudocódigo que os satisfaz. Não repetido aqui.

---

## 8. Limitações assumidas

Inalterado da v5 (`docs/phase-5b-v5.md` §8).

---

## 9. Riscos

Tabela da v5 (`docs/phase-5b-v5.md` §9) inalterada, com uma linha adicional:

| Risco | Prob. | Mitigação |
|---|---|---|
| Pseudocódigo descrito em prosa, sem o trecho de código, ser implementado incorretamente ou esquecido (classe inteira de achado da rodada 5) | Baixa agora | Rodada 5 (Hermes) checou por execução; os únicos três pontos que ainda estavam só em prosa (`registry.ts`, `engine.ts`, o gate de `stdin_reader_loop()`) ganharam pseudocódigo explícito em §6.2/6.9/6.10 |

---

## 10. Rastreabilidade

- Planos: v1–v5 (todos rejeitados), v6 (esta).
- Auditorias e modelos (rotação é entre modelos, não entre CLIs):
  - v1 e v2: `codex-cli 0.146.0` / gpt-5.6-sol, `effort=medium`.
  - v3: Hermes (container Nous) / longcat-2.0:free.
  - v4: `agy 1.2.7` / Gemini 3.8 Flash (High).
  - v5 → rodada 5: Hermes (container Nous) / longcat-2.0:free, a pedido explícito do usuário —
    segunda vez que Hermes audita este plano, mas não a mesma rodada; a regra violada seria "fechar
    com o auditor de **todas** as rodadas", e já foram quatro fornecedores diferentes até aqui
    (Codex, Hermes, agy, Hermes). Confirmou por execução real os 9 achados da rodada 4 e achou 6
    novos (2 ALTA), todos de completude de pseudocódigo, nenhum de desenho.
- v6: corrige os 6 achados da rodada 5. Não toca `DETECT_TOOL_SYSTEM_PROMPT` nem a amostra de H11
  (§0) — o protocolo de congelamento continua de pé.
- Próximo passo: decidir com o usuário entre (a) uma rodada 6 dirigida — só confirmar que os 6
  achados desta versão foram de fato corrigidos, sem reabrir o resto — ou (b) seguir direto para
  implementação, dado que os seis são lacunas mecânicas de pseudocódigo, não decisões de desenho, e
  a Parte A da rodada 5 já revalidou os nove achados anteriores por execução.
- Implementação: `agy` em modo de escrita, após aprovação. Auditoria do código resultante pelo
  Hermes.
