import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager, type SessionTuning } from '../voice/sessionManager.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { createSystemTools, createMutatingTools } from '../tools/index.js';
import type { IMutatingTool, ITool } from '../../shared/extensions/tools.js';
import { freePort } from './helpers/freePort.js';

/**
 * Fase 13a (docs/phase-13a-v3.md §4.3, H13a.15/.17): emissão das frases em ORDEM ESTRITA, coalescência de frases geradas
 * (só para o provedor que a pede), invariantes (primeira frase, pergunta de mutação e ferramentas nunca agrupadas),
 * descarte do grupo no barge-in e propagação do rótulo de origem de cada frase.
 */
function wav(): Buffer {
  const samples = 1600;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

interface Call {
  text: string;
  options: SynthesizeOptions | undefined;
}

class CtlProvider implements IVoiceProvider {
  readonly id = 'ctl';
  readonly name = 'ctl';
  prefersCoalescing = false;
  calls: Call[] = [];
  endTurns: string[] = [];
  /** Atraso por texto (ms); texto desconhecido = 5 ms. Valor Infinity: nunca resolve dentro do teste. */
  delays = new Map<string, number>();
  failOn = new Set<string>();
  isAvailable(): boolean {
    return true;
  }
  async synthesize(text: string, outputPath: string, signal?: AbortSignal, options?: SynthesizeOptions): Promise<void> {
    this.calls.push({ text, options });
    const d = this.delays.get(text) ?? 5;
    await new Promise((r) => setTimeout(r, d));
    if (signal?.aborted) throw new Error('aborted');
    if (this.failOn.has(text)) throw new Error('falhou');
    await fs.promises.writeFile(outputPath, wav());
  }
  endTurn(turnId: string): void {
    this.endTurns.push(turnId);
  }
}

interface H {
  server: http.Server;
  baseUrl: string;
  engine: FakeVoiceEngine;
  tts: CtlProvider;
  sm: SessionManager;
  tmp: string;
}

async function setup(opts: { tuning?: SessionTuning; tools?: readonly ITool[]; mutating?: readonly IMutatingTool[] } = {}): Promise<H> {
  const port = await freePort();
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-session-'));
  const engine = new FakeVoiceEngine();
  const tts = new CtlProvider();
  const audioStore = new AudioStore(tmp);
  const sm = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), null, opts.tools ?? [], opts.mutating ?? [], null, undefined, opts.tuning);
  const server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, sm, tmp };
}

async function teardown(h: H): Promise<void> {
  await h.sm.shutdownAll();
  const closed = new Promise<void>((r) => h.server.close(() => r()));
  h.server.closeAllConnections();
  h.server.closeIdleConnections();
  await closed;
  fs.rmSync(h.tmp, { recursive: true, force: true });
}

function readSse(url: string): { events: Array<Record<string, unknown>>; close: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const ac = new AbortController();
  fetch(url, { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    })
    .catch(() => {});
  return { events, close: () => ac.abort() };
}

async function waitFor(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 8));
  }
  throw new Error(`timeout esperando: ${what}`);
}

async function startSession(h: H): Promise<{ sessionId: string; token: string; sse: ReturnType<typeof readSse> }> {
  const r = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
  const { sessionId, token } = (await r.json()) as { sessionId: string; token: string };
  const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
  await waitFor(() => sse.events.length >= 1, 'estado inicial');
  return { sessionId, token, sse };
}

async function speak(h: H, s: { sessionId: string; token: string }): Promise<string> {
  const r = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'audio/wav' },
    body: wav()
  });
  assert.equal(r.status, 200);
  return ((await r.json()) as { turnId: string }).turnId;
}

const ready = (sse: { events: Array<Record<string, unknown>> }): Array<{ text: string; sentenceIndex: number }> =>
  sse.events.filter((e) => e.type === 'sentence_audio_ready') as unknown as Array<{ text: string; sentenceIndex: number }>;
const done = (sse: { events: Array<Record<string, unknown>> }): boolean => sse.events.some((e) => e.type === 'turn_done');

describe('Sessão: ordem de emissão e coalescência (Fase 13a)', () => {
  let h: H;
  afterEach(async () => {
    if (h) await teardown(h);
  });

  it('H13a.17: com latências invertidas (a 1ª frase é a mais lenta) o cliente recebe 0, 1, 2 na ORDEM', async () => {
    h = await setup();
    h.engine.sentencesToEmit = ['Zero.', 'Um.', 'Dois.'];
    h.tts.delays.set('Zero.', 160);
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(ready(s.sse).map((e) => e.text), ['Zero.', 'Um.', 'Dois.']);
    assert.deepEqual(ready(s.sse).map((e) => e.sentenceIndex), [0, 1, 2]);
    s.sse.close();
  });

  it('item que FALHA é pulado; os seguintes continuam na ordem', async () => {
    h = await setup();
    h.engine.sentencesToEmit = ['Zero.', 'Um.', 'Dois.'];
    h.tts.failOn.add('Um.');
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(ready(s.sse).map((e) => e.text), ['Zero.', 'Dois.']);
    s.sse.close();
  });

  it('H13a.17: item que passa do prazo de prontidão é PULADO (não prende o seguinte) e o resultado tardio é descartado', async () => {
    h = await setup({ tuning: { readyTimeoutMs: 60 } });
    h.engine.sentencesToEmit = ['Zero.', 'Um.', 'Dois.'];
    h.tts.delays.set('Um.', 900);
    const s = await startSession(h);
    const t0 = Date.now();
    await speak(h, s);
    await waitFor(() => ready(s.sse).some((e) => e.text === 'Dois.'), '"Dois." emitida');
    assert.ok(Date.now() - t0 < 600, 'a frase seguinte NÃO esperou os 900 ms do item travado');
    await waitFor(() => done(s.sse), 'turn_done');
    await new Promise((r) => setTimeout(r, 400)); // dá tempo ao resultado tardio (o 'Um.' termina aos 900 ms)
    assert.deepEqual(ready(s.sse).map((e) => e.text), ['Zero.', 'Dois.'], 'o item tardio nunca é emitido fora de ordem');
    s.sse.close();
  });

  it('turn_done só sai depois de TODAS as frases emitidas', async () => {
    h = await setup();
    h.engine.sentencesToEmit = ['A.', 'B.', 'C.'];
    h.tts.delays.set('A.', 60);
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    const types = s.sse.events.map((e) => e.type as string);
    const lastReady = types.lastIndexOf('sentence_audio_ready');
    assert.ok(types.indexOf('turn_done') > lastReady);
    s.sse.close();
  });

  it('provedor SEM coalescência (`say`): uma frase por pedido, como sempre', async () => {
    h = await setup();
    h.engine.sentencesToEmit = ['S0.', 'S1.', 'S2.', 'S3.'];
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(h.tts.calls.map((c) => c.text), ['S0.', 'S1.', 'S2.', 'S3.']);
    s.sse.close();
  });

  it('coalescência: a 1ª frase vai sozinha; as demais em grupos de até 3; rótulo "generated"; só a 1ª é "primeira do turno"', async () => {
    h = await setup();
    h.tts.prefersCoalescing = true;
    h.engine.sentencesToEmit = ['S0.', 'S1.', 'S2.', 'S3.', 'S4.'];
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(h.tts.calls.map((c) => c.text), ['S0.', 'S1. S2. S3.', 'S4.']);
    assert.ok(h.tts.calls.every((c) => c.options?.kind === 'generated'));
    assert.deepEqual(h.tts.calls.map((c) => c.options?.isFirstOfTurn), [true, false, false]);
    assert.deepEqual(ready(s.sse).map((e) => e.text), ['S0.', 'S1. S2. S3.', 'S4.']);
    const idx = ready(s.sse).map((e) => e.sentenceIndex);
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'sentenceIndex crescente');
    assert.equal(new Set(idx).size, idx.length, 'sentenceIndex único');
    s.sse.close();
  });

  it('coalescência: respeita o limite de caracteres do grupo', async () => {
    h = await setup({ tuning: { maxGroupChars: 10 } });
    h.tts.prefersCoalescing = true;
    h.engine.sentencesToEmit = ['S0.', 'S1.', 'S2.', 'S3.', 'S4.'];
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(h.tts.calls.map((c) => c.text), ['S0.', 'S1. S2.', 'S3. S4.']);
    s.sse.close();
  });

  it('coalescência: uma frase maior que o limite vai sozinha e não trava o grupo', async () => {
    h = await setup({ tuning: { maxGroupChars: 10 } });
    h.tts.prefersCoalescing = true;
    const longa = 'Esta é uma frase bem mais longa que o limite.';
    h.engine.sentencesToEmit = ['S0.', longa, 'S2.'];
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(h.tts.calls.map((c) => c.text), ['S0.', longa, 'S2.']);
    s.sse.close();
  });

  it('coalescência: um grupo não fica retido além da espera máxima (não há silêncio esperando a geração)', async () => {
    h = await setup({ tuning: { coalesceWaitMs: 40 } });
    h.tts.prefersCoalescing = true;
    h.engine.sentencesToEmit = ['S0.', 'S1.', 'S2.'];
    h.engine.sentenceDelayMs = 130; // a geração entrega uma frase a cada 130 ms
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => h.tts.calls.some((c) => c.text === 'S1.'), 'S1 sintetizada sozinha pelo temporizador');
    assert.ok(!h.engine.generateCalls.length || !h.tts.calls.some((c) => c.text.includes('S1. S2.')), 'S1 não ficou esperando S2');
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(h.tts.calls.map((c) => c.text), ['S0.', 'S1.', 'S2.']);
    s.sse.close();
  });

  it('barge-in descarta o grupo ainda acumulado: nada dele é sintetizado nem emitido', async () => {
    h = await setup({ tuning: { coalesceWaitMs: 800 } });
    h.tts.prefersCoalescing = true;
    h.engine.sentencesToEmit = ['S0.', 'S1.', 'S2.'];
    h.engine.sentenceDelayMs = 300; // S0 aos 300 ms, S1 aos 600 ms, S2 aos 900 ms
    const s = await startSession(h);
    const turnId = await speak(h, s);
    await waitFor(() => ready(s.sse).some((e) => e.text === 'S0.'), 'S0 emitida');
    await new Promise((r) => setTimeout(r, 400)); // ~700 ms: S1 já chegou e está retida no grupo; S2 só aos 900 ms
    // Direto no gerenciador (não pelo HTTP): a latência da requisição nesta máquina chegou a 170 ms e fazia o teste correr
    // contra a próxima frase. O que se prova aqui é o descarte do grupo, não a rota.
    assert.equal(h.sm.cancelTurn(s.sessionId, s.token, turnId), true);
    await new Promise((r) => setTimeout(r, 1200)); // passa do temporizador do grupo e da chegada de S2
    assert.deepEqual(h.tts.calls.map((c) => c.text), ['S0.'], 'o grupo acumulado foi descartado');
    assert.ok(!ready(s.sse).some((e) => /S1|S2/.test(e.text)));
    s.sse.close();
  });

  it('ao fim do turno o provedor é avisado (libera a reserva de cota)', async () => {
    h = await setup();
    const s = await startSession(h);
    const turnId = await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    await waitFor(() => h.tts.endTurns.includes(turnId), 'endTurn');
    assert.deepEqual(h.tts.endTurns, [turnId]);
    s.sse.close();
  });

  it('ferramenta (hora/data): fala sozinha, rótulo "local", mesmo com coalescência ligada', async () => {
    h = await setup({ tools: createSystemTools() });
    h.tts.prefersCoalescing = true;
    h.engine.toolToReturn = 'HORA';
    h.engine.fixedTranscript = 'que horas são';
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.equal(h.tts.calls.length, 1);
    assert.equal(h.tts.calls[0].options?.kind, 'local');
    assert.equal(h.tts.calls[0].options?.isFirstOfTurn, true);
    s.sse.close();
  });

  it('pergunta de mutação: fala SOZINHA, idêntica ao texto de markPlayed, rótulo "dictated" — mesmo com coalescência ligada', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-mut-'));
    try {
      const { tools: mutating } = createMutatingTools(dataDir);
      h = await setup({ mutating });
      h.tts.prefersCoalescing = true;
      h.engine.fixedTranscript = 'Lembrete: comprar café';
      h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];
      const s = await startSession(h);
      const turnId = await speak(h, s);
      await waitFor(() => done(s.sse), 'turn_done');
      assert.equal(h.tts.calls.length, 1, 'uma única síntese: a pergunta');
      assert.equal(h.tts.calls[0].text, 'Posso criar o lembrete: comprar café?');
      assert.equal(h.tts.calls[0].options?.kind, 'dictated');
      // o texto emitido ao cliente é exatamente o da pergunta: markPlayed ainda a reconhece
      const q = ready(s.sse)[0].text;
      assert.equal(q, 'Posso criar o lembrete: comprar café?');
      const played = await fetch(`${h.baseUrl}/api/voice/session/played`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId, text: q })
      });
      assert.equal(played.status, 200);
      s.sse.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('H13a.15: frases geradas com TEXTO IDÊNTICO no mesmo turno são emitidas e consumidas uma a uma por markPlayed', async () => {
    h = await setup();
    h.engine.sentencesToEmit = ['Certo.', 'Certo.', 'Certo.'];
    const s = await startSession(h);
    const turnId = await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.equal(ready(s.sse).length, 3);
    const post = async (): Promise<number> =>
      (
        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId, text: 'Certo.' })
        })
      ).status;
    assert.deepEqual([await post(), await post(), await post()], [200, 200, 200], 'a rota responde 200 em todas');
    s.sse.close();
  });
});
