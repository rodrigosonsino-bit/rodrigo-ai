import type { ConversationMessage, OrchestratorLabel } from '../../shared/voiceProtocol.js';

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
