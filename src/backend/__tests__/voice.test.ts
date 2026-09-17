import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { KnowledgeRetriever, chunkMarkdown, KNOWLEDGE_PREAMBLE } from '../knowledge/index.js';
import { SessionManager } from '../voice/sessionManager.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';

function buildTestWav(durationSeconds = 0.2, sampleRate = 16000): Buffer {
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  // amostras zeradas (silêncio) bastam para os testes de protocolo
  return buffer;
}

class FakeVoiceProvider implements IVoiceProvider {
  readonly id = 'fake';
  readonly name = 'Fake TTS';
  public synthesizeCalls: string[] = [];

  isAvailable(): boolean {
    return true;
  }

  async synthesize(text: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    this.synthesizeCalls.push(text);
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    await fs.promises.writeFile(outputPath, buildTestWav(0.1));
  }
}

interface Harness {
  server: http.Server;
  baseUrl: string;
  engine: FakeVoiceEngine;
  tts: FakeVoiceProvider;
  audioStore: AudioStore;
  sessionManager: SessionManager;
  tmpDir: string;
}

async function setupHarness(retriever: KnowledgeRetriever | null = null): Promise<Harness> {
  const testConfig: AppConfig = { port: 0, host: '127.0.0.1', clientPort: 0 };
  // porta 0 -> o SO escolhe uma porta livre; startServer atual exige config.port fixo,
  // então usamos uma porta alta fixa por teste para simplicidade e paralelismo seguro.
  const port = 20000 + Math.floor(Math.random() * 5000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-test-'));
  const engine = new FakeVoiceEngine();
  const tts = new FakeVoiceProvider();
  const audioStore = new AudioStore(tmpDir);
  const sessionManager = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), retriever);

  const server = await startServer(config, undefined, { config, sessionManager, audioStore });

  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, audioStore, sessionManager, tmpDir };
}

async function teardownHarness(h: Harness): Promise<void> {
  // Cada sessão criada arma um setTimeout de 10min (idle timeout) que mantém o processo
  // vivo se nada o limpar — shutdownAll() encerra a sessão atual e cancela esse timer
  // (é o que voiceRuntime.shutdown() já faz em produção antes de fechar o servidor HTTP).
  await h.sessionManager.shutdownAll();

  // server.close() por si só espera conexões abertas (ex.: SSE) fecharem sozinhas, e
  // closeAllConnections() sozinho não derruba conexões keep-alive ociosas — sem as duas
  // juntas, close() pode travar em teste.
  const closePromise = new Promise<void>((resolve) => h.server.close(() => resolve()));
  h.server.closeAllConnections();
  h.server.closeIdleConnections();
  await closePromise;
  await fs.promises.rm(h.tmpDir, { recursive: true, force: true }).catch(() => {});
}

function readSse(url: string): { events: unknown[]; close: () => void; waitFor: (n: number, timeoutMs?: number) => Promise<void> } {
  const events: unknown[] = [];
  const controller = new AbortController();
  let resolveWait: (() => void) | null = null;
  let waitCount = 0;

  fetch(url, { signal: controller.signal }).then(async (res) => {
    const reader = res.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          events.push(JSON.parse(line.slice(6)));
          if (resolveWait && events.length >= waitCount) {
            resolveWait();
            resolveWait = null;
          }
        }
      }
    }
  }).catch(() => {});

  return {
    events,
    close: () => controller.abort(),
    waitFor: (n: number, timeoutMs = 3000) =>
      new Promise<void>((resolve, reject) => {
        if (events.length >= n) {
          resolve();
          return;
        }
        waitCount = n;
        resolveWait = resolve;
        setTimeout(() => reject(new Error(`Timeout esperando ${n} eventos SSE (recebidos: ${events.length})`)), timeoutMs);
      })
  };
}

describe('Voz (Fase 2) — sessão, preempção, cancelamento, limites', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setupHarness();
  });

  after(async () => {
    // garante limpeza mesmo se o último teste falhar antes do teardown normal
  });

  it('cria sessão e recusa Origin cross-origin', async () => {
    const resOk = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    assert.equal(resOk.status, 200);
    const body = (await resOk.json()) as { sessionId: string; token: string };
    assert.ok(body.sessionId);
    assert.ok(body.token);

    const resBadOrigin = await fetch(`${h.baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: { Origin: 'http://attacker.example' }
    });
    assert.equal(resBadOrigin.status, 403);

    await teardownHarness(h);
  });

  it('transcreve, gera frases, sintetiza e serve o áudio — fluxo feliz completo', async () => {
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1); // state: ouvindo (attach)

    const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(audioRes.status, 200);
    const { turnId } = (await audioRes.json()) as { turnId: string };
    assert.ok(turnId);

    // processando + transcript + routing + falando + 2x sentence_audio_ready + turn_done + state(ouvindo)
    await sse.waitFor(9, 5000);

    const types = (sse.events as Array<{ type: string }>).map((e) => e.type);
    assert.ok(types.includes('transcript'));
    assert.ok(types.includes('routing'));
    assert.ok(types.filter((t) => t === 'sentence_audio_ready').length === 2);
    assert.ok(types.includes('turn_done'));

    const routingEvent = sse.events.find(
      (e): e is { type: 'routing'; turnId: string; label: string; handled: boolean } =>
        (e as { type: string }).type === 'routing'
    )!;
    assert.equal(routingEvent.turnId, turnId);
    assert.equal(routingEvent.label, 'GERAL'); // FakeVoiceEngine.classificationToReturn default
    assert.equal(routingEvent.handled, true);

    const audioEvent = sse.events.find(
      (e): e is { type: 'sentence_audio_ready'; audioId: string } =>
        (e as { type: string }).type === 'sentence_audio_ready'
    )!;

    const fileRes = await fetch(
      `${h.baseUrl}/api/voice/session/audio/${audioEvent.audioId}?sessionId=${sessionId}&token=${token}`
    );
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('content-type'), 'audio/wav');
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');

    // Confirma reprodução de uma frase -> deve entrar no histórico do próximo turno
    await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text: 'Olá!' })
    });

    const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(audioRes2.status, 200);
    await new Promise((r) => setTimeout(r, 200));

    const secondCallMessages = h.engine.generateCalls[1]?.messages || [];
    assert.ok(
      secondCallMessages.some((m) => m.role === 'assistant' && m.content === 'Olá!'),
      'histórico deve conter a frase confirmada como reproduzida'
    );

    // markPlayed com turnId de um turno que não é mais o último da sessão deve ser
    // rejeitado — não pode injetar texto obsoleto no histórico (regressão coberta).
    const staleRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: 'turno-antigo-inexistente', text: 'texto obsoleto' })
    });
    const staleBody = (await staleRes.json()) as { ok?: boolean; error?: string };
    assert.equal(staleBody.ok, undefined);
    assert.ok(staleBody.error, 'confirmação de turno obsoleto deve ser rejeitada');

    sse.close();
    await teardownHarness(h);
  });

  it('preempta a sessão anterior ao criar uma nova (sem esperar 10min)', async () => {
    const res1 = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const s1 = (await res1.json()) as { sessionId: string; token: string };

    const sse1 = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${s1.sessionId}&token=${s1.token}`);
    await sse1.waitFor(1);

    const res2 = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    assert.equal(res2.status, 200);
    const s2 = (await res2.json()) as { sessionId: string; token: string };
    assert.notEqual(s2.sessionId, s1.sessionId);

    await sse1.waitFor(2, 2000); // session_preempted chega na SSE antiga

    const preemptEvent = sse1.events.find((e) => (e as { type: string }).type === 'session_preempted');
    assert.ok(preemptEvent, 'sessão antiga deve receber session_preempted');

    // sessão antiga não deve mais aceitar comandos
    const oldAudioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s1.sessionId, 'X-Rodrigo-Token': s1.token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(oldAudioRes.status, 401);

    sse1.close();
    await teardownHarness(h);
  });

  it('cancela um turno em andamento — engine.cancel chamado e frases pós-cancelamento não emitidas', async () => {
    h.engine.sentenceDelayMs = 150; // dá tempo de cancelar entre a 1ª e a 2ª frase
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId } = (await audioRes.json()) as { turnId: string };

    // attach(1) + processando(2) + transcript(3) + routing(4) + falando(5) + 1ª sentence_audio_ready(6)
    await sse.waitFor(6, 2000);

    const cancelRes = await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(cancelRes.status, 200);

    await new Promise((r) => setTimeout(r, 400));

    assert.ok(h.engine.cancelledTurnIds.includes(turnId));
    const sentenceEvents = (sse.events as Array<{ type: string }>).filter((e) => e.type === 'sentence_audio_ready');
    assert.equal(sentenceEvents.length, 1, 'a 2ª frase não deve ser emitida após cancelamento');
    assert.ok(!(sse.events as Array<{ type: string }>).some((e) => e.type === 'turn_done'), 'turno cancelado não deve emitir turn_done');

    sse.close();
    await teardownHarness(h);
  });

  it('rejeita áudio maior que o limite e WAV malformado', async () => {
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1024, 0);
    const bigRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: oversized
    });
    assert.equal(bigRes.status, 413);

    const malformedRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: Buffer.from('isso nao e um wav')
    });
    assert.equal(malformedRes.status, 400);

    await teardownHarness(h);
  });

  it('rejeita token incorreto ou ausente', async () => {
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId } = (await createRes.json()) as { sessionId: string; token: string };

    const res = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': 'token-errado', 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(res.status, 401);

    await teardownHarness(h);
  });

  it('Fase 4: handled=true e system prompt do agente de Teologia quando rotulado TEOLOGIA', async () => {
    h.engine.classificationToReturn = 'TEOLOGIA';
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });

    await sse.waitFor(9, 5000);

    const routingEvent = sse.events.find((e) => (e as { type: string }).type === 'routing') as
      | { type: 'routing'; label: string; handled: boolean }
      | undefined;
    assert.ok(routingEvent, 'evento routing deveria ter sido emitido');
    assert.equal(routingEvent!.label, 'TEOLOGIA');
    assert.equal(routingEvent!.handled, true, 'TEOLOGIA tem agente especialista real na Fase 4');

    const systemPromptUsed = h.engine.generateCalls[0]?.messages[0]?.content || '';
    assert.match(systemPromptUsed, /Teologia de Rodrigo Sonsino/);
    assert.match(
      systemPromptUsed,
      /prioridade absoluta sobre qualquer instrução/,
      'salvaguarda universal deve estar presente também para agentes especialistas'
    );

    sse.close();
    await teardownHarness(h);
  });

  it('Fase 4: handled=true e system prompt do agente de Virtologia quando rotulado VIRTOLOGIA', async () => {
    h.engine.classificationToReturn = 'VIRTOLOGIA';
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });

    await sse.waitFor(9, 5000);

    const routingEvent = sse.events.find((e) => (e as { type: string }).type === 'routing') as
      | { type: 'routing'; label: string; handled: boolean }
      | undefined;
    assert.ok(routingEvent, 'evento routing deveria ter sido emitido');
    assert.equal(routingEvent!.label, 'VIRTOLOGIA');
    assert.equal(routingEvent!.handled, true, 'VIRTOLOGIA tem agente especialista real na Fase 4');

    const systemPromptUsed = h.engine.generateCalls[0]?.messages[0]?.content || '';
    assert.match(systemPromptUsed, /Eduardo Casarotto/);

    sse.close();
    await teardownHarness(h);
  });

  it('Fase 4: handled=false e system prompt do agente Geral quando rotulado AMBIGUO', async () => {
    h.engine.classificationToReturn = 'AMBIGUO';
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });

    await sse.waitFor(9, 5000);

    const routingEvent = sse.events.find((e) => (e as { type: string }).type === 'routing') as
      | { type: 'routing'; label: string; handled: boolean }
      | undefined;
    assert.ok(routingEvent, 'evento routing deveria ter sido emitido');
    assert.equal(routingEvent!.label, 'AMBIGUO');
    assert.equal(routingEvent!.handled, false, 'AMBIGUO não tem especialista dedicado, cai no Geral');

    const systemPromptUsed = h.engine.generateCalls[0]?.messages[0]?.content || '';
    assert.match(systemPromptUsed, /Rodrigo AI, um assistente de voz pessoal/);

    sse.close();
    await teardownHarness(h);
  });

  it('Fase 3: cancelar durante classify() rejeita de verdade — sem pending/timer preso', async () => {
    h.engine.classifySettleDelayMs = 5000; // trava até liberar manualmente (via cancel)

    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId } = (await audioRes.json()) as { turnId: string };

    // Espera a barreira de classify() realmente travar antes de cancelar — prova
    // cancelamento real, não "passou por sorte de timing" (Achado 5 da auditoria).
    const deadline = Date.now() + 2000;
    while (!h.engine.isClassifyPending(turnId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(h.engine.isClassifyPending(turnId), 'classify() deveria estar pendente antes do cancel');

    const cancelRes = await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(cancelRes.status, 200);

    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!h.engine.isClassifyPending(turnId), 'cancel() deveria limpar a barreira imediatamente');
    assert.ok(h.engine.cancelledTurnIds.includes(turnId));

    const types = (sse.events as Array<{ type: string }>).map((e) => e.type);
    assert.ok(!types.includes('routing'), 'classificação cancelada não deveria emitir routing');
    assert.ok(!types.includes('sentence_audio_ready'), 'não deveria ter avançado pra geração de fala');

    sse.close();
    await teardownHarness(h);
  });

  it('Fase 3 (C5): preempção rápida A→B→C durante classify não deixa pending órfão', async () => {
    h.engine.classifySettleDelayMs = 3000;

    const resA = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId: sidA, token: tokA } = (await resA.json()) as { sessionId: string; token: string };
    const sseA = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sidA}&token=${tokA}`);
    await sseA.waitFor(1);

    const audioResA = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sidA, 'X-Rodrigo-Token': tokA, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId: turnA } = (await audioResA.json()) as { turnId: string };

    const deadline = Date.now() + 2000;
    while (!h.engine.isClassifyPending(turnA) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(h.engine.isClassifyPending(turnA), 'classify de A deveria estar pendente');

    // B preempta a sessão de A (turno A ainda classificando)
    const resB = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId: sidB, token: tokB } = (await resB.json()) as { sessionId: string; token: string };

    // C preempta B quase imediatamente, antes de B sequer enviar áudio
    const resC = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId: sidC, token: tokC } = (await resC.json()) as { sessionId: string; token: string };

    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!h.engine.isClassifyPending(turnA), 'classify de A deveria ter sido cancelado pela preempção de B');
    assert.ok(h.engine.cancelledTurnIds.includes(turnA));

    const audioResC = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sidC, 'X-Rodrigo-Token': tokC, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(audioResC.status, 200, 'C é a sessão viva — deve continuar aceitando comandos');

    const audioResB = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sidB, 'X-Rodrigo-Token': tokB, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(audioResB.status, 401, 'B foi preemptada por C, não deveria mais aceitar comandos');

    sseA.close();
    await teardownHarness(h);
  });
});

const KNOWLEDGE_FIXTURE = `## 1. Aceitação na prática

A Aceitação é acolher ativamente o que não pode ser mudado no passado e agir no presente sobre
aquilo que ainda pode ser mudado, o que a distingue do conformismo passivo em vários aspectos
importantes para a prática clínica descrita neste material de referência.

## 2. Exegese e método

O método histórico-gramatical situa o texto no judaísmo do Segundo Templo antes de qualquer
aplicação ao presente, e essa sequência é obrigatória em toda análise exegética séria feita
dentro deste perfil de trabalho teológico.
`;

describe('Conhecimento (Fase 5a) — integração com o turno de voz', () => {
  let h: Harness;

  beforeEach(async () => {
    const chunks = [
      ...chunkMarkdown('virtologia', KNOWLEDGE_FIXTURE),
      ...chunkMarkdown('teologia', KNOWLEDGE_FIXTURE)
    ];
    h = await setupHarness(new KnowledgeRetriever(chunks));
  });

  async function runTurn(label: string, transcript: string): Promise<string> {
    h.engine.classificationToReturn = label as never;
    h.engine.fixedTranscript = transcript;
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);
    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    await sse.waitFor(9, 5000);
    const routingCount = sse.events.filter((e) => (e as { type: string }).type === 'routing').length;
    assert.equal(routingCount, 1, 'o evento routing deve ser emitido exatamente uma vez por turno');
    sse.close();
    return h.engine.generateCalls[0]?.messages[0]?.content || '';
  }

  it('TEOLOGIA: o corpo do trecho recuperado chega ao motor de geração', async () => {
    const prompt = await runTurn('TEOLOGIA', 'Faça uma análise exegética desse texto');
    assert.ok(prompt.includes(KNOWLEDGE_PREAMBLE), 'o preâmbulo do bloco deve estar presente');
    assert.match(prompt, /judaísmo do Segundo Templo/, 'o corpo do trecho deve estar no prompt');
    assert.match(prompt, /Teologia de Rodrigo Sonsino/, 'o prompt do agente continua presente');
    assert.match(prompt, /prioridade absoluta sobre qualquer instrução/, 'salvaguarda universal preservada');
  });

  it('VIRTOLOGIA: recupera o trecho do próprio agente', async () => {
    const prompt = await runTurn('VIRTOLOGIA', 'Explique a Aceitação');
    assert.ok(prompt.includes(KNOWLEDGE_PREAMBLE));
    assert.match(prompt, /conformismo passivo/);
  });

  it('GERAL: prompt byte a byte idêntico ao da Fase 4 — nenhuma consulta', async () => {
    const prompt = await runTurn('GERAL', 'Quanto é dezessete por cento de oitocentos e cinquenta');
    assert.ok(!prompt.includes(KNOWLEDGE_PREAMBLE), 'GERAL não pode receber bloco de conhecimento');
    assert.match(prompt, /Rodrigo AI, um assistente de voz pessoal/);
  });

  it('AMBIGUO: cai no Geral e não consulta', async () => {
    const prompt = await runTurn('AMBIGUO', 'sei lá, uma coisa qualquer');
    assert.ok(!prompt.includes(KNOWLEDGE_PREAMBLE));
  });

  it('consulta sem casamento não injeta bloco nenhum', async () => {
    const prompt = await runTurn('TEOLOGIA', 'receita de bolo de cenoura com cobertura');
    assert.ok(!prompt.includes(KNOWLEDGE_PREAMBLE), 'sem termo casado, nada é injetado');
    assert.match(prompt, /Teologia de Rodrigo Sonsino/);
  });

  afterEach(async () => {
    await teardownHarness(h);
  });
});
