import type { IAgent } from '../../shared/extensions/agents.js';
import type { ITool, IMutatingTool } from '../../shared/extensions/tools.js';
import type { IntentName } from '../../shared/voiceProtocol.js';
import type {
  ISubAgent,
  SubAgentTaskRequest,
  SubAgentTaskResult
} from './subAgent.js';

export class SpecialistSubAgent implements ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];

  constructor(private readonly agent: IAgent) {
    this.id = `agent_${agent.id.toLowerCase()}`;
    this.name = agent.name;
    this.capabilities = [agent.role.toLowerCase(), 'especialista'];
  }

  async runTask(
    req: SubAgentTaskRequest,
    signal: AbortSignal
  ): Promise<SubAgentTaskResult> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Tarefa cancelada pelo usuário.' };
    }

    // Nota de reconciliação (docs/phase-15-v3.md §3, item 1): IAgent (shared/extensions/agents.ts)
    // só expõe id/name/role/isAvailable()/getSystemPrompt() — nenhum método "roda a pergunta e
    // devolve a resposta". Essa execução de verdade (classificar, recuperar conhecimento, chamar
    // o motor de voz) vive em SessionManager.runTurn() e ainda não foi extraída pra algo que este
    // adaptador possa chamar isoladamente (Fatia 4 da F15, não feita). Devolver sucesso falso aqui
    // violaria a regra do projeto de nunca inventar sucesso — por isso o erro explícito abaixo.
    return {
      success: false,
      output: '',
      error: 'Delegação a especialista interno ainda não integrada ao motor de geração (Fatia 4 da F15).'
    };
  }
}

export class ToolSubAgent implements ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];

  constructor(private readonly tool: ITool | IMutatingTool) {
    this.id = `tool_${tool.name.toLowerCase()}`;
    this.name = tool.name;
    this.capabilities = ['ferramenta', tool.name.toLowerCase()];
  }

  async runTask(
    req: SubAgentTaskRequest,
    signal: AbortSignal
  ): Promise<SubAgentTaskResult> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Tarefa cancelada pelo usuário.' };
    }

    // §2.1 — trava estrutural: nenhuma mutação roda sem confirmationToken, mesmo que o chamador
    // esqueça de checar a confirmação por voz antes de invocar o coordenador.
    if (req.isMutation && !req.confirmationToken) {
      return {
        success: false,
        output: '',
        error: 'Mutação bloqueada: nenhum confirmationToken presente (achado 3 da auditoria r1 da F15).'
      };
    }

    try {
      let output: string;
      // 'preview' só existe em IMutatingTool — é o discriminante real entre as duas interfaces
      // (ambas têm 'execute', então checar só isso nunca distinguia as duas, e o ramo `else`
      // ficava morto: tsc hoje acusa `Expected 2 arguments, but got 0` bem aqui).
      if ('preview' in this.tool) {
        const actionName = (req.context?.action as IntentName | undefined) ?? 'NENHUMA';
        output = this.tool.execute(actionName, req.prompt);
      } else {
        output = this.tool.execute();
      }

      if (signal.aborted) {
        return { success: false, output: '', error: 'Tarefa cancelada pelo usuário.' };
      }
      return { success: true, output };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : 'Falha na execução da ferramenta.'
      };
    }
  }
}
