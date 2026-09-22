import type { ConversationMessage, OrchestratorLabel, ToolName } from '../../shared/voiceProtocol.js';
import type { GenerateCallbacks, VoiceEngine } from './engine.js';

interface ClassifyGate {
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

interface DetectToolGate {
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
  public detectToolCalls: Array<{ turnId: string; text: string }> = [];
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

  public toolToReturn: ToolName = 'NENHUMA';
  public detectToolSettleDelayMs = 0;
  private detectToolGates = new Map<string, DetectToolGate>();

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

  async detectTool(turnId: string, epoch: number, text: string): Promise<ToolName> {
    this.detectToolCalls.push({ turnId, text });

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      if (this.detectToolSettleDelayMs > 0) {
        timer = setTimeout(resolve, this.detectToolSettleDelayMs);
      }
      this.detectToolGates.set(turnId, { resolve, timer });
      if (this.detectToolSettleDelayMs === 0) resolve();
    });

    this.detectToolGates.delete(turnId);
    if (this.cancelledSet.has(turnId)) {
      throw new Error(`Detecção de ferramenta do turno ${turnId} cancelada.`);
    }
    return this.toolToReturn;
  }

  /** Libera manualmente uma detecção travada em detectToolSettleDelayMs alto (sem cancelar). */
  releaseDetectToolGate(turnId: string): void {
    const gate = this.detectToolGates.get(turnId);
    if (!gate) return;
    if (gate.timer) clearTimeout(gate.timer);
    this.detectToolGates.delete(turnId);
    gate.resolve();
  }

  isDetectToolPending(turnId: string): boolean {
    return this.detectToolGates.has(turnId);
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

    // Bloco já existente (fakeEngine.ts:107-114), para classifyGates — inalterado:
    const classifyGate = this.classifyGates.get(turnId);
    if (classifyGate) {
      if (classifyGate.timer) clearTimeout(classifyGate.timer);
      this.classifyGates.delete(turnId);
      classifyGate.resolve();
    }

    // Achado 2 (ALTA) da rodada 5 — o mesmo bloco, repetido para detectToolGates. Sem isto,
    // isDetectToolPending(turnId) continua true depois de cancel(), e H8 falha.
    const detectToolGate = this.detectToolGates.get(turnId);
    if (detectToolGate) {
      if (detectToolGate.timer) clearTimeout(detectToolGate.timer);
      this.detectToolGates.delete(turnId);
      detectToolGate.resolve();
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }
}
