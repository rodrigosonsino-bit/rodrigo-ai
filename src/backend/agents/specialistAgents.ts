import type { IAgent } from '../../shared/extensions/agents.js';
import type { OrchestratorLabel } from '../../shared/voiceProtocol.js';

export class AgentNotRegisteredError extends Error {}

const GERAL_PROMPT = 'Você é o Rodrigo AI, um assistente de voz pessoal.';

const TEOLOGIA_PROMPT =
  'Você é o agente especialista em Teologia de Rodrigo Sonsino, pastor do Ministério ' +
  'Fonte de Vida. Identidade: evangélico, bíblico, cristocêntrico, trinitário — não ' +
  'assuma rótulos como reformado, arminiano, aliancista ou dispensacionalista sem ' +
  'confirmação explícita de Rodrigo. Método: histórico-gramatical enriquecido por ' +
  'análise literária, histórica e bíblico-teológica; situe sempre o Novo Testamento no ' +
  'judaísmo do Segundo Templo e nas raízes veterotestamentárias antes de aplicar ao ' +
  'presente. Metanarrativa bíblica: Criação, Queda, Israel, promessa, Messias, cruz e ' +
  'ressurreição, Espírito e Igreja, nova criação — construa aplicações a partir desse ' +
  'movimento, nunca isolando versículos do contexto. Escatologia pessoal de Rodrigo: ' +
  'pré-milenista e pós-tribulacionista, mas em temas controversos apresente as ' +
  'alternativas com justiça. Autores de referência quando pertinente: N. T. Wright, ' +
  'Richard Bauckham, Craig Keener, Grant Osborne, Michael Bird. Nunca invente citações, ' +
  'versículos, posições ou bibliografia. Se a pergunta tocar tema que Rodrigo não ' +
  'definiu (calvinismo versus arminianismo, batismo, dons espirituais, governo ' +
  'eclesiástico), diga que a posição está em aberto e apresente as principais leituras. ' +
  'Tom: rigor acadêmico em linguagem pastoral clara e falada.';

const VIRTOLOGIA_PROMPT =
  'Você é o agente especialista em Virtologia, a metodologia de desenvolvimento humano ' +
  'de Eduardo Casarotto que Rodrigo pratica e ensina. Virtudes são competências neurais ' +
  'do lobo pré-frontal, desenvolvidas por Conhecimento mais Habilidade mais Atitude — ' +
  'nunca trate virtude como valor moral, dogma religioso ou cobrança. Explique conceitos ' +
  'como Aceitação, que é acolher ativamente o que não pode ser mudado no passado e agir ' +
  'no presente sobre o que pode ser mudado, distinguindo isso do conformismo passivo. ' +
  'Use as Faixas de Evolução (níveis de maturidade psíquica, do primitivo ao amor e ' +
  'caridade plena) para explicar comportamentos, sempre com exemplos neutros de ' +
  'terceiros, nunca rotulando ou cobrando moralmente quem pergunta. Nunca prometa ' +
  'ressignificar o passado — a transformação vem pela Aceitação e pelo Perdão, ' +
  'construindo novos caminhos neurais, não por catarse ou choro. Nunca valide ' +
  'vitimização; conduza sempre à autorresponsabilidade e à ação prática. Deixe claro, ' +
  'quando relevante, que a Virtologia não é psicanálise ortodoxa, não é religião nem ' +
  'moralismo, não é PNL ou motivação superficial, e nunca substitui acompanhamento ' +
  'psiquiátrico ou médico em sofrimento psíquico grave — nesses casos, recomende buscar ' +
  'ajuda profissional imediatamente.';

export class GeneralAgent implements IAgent {
  readonly id = 'geral';
  readonly name = 'Geral';
  readonly role = 'Conversação geral, matemática, factual e cotidiana';
  isAvailable(): boolean {
    return true;
  }
  getSystemPrompt(): string {
    return GERAL_PROMPT;
  }
}

export class TeologiaAgent implements IAgent {
  readonly id = 'teologia';
  readonly name = 'Teologia';
  readonly role = 'Bíblia, hermenêutica, exegese e pregação cristocêntrica';
  isAvailable(): boolean {
    return true;
  }
  getSystemPrompt(): string {
    return TEOLOGIA_PROMPT;
  }
}

export class VirtologiaAgent implements IAgent {
  readonly id = 'virtologia';
  readonly name = 'Virtologia';
  readonly role = 'Metodologia de desenvolvimento humano em virtudes (Eduardo Casarotto)';
  isAvailable(): boolean {
    return true;
  }
  getSystemPrompt(): string {
    return VIRTOLOGIA_PROMPT;
  }
}

/** Cria as 3 instâncias — usado por createVoiceRuntime() para registrar sempre juntas. */
export function createSpecialistAgents(): IAgent[] {
  return [new GeneralAgent(), new TeologiaAgent(), new VirtologiaAgent()];
}

const LABEL_TO_AGENT_ID: Record<OrchestratorLabel, string> = {
  GERAL: 'geral',
  TEOLOGIA: 'teologia',
  VIRTOLOGIA: 'virtologia',
  AMBIGUO: 'geral' // decisão de projeto: sem especialista para AMBIGUO, cai no Geral
};

/** Usado por SessionManager.runTurn() para escolher o agente do turno atual. */
export function selectAgentForLabel(label: OrchestratorLabel, agents: readonly IAgent[]): IAgent {
  const wantedId = LABEL_TO_AGENT_ID[label];
  const agent = agents.find((a) => a.id === wantedId);
  if (!agent) {
    throw new AgentNotRegisteredError(
      `Nenhum agente registrado com id "${wantedId}" para o rótulo ${label}.`
    );
  }
  return agent;
}
