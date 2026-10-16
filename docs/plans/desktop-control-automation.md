# Plano de Implementação: Controle Completo de Desktop macOS, Digitação Segura, DitadoLocal, Troca Autônoma de Voz e Auto-Correção em Branch Isolada (v5)

## 1. Visão Geral e Arquitetura Unificada

Este documento especifica a arquitetura executável e de segurança para os 4 pilares solicitados pelo usuário no **Rodrigo AI**, fechando integralmente os 8 achados bloqueantes, a tabela A1–A12 e as 5 ressalvas finais (R1–R5) da auditoria adversarial (`cursor-agent`):

1. **Pilar 1 — Controle Nativo do Desktop macOS (`DESKTOP_COMANDO` e `DESKTOP_CRITICO`)**:
   - **Ações imediatas (`DESKTOP_COMANDO`, via `QUERY_NAMES`, `isMutation: false`)**: ajuste de volume (com piso de 10% em reduções relativas e `without output muted` sempre que volume > 0), mudo/desmudo, mídia (`play_pause`, `next`, `prev` direcionados por bundle ID a `com.spotify.client` ou `com.apple.Music`), abertura de aplicativos na allowlist por bundle ID, alternância de modo escuro/claro, minimizar janela ativa e abertura de pastas canônicas (`Downloads`, `Documents`, `Desktop`, `Developer`).
   - **Ações críticas (`DESKTOP_CRITICO`, via `MUTATION_NAMES`, `isMutation: true`)**: fechar aplicativo da allowlist (`app_quit`), esvaziar lixeira (`empty_trash`), colocar o Mac em repouso (`system_sleep`) e bloquear a tela (`lock_screen`). Protegidas por confirmação falada em duas fases (`armedMutation` -> `markPlayed()` -> `pendingMutation` -> `classifyConfirmation` -> `recordMutationConfirmation` -> `withAudit` -> `consumeMutationToken`).
   - **Execução estrita pós-`markPlayed` para `lock_screen` e `system_sleep` (R1 — Fail-Closed, sem timer paralelo)**: a mutação confirmada registra `session.pendingPostSpeechAction = { turnId, expectedText, action }` na sessão; o comando de sistema operacional dispara **exclusivamente** quando `markPlayed()` confirma que a frase final (`expectedText`) do `turnId` terminou de ser reproduzida no cliente. Se o turno sofrer barge-in (`cancelTurn`) ou a sessão encerrar (`terminate`) antes de `markPlayed()`, `pendingPostSpeechAction` é descartada sem executar (fail-closed).
   - **Disposição Explícita de Latência (A3 — SLI Realista)**:
     - Quando `RODRIGO_CLOUD_INTENT=1`, a classificação de intenção em nuvem tem mediana de ~3,2s e p95 de ~3,8s (`CLOUD_INTENT_WAIT_S = 4.0s`).
     - A execução local do comando (`osascript` / `open -b`) após a resolução da intenção leva **< 200ms** (p95), mantendo a latência total ponta a ponta dentro do envelope real do pipeline de voz (~3,4s com intent em nuvem; ~1,1s em modo 100% local).

2. **Pilar 2 — Digitação Segura em Chats / Bloco de Notas (`DIGITAR_TEXTO`) & Processamento Local DitadoLocal (`DITADO_LOCAL`)**:
   - **Separação Estrita de Fronteira (R2 — Sem Bypass de Mutação)**:
     - **`DITADO_LOCAL` (`QUERY_NAMES`, `isMutation: false`)**: Executa **exclusivamente** transformações locais de texto (limpar muletas de ditado, traduzir texto para português ou para idioma alvo) e devolve o resultado falado, **nunca** injetando eventos de teclado (`CGEvent` / `keystroke`) nem colando no aplicativo focado sem confirmação.
     - **`DIGITAR_TEXTO` (`MUTATION_NAMES`, `isMutation: true`)**: **Toda e qualquer** operação que digite, cole (`⌘V`) ou dispare atalho sintético no aplicativo em primeiro plano (`atalho:ditar` `⌘⌥F`, `atalho:perguntar` `⌘⌥A`, `atalho:traduzir_selecao` `⌘⌥T`, `atalho:ditar_traduzir` `⌘⌥S` do DitadoLocal) passa obrigatoriamente por `DIGITAR_TEXTO` com confirmação falada `SIM`.
   - **Fixação e Revalidação de Alvo (`targetBundleId`)**: No `preview()`, captura sincronamente o `bundleId` e o nome do aplicativo `frontmost`. Se estiver em `DENIED_TYPING_BUNDLE_IDS` (terminais, IDEs, consoles ou o próprio Rodrigo AI), recusa imediatamente no `preview()` lançando `ToolPreviewRefusedError`. No `execute()` (após `SIM`), consulta novamente o `bundleId` `frontmost`: se for diferente do `targetBundleId` capturado no `preview()` ou estiver na deny-list, aborta imediatamente sem colar nada.
   - **Clipboard Fiel ao `ClipboardPaster.swift` do DitadoLocal**: Sanitiza o texto removendo `\r`, `\n` e caracteres de controle (`[\x00-\x1f\x7f]`), captura o conteúdo anterior e `ourChangeCount` do pasteboard, grava o texto, dispara `⌘V` sintético com modificador explícito `command down`, aguarda **500ms** e **só restaura** o clipboard anterior se `changeCount === ourChangeCount`.

3. **Pilar 3 — Autonomia de Autoconfiguração e Troca Dinâmica de Voz (`CONFIGURAR_VOZ` & `DynamicVoiceProvider`)**:
   - **`DynamicVoiceProvider implements IVoiceProvider`**: Envelopa o `IVoiceProvider` ativo, delegando `synthesize()`, `prefersCoalescing`, `endTurn()` e `onFallback`.
   - **Isolamento de Síntese em Voo (R5)**: `synthesize()` captura a referência `const provider = this.currentProvider` no início da chamada. Uma troca de voz via `switchVoice()` altera `this.currentProvider` para as próximas sínteses sem interromper nem corromper uma síntese já em andamento ou sua confirmação em `markPlayed()`.
   - **Respeito Estrito a `ttsCloudEffective(privacy)` (Fase 13a)**:
     - Vozes locais (`Felipe (Enhanced)`, `Luciana (Enhanced)`, `Kokoro`) podem ser ativadas a qualquer momento.
     - Vozes em nuvem do Gemini (`Charon`, `Puck`, `Aoede`, `Fenrir`, `Kore`, `Zephyr`) verificam `ttsCloudEffective(privacy)` e `GEMINI_API_KEY`. Se `ttsCloudEffective(privacy)` for `false`, a troca é recusada sem chamada de rede e o assistente explica por voz o motivo de privacidade.
   - **Persistência Auditada**: Grava a preferência em `.runtime/voice-preference.json` (escrita atômica `tmp + rename`), via `src/backend/voice/ttsProviders.ts` (já registrado como exceção auditada em `src/backend/fileAccessRegistry.ts`).

4. **Pilar 4 — Acesso ao Próprio Código e Auto-Correção Segura (`AUTO_CORRECAO`)**:
   - **Fluxo T4 Completo (`MUTATION_NAMES`, `isMutation: true`)**: Passa obrigatoriamente por `armedMutation` -> `markPlayed()` -> `pendingMutation` -> `SIM` -> `recordMutationConfirmation(turnId)` -> `delegateToolInTurn(..., isMutation: true)` -> `withAudit(this.decisionLog, ...)` -> `ToolSubAgent` (`consumeMutationToken`).
   - **Proibição Explícita de Reutilizar `ClaudeCodeSubAgent` em `AutoCorrecaoTool` (R3)**:
     - **É expressamente proibido** reutilizar `ClaudeCodeSubAgent` (que usa `--permission-mode bypassPermissions`) dentro de `AutoCorrecaoTool`.
     - `AutoCorrecaoTool` realiza um **spawn dedicado** do binário `claude` confinado a `cwd: worktreePath` (`.runtime/worktrees/auto-fix-<id>`), com ambiente sanitizado (`buildSafeAgentEnv()`), prompt filtrado por `guardText(..., privacy.outboundGuard)` e flags estritas:
       ```typescript
       const agentArgs = [
         '-p',
         '--output-format', 'json',
         '--permission-mode', 'acceptEdits',
         '--tools', 'Read,Write,Edit,Glob,Grep',
         '--no-session-persistence'
       ];
       ```
     - Sem `Bash` e sem `bypassPermissions`: o subagente nunca pode executar comandos de shell arbitrários nem escapar do worktree.
     - Após o término do subagente, o próprio `AutoCorrecaoTool` verifica via `git diff --diff-filter=D --name-only -- src/**/__tests__` que nenhum arquivo de teste foi removido e executa `npm run typecheck` e `npm test` via `execFile` determinístico no `worktreePath`.
   - **Endurecimento de `ClaudeCodeSubAgent` (`DELEGAR_CODIGO`)**:
     - `ClaudeCodeSubAgent` recebe e invoca `verifyMutationToken: (turnId, token) => boolean` (`consumeMutationToken`), garantindo consumo atômico one-shot do token.
     - `pendingDelegation` em `sessionManager.ts` executa obrigatoriamente sob `withAudit(this.decisionLog, ...)`.

---

## 2. Resolução Completa dos Achados 1–8, A1–A12 e Ressalvas R1–R5

### 2.1. Tabela Explícita das 5 Ressalvas Finais (R1–R5)

| Ressalva | Descrição da Ressalva | Status na v5 | Contrato / Implementação Exata |
| :--- | :--- | :--- | :--- |
| **R1** | `lock_screen` e `system_sleep` não podem usar timer paralelo (`setTimeout(3000)`) que cortaria a fala ou dispararia após barge-in. | **SANADO** | `session.pendingPostSpeechAction = { turnId, expectedText, action }` em `src/backend/voice/sessionManager.ts`: dispara **somente** em `markPlayed()` quando `turnId` e `expectedText` coincidem; descartado em `cancelTurn()` e `terminate()`. |
| **R2** | Atalhos do DitadoLocal que injetam teclas (`⌘⌥F`, `⌘⌥A`, `⌘⌥T`, `⌘⌥S`) não podem rodar em `DITADO_LOCAL` (`QUERY_NAMES`, sem confirmação). | **SANADO** | `DITADO_LOCAL` faz apenas limpeza/tradução pura de texto sem `keystroke`. Atalhos que injetam teclas no app focado ficam exclusivamente em `DIGITAR_TEXTO` (`atalho:ditar`, `atalho:perguntar`, `atalho:traduzir_selecao`, `atalho:ditar_traduzir`) com confirmação `SIM` e checagem de `DENIED_TYPING_BUNDLE_IDS` + `targetBundleId`. |
| **R3** | `AutoCorrecaoTool` não pode reutilizar `ClaudeCodeSubAgent` (`bypassPermissions`) nem conceder `Bash` ao subagente. | **SANADO** | Proibição explícita de reutilizar `ClaudeCodeSubAgent`. `AutoCorrecaoTool` faz spawn dedicado com `--permission-mode acceptEdits --tools Read,Write,Edit,Glob,Grep` (sem `Bash` e sem `bypassPermissions`) e valida `src/**/__tests__` + `npm run typecheck` + `npm test` via `execFile`. |
| **R4** | `desktop/build.sh` não pode ter fallback silencioso para assinatura ad-hoc (`-`), que quebraria permissões TCC a cada rebuild. | **SANADO** | `desktop/build.sh` verifica `security find-identity -v -p codesigning \| grep -Fq "$SIGN_ID"` (`DitadoLocal Dev`) e aborta com `exit 1` se ausente, assinando com `codesign --force --deep --sign "$SIGN_ID" "$APP"`. |
| **R5** | Troca de voz em runtime (`DynamicVoiceProvider.switchVoice`) não pode interromper síntese já em andamento nem violar `ttsCloudEffective(privacy)`. | **SANADO** | `DynamicVoiceProvider.synthesize()` faz snapshot `const provider = this.currentProvider` antes do `await`; `switchVoice()` verifica `ttsCloudEffective(this.deps.privacy)` antes de ativar qualquer voz do Gemini. |

### 2.2. Tabela Consolidada dos Achados 1–8 e A1–A12

| Item | Status na v5 | Evidência Técnica |
| :--- | :--- | :--- |
| **Achado 1 / A1** | **SANADO** | `AUTO_CORRECAO`, `DESKTOP_CRITICO` e `DIGITAR_TEXTO` via `delegateToolInTurn(..., isMutation: true)` com `withAudit`; `pendingDelegation` também envelopado por `withAudit`. |
| **Achado 2 / A7** | **SANADO** | `AutoCorrecaoTool` executa o agente no `worktreePath` com `--permission-mode acceptEdits --tools Read,Write,Edit,Glob,Grep` (**sem `Bash` e sem `bypassPermissions`**). Os testes são rodados pelo Node via `execFile` fixo. |
| **Achado 3** | **SANADO** | `git worktree add` isolado em `.runtime/worktrees/auto-fix-<id>`; árvores sujas no repo principal permanecem intocadas. |
| **Achado 4 / A8** | **SANADO** | Especificação e paridade completa de `src/shared/voiceProtocol.ts` (`TOOL_NAMES`, `MUTATION_NAMES`, `QUERY_NAMES`), `MUTATION_GATE`, `actionGroupOf`, `selectMutatingToolByAction` e `scripts/worker/worker.py`. |
| **Achado 5 / A10** | **SANADO** | `pendingPostSpeechAction` dispara **somente** em `markPlayed()` (sem timer paralelo de 3s; cancelamento ou fim de sessão descarta fail-closed). Volume > 0 aplica piso de 10% em reduções e `without output muted`. |
| **Achado 6 / A4** | **SANADO** | `desktop/build.sh` exige assinatura com `"DitadoLocal Dev"` (ou `RODRIGO_CODESIGN_IDENTITY`), **sem fallback silencioso para `-` ad-hoc**. `doctor.ts` inclui verificação `desktop-control`. |
| **Achado 7** | **SANADO** | `ClaudeCodeSubAgent` consome `confirmationToken` de uso único via `consumeMutationToken`. |
| **Achado 8 / A3 / A6 / A9 / A11 / A12** | **SANADO** | SLI A3 explicitado (~3,2s mediana com cloud intent, <200ms execução local); allowlist por bundle ID em `open_app` e `app_quit`; `on run argv` sem interpolação; `parseDesktopControlFlag` fail-closed; suíte de testes unitários completa. |

---

## 3. Contratos Exatos de Código em `src/backend/voice/sessionManager.ts`

### 3.1. Contrato Exato de `pendingPostSpeechAction` (`schedulePostSpeechAction`, `markPlayed`, `cancelTurn`, `terminate`)
Em `src/backend/voice/sessionManager.ts`:
```typescript
interface Session {
  // ...
  pendingPostSpeechAction: { turnId: string; expectedText: string; run: () => Promise<void> } | null;
}

// Registro durante execute() da ferramenta (ex.: lock_screen / system_sleep):
schedulePostSpeechAction(action: () => Promise<void>): void {
  const s = this.current;
  const t = s?.activeTurn;
  if (!s || !t) return;
  s.pendingPostSpeechAction = { turnId: t.turnId, expectedText: '', run: action };
}

// Em delegateToolInTurn() / confirmação de mutação, logo após obter a frase final `clean`:
if (session.pendingPostSpeechAction && session.pendingPostSpeechAction.turnId === turn.turnId) {
  session.pendingPostSpeechAction.expectedText = clean;
}

// Em markPlayed(sessionId, turnId, text):
if (
  session.pendingPostSpeechAction &&
  session.pendingPostSpeechAction.turnId === turnId &&
  session.pendingPostSpeechAction.expectedText === text
) {
  const postAction = session.pendingPostSpeechAction;
  session.pendingPostSpeechAction = null;
  void postAction.run().catch((err) => {
    console.error(`[desktop] falha na ação pós-fala (turno=${turnId}):`, err);
  });
}

// Em cancelTurn(session, reason) e terminate(session):
session.pendingPostSpeechAction = null;
```

### 3.2. Contrato Exato de `withAudit` em torno de `pendingDelegation` (`DELEGAR_CODIGO`)
Em `src/backend/voice/sessionManager.ts`:
```typescript
if (confirmed === 'SIM') {
  this.recordMutationConfirmation(turn.turnId);
  const audited = await withAudit(
    this.decisionLog,
    {
      mid: crypto.randomUUID(),
      turnId: turn.turnId,
      action: 'DELEGAR_CODIGO',
      tool: 'claude_code',
      executor: 'subagent',
      dataClass: 'unknown'
    },
    () =>
      this.runSubAgentDelegation({
        turnId: turn.turnId,
        query: pend.transcript,
        subAgentId: 'claude_code',
        prompt: pend.transcript,
        isMutation: true,
        signal: turn.abortController.signal,
        needs: ['shell', 'read_file', 'write_file', 'network']
      }),
    (r) => (r.ok && r.result?.success ? 'ok' : 'failed')
  );
  if (session.activeTurn !== turn) return;
  if (audited.refused) {
    text = AUDIT_REFUSED_TEXT;
  } else {
    const r = audited.result;
    if (r.budgetExceeded && r.speech) {
      text = r.speech;
    } else if (r.result?.success) {
      text = r.result.output || 'Concluído.';
    } else {
      text = r.result?.error ?? MUTATION_FAILURE_TEXT;
    }
    if (audited.conclusionLost && r.result?.success) {
      text = `${text} ${AUDIT_CONCLUSION_LOST_TEXT}`;
    }
  }
}
```

---

## 4. Especificação Executável da Ligação Protocolo <-> Worker <-> SessionManager <-> Tools

### 4.1. `MUTATION_GATE` (`mightBeMutation` em `src/backend/tools/mutatingTools.ts`)
```typescript
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr|memor|grava|grave|gravou|gravand|gravar|avis|delet|alter|some|toque|acord|bota|zera|reescrev|desfaz|limp|errad|confund|volum|som|mudo|muta|desmuta|paus|toca|musica|faixa|proxim|anterior|abr|fech|encerr|modo|escur|clar|minimiz|janel|pasta|download|document|desktop|lixeir|bloque|repous|dorm|suspens|digit|colar|cola|ditad|traduz|voz|luciana|felipe|charon|puck|kokoro|aoede|fenrir|kore|zephyr|autocorrig|melhoria|refator|codigo)\w*\b|\b(edita|editar|edite|editou|editando|troca|trocar|troque|trocou|trocando|corrige|corrigir|corrija|corrigiu|corrigindo|auto\s*corrig\w*|auto\s*correc\w*)\b/;
```

### 4.2. `actionGroupOf` em `src/backend/voice/confirmationClassifier.ts`
```typescript
export function actionGroupOf(kind: string): PendingActionGroup | null {
  const k = kind.toUpperCase();
  if (k.endsWith('_CRIAR') || k === 'MEMORIA_GUARDAR' || k === 'DIGITAR_TEXTO') return 'CREATE';
  if (k.endsWith('_APAGAR') || k === 'MEMORIA_ESQUECER' || k === 'DESKTOP_CRITICO') return 'DELETE';
  if (k.endsWith('_EDITAR') || k === 'AUTO_CORRECAO') return 'EDIT';
  return null;
}
```

### 4.3. Mapeamento `selectMutatingToolByAction` e Nomes das Ferramentas (`IMutatingTool`)
Como `selectMutatingToolByAction(kind, tools)` extrai `prefix = kind.split('_')[0].toUpperCase()` e procura `tool.name.toUpperCase() === prefix`:
- `DesktopTool`: `readonly name = 'DESKTOP'` -> atende `DESKTOP_COMANDO` (`isQueryName` = true, executa sem confirmação) e `DESKTOP_CRITICO` (`isMutationName` = true, exige `preview()` + confirmação `SIM` + `withAudit` + `consumeMutationToken`).
- `DigitarTool`: `readonly name = 'DIGITAR'` -> atende `DIGITAR_TEXTO` (`isMutationName` = true, exige `preview()` que fixa `targetBundleId` + confirmação `SIM` + `withAudit` + `consumeMutationToken`).
- `DitadoLocalTool`: `readonly name = 'DITADO'` -> atende `DITADO_LOCAL` (`isQueryName` = true, executa limpeza/tradução pura de texto sem injeção de teclado).
- `ConfigurarVozTool`: `readonly name = 'CONFIGURAR'` -> atende `CONFIGURAR_VOZ` (`isQueryName` = true, troca a voz via `DynamicVoiceProvider.switchVoice()`).
- `AutoCorrecaoTool`: `readonly name = 'AUTO'` -> atende `AUTO_CORRECAO` (`isMutationName` = true, exige `preview()` + confirmação `SIM` + `withAudit` + `consumeMutationToken` + worktree isolada).

### 4.4. Paridade Explícita entre `src/shared/voiceProtocol.ts` e `scripts/worker/worker.py`
- Em `src/shared/voiceProtocol.ts`:
  ```typescript
  export const TOOL_NAMES = [
    'HORA',
    'DATA',
    'LEMBRETE_CONSULTAR',
    'NOTA_CONSULTAR',
    'MEMORIA_CONSULTAR',
    'DESKTOP_COMANDO',
    'DITADO_LOCAL',
    'CONFIGURAR_VOZ',
    'DELEGAR_CODIGO',
    'NENHUMA'
  ] as const;

  export const MUTATION_NAMES = [
    'LEMBRETE_CRIAR',
    'LEMBRETE_EDITAR',
    'LEMBRETE_APAGAR',
    'LEMBRETE_REAGENDAR',
    'LEMBRETE_CONSULTAR',
    'NOTA_CRIAR',
    'NOTA_EDITAR',
    'NOTA_APAGAR',
    'NOTA_CONSULTAR',
    'MEMORIA_GUARDAR',
    'MEMORIA_EDITAR',
    'MEMORIA_ESQUECER',
    'MEMORIA_CONSULTAR',
    'DESKTOP_COMANDO',
    'DESKTOP_CRITICO',
    'DIGITAR_TEXTO',
    'DITADO_LOCAL',
    'CONFIGURAR_VOZ',
    'AUTO_CORRECAO',
    'NENHUMA'
  ] as const;

  export const QUERY_NAMES = [
    'LEMBRETE_CONSULTAR',
    'NOTA_CONSULTAR',
    'MEMORIA_CONSULTAR',
    'DESKTOP_COMANDO',
    'DITADO_LOCAL',
    'CONFIGURAR_VOZ'
  ] as const;
  ```
- Em `scripts/worker/worker.py`:
  ```python
  MUTATION_NAMES = {
      "LEMBRETE_CRIAR", "LEMBRETE_EDITAR", "LEMBRETE_APAGAR", "LEMBRETE_REAGENDAR", "LEMBRETE_CONSULTAR",
      "NOTA_CRIAR", "NOTA_EDITAR", "NOTA_APAGAR", "NOTA_CONSULTAR",
      "MEMORIA_GUARDAR", "MEMORIA_EDITAR", "MEMORIA_ESQUECER", "MEMORIA_CONSULTAR",
      "DESKTOP_COMANDO", "DESKTOP_CRITICO", "DIGITAR_TEXTO", "DITADO_LOCAL", "CONFIGURAR_VOZ", "AUTO_CORRECAO",
      "NENHUMA"
  }
  OPTIONAL_CONTENT_QUERY_NAMES = {"LEMBRETE_CONSULTAR", "NOTA_CONSULTAR", "MEMORIA_CONSULTAR"}
  QUERY_NAMES = OPTIONAL_CONTENT_QUERY_NAMES | {"DESKTOP_COMANDO", "DITADO_LOCAL", "CONFIGURAR_VOZ"}
  STRUCTURED_ACTION_NAMES = {"DESKTOP_COMANDO", "DESKTOP_CRITICO", "CONFIGURAR_VOZ"}
  ```
  - Em `parse_intent_json(raw, text)`: exige `content` não-vazio (`1..MAX_MUTATION_CONTENT_CHARS`) para todas as 6 novas intenções. Para `DIGITAR_TEXTO` (texto livre), `DITADO_LOCAL` e `AUTO_CORRECAO`, exige `content_grounded` sobre o texto após o prefixo; para `STRUCTURED_ACTION_NAMES` e `DIGITAR_TEXTO` com `atalho:`, aceita o token estruturado canônico.
  - Em `parse_mutation_output(raw, truncated)`: exige `content` não-vazio (`1..MAX_MUTATION_CONTENT_CHARS`) para todas as 6 novas ações.

---

## 5. Plano de Testes Automatizados Adversariais (A12 Completo)

1. **`src/backend/tools/__tests__/desktopControl.test.ts`**:
   - Allowlist open + quit, piso de 10% em `volume_down`, `without output muted` em volume > 0, `lock_screen` agendado via `schedulePostSpeechAction` (disparado apenas após a fala), `DITADO_LOCAL` (`isMutation: false`) sem injeção de teclas, `DIGITAR_TEXTO` bloqueando `DENIED_TYPING_BUNDLE_IDS`, abortando se `targetBundleId` mudar entre `preview()` e `execute()`, e restaurando o clipboard somente se `changeCount === ourChangeCount`.
2. **`src/backend/voice/__tests__/voiceSwitching.test.ts`**:
   - Bloqueio de voz em nuvem quando `ttsCloudEffective(privacy)` é `false`, troca entre vozes do Gemini com persistência atômica em `.runtime/voice-preference.json` e isolamento de síntese em voo (`DynamicVoiceProvider.synthesize`).
3. **`src/backend/tools/__tests__/autoCorrection.test.ts`**:
   - Recusa no `preview()` quando `RODRIGO_CLAUDE_CODE=0`, bloqueio de segredos pelo `outboundGuard`, spawn dedicado em worktree isolada com `--permission-mode acceptEdits --tools Read,Write,Edit,Glob,Grep` (sem `bypassPermissions` e sem `Bash`), reversão se arquivos em `src/**/__tests__` forem deletados, e execução de `npm run typecheck` e `npm test`.
4. **Testes Python do Worker (`scripts/worker/test_intent_parser.py` e `scripts/worker/test_mutation_parser.py`)**:
   - Casos de paridade para `DESKTOP_COMANDO`, `DESKTOP_CRITICO`, `DIGITAR_TEXTO`, `DITADO_LOCAL`, `CONFIGURAR_VOZ` e `AUTO_CORRECAO`.
