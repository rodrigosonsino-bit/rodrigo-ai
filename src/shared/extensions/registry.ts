import type { IVoiceProvider } from './voice.js';
import type { IAgent } from './agents.js';
import type { ITool } from './tools.js';
import type { ModuleStatus } from '../types.js';

/**
 * Registro central de extensões modulares.
 * Na Fase 1, todos os registros de funcionalidades avançadas permanecem vazios
 * e os recursos indisponíveis são honestamente informados.
 */
export class ExtensionRegistry {
  private static instance: ExtensionRegistry;

  private readonly voiceProviders: IVoiceProvider[] = [];
  private readonly agents: IAgent[] = [];
  private readonly tools: ITool[] = [];

  private constructor() {}

  public static getInstance(): ExtensionRegistry {
    if (!ExtensionRegistry.instance) {
      ExtensionRegistry.instance = new ExtensionRegistry();
    }
    return ExtensionRegistry.instance;
  }

  /** Registrado pelo runtime de voz (Fase 2) somente quando de fato disponível — nunca antecipado. */
  public registerVoiceProvider(provider: IVoiceProvider): void {
    this.voiceProviders.push(provider);
  }

  public getVoiceProviders(): readonly IVoiceProvider[] {
    return this.voiceProviders;
  }

  /**
   * Registrado pelo runtime de voz (Fase 4), sempre os 3 juntos, só quando disponível.
   * Idempotente por id — registrar o mesmo agente duas vezes (ex.: um teste que
   * reconstrói o runtime de voz no mesmo processo) não duplica a entrada, já que
   * ExtensionRegistry é singleton e acumularia agentes fantasmas sem essa checagem.
   */
  public registerAgent(agent: IAgent): void {
    if (this.agents.some((a) => a.id === agent.id)) return;
    this.agents.push(agent);
  }

  public getAgents(): readonly IAgent[] {
    return this.agents;
  }

  public getTools(): readonly ITool[] {
    return this.tools;
  }

  public getModuleStatuses(): readonly ModuleStatus[] {
    return [
      {
        id: 'foundation',
        name: 'Fundação Técnica e API Local',
        phase: 1,
        available: true,
        description: 'Servidor local Node.js + TypeScript com comunicação comprovada via /api/health.'
      },
      {
        id: 'voice',
        name: 'Interface e Provedor de Voz',
        phase: 2,
        available: this.voiceProviders.length > 0,
        description:
          this.voiceProviders.length > 0
            ? `Voz local ativa (provedor: ${this.voiceProviders[0].name}).`
            : 'Provedor de voz não inicializado — rode "npm run setup:voice" e reinicie o servidor.'
      },
      {
        id: 'agents',
        name: 'Orquestrador e Agentes Especialistas',
        phase: 4,
        available: this.agents.length > 0,
        description:
          this.agents.length > 0
            ? `${this.agents.length} agentes especialistas ativos: ${this.agents.map((a) => a.name).join(', ')}.`
            : 'Nenhum agente especialista conectado — depende do runtime de voz (rode "npm run setup:voice").'
      },
      {
        id: 'tools',
        name: 'Ferramentas do Sistema',
        phase: 5,
        available: false,
        description: 'Integrações e ferramentas operacionais não habilitadas nesta fase (previsto para Fase 5).'
      }
    ];
  }
}
