import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../../server.js';
import type { AppConfig } from '../../../shared/types.js';
import { AudioStore } from '../../voice/audioStore.js';
import { FakeVoiceEngine } from '../../voice/fakeEngine.js';
import { MlxWorkerEngine } from '../../voice/mlxWorkerEngine.js';
import { SessionManager } from '../../voice/sessionManager.js';
import { createSpecialistAgents } from '../../agents/specialistAgents.js';
import { KnowledgeRetriever, chunkMarkdown } from '../../knowledge/index.js';
import { createSystemTools, createMutatingTools } from '../../tools/index.js';
import type { ITool, IMutatingTool } from '../../../shared/extensions/tools.js';
import type { IVoiceProvider } from '../../../shared/extensions/voice.js';
import type { ConversationMessage, IntentDetection } from '../../../shared/voiceProtocol.js';
import { workerGeminiEnv } from '../../geminiTestEndpoint.js';
import { workerPrivacyEnv, type PrivacyConfig, DEFAULT_PRIVACY } from '../../privacy.js';
import type { JsonStore, StoredItem } from '../../storage/jsonStore.js';

/** Fase 12 (H12.2/H12.3): infraestrutura do teste de egresso — SessionManager real + worker Python real (sem modelos) + Gemini FALSO em loopback. */

export const ROOT = process.cwd();
export const VENV_PY = path.join(ROOT, '.runtime', '.venv', 'bin', 'python3');
export const WORKER = path.join(ROOT, 'scripts', 'worker', 'worker.py');
export const HAVE_VENV = fs.existsSync(VENV_PY) && fs.existsSync(WORKER);

/** "Chave real" SINTÉTICA do usuário: o worker em modo de teste NÃO pode enviá-la a ninguém. */
export const REAL_LOOKING_KEY = 'AIzaSyD-CHAVE-REAL-SINTETICA-0123456789';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type GeminiMode =
  | { kind: 'ok' }
  | { kind: 'status'; status: number; echo: string }
  | { kind: 'hang' }
  | { kind: 'redirect'; to: string }
  /** Stream que entrega uma frase completa e uma parcial e então derruba a conexão (falha NO MEIO da resposta). */
  | { kind: 'break-after-sentence' }
  /** Fase 13a: 429 de cota com o corpo estruturado do Google (QuotaFailure + RetryInfo). */
  | { kind: 'quota'; quotaId: string; retryDelay: string };

/** Fase 13a: PCM 16 bits mono 24 kHz de uma senoide (RMS em dBFS) — o "áudio" que o Gemini falso devolve ao TTS. */
export function tonePcm(rmsDbfs: number, seconds = 0.4, rate = 24000): Buffer {
  const n = Math.round(seconds * rate);
  const amp = 10 ** (rmsDbfs / 20) * Math.SQRT2;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate) * 32767), i * 2);
  return b;
}

/** Gemini falso: responde aos DOIS contratos (SSE de geração e JSON de intenção) e grava toda requisição recebida. */
export class FakeGemini {
  requests: RecordedRequest[] = [];
  mode: GeminiMode = { kind: 'ok' };
  /** Sobrescreve o modo para um modelo específico (ex.: só o gemini-flash-latest falha). */
  modelModes: Record<string, GeminiMode> = {};
  intent: IntentDetection | { intent: string; content: string | null } = { intent: 'NENHUMA', content: null };
  /** Fase 13a: o áudio que o TTS falso devolve e o seu tipo MIME. */
  ttsPcm: Buffer = tonePcm(-24);
  ttsMime = 'audio/L16;codec=pcm;rate=24000';
  private server: http.Server;
  private hung: http.ServerResponse[] = [];
  url = '';

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') });
        this.respond(req, res);
      });
    });
  }

  private respond(req: http.IncomingMessage, res: http.ServerResponse): void {
    const model = /\/models\/([^:/]+):/.exec(req.url ?? '')?.[1] ?? '';
    const m = this.modelModes[model] ?? this.mode;
    if (m.kind === 'break-after-sentence') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const t of ['Primeira frase completa. ', 'Segunda ainda não termi']) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })}\r\n\r\n`);
      }
      setTimeout(() => res.destroy(), 50);
      return;
    }
    if (m.kind === 'hang') {
      this.hung.push(res);
      return;
    }
    if (m.kind === 'redirect') {
      res.writeHead(307, { Location: m.to, 'Content-Length': '0' });
      res.end();
      return;
    }
    if (m.kind === 'quota') {
      const body = JSON.stringify({
        error: {
          code: 429,
          message: `You exceeded your current quota. Please retry in ${m.retryDelay}.`,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_requests_per_model', quotaId: m.quotaId }] },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: m.retryDelay }
          ]
        }
      });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (m.kind === 'status') {
      const body = JSON.stringify({ error: { code: m.status, message: `falha simulada; eco: ${m.echo}`, status: 'INTERNAL' } });
      res.writeHead(m.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if ((req.url ?? '').includes(':streamGenerateContent') && /tts/i.test(model)) {
      // Fase 13a: resposta do TTS = trechos de áudio PCM em base64 (divididos em 2) e a contagem de tokens.
      const half = Math.floor(this.ttsPcm.length / 2);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const part of [this.ttsPcm.subarray(0, half), this.ttsPcm.subarray(half)]) {
        res.write(
          `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: this.ttsMime, data: part.toString('base64') } }] } }] })}\r\n\r\n`
        );
      }
      res.write(`data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 } })}\r\n\r\n`);
      res.end();
      return;
    }
    if ((req.url ?? '').includes(':streamGenerateContent')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const t of ['Resposta de teste. ', 'Segunda frase.']) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })}\r\n\r\n`);
      }
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }] })}\r\n\r\n`);
      res.end();
      return;
    }
    const body = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(this.intent) }] }, finishReason: 'STOP' }]
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const r of this.hung) r.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Requisições de GERAÇÃO (stream de texto). As de TTS ficam em ttsRequests() — a contagem da Fase 12 não muda. */
  streamRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.includes(':streamGenerateContent') && !/\/models\/[^:/]*tts[^:/]*:/i.test(r.url));
  }
  /** Fase 13a: requisições de TTS (modelo com "tts" no nome). */
  ttsRequests(): RecordedRequest[] {
    return this.requests.filter((r) => /\/models\/[^:/]*tts[^:/]*:streamGenerateContent/i.test(r.url));
  }
  streamModels(): string[] {
    return this.streamRequests().map((r) => /\/models\/([^:/]+):/.exec(r.url)?.[1] ?? '');
  }
  intentRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.includes(':generateContent') && !r.url.includes(':streamGenerateContent'));
  }
}

/** Guarda de TCP no processo Node: registra TODA tentativa de conexão (fetch, http, https, tls passam por net.Socket.connect). */
export function installTcpGuard(): { attempts: string[]; nonLoopback: string[]; restore: () => void } {
  const attempts: string[] = [];
  const nonLoopback: string[] = [];
  const original = net.Socket.prototype.connect;
  const isLoopback = (h: string): boolean => h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '[::1]';
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    // net.connect()/undici chamam socket.connect(normalized) com os argumentos JÁ normalizados num ARRAY [options, cb]:
    // sem desembrulhar, a guarda lia o array como objeto sem host e assumia 'localhost' (cega a TODO destino externo).
    const first = args[0];
    const a0 = (Array.isArray(first) ? first[0] : first) as Record<string, unknown> | number | string | undefined;
    let host = 'localhost';
    let port: unknown = '';
    if (typeof a0 === 'object' && a0 !== null) {
      host = String((a0 as { host?: string }).host ?? 'localhost');
      port = (a0 as { port?: unknown }).port;
      if ((a0 as { path?: string }).path) {
        host = 'unix';
      }
    } else if (typeof a0 === 'number') {
      port = a0;
      host = typeof args[1] === 'string' ? (args[1] as string) : 'localhost';
    }
    const label = `${host}:${String(port)}`;
    attempts.push(label);
    if (host !== 'unix' && !isLoopback(host)) {
      nonLoopback.push(label);
      throw new Error(`egress guard: conexão a destino fora do loopback bloqueada (${label})`);
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  return { attempts, nonLoopback, restore: () => { net.Socket.prototype.connect = original; } };
}

/** Proxy de rede em loopback que RECUSA e conta toda tentativa (mede o worker Python via HTTP(S)_PROXY). */
export class RecordingProxy {
  seen: string[] = [];
  private server: http.Server;
  url = '';
  constructor() {
    this.server = http.createServer((req, res) => {
      this.seen.push(`${req.method} ${req.url}`);
      res.writeHead(502);
      res.end();
    });
    this.server.on('connect', (req, socket) => {
      this.seen.push(`CONNECT ${req.url}`);
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function buildTestWav(durationSeconds = 0.2, sampleRate = 16000): Buffer {
  const dataSize = Math.round(durationSeconds * sampleRate) * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8, 'ascii'); b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'ascii'); b.writeUInt32LE(dataSize, 40);
  return b;
}

class FakeTts implements IVoiceProvider {
  readonly id = 'fake';
  readonly name = 'Fake TTS';
  spoken: string[] = [];
  isAvailable(): boolean { return true; }
  async synthesize(text: string, outputPath: string): Promise<void> {
    this.spoken.push(text);
    await fs.promises.writeFile(outputPath, buildTestWav(0.1));
  }
}

/** Motor híbrido: tudo local é falso; geração e intenção em nuvem passam pelo worker Python REAL (sem modelos). */
export class HybridEngine extends FakeVoiceEngine {
  constructor(private readonly real: MlxWorkerEngine) {
    super();
  }
  override async detectIntent(turnId: string, epoch: number, text: string): Promise<IntentDetection | null> {
    this.detectIntentCalls.push({ turnId, text });
    return this.real.detectIntent(turnId, epoch, text);
  }
  override async generate(turnId: string, epoch: number, messages: ConversationMessage[], cb: Parameters<FakeVoiceEngine['generate']>[3]): Promise<void> {
    this.generateCalls.push({ turnId, epoch, messages });
    return this.real.generate(turnId, epoch, messages, cb);
  }
  override cancel(turnId: string): void {
    this.real.cancel(turnId);
    super.cancel(turnId);
  }
  override async shutdown(): Promise<void> {
    await this.real.shutdown();
    await super.shutdown();
  }
}

export interface EgressOptions {
  privacy?: PrivacyConfig;
  /** Variáveis extras para o worker (proxy, timeout curto...). */
  workerEnv?: Record<string, string>;
  withKnowledge?: string;
  memories?: string[];
  systemTools?: boolean;
  mutating?: boolean;
  fixedDate?: Date;
}

export interface EgressSession {
  sessionId: string;
  token: string;
  events: Array<Record<string, unknown>>;
  close: () => void;
}

export interface EgressHarness {
  gemini: FakeGemini;
  engine: HybridEngine;
  tts: FakeTts;
  baseUrl: string;
  logs: string[];
  sessionManager: SessionManager;
  memoriaStore: JsonStore<StoredItem> | null;
  dataDir: string;
  newSession(): Promise<EgressSession>;
  say(s: EgressSession, transcript: string, label?: string): Promise<{ turnId: string; spoken: string[] }>;
  played(s: EgressSession, turnId: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startEgressHarness(opts: EgressOptions = {}): Promise<EgressHarness> {
  const privacy = opts.privacy ?? DEFAULT_PRIVACY;
  const gemini = new FakeGemini();
  await gemini.start();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-egress-'));

  // logs: tudo que o servidor e o worker imprimem (o worker passa pelo lineSink + redact do MlxWorkerEngine)
  const logs: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const cap = (...a: unknown[]): void => { logs.push(a.map(String).join(' ')); };
  console.error = cap; console.warn = cap; console.log = cap;

  const workerBase: Record<string, string> = {
    RODRIGO_TEST: '1',
    RODRIGO_WORKER_NO_MODELS: '1',
    RODRIGO_GEMINI_BASE_URL: gemini.url,
    GEMINI_API_KEY: REAL_LOOKING_KEY
  };
  const env = { ...workerBase, ...(opts.workerEnv ?? {}) };
  const real = new MlxWorkerEngine({
    pythonBin: VENV_PY,
    workerScript: WORKER,
    hfCacheDir: path.join(tmp, 'hf'),
    env: { ...env, ...workerPrivacyEnv(privacy), ...workerGeminiEnv(env) }
  });
  await real.waitUntilReady(20000);
  const engine = new HybridEngine(real);

  const tts = new FakeTts();
  const audioStore = new AudioStore(path.join(tmp, 'audio'));
  let retriever: KnowledgeRetriever | null = null;
  if (opts.withKnowledge) retriever = new KnowledgeRetriever(chunkMarkdown('teologia', opts.withKnowledge));
  const tools: readonly ITool[] = opts.systemTools ? createSystemTools(() => opts.fixedDate ?? new Date('2026-10-07T10:00:00-03:00')) : [];
  let mutatingTools: readonly IMutatingTool[] = [];
  let memoriaStore: JsonStore<StoredItem> | null = null;
  if (opts.mutating || opts.memories) {
    const made = createMutatingTools(path.join(tmp, 'data'));
    mutatingTools = opts.mutating ? made.tools : [];
    memoriaStore = made.memoriaStore;
    if (opts.memories) {
      made.memoriaStore.write({ items: opts.memories.map((text, i) => ({ id: String(i + 1), text, createdAt: new Date().toISOString() })) });
    }
  }
  const sessionManager = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), retriever, tools, mutatingTools, memoriaStore, privacy);
  const port = 27000 + Math.floor(Math.random() * 2000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const server = await startServer(config, undefined, { config, sessionManager, audioStore });
  const baseUrl = `http://127.0.0.1:${port}`;

  async function newSession(): Promise<EgressSession> {
    const r = await fetch(`${baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await r.json()) as { sessionId: string; token: string };
    const events: Array<Record<string, unknown>> = [];
    const ctrl = new AbortController();
    fetch(`${baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`, { signal: ctrl.signal })
      .then(async (res) => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done: d, value } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data: '));
            if (line) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
          }
        }
      })
      .catch(() => {});
    const deadline = Date.now() + 5000;
    while (events.length < 1 && Date.now() < deadline) await new Promise((r2) => setTimeout(r2, 10));
    return { sessionId, token, events, close: () => ctrl.abort() };
  }

  async function say(s: EgressSession, transcript: string, label = 'GERAL') {
    engine.fixedTranscript = transcript;
    engine.classificationToReturn = label as never;
    const from = s.events.length;
    const res = await fetch(`${baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    if (res.status !== 200) throw new Error(`audio rejeitado (${res.status}): ${await res.text()}`);
    const deadline = Date.now() + 20000;
    for (;;) {
      const fresh = s.events.slice(from);
      const end = fresh.find((e) => e.type === 'turn_done' || e.type === 'error');
      if (end) {
        const spoken = fresh.filter((e) => e.type === 'sentence_audio_ready').map((e) => String(e.text));
        return { turnId: String(end.turnId ?? ''), spoken };
      }
      if (Date.now() > deadline) throw new Error(`turno não terminou: ${transcript} (${JSON.stringify(fresh.map((e) => e.type))})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async function played(s: EgressSession, turnId: string, text: string): Promise<void> {
    await fetch(`${baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text })
    });
  }

  return {
    gemini, engine, tts, baseUrl, logs, sessionManager, memoriaStore, dataDir: path.join(tmp, 'data'), newSession, say, played,
    stop: async () => {
      console.error = saved.error; console.warn = saved.warn; console.log = saved.log;
      await sessionManager.shutdownAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await engine.shutdown();
      await gemini.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}
