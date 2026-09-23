/**
 * Contratos compartilhados do protocolo de voz (Fase 2 + Fase 3) — frontend <-> backend.
 * Eventos SSE emitidos em GET /api/voice/session/events.
 */

export type VoiceState = 'ouvindo' | 'processando' | 'falando' | 'aquecendo' | 'erro';

/** Fase 3 — rótulo de classificação de intenção. Nenhum tem especialista real ainda (Fase 4). */
export type OrchestratorLabel = 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'AMBIGUO';

/** Fase 5b — nomes de ferramentas suportadas pelo sistema e detecção. */
export const TOOL_NAMES = ['HORA', 'DATA', 'NENHUMA'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);
}

/** Fase 5c — nomes de mutações suportadas pelo sistema e detecção. */
export const MUTATION_NAMES = [
  'LEMBRETE_CRIAR',
  'LEMBRETE_APAGAR',
  'NOTA_CRIAR',
  'NOTA_APAGAR',
  'NENHUMA'
] as const;
export type MutationName = (typeof MUTATION_NAMES)[number];
export function isMutationName(v: unknown): v is MutationName {
  return typeof v === 'string' && (MUTATION_NAMES as readonly string[]).includes(v);
}

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
  DETECT_CONFIRMATION_TIMEOUT_MS: 10_000,
  PENDING_MUTATION_TTL_MS: 60_000,
  WARMUP_TIMEOUT_MS: 120_000,
  IDLE_TIMEOUT_MS: 10 * 60_000,
  WORKER_SHUTDOWN_GRACE_MS: 3_000
} as const;

export const MAX_MUTATION_CONTENT_CHARS = 200;
export const DETECT_MUTATION_TIMEOUT_MS = VOICE_LIMITS.DETECT_MUTATION_TIMEOUT_MS;
export const DETECT_CONFIRMATION_TIMEOUT_MS = VOICE_LIMITS.DETECT_CONFIRMATION_TIMEOUT_MS;
export const PENDING_MUTATION_TTL_MS = VOICE_LIMITS.PENDING_MUTATION_TTL_MS;
export const MUTATION_FAILURE_TEXT = 'Não consegui salvar isso agora.';
export const MUTATION_CANCELLED_TEXT = 'Tudo bem, não fiz nada.';

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
