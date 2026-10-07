import type { IVoiceProvider } from './voice.js';
import type { IAgent } from './agents.js';
import type { ITool, IMutatingTool } from './tools.js';
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
  private readonly mutatingTools: IMutatingTool[] = [];
  /** Fase 5a: nº de trechos de referência carregados. 0 = corpus ausente => módulo indisponível. */
  private knowledgeChunkCount = 0;
  /** Fase 12 (D1): o trecho de pesquisa só vai ao Gemini com RODRIGO_SEND_KNOWLEDGE=1; desligado, o corpus nem é carregado. */
  private knowledgeDisabledByPrivacy = false;

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

  /**
   * Fase 5b: registra ferramentas do sistema.
   * Idempotente por name — registrar a mesma ferramenta duas vezes não duplica.
   */
  public registerTool(tool: ITool): void {
    if (this.tools.some((t) => t.name === tool.name)) return;
    this.tools.push(tool);
  }

  public getMutatingTools(): readonly IMutatingTool[] {
    return this.mutatingTools;
  }

  /**
   * Fase 5c: registra ferramentas que mutam estado.
   * Idempotente por name — registrar a mesma ferramenta duas vezes não duplica.
   */
  public registerMutatingTool(tool: IMutatingTool): void {
    if (this.mutatingTools.some((t) => t.name === tool.name)) return;
    this.mutatingTools.push(tool);
  }

  /** Fase 5a: registra quantos trechos de referência foram carregados. */
  public registerKnowledge(chunkCount: number): void {
    this.knowledgeChunkCount = chunkCount;
  }

  /** Fase 12: marca a consulta de conhecimento como desligada por privacidade (não por ausência de material). */
  public registerKnowledgeDisabledByPrivacy(disabled: boolean): void {
    this.knowledgeDisabledByPrivacy = disabled;
  }

  /** Só para teste: zera o estado do singleton in-place, sem substituir a instância. */
  public resetForTesting(): void {
    this.voiceProviders.length = 0;
    this.agents.length = 0;
    this.tools.length = 0;
    this.mutatingTools.length = 0;
    this.knowledgeChunkCount = 0;
    this.knowledgeDisabledByPrivacy = false;
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
        available: this.tools.length > 0,
        description:
          this.tools.length > 0
            ? `${this.tools.length} ferramentas ativas: ${this.tools.map((t) => t.name).join(', ')}.`
            : 'Nenhuma ferramenta conectada — depende do runtime de voz (rode "npm run setup:voice").'
      }
      ,{
        id: 'knowledge',
        name: 'Conhecimento especializado',
        phase: 5,
        available: this.knowledgeChunkCount > 0,
        description: this.knowledgeDisabledByPrivacy
          ? 'Desligado por privacidade: os textos de pesquisa não são carregados nem enviados ao Gemini (ligue com RODRIGO_SEND_KNOWLEDGE=1).'
          : this.knowledgeChunkCount > 0
            ? `Consulta léxica local sobre ${this.knowledgeChunkCount} trechos de referência de Teologia e Virtologia; o trecho consultado é enviado ao Gemini junto com a resposta.`
            : 'Material de referência não encontrado em docs/research — agentes respondem sem consulta.'
      }
    ];
  }
}
