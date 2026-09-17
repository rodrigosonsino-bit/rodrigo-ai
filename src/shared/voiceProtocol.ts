/**
 * Contratos compartilhados do protocolo de voz (Fase 2 + Fase 3) — frontend <-> backend.
 * Eventos SSE emitidos em GET /api/voice/session/events.
 */

export type VoiceState = 'ouvindo' | 'processando' | 'falando' | 'aquecendo' | 'erro';

/** Fase 3 — rótulo de classificação de intenção. Nenhum tem especialista real ainda (Fase 4). */
export type OrchestratorLabel = 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'AMBIGUO';

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
  WARMUP_TIMEOUT_MS: 120_000,
  IDLE_TIMEOUT_MS: 10 * 60_000,
  WORKER_SHUTDOWN_GRACE_MS: 3_000
} as const;

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
