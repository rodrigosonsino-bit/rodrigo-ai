import type { ConversationMessage, IntentDetection, MutationName, OrchestratorLabel, ToolName } from '../../shared/voiceProtocol.js';

export interface GenerateCallbacks {
  onSentence: (text: string, index: number) => void;
}

/**
 * Abstração sobre o motor de voz local (LLM + STT). A implementação real
 * (`MlxWorkerEngine`) fala com um worker Python via NDJSON; testes usam uma
 * implementação fake em memória, sem depender de Python/MLX instalados
 * (Fase 1 continua funcionando e testável mesmo sem o runtime de voz — B2).
 */
export interface VoiceEngine {
  /** true se os modelos já estão aquecidos agora (sem esperar). */
  isReadySync(): boolean;
  /** Resolve quando o motor está pronto para uso (modelos aquecidos). */
  waitUntilReady(timeoutMs: number): Promise<void>;
  transcribe(audioPath: string): Promise<string>;
  /**
   * Classifica a intenção do texto transcrito numa categoria (Fase 3). Nenhuma categoria
   * tem especialista real ainda — é decisão + transparência, não roteamento de verdade.
   */
  classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel>;
  /**
   * Fase 5b: decide se o texto pede uma ferramenta do sistema (HORA/DATA) ou nenhuma.
   * Nunca lança por "não reconheci a intenção" — isso é NENHUMA, não erro (ver
   * parse_tool_output, §4.9). Só rejeita por falha real do motor (timeout, worker
   * indisponível) — mesma semântica de classify().
   */
  detectTool(turnId: string, epoch: number, text: string): Promise<ToolName>;
  /**
   * Fase 5c: decide se o texto pede para CRIAR ou APAGAR um LEMBRETE ou uma NOTA.
   * Formato inesperado ou não reconhecimento degrada para ['NENHUMA', null].
   */
  detectMutation(
    turnId: string,
    epoch: number,
    text: string
  ): Promise<[MutationName, string | null]>;
  /**
   * F11 adendo: classificação de intenção (mutação/hora/data/nenhuma) em NUVEM (Gemini), só com o texto
   * da fala. Devolve null quando indisponível (desligada, sem chave, erro, timeout, saída inválida) —
   * o chamador então usa os detectores locais. Nunca lança por indisponibilidade.
   */
  detectIntent(turnId: string, epoch: number, text: string): Promise<IntentDetection | null>;
  /**
   * Fase 5c: decide se a fala confirma (SIM) ou nega/cancela (NAO) a pergunta de confirmação.
   */
  detectConfirmation(
    turnId: string,
    epoch: number,
    text: string
  ): Promise<'SIM' | 'NAO'>;
  /**
   * Gera a resposta de um turno. Resolve quando a geração termina (ou é cancelada).
   * Frases completas são emitidas incrementalmente via callbacks.onSentence.
   */
  generate(
    turnId: string,
    epoch: number,
    messages: ConversationMessage[],
    callbacks: GenerateCallbacks
  ): Promise<void>;
  /** Cancela cooperativamente o turno em andamento, se o turnId corresponder. */
  cancel(turnId: string): void;
  shutdown(): Promise<void>;
}

export class VoiceEngineError extends Error {}
