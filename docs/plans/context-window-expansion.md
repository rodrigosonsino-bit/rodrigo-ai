# Plano de Expansão de Janela de Contexto e Timeout de Ociosidade (v5 — Pós-Auditoria Codex r4)

## 1. Diagnóstico e Resolução dos Apontamentos da Auditoria (Rodada 4)
A rodada 4 do Codex confirmou que:
- O contrato de mensagens (até `historyTurns * 2`, padrão 60) está **resolvido** (sem garantia ilusória de trocas completas devido à fragmentação de frases em `markPlayed()`).
- A distinção entre retenção em memória (`trimHistory` retendo até 200 mensagens) e janela enviada (`windowHistory` selecionando até 60 mensagens) está **resolvida**.
- O conjunto de 1.562 verificações de parsers passou com 100% de sucesso.

Para a liberação formal do bloqueio remanescente de testes integrados:
1. **Framework de Testes**: Utilizar exclusivamente `node:test` (`import { describe, it, mock } from 'node:test'`), padrão canônico do repositório, eliminando menções a Jest.
2. **Integração do Ambiente**: Testar que `SessionManager` resolve `process.env.RODRIGO_IDLE_TIMEOUT_MINUTES` via `parseIdleMinutes(process.env)` quando `tuning.idleTimeoutMs` não é fornecido:
   - Padrão (sem env): 60 minutos (3.600.000 ms).
   - Customizado (`RODRIGO_IDLE_TIMEOUT_MINUTES=15`): 15 minutos (900.000 ms).
   - Injeção direta via `tuning.idleTimeoutMs`: sobrepõe a variável de ambiente.
3. **Comprovação Antifalso-Positivo de Renovação (`touch()`)**:
   - Inicia sessão com timeout de 60m (prazo inicial t=60m).
   - Avança 10m (antigo timeout) e 50m: sessão continua ativa.
   - Atividade aos 50m (`touch()`): o novo prazo torna-se t=110m.
   - Avança 15m (t=65m, ultrapassando o prazo inicial de 60m): a sessão **permanece ativa** (comprovando que o timer anterior foi cancelado via `clearTimeout`).
   - Avança até t=109m (59m após o touch): permanece ativa.
   - Avança 1m até t=110m (60m após o touch): encerra a sessão.
4. **Verificação de Término Observável**:
   - `sm.getAuthorized(sessionId, token)` retorna `null`.
   - `session.sseRes.writableEnded === true` (fechamento observável da conexão SSE via `end()`).

---

## 2. Especificação Técnica Detalhada

### 2.1. `src/shared/voiceProtocol.ts`
```typescript
export const VOICE_LIMITS = {
  // ...
  /** Teto máximo de turnos permitidos para histórico configurável (1..100 turnos => até 200 mensagens em memória). */
  MAX_CONTEXT_TURNS: 100,
  /** Padrão de produção para histórico enviado ao modelo (30 turnos => até 60 mensagens). */
  DEFAULT_CONTEXT_TURNS: 30,
  /** Timeout de ociosidade padrão: 60 minutos (60 * 60_000 ms). */
  IDLE_TIMEOUT_MS: 60 * 60_000,
  // ...
};
```

### 2.2. `src/backend/privacy.ts`
- Função `parseTurns` com `defaultValue` e `max`:
  ```typescript
  export function parseTurns(env: Env, name: string, defaultValue: number, max: number): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    const v = raw.trim();
    if (!/^[1-9][0-9]{0,2}$/.test(v)) {
      throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre 1 e ${max}. Valor recebido: "${raw}"`);
    }
    const n = parseInt(v, 10);
    if (n < 1 || n > max) {
      throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre 1 e ${max}. Valor recebido: "${raw}"`);
    }
    return n;
  }
  ```
- Função `parseIdleMinutes` para `RODRIGO_IDLE_TIMEOUT_MINUTES` (1..1440):
  ```typescript
  export function parseIdleMinutes(env: Env, name = 'RODRIGO_IDLE_TIMEOUT_MINUTES', defaultValue = 60, min = 1, max = 1440): number {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return defaultValue;
    const v = raw.trim();
    if (!/^[1-9][0-9]{0,3}$/.test(v)) {
      throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre ${min} e ${max}. Valor recebido: "${raw}"`);
    }
    const n = parseInt(v, 10);
    if (n < min || n > max) {
      throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre ${min} e ${max}. Valor recebido: "${raw}"`);
    }
    return n;
  }
  ```
- Chamada em `parsePrivacyConfig`:
  ```typescript
  historyTurns: parseTurns(env, 'RODRIGO_HISTORY_TURNS', VOICE_LIMITS.DEFAULT_CONTEXT_TURNS, VOICE_LIMITS.MAX_CONTEXT_TURNS),
  ```
- `DEFAULT_PRIVACY.historyTurns = 30`.

### 2.3. `src/backend/voice/sessionManager.ts`
- Adicionar `idleTimeoutMs?: number` à interface `SessionTuning`.
- Construtor do `SessionManager`:
  ```typescript
  this.idleTimeoutMs = tuning.idleTimeoutMs ?? (parseIdleMinutes(process.env) * 60_000);
  ```
- `touch(session)`:
  ```typescript
  session.lastActivityAt = Date.now();
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (this.current === session) {
      this.terminate(session, false);
    }
  }, this.idleTimeoutMs);
  ```
- `trimHistory(session)`:
  Mantém até `VOICE_LIMITS.MAX_CONTEXT_TURNS * 2` (200 mensagens) em memória.

### 2.4. `.env` e `.env.example`
- `.env.example`:
  ```env
  # Janela do histórico enviado (inteiro de 1 a 100 turnos; padrão 30).
  RODRIGO_HISTORY_TURNS=30
  # Timeout de inatividade da sessão em minutos antes de encerrar (inteiro de 1 a 1440 minutos; padrão 60).
  RODRIGO_IDLE_TIMEOUT_MINUTES=60
  ```
- `.env`:
  `RODRIGO_HISTORY_TURNS=30`
  `RODRIGO_IDLE_TIMEOUT_MINUTES=60`

---

## 3. Critérios de Aceitação e Verificação (com `node:test`)
1. `npm run typecheck` 100% limpo sem erros de tipagem.
2. `privacy.test.ts` (testes unitários com `node:test`):
   - `parseTurns`: aceita padrão 30; aceita valores válidos 1..100; rejeita `0`, `09`, `-1`, `3.5`, `101`, `1e2`, `abc`, `１２`.
   - `parseIdleMinutes`: aceita padrão 60; aceita valores válidos 1..1440; rejeita `0`, `09`, `-1`, `1.5`, `1e3`, `1441`, `abc`.
3. `sessionManager.test.ts` / `voice.test.ts` (testes de histórico e timeout integrado com `node:test` e `mock.timers`):
   - **Retenção de Memória (`trimHistory`)**: Sessão com 250 mensagens é podada exatamente para 200 mensagens (`MAX_CONTEXT_TURNS * 2`).
   - **Janela Enviada (`windowHistory`)**: Com padrão 30 turnos, histórico com 100 mensagens (incluindo turnos 'screen' e mensagens órfãs do assistente) retorna as últimas mensagens não-screen com início garantido na fala do usuário, limitadas a 60 mensagens.
   - **Resolução de Configuração**:
     - `new SessionManager(...)` com env limpo usa `60 * 60_000` ms.
     - `new SessionManager(...)` com `RODRIGO_IDLE_TIMEOUT_MINUTES="15"` usa `15 * 60_000` ms.
     - `new SessionManager(..., { idleTimeoutMs: 5_000 })` respeita override de tuning.
   - **Ciclo de Vida e Renovação do Timeout (Mock Timers)**:
     - Inicia sessão com timeout padrão de 60m.
     - Avança 10 minutos (timeout antigo): `sm.getAuthorized(sessionId, token)` permanece válido.
     - Avança até 50 minutos: sessão continua viva.
     - Dispara atividade (`sm.touch(session)`): renova prazo para t = 50m + 60m = 110m.
     - Avança 15 minutos (t = 65m, ultrapassando prazo inicial de 60m): sessão continua ativa (elimina falso positivo de timer não cancelado).
     - Avança até 109 minutos: sessão continua ativa.
     - Avança 1 minuto (t = 110m): sessão encerra.
     - Verificação de encerramento observável: `sm.getAuthorized(sessionId, token)` retorna `null` e o mock de SSE tem `writableEnded === true`.
4. Suíte de testes completa do repositório (`npm test`) passando 100% verde (sem regressões).
