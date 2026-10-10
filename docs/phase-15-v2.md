# Fase 15 — Orquestrador Autônomo e Coordenador de Subagentes por Voz (plano v2)

Data: 2026-10-09. Autor: Orquestrador. Estado: **Aprovado para implementação**.
Substitui `docs/phase-15-v1.md` (REFAZER — auditoria em `docs/audits/phase-15-plan-audit-r1.md`).

---

## 1. Contexto, Ancoragem no Código e Objetivos

A Fase 15 transforma o `SessionManager` (`src/backend/voice/sessionManager.ts`) e o `voiceRuntime` (`src/backend/voice/voiceRuntime.ts`) num **coordenador inteligente de subagentes**.

Quando o usuário faz um pedido com vários passos (ex.: *"Pesquisa X e salva uma nota com o resumo"* ou *"Pede pro revisor checar este texto"*), o orquestrador:
1. Decompõe o pedido num grafo/sequência de tarefas de subagentes.
2. Delega a execução para o subagente adequado via interface `ISubAgent`.
3. Garante **cancelamento cooperativo via `AbortSignal`** no barge-in (interrupção por fala em <= 350ms).
4. Garante a **fronteira de segurança e confirmação**:
   - **Leitura/Consulta local:** Execução autônoma imediata.
   - **Mutações (criar, editar, apagar):** O plano é montado e a confirmação por voz é obtida **ANTES** da chamada ao subagente mutante.
   - **Ações Financeiras / Irreversíveis:** Bloqueadas por guardrail técnico no coordenador (prepara no máximo rascunho/carrinho).
5. Mantém um registro auditável `ExecutionTrace` para responder por voz à pergunta *"O que você fez?"*.

---

## 2. Assinatura Estrita da Interface `ISubAgent` e Cancelamento

Em `src/shared/extensions/agents.ts` (ou novo `src/backend/agents/subAgent.ts`):

```ts
export interface SubAgentTaskRequest {
  taskId: string;
  turnId: string;
  prompt: string;
  isMutation: boolean;
  context?: Record<string, unknown>;
}

export interface SubAgentTaskResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  
  /**
   * Executa a tarefa do subagente com suporte a cancelamento por AbortSignal.
   * Se o signal for abortado durante a execução, a Promise rejeita com DOMException('AbortError') ou encerra limpo.
   */
  runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult>;
}
```

---

## 3. Subagentes Suportados na F15

1. **Especialistas Internos (`SpecialistSubAgent`):**
   - Encapsula os agentes existentes (`Geral`, `Teologia`, `Virtologia`, `Neurociência`) em `src/backend/agents/specialistAgents.ts`.
2. **Ferramentas Mutantes e de Estado (`StateToolSubAgent`):**
   - Encapsula `LembreteTool`, `NotaTool`, `MemoriaTool` de `src/backend/tools/mutatingTools.ts`.
3. **Ponte OpenClaw (`OpenClawSubAgent`):**
   - Comunica-se com os agentes e subagentes do OpenClaw via API local com timeout estrito de 15s.

---

## 4. Estrutura do Rastro de Execução (`ExecutionTrace`)

Cada pedido gera um rastro registrado na sessão:
```ts
export interface TaskTraceItem {
  subAgentId: string;
  prompt: string;
  isMutation: boolean;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  result?: string;
  durationMs?: number;
}

export interface ExecutionTrace {
  turnId: string;
  query: string;
  tasks: TaskTraceItem[];
}
```

Quando o usuário pergunta *"O que você fez?"*, o `SessionManager` formata e lê em voz alta o resumo dos passos do `ExecutionTrace` daquele turno.

---

## 5. Fatias de Implementação da Fase 15

- **Fatia 1:** Interface `ISubAgent` + `SubAgentCoordinator` com suporte a `AbortSignal` + `ExecutionTrace`.
- **Fatia 2:** Adaptadores dos especialistas internos e ferramentas de estado para a interface `ISubAgent`.
- **Fatia 3:** Ponte OpenClaw (`OpenClawSubAgent`) com timeout e resiliência.
- **Fatia 4:** Integração no `SessionManager` (gatekeeper de mutação antes da chamada + barge-in em <= 350ms).
- **Fatia 5:** Suíte de testes de estresse H15 (40 cenários multi-passo, 200 cenários de segurança, cancelamento e orçamentos).

---

## 6. Tabela de Critérios de Aceite (Harness H15)

| ID | Critério |
|---|---|
| H15.1 | 40 cenários multi-passo >= 90% concluídos corretamente |
| H15.2 | Zero mutação executada sem confirmação verificada antes da chamada ao subagente |
| H15.3 | Cancelamento por barge-in em <= 350ms p95 sem tarefas órfãs |
| H15.4 | Rastreabilidade total: o app responde por voz *"o que você fez?"* usando o `ExecutionTrace` |
| H15.5 | Orçamento e limites: máximo de 5 chamadas a subagentes por pedido e timeout global de 30s |
