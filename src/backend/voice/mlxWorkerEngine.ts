import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import type { ConversationMessage, OrchestratorLabel, ToolName } from '../../shared/voiceProtocol.js';
import { isToolName, VOICE_LIMITS } from '../../shared/voiceProtocol.js';
import type { GenerateCallbacks, VoiceEngine } from './engine.js';
import { VoiceEngineError } from './engine.js';

export interface MlxWorkerEngineOptions {
  pythonBin: string;
  workerScript: string;
  hfCacheDir: string;
  env?: NodeJS.ProcessEnv;
}

const CLASSIFICATION_LABELS = new Set<OrchestratorLabel>(['GERAL', 'TEOLOGIA', 'VIRTOLOGIA', 'AMBIGUO']);

interface PendingTranscribe {
  kind: 'transcribe';
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

interface PendingGenerate {
  kind: 'generate';
  turnId: string;
  resolve: () => void;
  reject: (err: Error) => void;
  callbacks: GenerateCallbacks;
  timeout: NodeJS.Timeout;
  spawnGeneration: number;
}

interface PendingClassify {
  kind: 'classify';
  turnId: string;
  resolve: (label: OrchestratorLabel) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  spawnGeneration: number;
}

interface PendingDetectTool {
  kind: 'detect_tool';
  turnId: string;
  resolve: (tool: ToolName) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  spawnGeneration: number;
}

type Pending = PendingTranscribe | PendingGenerate | PendingClassify | PendingDetectTool;

let reqCounter = 0;
function nextReqId(): string {
  reqCounter += 1;
  return `req_${Date.now()}_${reqCounter}`;
}

/**
 * Motor de voz real: worker Python persistente (MLX LM + MLX Whisper) falado via
 * NDJSON em stdin/stdout. Reinício do processo é reservado a falhas catastróficas
 * (crash, timeout de turno, protocolo corrompido) — nunca por cancelamento normal de
 * barge-in, que é tratado via comando "cancel" cooperativo E resolvido localmente no
 * Node sem esperar confirmação do worker (Fase 3, correção dos Achados 1+2 da auditoria:
 * o Node nunca fica preso esperando uma resposta que pode nunca chegar).
 */
export class MlxWorkerEngine implements VoiceEngine {
  private readonly options: MlxWorkerEngineOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private readyResolvers: Array<() => void> = [];
  private readyRejecters: Array<(err: Error) => void> = [];
  private isReady = false;
  private shuttingDown = false;
  private restartCount = 0;
  /** Incrementado a cada (re)spawn — impede que um timeout de uma instância antiga do
   * worker mate uma instância nova já em uso (spawnWorker() roda no construtor e de
   * novo, recursivamente, no handler de 'exit'). */
  private spawnGeneration = 0;

  constructor(options: MlxWorkerEngineOptions) {
    this.options = options;
    this.spawnWorker();
  }

  private spawnWorker(): void {
    this.spawnGeneration += 1;
    fs.mkdirSync(this.options.hfCacheDir, { recursive: true });

    const child = spawn(this.options.pythonBin, [this.options.workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        ...process.env,
        ...this.options.env,
        HF_HOME: this.options.hfCacheDir,
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1'
      }
    });
    this.child = child;
    this.isReady = false;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));

    child.stderr.on('data', (chunk: Buffer) => {
      console.error(`[voice-worker] ${chunk.toString('utf-8').trimEnd()}`);
    });

    child.on('exit', (code, signal) => {
      const wasReady = this.isReady;
      this.isReady = false;
      this.child = null;

      const err = new VoiceEngineError(
        `Worker de voz encerrado inesperadamente (código ${code}, sinal ${signal}).`
      );
      this.failAllPending(err);

      if (!wasReady) {
        for (const reject of this.readyRejecters) reject(err);
      }
      this.readyResolvers = [];
      this.readyRejecters = [];

      if (!this.shuttingDown) {
        this.restartCount += 1;
        console.error(
          `[voice-worker] Reiniciando worker após falha catastrófica (tentativa ${this.restartCount}).`
        );
        this.spawnWorker();
      }
    });
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.kind === 'generate' || pending.kind === 'classify' || pending.kind === 'detect_tool') {
        clearTimeout(pending.timeout);
      }
      pending.reject(err);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[voice-worker] Linha de protocolo inválida ignorada: ${line}`);
      return;
    }

    const event = msg.event as string | undefined;

    if (event === 'ready') {
      this.isReady = true;
      for (const resolve of this.readyResolvers) resolve();
      this.readyResolvers = [];
      this.readyRejecters = [];
      return;
    }

    if (event === 'pong' || event === 'cancelled') {
      return;
    }

    const reqId = msg.reqId as string | undefined;
    if (!reqId) return;
    const pending = this.pending.get(reqId);
    // Resultado de um reqId que o Node já cancelou/substituiu localmente — ignora
    // silenciosamente (correção do Achado 2: a fila de tamanho 1 do worker pode
    // descartar ou processar tardiamente um comando obsoleto; isso nunca mais trava
    // nada do lado Node, porque o pending já foi resolvido em cancel()).
    if (!pending) return;

    if (event === 'transcript' && pending.kind === 'transcribe') {
      this.pending.delete(reqId);
      pending.resolve((msg.text as string) || '');
      return;
    }

    if (event === 'classification' && pending.kind === 'classify') {
      this.pending.delete(reqId);
      clearTimeout(pending.timeout);
      const label = msg.label as string;
      if (!CLASSIFICATION_LABELS.has(label as OrchestratorLabel)) {
        pending.reject(new VoiceEngineError('Worker retornou rótulo de classificação inválido.'));
        return;
      }
      pending.resolve(label as OrchestratorLabel);
      return;
    }

    if (event === 'sentence' && pending.kind === 'generate') {
      pending.callbacks.onSentence((msg.text as string) || '', (msg.index as number) ?? 0);
      return;
    }

    if (event === 'done' && pending.kind === 'generate') {
      this.pending.delete(reqId);
      clearTimeout(pending.timeout);
      pending.resolve();
      return;
    }

    if (event === 'tool_detection' && pending.kind === 'detect_tool') {
      this.pending.delete(reqId);
      clearTimeout(pending.timeout);
      pending.resolve(isToolName(msg.tool) ? (msg.tool as ToolName) : 'NENHUMA');
      return;
    }

    if (event === 'error') {
      this.pending.delete(reqId);
      if (pending.kind === 'generate' || pending.kind === 'classify' || pending.kind === 'detect_tool') {
        clearTimeout(pending.timeout);
      }
      pending.reject(new VoiceEngineError((msg.message as string) || 'Erro desconhecido no worker de voz.'));
      return;
    }
  }

  isReadySync(): boolean {
    return this.isReady;
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.isReady) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new VoiceEngineError('Timeout aguardando aquecimento do worker de voz.'));
      }, timeoutMs);

      this.readyResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.readyRejecters.push((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private writeCommand(cmd: Record<string, unknown>): void {
    if (!this.child || this.child.stdin.destroyed) {
      throw new VoiceEngineError('Worker de voz não está disponível.');
    }
    this.child.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  async transcribe(audioPath: string): Promise<string> {
    const reqId = nextReqId();
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { kind: 'transcribe', resolve, reject });
      try {
        this.writeCommand({ cmd: 'transcribe', reqId, audioPath });
      } catch (err) {
        this.pending.delete(reqId);
        reject(err as Error);
      }
    });
  }

  async classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel> {
    const reqId = nextReqId();
    const spawnGeneration = this.spawnGeneration;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(
          new VoiceEngineError(
            `Classificação do turno ${turnId} excedeu ${VOICE_LIMITS.CLASSIFY_TIMEOUT_MS}ms.`
          )
        );
        if (this.spawnGeneration === spawnGeneration) {
          this.child?.kill('SIGKILL'); // só mata a instância que ainda é a atual
        }
      }, VOICE_LIMITS.CLASSIFY_TIMEOUT_MS);

      // Registrado em `pending` ANTES de escrever no worker, na mesma execução síncrona
      // — Node.js é single-threaded, então não existe janela onde cancel(turnId) rode
      // "no meio" e não encontre esta entrada (verificado na reauditoria da v2).
      this.pending.set(reqId, { kind: 'classify', turnId, resolve, reject, timeout, spawnGeneration });

      try {
        this.writeCommand({ cmd: 'classify', reqId, turnId, epoch, text });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(err as Error);
      }
    });
  }

  async detectTool(turnId: string, epoch: number, text: string): Promise<ToolName> {
    const reqId = nextReqId();
    const spawnGeneration = this.spawnGeneration;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(
          new VoiceEngineError(
            `Detecção de ferramenta do turno ${turnId} excedeu ${VOICE_LIMITS.DETECT_TOOL_TIMEOUT_MS}ms.`
          )
        );
        // Achado 1 (ALTA) da 4ª rodada: ao contrário de classify()/generate(), este timeout
        // NÃO mata o worker. detect_tool é uma decisão auxiliar e descartável — a §4.4 exige
        // que o worker continue utilizável imediatamente depois, para o classify() do caminho
        // normal rodar em seguida. Se o worker estiver de fato travado (não só lento nesta
        // troca), o classify() seguinte vai, ele sim, estourar CLASSIFY_TIMEOUT_MS e disparar
        // o kill-e-reinício catastrófico já auditado — duplicá-lo aqui derrubaria o próprio
        // fallback que esta função existe para viabilizar.
      }, VOICE_LIMITS.DETECT_TOOL_TIMEOUT_MS);

      this.pending.set(reqId, { kind: 'detect_tool', turnId, resolve, reject, timeout, spawnGeneration });

      try {
        this.writeCommand({ cmd: 'detect_tool', reqId, turnId, epoch, text });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(err as Error);
      }
    });
  }

  async generate(
    turnId: string,
    epoch: number,
    messages: ConversationMessage[],
    callbacks: GenerateCallbacks
  ): Promise<void> {
    const reqId = nextReqId();
    const spawnGeneration = this.spawnGeneration;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        const err = new VoiceEngineError(
          `Turno ${turnId} excedeu o timeout de ${VOICE_LIMITS.TURN_TIMEOUT_MS}ms — falha catastrófica, reiniciando worker.`
        );
        reject(err);
        if (this.spawnGeneration === spawnGeneration) {
          this.child?.kill('SIGKILL');
        }
      }, VOICE_LIMITS.TURN_TIMEOUT_MS);

      this.pending.set(reqId, { kind: 'generate', turnId, resolve, reject, callbacks, timeout, spawnGeneration });

      try {
        this.writeCommand({ cmd: 'generate', reqId, turnId, epoch, messages });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(err as Error);
      }
    });
  }

  cancel(turnId: string): void {
    // Fase 3 (correção dos Achados 1+2): resolve/rejeita localmente, agora, qualquer
    // pending deste turnId — nunca espera o worker confirmar. O comando enviado ao
    // worker abaixo é só uma otimização de CPU (parar de gastar ciclos com algo que
    // ninguém mais vai usar), nunca um requisito para o Node destravar.
    for (const [reqId, pending] of this.pending) {
      if (pending.kind === 'transcribe') continue; // transcribe não carrega turnId
      if (pending.turnId !== turnId) continue;

      this.pending.delete(reqId);
      clearTimeout(pending.timeout);

      if (pending.kind === 'classify' || pending.kind === 'detect_tool') {
        pending.reject(new VoiceEngineError(`Operação do turno ${turnId} cancelada.`));
      } else {
        pending.resolve(); // generate() cancelado: não é erro, o chamador já abandonou o turno
      }
    }

    try {
      this.writeCommand({ cmd: 'cancel', turnId });
    } catch {
      // worker já pode estar morto/reiniciando — sem problema, já resolvemos acima
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.child) return;

    const child = this.child;
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // já encerrado
        }
      }, VOICE_LIMITS.WORKER_SHUTDOWN_GRACE_MS);

      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });

      try {
        child.stdin.end();
        child.kill('SIGTERM');
      } catch {
        clearTimeout(forceKill);
        resolve();
      }
    });
  }
}
