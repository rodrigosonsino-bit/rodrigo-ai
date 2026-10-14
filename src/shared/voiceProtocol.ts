/**
 * Contratos compartilhados do protocolo de voz (Fase 2 + Fase 3) — frontend <-> backend.
 * Eventos SSE emitidos em GET /api/voice/session/events.
 */

export type VoiceState = 'ouvindo' | 'processando' | 'falando' | 'aquecendo' | 'erro';

/** Fase 3 — rótulo de classificação de intenção. Nenhum tem especialista real ainda (Fase 4). */
// 'TELA' (Fase V) nunca vem do classificador: só o caminho de tela do sessionManager o emite no `routing`.
export type OrchestratorLabel = 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'NEUROCIENCIA' | 'AMBIGUO' | 'TELA';

/** Fase 5b — nomes de ferramentas suportadas pelo sistema e detecção. */
export const TOOL_NAMES = ['HORA', 'DATA', 'LEMBRETE_CONSULTAR', 'NOTA_CONSULTAR', 'MEMORIA_CONSULTAR', 'NENHUMA'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);
}

/** Fase 5c — nomes de mutações suportadas pelo sistema e detecção. */
export const MUTATION_NAMES = [
  'LEMBRETE_CRIAR',
  'LEMBRETE_EDITAR',
  'LEMBRETE_APAGAR',
  'LEMBRETE_REAGENDAR',
  'NOTA_CRIAR',
  'NOTA_EDITAR',
  'NOTA_APAGAR',
  'MEMORIA_GUARDAR',
  'MEMORIA_EDITAR',
  'MEMORIA_ESQUECER',
  'NENHUMA'
] as const;
export type MutationName = (typeof MUTATION_NAMES)[number];
export function isMutationName(v: unknown): v is MutationName {
  return typeof v === 'string' && (MUTATION_NAMES as readonly string[]).includes(v);
}

/**
 * Fase 14 — as 3 ações `*_CONSULTAR` são LEITURA, não mutação (vivem em TOOL_NAMES, não em
 * MUTATION_NAMES), mas são detectadas pelo mesmo pipeline de detecção de mutação (é ele que
 * extrai o termo de busca da fala). Este predicado existe pra quem precisa reconhecer as duas
 * famílias juntas (o gate de entrada no pipeline) sem também aceitar HORA/DATA/NENHUMA.
 */
export const QUERY_NAMES = ['LEMBRETE_CONSULTAR', 'NOTA_CONSULTAR', 'MEMORIA_CONSULTAR'] as const;
export type QueryName = (typeof QUERY_NAMES)[number];
export function isQueryName(v: unknown): v is QueryName {
  return typeof v === 'string' && (QUERY_NAMES as readonly string[]).includes(v);
}

/** Mensagem fixa do aviso de troca de voz (T9-política a). */
export const VOICE_FALLBACK_NOTICE = 'A voz do Google ficou indisponível agora; vou falar com a voz do sistema até ela voltar.';

export interface StateEvent {
  type: 'state';
  state: VoiceState;
}

export interface TranscriptEvent {
  type: 'transcript';
  turnId: string;
  text: string;
}

export interface SentenceAudioReadyEvent {
  type: 'sentence_audio_ready';
  turnId: string;
  sentenceIndex: number;
  audioId: string;
  text: string;
}

export interface TurnDoneEvent {
  type: 'turn_done';
  turnId: string;
}

/**
 * Fase 4 — decisão de roteamento, informativa/auditável, com efeito real na geração.
 * `handled` é `false` só para AMBIGUO (sem especialista dedicado — cai no agente Geral
 * com salvaguardas universais); GERAL, TEOLOGIA e VIRTOLOGIA são `true`, cada um com seu
 * agente real (ver src/backend/agents/specialistAgents.ts).
 */
export interface RoutingEvent {
  type: 'routing';
  turnId: string;
  label: OrchestratorLabel;
  handled: boolean;
}

export interface SessionPreemptedEvent {
  type: 'session_preempted';
}

/**
 * Fase V (docs/phase-vision-v3.md §4): pedido de UM quadro da tela, de uso único. O cliente responde com
 * `POST /api/voice/session/screen?captureId=...` (sucesso) ou `{ captureId, unavailable: true }` (sem
 * compartilhamento ativo) dentro do prazo; depois disso o `captureId` deixa de valer.
 */
export interface ScreenRequestEvent {
  type: 'screen_request';
  turnId: string;
  captureId: string;
}

/**
 * T9-política (a): aviso INFORMATIVO, no máximo uma vez por sessão, quando a voz do Gemini cai para a do sistema por
 * indisponibilidade (cota ou falha). Não é erro e não carrega texto de frase: só um código e a mensagem fixa.
 */
export interface VoiceNoticeEvent {
  type: 'voice_notice';
  code: 'tts_fallback';
  message: string;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  turnId?: string;
}

export type VoiceServerEvent =
  | StateEvent
  | TranscriptEvent
  | RoutingEvent
  | SentenceAudioReadyEvent
  | TurnDoneEvent
  | SessionPreemptedEvent
  | ScreenRequestEvent
  | VoiceNoticeEvent
  | ErrorEvent;

export interface CreateSessionResponse {
  sessionId: string;
  token: string;
}

export interface AudioTurnResponse {
  turnId: string;
}

/**
 * Mensagem de histórico confirmada (só entra depois que o cliente reproduziu o áudio até o fim).
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Fase V (docs/phase-vision-v3.md §5.3): 'screen' = pergunta ou resposta de um turno de tela. Nunca sai para o Gemini em
   * turnos seguintes — `windowHistory` remove essas mensagens de todo envio.
   */
  origin?: 'screen';
}

export const VOICE_LIMITS = {
  MAX_AUDIO_BYTES: 2 * 1024 * 1024,
  MAX_AUDIO_SECONDS: 20,
  MAX_TEXT_CHARS: 2000,
  MAX_TURN_TOKENS: 160,
  MAX_CONTEXT_TURNS: 8,
  MAX_CONTEXT_TOKENS: 4096,
  TURN_TIMEOUT_MS: 60_000,
  CLASSIFY_TIMEOUT_MS: 10_000,
  DETECT_TOOL_TIMEOUT_MS: 10_000,
  DETECT_MUTATION_TIMEOUT_MS: 10_000,
  /** F11 adendo: classificação de intenção em nuvem; passou disso => cai no detector local. */
  DETECT_INTENT_TIMEOUT_MS: 6_000,
  DETECT_CONFIRMATION_TIMEOUT_MS: 10_000,
  PENDING_MUTATION_TTL_MS: 60_000,
  WARMUP_TIMEOUT_MS: 120_000,
  IDLE_TIMEOUT_MS: 10 * 60_000,
  WORKER_SHUTDOWN_GRACE_MS: 3_000,
  /** Fase V §4: do screen_request até o quadro chegar (ou a resposta vira "compartilhe a tela e pergunte de novo"). */
  SCREEN_CAPTURE_TIMEOUT_MS: 5_000,
  /** Fase V §4, achado 8 (PNG de alta entropia em 1280² mede ~4,9 MB): JPEG 0,8 cabe bem abaixo disto. */
  MAX_SCREEN_IMAGE_BYTES: 3 * 1024 * 1024,
  MAX_SCREEN_IMAGE_DIM: 1600
} as const;

export const MAX_MUTATION_CONTENT_CHARS = 200;
/** F11 adendo: resultado da classificação de intenção em nuvem (Gemini). */
export type IntentName = MutationName | ToolName;
export interface IntentDetection {
  intent: IntentName;
  content: string | null;
  /** Modelo efetivo que respondeu (registro da medição; alias -latest muda de comportamento). */
  model?: string;
}

export const DETECT_MUTATION_TIMEOUT_MS = VOICE_LIMITS.DETECT_MUTATION_TIMEOUT_MS;
export const DETECT_CONFIRMATION_TIMEOUT_MS = VOICE_LIMITS.DETECT_CONFIRMATION_TIMEOUT_MS;
export const PENDING_MUTATION_TTL_MS = VOICE_LIMITS.PENDING_MUTATION_TTL_MS;
export const MUTATION_FAILURE_TEXT = 'Não consegui salvar isso agora.';
/** T4: a intenção não pôde ser registrada, então a mutação NÃO foi executada. */
export const AUDIT_REFUSED_TEXT = 'Não consegui registrar o que ia fazer, então não executei. Pode tentar de novo.';
/** T4: a mutação foi feita, mas o registro de conclusão falhou (a ação não é desfeita). */
export const AUDIT_CONCLUSION_LOST_TEXT = 'Atenção: fiz a ação, mas não consegui registrar a conclusão no histórico de auditoria.';
export const MUTATION_CANCELLED_TEXT = 'Tudo bem, não fiz nada.';
/** Idade máxima TOTAL de um pedido de mutação, contada do pedido original (o reprompt não renova). */
export const MUTATION_MAX_AGE_MS = 120_000;
export const NO_ACTION_CLAIM_TEXT = 'Eu não fiz isso. Para eu anotar ou criar um lembrete, peça direto, por exemplo: anota que.';
export const MUTATION_REPROMPT_TEXT = 'Não entendi. Posso confirmar? Diga só sim ou não.';
export const GENERATION_FAILURE_TEXT = 'Não consegui pensar numa resposta agora.';

/** Fase V, fatia 2: o caminho de tela existe, mas a visão chega na fatia 4. Dito quando a CAPTURA deu certo. */
export const SCREEN_NOT_READY_TEXT = 'Ainda estou aprendendo a enxergar a tela. Em breve consigo te ajudar com isso.';
/** Fase V, fatia 3: sem compartilhamento ativo, captureId vencido/rejeitado, ou upload inválido. */
export const SCREEN_SHARE_NEEDED_TEXT = 'Compartilhe a tela no botão da página e pergunte de novo.';

/** Fase 5a — consulta léxica local ao material de referência (docs/research). */
export const KNOWLEDGE_LIMITS = {
  /** Um trecho por turno. Com um só, o melhor colocado sempre entra e não há descarte silencioso. */
  MAX_CHUNKS: 1,
  /** Teto aplicado na CONSTRUÇÃO do índice: nenhum caminho posterior pode injetar mais que isso. */
  MAX_CHUNK_CHARS: 1200,
  MIN_CHUNK_CHARS: 80,
  /** Termo que casa no cabeçalho conta como N ocorrências. */
  HEADING_WEIGHT: 3,
  BM25_K1: 1.2,
  BM25_B: 0.75,
  /** Tolerância de igualdade de score em ponto flutuante (scores são somas de logs). */
  SCORE_EPSILON: 1e-9
} as const;
