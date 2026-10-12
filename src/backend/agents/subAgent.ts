/** Tetos iniciais da Fase 15 §6 (ponto de partida; recalibração é Fatia 5). */
export const SUBAGENT_BUDGET = {
  MAX_CALLS_PER_TURN: 6,
  MAX_ORCHESTRATION_MS: 60_000,
  MAX_CONCURRENT_ASYNC: 2
} as const;

export type BudgetExceededReason = 'max_calls' | 'time' | 'max_async';

export interface SubAgentTaskRequest {
  taskId: string;
  turnId: string;
  prompt: string;
  isMutation: boolean;
  /**
   * Presente SOMENTE depois que a confirmação por voz foi obtida (docs/phase-15-v3.md §2.1,
   * achado 3 da auditoria r1). Nunca gerado aqui — quem monta o request é quem viu o "sim" real
   * (hoje, `SessionManager`, no mesmo ponto onde monta `confirmed === 'SIM'`).
   */
  confirmationToken?: string;
  context?: Record<string, unknown>;
}

export interface SubAgentTaskResult {
  success: boolean;
  output: string;
  error?: string;
  /**
   * Discriminante estrutural (Fase 15, §4.3, achado r2 N2): 'final' (padrão) é a
   * resposta concluída da tarefa; 'async_deferred' sinaliza que a tarefa seguiu como
   * long-running (linha com `asyncTaskId`) e quem orquestra deve falar progresso em
   * vez de uma resposta final. Opcional para não quebrar ISubAgent implementados antes.
   */
  kind?: 'final' | 'async_deferred';
  asyncTaskId?: string;
}

export interface ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];

  /**
   * Executa a tarefa do subagente com suporte a cancelamento por AbortSignal.
   */
  runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult>;
}

export interface TaskTraceItem {
  subAgentId: string;
  prompt: string;
  isMutation: boolean;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  result?: string;
  durationMs?: number;
  /** Fatia 4 (§4.3, A2): id da tarefa async_deferred ainda em andamento (espelha SubAgentTaskResult). */
  asyncTaskId?: string;
}

export interface ExecutionTrace {
  turnId: string;
  query: string;
  tasks: TaskTraceItem[];
  /** Contador de delegações tentadas neste turno (inclui as que passaram do orçamento). */
  callCount: number;
  /** Relógio (ms) da primeira delegação do turno — base do orçamento de 60s. */
  orchestrationStartedAtMs?: number;
  /** Preenchido quando qualquer teto do §6 estoura; nunca silencioso. */
  budgetExceeded?: BudgetExceededReason;
}

/** Fala honesta obrigatória ao estourar qualquer teto do §6. */
export function formatBudgetExceededSpeech(
  coordinator: SubAgentCoordinator,
  turnId: string
): string {
  const base =
    'Não consegui terminar isso dentro do tempo/dos passos previstos; aqui está o que já fiz';
  const summary = coordinator.formatTraceSummary(turnId);
  if (!summary || summary.startsWith('Nenhuma ')) {
    return base + '.';
  }
  return `${base}: ${summary}`;
}

export class SubAgentCoordinator {
  private readonly subAgents = new Map<string, ISubAgent>();
  private readonly traces = new Map<string, ExecutionTrace>();
  /** taskIds assíncronos em voo nesta sessão (teto §6 = 2). */
  private readonly asyncInFlight = new Set<string>();

  register(subAgent: ISubAgent): void {
    this.subAgents.set(subAgent.id, subAgent);
  }

  get(id: string): ISubAgent | undefined {
    return this.subAgents.get(id);
  }

  list(): ISubAgent[] {
    return Array.from(this.subAgents.values());
  }

  createTrace(turnId: string, query: string): ExecutionTrace {
    const existing = this.traces.get(turnId);
    if (existing) {
      if (query && existing.query !== query) existing.query = query;
      return existing;
    }
    const trace: ExecutionTrace = { turnId, query, tasks: [], callCount: 0 };
    this.traces.set(turnId, trace);
    return trace;
  }

  getTrace(turnId: string): ExecutionTrace | undefined {
    return this.traces.get(turnId);
  }

  activeAsyncCount(): number {
    return this.asyncInFlight.size;
  }

  /**
   * Reserva um slot de tarefa assíncrona. Idempotente por taskId.
   * Retorna false se o teto de 2 já está cheio com outro taskId.
   */
  tryAcquireAsyncSlot(taskId: string): boolean {
    if (this.asyncInFlight.has(taskId)) return true;
    if (this.asyncInFlight.size >= SUBAGENT_BUDGET.MAX_CONCURRENT_ASYNC) return false;
    this.asyncInFlight.add(taskId);
    return true;
  }

  releaseAsyncSlot(taskId: string): void {
    this.asyncInFlight.delete(taskId);
  }

  /**
   * Checa e registra o orçamento de chamadas/tempo ANTES de invocar um subagente.
   * Em estouro, grava `budgetExceeded` no ExecutionTrace e não incrementa o contador.
   */
  beginDelegation(
    turnId: string,
    query: string,
    nowMs: number
  ): { ok: true; trace: ExecutionTrace } | { ok: false; reason: BudgetExceededReason; trace: ExecutionTrace } {
    const trace = this.createTrace(turnId, query);

    if (trace.budgetExceeded) {
      return { ok: false, reason: trace.budgetExceeded, trace };
    }

    if (trace.orchestrationStartedAtMs !== undefined) {
      if (nowMs - trace.orchestrationStartedAtMs >= SUBAGENT_BUDGET.MAX_ORCHESTRATION_MS) {
        trace.budgetExceeded = 'time';
        return { ok: false, reason: 'time', trace };
      }
    }

    if (trace.callCount >= SUBAGENT_BUDGET.MAX_CALLS_PER_TURN) {
      trace.budgetExceeded = 'max_calls';
      return { ok: false, reason: 'max_calls', trace };
    }

    if (trace.orchestrationStartedAtMs === undefined) {
      trace.orchestrationStartedAtMs = nowMs;
    }
    trace.callCount += 1;
    return { ok: true, trace };
  }

  markBudgetExceeded(turnId: string, reason: BudgetExceededReason): ExecutionTrace {
    const trace = this.createTrace(turnId, '');
    trace.budgetExceeded = reason;
    return trace;
  }

  /** Fatia 4 (A2): último trace com tarefas, pela ordem de inserção (coordenador é do processo — R3). */
  latestTraceWithTasks(): ExecutionTrace | undefined {
    let latest: ExecutionTrace | undefined;
    for (const trace of this.traces.values()) {
      if (trace.tasks.length > 0) latest = trace;
    }
    return latest;
  }

  formatTraceSummary(turnId: string): string {
    const trace = this.traces.get(turnId);
    if (!trace || trace.tasks.length === 0) {
      return 'Nenhuma ação foi executada neste turno.';
    }

    const completed = trace.tasks.filter((t) => t.status === 'completed');
    // Fatia 4 (A2): pendentes assíncronas entram na fala com o id da tarefa.
    const pending = trace.tasks
      .filter((t) => t.status === 'pending')
      .map((t) => ` Ainda em andamento: ${t.prompt} (tarefa ${t.asyncTaskId ?? 'sem id'}).`)
      .join('');
    if (completed.length === 0) {
      return pending ? pending.trim() : 'Nenhuma tarefa foi concluída com sucesso.';
    }

    const summaryList = completed
      .map((t, idx) => `Passo ${idx + 1}: ${t.result || 'concluído'}`)
      .join('; ');
    return `Executei ${completed.length} ${completed.length === 1 ? 'passo' : 'passos'}: ${summaryList}.${pending}`;
  }
}
