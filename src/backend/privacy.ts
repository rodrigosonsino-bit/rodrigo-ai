import type { PrivacyStatus } from '../shared/types.js';
import { VOICE_LIMITS } from '../shared/voiceProtocol.js';
import { isOutboundGuardMode, type OutboundGuardMode } from './privacy/outboundGuard.js';

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
  /** RODRIGO_HISTORY_TURNS — janela do histórico enviado (turnos; 1..MAX_CONTEXT_TURNS; padrão DEFAULT_CONTEXT_TURNS). */
  readonly historyTurns: number;
  /** RODRIGO_IDLE_TIMEOUT_MINUTES — timeout de inatividade em minutos (1..1440; padrão 60). */
  readonly idleTimeoutMinutes: number;
  /** RODRIGO_SEND_MEMORIES — bloco de memórias armazenadas no prompt. */
  readonly sendMemories: boolean;
  /** RODRIGO_SEND_KNOWLEDGE — trecho de docs/research/ no prompt (decisão D1: padrão 0). */
  readonly sendKnowledge: boolean;
  /** Fase 13a — RODRIGO_CLOUD_TTS: o texto de cada frase falada vai ao Gemini para virar voz. Só vale com o mestre ligado. */
  readonly cloudTts: boolean;
  /** Fase 13a, decisão D-b — RODRIGO_TTS_DICTATED: confirmações que repetem conteúdo ditado (prévia de nota/lembrete/memória) também vão à voz em nuvem. */
  readonly ttsDictated: boolean;
  /** Fase V — RODRIGO_CLOUD_VISION (padrão DESLIGADO, como todo canal de nuvem novo): imagem da tela ao Gemini só com este canal ligado E autorização explícita na fala. */
  readonly cloudVision: boolean;
  /**
   * Fase 15 — RODRIGO_WEB_SEARCH: leitura externa/nuvem autônoma (busca web via OpenClaw).
   * Padrão 0 — nunca autônoma sem ligar o canal explicitamente (docs/phase-15-v3.md §5).
   */
  readonly webSearch: boolean;
  /** T1 — RODRIGO_OUTBOUND_GUARD: off | warn | redact | block (padrão redact). Varre o TEXTO que sai para a nuvem. */
  readonly outboundGuard: OutboundGuardMode;
  /**
   * Fase 17 — RODRIGO_CLAUDE_CODE: habilita o ClaudeCodeSubAgent (spawna `claude -p`).
   * Padrão DESLIGADO. Ordem + arquivos lidos vão à Anthropic sob o plano da assinatura.
   * Só efetivo com RODRIGO_CLOUD=1 (mestre). Valor inválido aborta o boot.
   */
  readonly claudeCode: boolean;
  /**
   * Automação desktop (computer-use): RODRIGO_AUTO_DESKTOP.
   * Padrão DESLIGADO. Com 1 + RODRIGO_DESKTOP_CONTROL=1, intenções AUTOMACAO_DESKTOP
   * executam sem SIM por passo (kill switch por voz ainda vale). Valor inválido aborta o boot.
   */
  readonly autoDesktop: boolean;
  /**
   * Camada Ogra (fase 1): RODRIGO_OGRA. Padrão DESLIGADO. Com 1, a fala vai ao webhook
   * da Ogra e a resposta volta em POST /api/ogra/reply. Independente do mestre Gemini.
   * Valor inválido aborta o boot. Com 0, o caminho de voz não muda.
   */
  readonly ogra: boolean;
  /**
   * RODRIGO_OGRA_FALLBACK. Padrão LIGADO. Com 1, falha de transporte da Ogra (HTTP fora de 2xx,
   * prazo do webhook, rede, webhook ausente) e o silêncio depois do 2xx (sem POST /api/ogra/reply
   * dentro de ograReplyTimeoutMs) seguem o mesmo turno pelo caminho de RODRIGO_OGRA=0.
   * Com 0, esses casos encerram o turno. A Ogra não entra na cadeia de reserva do Gemini.
   * Valor inválido aborta o boot.
   */
  readonly ograFallback: boolean;
  /**
   * RODRIGO_OGRA_REPLY_TIMEOUT_MS. Prazo, em milissegundos, entre o 2xx do webhook e o
   * POST /api/ogra/reply. Padrão 120000. Inteiro entre 1000 e 600000. Vazio = padrão.
   * Valor inválido aborta o boot.
   */
  readonly ograReplyTimeoutMs: number;
}

/** Prazo padrão da resposta assíncrona da Ogra (RODRIGO_OGRA_REPLY_TIMEOUT_MS). */
export const OGRA_REPLY_TIMEOUT_DEFAULT_MS = 120_000;
export const OGRA_REPLY_TIMEOUT_MIN_MS = 1_000;
export const OGRA_REPLY_TIMEOUT_MAX_MS = 600_000;

/** Fase 13a: modelo e voz padrão do TTS (docs/phase-13a-v3.md §4.1); configuráveis por RODRIGO_TTS_MODEL / RODRIGO_TTS_VOICE. */
export const TTS_DEFAULT_MODEL = 'gemini-3.8-flash-lite-tts';
export const TTS_DEFAULT_VOICE = 'Charon';

/**
 * Fase 13a (v3 §3): o TTS em nuvem só fica EFETIVAMENTE ligado com o mestre ligado, o canal ligado E o histórico enviado
 * (RODRIGO_SEND_HISTORY=1). Regra conservadora: quem desligou o histórico declarou que fala do assistente não sai da
 * máquina; na dúvida, voz local. O cartão mostra o motivo.
 */
export function ttsCloudEffective(cfg: PrivacyConfig): boolean {
  return cfg.cloud && cfg.cloudTts && cfg.sendHistory;
}

export type TtsOffReason = 'master-off' | 'channel-off' | 'history-off';

export function ttsOffReason(cfg: PrivacyConfig): TtsOffReason | null {
  if (!cfg.cloud) return 'master-off';
  if (!cfg.cloudTts) return 'channel-off';
  if (!cfg.sendHistory) return 'history-off';
  return null;
}

/** D-b: conteúdo ditado vai à voz em nuvem só com o TTS efetivo, a flag ligada e memórias na nuvem permitidas. */
export function ttsDictatedViaCloud(cfg: PrivacyConfig): boolean {
  return ttsCloudEffective(cfg) && cfg.ttsDictated && cfg.sendMemories;
}

/** T1: fala usada quando o modo block impede o envio do prompt (nada saiu; texto fixo, sem eco do conteúdo). */
export const OUTBOUND_BLOCKED_TEXT =
  'Detectei um dado sensível na conversa e, pela configuração de privacidade, não enviei esse pedido à nuvem.';

export const GENERATION_DISABLED_TEXT =
  'A geração de respostas em nuvem está desligada. Posso usar só as ferramentas locais, como hora, data, lembretes e notas.';

/** Fase 15 §5 — busca web desligada (mesmo padrão de fala honesta de GENERATION_DISABLED_TEXT). */
export const WEB_SEARCH_DISABLED_TEXT =
  'A busca na web está desligada; quer que eu ligue?';

/**
 * Fase 15 §5: busca web só com o mestre ligado E o canal RODRIGO_WEB_SEARCH=1.
 * Espelha a regra efetiva de cloudVision/cloudTts (mestre + sub-canal).
 */
export function webSearchEffective(cfg: PrivacyConfig): boolean {
  return cfg.cloud && cfg.webSearch;
}

export type WebSearchOffReason = 'master-off' | 'channel-off';

export function webSearchOffReason(cfg: PrivacyConfig): WebSearchOffReason | null {
  if (!cfg.cloud) return 'master-off';
  if (!cfg.webSearch) return 'channel-off';
  return null;
}

/**
 * Fase 17: Claude Code só com o mestre ligado E RODRIGO_CLAUDE_CODE=1.
 * Ordem + arquivos lidos vão à Anthropic; canal opt-in, padrão desligado.
 */
export function claudeCodeEffective(cfg: PrivacyConfig): boolean {
  return cfg.cloud && cfg.claudeCode;
}

export type ClaudeCodeOffReason = 'master-off' | 'channel-off';

export function claudeCodeOffReason(cfg: PrivacyConfig): ClaudeCodeOffReason | null {
  if (!cfg.cloud) return 'master-off';
  if (!cfg.claudeCode) return 'channel-off';
  return null;
}

/** Fase 17: fala honesta quando o canal está desligado (mesmo padrão de WEB_SEARCH_DISABLED_TEXT). */
export const CLAUDE_CODE_DISABLED_TEXT =
  'A delegação ao Claude está desligada. Para ligar, é preciso ativar RODRIGO_CLAUDE_CODE e configurar uma pasta de leitura.';
/**
 * Automação desktop efetiva: RODRIGO_AUTO_DESKTOP=1 E controle de desktop ligado.
 * Não envia áudio; AX/texto só saem pelos canais de geração/visão já configurados.
 */
export function autoDesktopEffective(
  cfg: PrivacyConfig,
  desktopControlOn: boolean
): boolean {
  return cfg.autoDesktop && desktopControlOn;
}

export type AutoDesktopOffReason = 'flag-off' | 'desktop-control-off';

export function autoDesktopOffReason(
  cfg: PrivacyConfig,
  desktopControlOn: boolean
): AutoDesktopOffReason | null {
  if (!cfg.autoDesktop) return 'flag-off';
  if (!desktopControlOn) return 'desktop-control-off';
  return null;
}

/** Ogra efetiva: só RODRIGO_OGRA=1. Não depende do mestre Gemini (é outro destino). */
export function ograEffective(cfg: PrivacyConfig): boolean {
  return cfg.ogra;
}

type Env = Readonly<Record<string, string | undefined>>;

function parseFlag(env: Env, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const v = raw.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  throw new Error(`Configuração inválida: ${name} deve ser exatamente "0" ou "1". Valor recebido: "${raw}"`);
}

function parseGuardMode(env: Env, name: string, defaultValue: OutboundGuardMode): OutboundGuardMode {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const v = raw.trim();
  if (isOutboundGuardMode(v)) return v;
  throw new Error(`Configuração inválida: ${name} deve ser exatamente "off", "warn", "redact" ou "block". Valor recebido: "${raw}"`);
}

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

export function parseOgraReplyTimeoutMs(
  env: Env,
  name = 'RODRIGO_OGRA_REPLY_TIMEOUT_MS',
  defaultValue = OGRA_REPLY_TIMEOUT_DEFAULT_MS,
  min = OGRA_REPLY_TIMEOUT_MIN_MS,
  max = OGRA_REPLY_TIMEOUT_MAX_MS
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,6}$/.test(v)) {
    throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre ${min} e ${max}. Valor recebido: "${raw}"`);
  }
  const n = parseInt(v, 10);
  if (n < min || n > max) {
    throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre ${min} e ${max}. Valor recebido: "${raw}"`);
  }
  return n;
}

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

export function parsePrivacyConfig(env: Env): PrivacyConfig {
  return {
    cloud: parseFlag(env, 'RODRIGO_CLOUD', true),
    cloudIntent: parseFlag(env, 'RODRIGO_CLOUD_INTENT', true),
    sendHistory: parseFlag(env, 'RODRIGO_SEND_HISTORY', true),
    historyTurns: parseTurns(env, 'RODRIGO_HISTORY_TURNS', VOICE_LIMITS.DEFAULT_CONTEXT_TURNS, VOICE_LIMITS.MAX_CONTEXT_TURNS),
    idleTimeoutMinutes: parseIdleMinutes(env, 'RODRIGO_IDLE_TIMEOUT_MINUTES', 60, 1, 1440),
    sendMemories: parseFlag(env, 'RODRIGO_SEND_MEMORIES', true),
    sendKnowledge: parseFlag(env, 'RODRIGO_SEND_KNOWLEDGE', false),
    cloudTts: parseFlag(env, 'RODRIGO_CLOUD_TTS', true),
    ttsDictated: parseFlag(env, 'RODRIGO_TTS_DICTATED', true),
    cloudVision: parseFlag(env, 'RODRIGO_CLOUD_VISION', false),
    webSearch: parseFlag(env, 'RODRIGO_WEB_SEARCH', false),
    outboundGuard: parseGuardMode(env, 'RODRIGO_OUTBOUND_GUARD', 'redact'),
    claudeCode: parseFlag(env, 'RODRIGO_CLAUDE_CODE', false),
    autoDesktop: parseFlag(env, 'RODRIGO_AUTO_DESKTOP', false),
    ogra: parseFlag(env, 'RODRIGO_OGRA', false),
    ograFallback: parseFlag(env, 'RODRIGO_OGRA_FALLBACK', true),
    ograReplyTimeoutMs: parseOgraReplyTimeoutMs(env)
  };
}

/**
 * Alias estável citado no plano F15 (envToPrivacyConfig) — mesma função que parsePrivacyConfig.
 * Preferir parsePrivacyConfig em código novo; este nome existe para casar com a auditoria r3 N4.
 */
export const envToPrivacyConfig = parsePrivacyConfig;

/** Padrões de produção (sem variáveis definidas). */
export const DEFAULT_PRIVACY: PrivacyConfig = parsePrivacyConfig({});

/** Variáveis que o worker Python precisa receber para aplicar o mesmo mestre (defesa em profundidade). */
export function workerPrivacyEnv(cfg: PrivacyConfig): Record<string, string> {
  return {
    RODRIGO_CLOUD: cfg.cloud ? '1' : '0',
    RODRIGO_CLOUD_INTENT: cfg.cloud && cfg.cloudIntent ? '1' : '0',
    RODRIGO_CLOUD_TTS: ttsCloudEffective(cfg) ? '1' : '0',
    // Fase V: o worker recebe o valor JÁ resolvido aqui (mestre + canal), nunca lê um padrão próprio: os dois lados não divergem.
    RODRIGO_CLOUD_VISION: cfg.cloud && cfg.cloudVision ? '1' : '0',
    // T1: o worker aplica o mesmo modo do guarda de saída (camada em profundidade).
    RODRIGO_OUTBOUND_GUARD: cfg.outboundGuard
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
  const ttsOn = ttsCloudEffective(cfg);
  const webOn = webSearchEffective(cfg);
  const claudeOn = claudeCodeEffective(cfg);
  // Espelho de parseDesktopControlFlag (evita import circular com desktopControlTool).
  let desktopOn = true;
  const rawDesktop = env['RODRIGO_DESKTOP_CONTROL'];
  if (rawDesktop !== undefined && rawDesktop.trim() !== '') {
    const v = rawDesktop.trim();
    if (v === '0') desktopOn = false;
    else if (v !== '1') desktopOn = false; // valor inválido: cartão mostra off; o boot já falhou via parseDesktopControlFlag
  }
  const autoOn = autoDesktopEffective(cfg, desktopOn);
  return {
    mode: cfg.cloud ? 'cloud' : 'local-only',
    intent: intentOn ? 'gemini' : 'local',
    keyPresent: typeof key === 'string' && key.trim().length > 0,
    sends: {
      utteranceForIntent: intentOn,
      history: cfg.cloud && cfg.sendHistory,
      historyTurns: cfg.cloud && cfg.sendHistory ? cfg.historyTurns : null,
      memories: cfg.cloud && cfg.sendMemories,
      knowledgeSnippet: cfg.cloud && cfg.sendKnowledge,
      ttsText: ttsOn,
      visionImage: cfg.cloud && cfg.cloudVision,
      webSearch: webOn,
      claudeCodeOrder: claudeOn,
      ograUtterance: cfg.ogra
    },
    models: {
      generation: cfg.cloud ? 'gemini-flash-latest' : null,
      intent: intentOn ? (env['RODRIGO_CLOUD_INTENT_MODEL'] || 'gemini-3.5-flash-lite') : null,
      tts: ttsOn ? (env['RODRIGO_TTS_MODEL'] || TTS_DEFAULT_MODEL) : null
    },
    tts: { cloud: ttsOn, reason: ttsOffReason(cfg), dictatedViaCloud: ttsDictatedViaCloud(cfg) },
    webSearch: { enabled: webOn, reason: webSearchOffReason(cfg) },
    claudeCode: { enabled: claudeOn, reason: claudeCodeOffReason(cfg) },
    autoDesktop: { enabled: autoOn, reason: autoDesktopOffReason(cfg, desktopOn) },
    ogra: { enabled: cfg.ogra },
    neverSends: ['audio'],
    outboundGuard: cfg.outboundGuard
  };
}
