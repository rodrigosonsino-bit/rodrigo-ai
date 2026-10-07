import type { PrivacyStatus } from '../shared/types.js';
import { VOICE_LIMITS } from '../shared/voiceProtocol.js';

/**
 * Fase 12 (docs/phase-12-v2.md §2.1): um controle por canal de saída para o Gemini.
 * Esta é a ÚNICA fonte da verdade — o gerenciador de sessão, o worker (via env) e /api/privacy
 * leem a mesma estrutura. Valores inválidos LANÇAM no startup (falhar alto é mais seguro do
 * que adivinhar um padrão numa configuração de privacidade).
 */
export interface PrivacyConfig {
  /** RODRIGO_CLOUD — mestre: 0 desliga TODA chamada ao Gemini (geração e intenção). */
  readonly cloud: boolean;
  /** RODRIGO_CLOUD_INTENT — sub-interruptor da intenção; só vale com o mestre ligado. */
  readonly cloudIntent: boolean;
  /** RODRIGO_SEND_HISTORY — 0 => só a fala do turno atual vai à geração. */
  readonly sendHistory: boolean;
  /** RODRIGO_HISTORY_TURNS — janela do histórico enviado (turnos; 1..MAX_CONTEXT_TURNS). */
  readonly historyTurns: number;
  /** RODRIGO_SEND_MEMORIES — bloco de memórias armazenadas no prompt. */
  readonly sendMemories: boolean;
  /** RODRIGO_SEND_KNOWLEDGE — trecho de docs/research/ no prompt (decisão D1: padrão 0). */
  readonly sendKnowledge: boolean;
}

export const GENERATION_DISABLED_TEXT =
  'A geração de respostas em nuvem está desligada. Posso usar só as ferramentas locais, como hora, data, lembretes e notas.';

type Env = Readonly<Record<string, string | undefined>>;

function parseFlag(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const v = raw.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  throw new Error(`Configuração inválida: ${name} deve ser exatamente "0" ou "1". Valor recebido: "${raw}"`);
}

function parseTurns(env: Env, name: string, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return max;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,2}$/.test(v)) {
    throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre 1 e ${max}. Valor recebido: "${raw}"`);
  }
  const n = parseInt(v, 10);
  if (n > max) {
    throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre 1 e ${max}. Valor recebido: "${raw}"`);
  }
  return n;
}

export function parsePrivacyConfig(env: Env): PrivacyConfig {
  return {
    cloud: parseFlag(env, 'RODRIGO_CLOUD', true),
    cloudIntent: parseFlag(env, 'RODRIGO_CLOUD_INTENT', true),
    sendHistory: parseFlag(env, 'RODRIGO_SEND_HISTORY', true),
    historyTurns: parseTurns(env, 'RODRIGO_HISTORY_TURNS', VOICE_LIMITS.MAX_CONTEXT_TURNS),
    sendMemories: parseFlag(env, 'RODRIGO_SEND_MEMORIES', true),
    sendKnowledge: parseFlag(env, 'RODRIGO_SEND_KNOWLEDGE', false)
  };
}

/** Padrões de produção (sem variáveis definidas). */
export const DEFAULT_PRIVACY: PrivacyConfig = parsePrivacyConfig({});

/** Variáveis que o worker Python precisa receber para aplicar o mesmo mestre (defesa em profundidade). */
export function workerPrivacyEnv(cfg: PrivacyConfig): Record<string, string> {
  return {
    RODRIGO_CLOUD: cfg.cloud ? '1' : '0',
    RODRIGO_CLOUD_INTENT: cfg.cloud && cfg.cloudIntent ? '1' : '0'
  };
}

/**
 * O que o sistema está CONFIGURADO para enviar. Não é medição de tráfego — a medição é o teste
 * H12.2 (Gemini falso em loopback). A tela rotula isto como "configuração em vigor".
 */
export function effectivePrivacy(env: Env): PrivacyStatus {
  const cfg = parsePrivacyConfig(env);
  const key = env['GEMINI_API_KEY'];
  const intentOn = cfg.cloud && cfg.cloudIntent;
  return {
    mode: cfg.cloud ? 'cloud' : 'local-only',
    intent: intentOn ? 'gemini' : 'local',
    keyPresent: typeof key === 'string' && key.trim().length > 0,
    sends: {
      utteranceForIntent: intentOn,
      history: cfg.cloud && cfg.sendHistory,
      historyTurns: cfg.cloud && cfg.sendHistory ? cfg.historyTurns : null,
      memories: cfg.cloud && cfg.sendMemories,
      knowledgeSnippet: cfg.cloud && cfg.sendKnowledge
    },
    models: {
      generation: cfg.cloud ? 'gemini-flash-latest' : null,
      intent: intentOn ? (env['RODRIGO_CLOUD_INTENT_MODEL'] || 'gemini-3.5-flash-lite') : null
    },
    neverSends: ['audio']
  };
}
