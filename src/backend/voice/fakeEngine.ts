import type { ConversationMessage, OrchestratorLabel } from '../../shared/voiceProtocol.js';
import type { GenerateCallbacks, VoiceEngine } from './engine.js';

interface ClassifyGate {
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

/**
 * Motor de voz fake, determinístico, sem MLX/Python — usado em testes (B4/B5, e Fase 3
 * C5) para validar sessão, cancelamento, preempção e turnId sem depender do runtime pesado.
 */
export class FakeVoiceEngine implements VoiceEngine {
  public transcribeCalls: string[] = [];
  public generateCalls: Array<{ turnId: string; epoch: number; messages: ConversationMessage[] }> = [];
  public classifyCalls: Array<{ turnId: string; text: string }> = [];
  public cancelledTurnIds: string[] = [];
  public shutdownCalled = false;

  private cancelledSet = new Set<string>();
  public fixedTranscript = 'olá rodrigo';
  public sentencesToEmit = ['Olá!', 'Como posso ajudar?'];
  /** Atraso simulado (ms) entre frases, para testes de cancelamento no meio da geração. */
  public sentenceDelayMs = 0;

  public classificationToReturn: OrchestratorLabel = 'GERAL';
  /**
   * Se 0 (padrão), classify() resolve no mesmo tick. Se > 0, fica pendente até esse
   * tempo OU até releaseClassifyGate(turnId)/cancel(turnId) liberar manualmente — usado
   * pelos testes que precisam provar cancelamento real (Achado 5 da auditoria: um fake
   * que só espera e retorna não prova nada sobre limpeza de pending/timer).
   */
  public classifySettleDelayMs = 0;
  private classifyGates = new Map<string, ClassifyGate>();

  isReadySync(): boolean {
    return true;
  }

  async waitUntilReady(): Promise<void> {
    return;
  }

  async transcribe(audioPath: string): Promise<string> {
    this.transcribeCalls.push(audioPath);
    return this.fixedTranscript;
  }

  async classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel> {
    this.classifyCalls.push({ turnId, text });

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      if (this.classifySettleDelayMs > 0) {
        timer = setTimeout(resolve, this.classifySettleDelayMs);
      }
      this.classifyGates.set(turnId, { resolve, timer });
      if (this.classifySettleDelayMs === 0) resolve();
    });

    this.classifyGates.delete(turnId);
    if (this.cancelledSet.has(turnId)) {
      throw new Error(`Classificação do turno ${turnId} cancelada.`);
    }
    return this.classificationToReturn;
  }

  /** Libera manualmente uma classificação travada em classifySettleDelayMs alto (sem cancelar). */
  releaseClassifyGate(turnId: string): void {
    const gate = this.classifyGates.get(turnId);
    if (!gate) return;
    if (gate.timer) clearTimeout(gate.timer);
    this.classifyGates.delete(turnId);
    gate.resolve();
  }

  isClassifyPending(turnId: string): boolean {
    return this.classifyGates.has(turnId);
  }

  async generate(
    turnId: string,
    epoch: number,
    messages: ConversationMessage[],
    callbacks: GenerateCallbacks
  ): Promise<void> {
    this.generateCalls.push({ turnId, epoch, messages });

    for (let i = 0; i < this.sentencesToEmit.length; i += 1) {
      if (this.cancelledSet.has(turnId)) {
        return;
      }
      if (this.sentenceDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.sentenceDelayMs));
      }
      if (this.cancelledSet.has(turnId)) {
        return;
      }
      callbacks.onSentence(this.sentencesToEmit[i], i);
    }
  }

  cancel(turnId: string): void {
    this.cancelledSet.add(turnId);
    this.cancelledTurnIds.push(turnId);

    // Achado v2-3 da auditoria: limpar o timer do gate (não só resolvê-lo) — sem isso,
    // um classifySettleDelayMs alto deixa um setTimeout vazando no runner de testes.
    const gate = this.classifyGates.get(turnId);
    if (gate) {
      if (gate.timer) clearTimeout(gate.timer);
      this.classifyGates.delete(turnId);
      gate.resolve();
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }
}
