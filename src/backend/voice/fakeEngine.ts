import type { ConversationMessage, IntentDetection, MutationName, OrchestratorLabel, ToolName } from '../../shared/voiceProtocol.js';
import fs from 'node:fs';
import type { GenerateCallbacks, SynthesizeRequest, SynthesizeResult, VoiceEngine } from './engine.js';

interface ClassifyGate {
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

interface DetectToolGate {
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

interface DetectMutationGate {
  resolve: () => void;
  timer: NodeJS.Timeout | null;
}

interface DetectConfirmationGate {
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
  public detectMutationCalls: Array<{ turnId: string; text: string }> = [];
  public detectConfirmationCalls: Array<{ turnId: string; text: string }> = [];
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

  public mutationToReturn: [MutationName, string | null] = ['NENHUMA', null];
  public detectMutationSettleDelayMs = 0;
  private detectMutationGates = new Map<string, DetectMutationGate>();

  public confirmationToReturn: 'SIM' | 'NAO' = 'NAO';
  public detectConfirmationSettleDelayMs = 0;
  private detectConfirmationGates = new Map<string, DetectConfirmationGate>();

  /** Fase 13a: pedidos de síntese em nuvem recebidos. */
  public synthCalls: SynthesizeRequest[] = [];
  /** Comportamento da síntese fake; padrão: grava um WAV mínimo em outPath e devolve ok. */
  public synthBehavior: ((req: SynthesizeRequest, signal?: AbortSignal) => Promise<SynthesizeResult>) | null = null;

  async synthesize(request: SynthesizeRequest, signal?: AbortSignal): Promise<SynthesizeResult> {
    this.synthCalls.push(request);
    if (this.synthBehavior) return this.synthBehavior(request, signal);
    if (signal?.aborted) return { ok: false, kind: 'cancelled' };
    const data = Buffer.alloc(4800); // 0,1 s de silêncio a 24 kHz
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    await fs.promises.writeFile(request.outPath, Buffer.concat([header, data]));
    return { ok: true, seconds: 0.1, tokensIn: 5, tokensOut: 3 };
  }

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

  /** F11 adendo: null (padrão) = nuvem indisponível => o sessionManager usa os detectores locais. */
  public intentToReturn: IntentDetection | null = null;
  public detectIntentCalls: Array<{ turnId: string; text: string }> = [];

  async detectIntent(turnId: string, _epoch: number, text: string): Promise<IntentDetection | null> {
    this.detectIntentCalls.push({ turnId, text });
    return this.intentToReturn;
  }

  async detectMutation(
    turnId: string,
    epoch: number,
    text: string
  ): Promise<[MutationName, string | null]> {
    this.detectMutationCalls.push({ turnId, text });

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      if (this.detectMutationSettleDelayMs > 0) {
        timer = setTimeout(resolve, this.detectMutationSettleDelayMs);
      }
      this.detectMutationGates.set(turnId, { resolve, timer });
      if (this.detectMutationSettleDelayMs === 0) resolve();
    });

    this.detectMutationGates.delete(turnId);
    if (this.cancelledSet.has(turnId)) {
      throw new Error(`Detecção de mutação do turno ${turnId} cancelada.`);
    }
    return this.mutationToReturn;
  }

  releaseDetectMutationGate(turnId: string): void {
    const gate = this.detectMutationGates.get(turnId);
    if (!gate) return;
    if (gate.timer) clearTimeout(gate.timer);
    this.detectMutationGates.delete(turnId);
    gate.resolve();
  }

  isDetectMutationPending(turnId: string): boolean {
    return this.detectMutationGates.has(turnId);
  }

  async detectConfirmation(
    turnId: string,
    epoch: number,
    text: string
  ): Promise<'SIM' | 'NAO'> {
    this.detectConfirmationCalls.push({ turnId, text });

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      if (this.detectConfirmationSettleDelayMs > 0) {
        timer = setTimeout(resolve, this.detectConfirmationSettleDelayMs);
      }
      this.detectConfirmationGates.set(turnId, { resolve, timer });
      if (this.detectConfirmationSettleDelayMs === 0) resolve();
    });

    this.detectConfirmationGates.delete(turnId);
    if (this.cancelledSet.has(turnId)) {
      throw new Error(`Detecção de confirmação do turno ${turnId} cancelada.`);
    }
    return this.confirmationToReturn;
  }

  releaseDetectConfirmationGate(turnId: string): void {
    const gate = this.detectConfirmationGates.get(turnId);
    if (!gate) return;
    if (gate.timer) clearTimeout(gate.timer);
    this.detectConfirmationGates.delete(turnId);
    gate.resolve();
  }

  isDetectConfirmationPending(turnId: string): boolean {
    return this.detectConfirmationGates.has(turnId);
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

    const detectMutationGate = this.detectMutationGates.get(turnId);
    if (detectMutationGate) {
      if (detectMutationGate.timer) clearTimeout(detectMutationGate.timer);
      this.detectMutationGates.delete(turnId);
      detectMutationGate.resolve();
    }

    const detectConfirmationGate = this.detectConfirmationGates.get(turnId);
    if (detectConfirmationGate) {
      if (detectConfirmationGate.timer) clearTimeout(detectConfirmationGate.timer);
      this.detectConfirmationGates.delete(turnId);
      detectConfirmationGate.resolve();
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true;
  }
}
