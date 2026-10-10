import type {
  ISubAgent,
  SubAgentTaskRequest,
  SubAgentTaskResult
} from './subAgent.js';

export class OpenClawSubAgent implements ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];

  constructor(
    id: string,
    name: string,
    capabilities: string[],
    private readonly openClawClient?: {
      invoke: (agentId: string, prompt: string, signal: AbortSignal) => Promise<string>;
    }
  ) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
  }

  async runTask(
    req: SubAgentTaskRequest,
    signal: AbortSignal
  ): Promise<SubAgentTaskResult> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Tarefa cancelada antes do início.' };
    }

    if (!this.openClawClient) {
      // Mock/fallback local quando o OpenClaw não está conectado
      return {
        success: true,
        output: `[OpenClaw ${this.name}] Processado com sucesso: ${req.prompt}`
      };
    }

    try {
      const output = await this.openClawClient.invoke(this.id, req.prompt, signal);
      if (signal.aborted) {
        return { success: false, output: '', error: 'Tarefa cancelada pelo usuário.' };
      }
      return { success: true, output };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : 'Falha na comunicação com OpenClaw.'
      };
    }
  }
}
