import type { OrchestratorLabel } from '../../shared/voiceProtocol.js';

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
}

export interface ExecutionTrace {
  turnId: string;
  query: string;
  tasks: TaskTraceItem[];
}

export class SubAgentCoordinator {
  private readonly subAgents = new Map<string, ISubAgent>();
  private readonly traces = new Map<string, ExecutionTrace>();

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
    const trace: ExecutionTrace = { turnId, query, tasks: [] };
    this.traces.set(turnId, trace);
    return trace;
  }

  getTrace(turnId: string): ExecutionTrace | undefined {
    return this.traces.get(turnId);
  }

  formatTraceSummary(turnId: string): string {
    const trace = this.traces.get(turnId);
    if (!trace || trace.tasks.length === 0) {
      return 'Nenhuma ação foi executada neste turno.';
    }

    const completed = trace.tasks.filter((t) => t.status === 'completed');
    if (completed.length === 0) {
      return 'Nenhuma tarefa foi concluída com sucesso.';
    }

    const summaryList = completed
      .map((t, idx) => `Passo ${idx + 1}: ${t.result || 'concluído'}`)
      .join('; ');
    return `Executei ${completed.length} ${completed.length === 1 ? 'passo' : 'passos'}: ${summaryList}.`;
  }
}
