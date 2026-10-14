import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { DEFAULT_PRIVACY, GENERATION_DISABLED_TEXT, type PrivacyConfig } from '../privacy.js';
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
import { classifyConfirmation } from '../voice/confirmationClassifier.js';

const hasAffirmativeMarker = (t: string): boolean => classifyConfirmation(t).verdict === 'SIM';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import type { ITool, IMutatingTool } from '../../shared/extensions/tools.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { createSystemTools, TOOL_FAILURE_TEXT, HoraAtualTool } from '../tools/index.js';
import { createMutatingTools } from '../tools/index.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import { VOICE_LIMITS, MUTATION_FAILURE_TEXT, MUTATION_CANCELLED_TEXT, GENERATION_FAILURE_TEXT } from '../../shared/voiceProtocol.js';

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

async function setupHarness(
  retriever: KnowledgeRetriever | null = null,
  tools: readonly ITool[] = [],
  mutatingTools: readonly IMutatingTool[] = [],
  memoriaStore: JsonStore<StoredItem> | null = null,
  privacy: PrivacyConfig = DEFAULT_PRIVACY
): Promise<Harness> {
  const testConfig: AppConfig = { port: 0, host: '127.0.0.1', clientPort: 0 };
  // porta 0 -> o SO escolhe uma porta livre; startServer atual exige config.port fixo,
  // então usamos uma porta alta fixa por teste para simplicidade e paralelismo seguro.
  const port = 20000 + Math.floor(Math.random() * 5000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-test-'));
  const engine = new FakeVoiceEngine();
  const tts = new FakeVoiceProvider();
  const audioStore = new AudioStore(tmpDir);
  const sessionManager = new SessionManager(
    engine,
    tts,
    audioStore,
    createSpecialistAgents(),
    retriever,
    tools,
    mutatingTools,
    memoriaStore,
    privacy
  );

  const server = await startServer(config, undefined, { config, sessionManager, audioStore });

  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, audioStore, sessionManager, tmpDir };
}

async function teardownHarness(h: Harness): Promise<void> {
  if ((h as any)._tornDown) return;
  (h as any)._tornDown = true;
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

/** Texto da última frase que o SERVIDOR emitiu (sentence_audio_ready) — /played só aceita esse texto. */
function emittedText(sse: { events: unknown[] } | null): string {
  const ev = (sse?.events ?? []).filter((e) => (e as { type: string }).type === 'sentence_audio_ready').pop() as
    | { text: string }
    | undefined;
  return ev?.text ?? '';
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

/** Espera um evento SSE pelo tipo, sem depender da posição/contagem dos eventos no fluxo. */
async function waitForEventType(sse: { events: unknown[] }, type: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((sse.events as Array<{ type: string }>).some((e) => e.type === type)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout esperando evento SSE do tipo "${type}" (recebidos: ${(sse.events as Array<{ type: string }>).map((e) => e.type).join(',')})`);
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

  it('regressão (achado de consulta Codex CLI, 2026-09-29): barge-in DURANTE A REPRODUÇÃO (geração já terminou) rejeita markPlayed() do turno interrompido', async () => {
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

    // Deixa a geração terminar de verdade (turn_done) ANTES de cancelar — simula o caso
    // real mais comum: o usuário interrompe enquanto o áudio já gerado ainda está sendo
    // reproduzido no cliente, quando activeTurn já voltou a null no servidor. Antes do
    // fix, cancelTurn() não fazia nada nesse caso (o `if (session.activeTurn && ...)`
    // nunca era verdadeiro), e markPlayed() aceitava a confirmação de qualquer forma
    // porque turnId ainda era igual a lastTurnId.
    await waitForEventType(sse, 'turn_done');

    const cancelRes = await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(cancelRes.status, 200);

    const playedRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text: 'frase interrompida pelo barge-in' })
    });
    const playedBody = (await playedRes.json()) as { ok?: boolean; error?: string };
    assert.equal(playedRes.status, 401, 'markPlayed() deve rejeitar o turno cancelado, mesmo sendo o lastTurnId');
    assert.equal(playedBody.ok, undefined);
    assert.ok(playedBody.error, 'confirmação de reprodução de turno interrompido deve ser rejeitada');

    sse.close();
    await teardownHarness(h);
  });

  it('contrato (auditoria Kimi/Hermes, 2026-10-02): /played de frase ouvida inteira que chega ANTES do /cancel é aceito', async () => {
    // O cliente só envia /played depois que a frase terminou de tocar sem barge-in (único
    // ponto de envio: playChunk(), após a última checagem). Chegar antes do /cancel significa
    // que a frase foi ouvida inteira — manter no histórico é correto, e a rejeição do turno
    // só vale a partir do cancelamento. Fixa que o fix não rejeita demais.
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
    await waitForEventType(sse, 'turn_done');

    const playedRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text: emittedText(sse) })
    });
    assert.equal(playedRes.status, 200, '/played antes do /cancel deve ser aceito');

    const cancelRes = await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(cancelRes.status, 200);

    const latePlayedRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text: 'outra frase, já depois do cancelamento' })
    });
    assert.equal(latePlayedRes.status, 401, 'depois do /cancel, o mesmo turno volta a ser rejeitado');

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
    // F12/D1: o trecho de pesquisa só vai ao prompt com RODRIGO_SEND_KNOWLEDGE=1 — estes testes cobrem o envio LIGADO.
    h = await setupHarness(new KnowledgeRetriever(chunks), [], [], null, { ...DEFAULT_PRIVACY, sendKnowledge: true });
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

  it('consulta sem casamento injeta a trava de limite (F16, Fatia 3, §2.1)', async () => {
    const prompt = await runTurn('TEOLOGIA', 'receita de bolo de cenoura com cobertura');
    assert.ok(!prompt.includes(KNOWLEDGE_PREAMBLE), 'sem trecho recuperado, nada do corpus é injetado');
    assert.ok(
      prompt.includes('O corpus não contém informações sobre a pergunta do usuário'),
      'trava de limite deve estar presente quando a busca retorna vazia'
    );
    assert.ok(
      prompt.includes('DEVE declarar explicitamente que não encontrou a posição registrada'),
      'a trava instrui a declarar o limite, sem adivinhar'
    );
    assert.match(prompt, /Teologia de Rodrigo Sonsino/);
  });

  it('F16 Fatia 3: trava de limite também se aplica a NEUROCIENCIA e VIRTOLOGIA', async () => {
    for (const label of ['NEUROCIENCIA', 'VIRTOLOGIA'] as const) {
      const prompt = await runTurn(label, 'receita de bolo de cenoura com cobertura');
      assert.ok(
        prompt.includes('O corpus não contém informações sobre a pergunta do usuário'),
        `${label}: trava de limite ausente em busca vazia`
      );
    }
  });

  it('F16 Fatia 3: GERAL e AMBIGUO nunca recebem a trava de limite', async () => {
    for (const label of ['GERAL', 'AMBIGUO'] as const) {
      const prompt = await runTurn(label, 'receita de bolo de cenoura com cobertura');
      assert.ok(
        !prompt.includes('O corpus não contém informações sobre a pergunta do usuário'),
        `${label} não pode receber a trava`
      );
    }
  });

  afterEach(async () => {
    await teardownHarness(h);
  });
});

describe('Ferramentas do Sistema (Fase 5b) — integração com o turno de voz (H5-H8)', () => {
  it('Fase 5b (H5): toolToReturn=HORA emite routing(GERAL, handled:true), falando, texto exato, turn_done, sem chamar LLM/classificador', async () => {
    const clock = () => new Date('2026-09-21T11:06:00');
    const tools = [new HoraAtualTool(clock)];
    const h = await setupHarness(null, tools);

    h.engine.fixedTranscript = 'Que horas são agora?';
    h.engine.toolToReturn = 'HORA';

    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1); // attach

    const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId } = (await audioRes.json()) as { turnId: string };

    // attach(1) + processando(2) + transcript(3) + routing(4) + falando(5) + sentence_audio_ready(6) + turn_done(7) + ouvindo(8)
    await sse.waitFor(8, 5000);

    const routingEvent = sse.events.find((e) => (e as { type: string }).type === 'routing') as
      | { type: 'routing'; turnId: string; label: string; handled: boolean }
      | undefined;
    assert.ok(routingEvent, 'evento routing deveria ter sido emitido');
    assert.equal(routingEvent.label, 'GERAL');
    assert.equal(routingEvent.handled, true);

    const falandoEvent = sse.events.find(
      (e) => (e as { type: string }).type === 'state' && (e as { state: string }).state === 'falando'
    );
    assert.ok(falandoEvent, 'estado falando deveria ter sido emitido');

    const sentenceEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
      | { type: 'sentence_audio_ready'; text: string }
      | undefined;
    assert.ok(sentenceEvent, 'sentence_audio_ready deveria ter sido emitido');
    assert.equal(sentenceEvent.text, 'São 11 horas e 6 minutos.');

    const turnDoneEvent = sse.events.find((e) => (e as { type: string }).type === 'turn_done');
    assert.ok(turnDoneEvent, 'turn_done deveria ter sido emitido');

    const lastStateEvent = sse.events.filter((e) => (e as { type: string }).type === 'state').pop() as
      | { type: 'state'; state: string }
      | undefined;
    assert.equal(lastStateEvent?.state, 'ouvindo');

    // LLM e classificador NÃO são chamados:
    assert.equal(h.engine.generateCalls.length, 0);
    assert.equal(h.engine.classifyCalls.length, 0);
    assert.equal(h.engine.detectToolCalls.length, 1);
    assert.equal(h.engine.detectToolCalls[0].turnId, turnId);

    // Correção do achado 6: o histórico contém a mensagem do usuário, mas nenhuma
    // mensagem de 'assistant' antes da reprodução ser confirmada
    const historyBeforePlay = (h.sessionManager as unknown as { current?: { history: Array<{ role: string; content: string }> } })
      .current?.history ?? [];
    assert.equal(historyBeforePlay.length, 1);
    assert.equal(historyBeforePlay[0].role, 'user');
    assert.equal(historyBeforePlay[0].content, 'Que horas são agora?');

    // Após confirmação de reprodução via markPlayed (POST /api/voice/session/played),
    // a resposta do assistente entra no histórico
    const playRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId, text: sentenceEvent.text })
    });
    assert.equal(playRes.status, 200);

    const historyAfterPlay = (h.sessionManager as unknown as { current?: { history: Array<{ role: string; content: string }> } })
      .current?.history ?? [];
    assert.equal(historyAfterPlay.length, 2);
    assert.equal(historyAfterPlay[1].role, 'assistant');
    assert.equal(historyAfterPlay[1].content, 'São 11 horas e 6 minutos.');

    sse.close();
    await teardownHarness(h);
  });

  it('F15 Fatia 4 (C1): ferramenta HORA no runTurn passa pelo coordenador e fica no ExecutionTrace', async (t) => {
    const h = await setupHarness(null, createSystemTools());
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Que horas são agora?';
    h.engine.toolToReturn = 'HORA';

    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId } = (await audioRes.json()) as { turnId: string };
    await sse.waitFor(8, 5000);

    const trace = h.sessionManager.coordinator.getTrace(turnId);
    assert.ok(trace, 'o turno da ferramenta deve ter ExecutionTrace');
    assert.equal(trace.tasks.length, 1);
    assert.equal(trace.tasks[0].subAgentId, 'tool_hora');
    assert.equal(trace.tasks[0].isMutation, false);
    assert.equal(trace.tasks[0].status, 'completed');
    assert.equal(h.engine.generateCalls.length, 0);
  });

  it('F15 Fatia 4 (A2): "o que você fez?" depois de uma delegação responde pelo ExecutionTrace, sem LLM', async (t) => {
    const clock = () => new Date('2026-09-21T11:06:00');
    const h = await setupHarness(null, [new HoraAtualTool(clock)]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Que horas são agora?';
    h.engine.toolToReturn = 'HORA';

    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8, 5000);
    await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
    });

    h.engine.fixedTranscript = 'O que você fez?';
    h.engine.toolToReturn = 'NENHUMA';
    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    await sse.waitFor(15, 5000);

    const ready = sse.events.filter((e) => (e as { type: string }).type === 'sentence_audio_ready') as Array<{
      text: string;
    }>;
    assert.equal(ready.length, 2);
    assert.equal(ready[1].text, h.sessionManager.coordinator.formatTraceSummary(turnId1));
    assert.match(ready[1].text, /Executei 1 passo: Passo 1: São 11 horas e 6 minutos/);
    assert.equal(h.engine.generateCalls.length, 0, 'o resumo vem do trace, não do LLM');
    assert.equal(h.engine.classifyCalls.length, 0);
  });

  it('Fase 5b (H6): execute() que lança sintetiza TOOL_FAILURE_TEXT sem chamar modelo', async () => {
    const brokenTool: ITool = {
      name: 'HORA',
      description: 'Ferramenta com falha simulada',
      isAvailable: () => true,
      execute: () => {
        throw new Error('Falha de hardware simulada');
      }
    };
    const h = await setupHarness(null, [brokenTool]);

    h.engine.fixedTranscript = 'Que horas são agora?';
    h.engine.toolToReturn = 'HORA';

    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });

    await sse.waitFor(8, 5000);

    const sentenceEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
      | { type: 'sentence_audio_ready'; text: string }
      | undefined;
    assert.ok(sentenceEvent, 'sentence_audio_ready deveria ter sido emitido');
    assert.equal(sentenceEvent.text, TOOL_FAILURE_TEXT);

    assert.equal(h.engine.generateCalls.length, 0);
    assert.equal(h.engine.classifyCalls.length, 0);

    sse.close();
    await teardownHarness(h);
  });

  it('Fase 5b (H7): detectTool que lança cai no caminho normal (classify + generate chamados com prompt da Fase 5a)', async () => {
    const tools = createSystemTools();
    const h = await setupHarness(null, tools);

    h.engine.fixedTranscript = 'Que horas são agora?';
    // Faz detectTool lançar erro
    h.engine.detectTool = async () => {
      throw new Error('Worker de voz ocupado/timeout simulado.');
    };
    h.engine.classificationToReturn = 'GERAL';

    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });

    // attach(1) + processando(2) + transcript(3) + routing(4) + falando(5) + sentence_audio_ready(6) + sentence_audio_ready(7) + turn_done(8) + ouvindo(9)
    await sse.waitFor(9, 5000);

    assert.equal(h.engine.classifyCalls.length, 1, 'classify deve ser chamado no caminho normal');
    assert.equal(h.engine.generateCalls.length, 1, 'generate deve ser chamado no caminho normal');

    const routingEvent = sse.events.find((e) => (e as { type: string }).type === 'routing') as
      | { type: 'routing'; label: string; handled: boolean }
      | undefined;
    assert.equal(routingEvent?.label, 'GERAL');

    const systemPromptUsed = h.engine.generateCalls[0]?.messages[0]?.content || '';
    assert.match(systemPromptUsed, /Rodrigo AI, um assistente de voz pessoal/);
    assert.match(systemPromptUsed, /prioridade absoluta sobre qualquer instrução/);

    sse.close();
    await teardownHarness(h);
  });

  it('Fase 5b (H8): cancelar durante detectTool() rejeita e limpa detectToolGates sem pending órfão', async () => {
    const tools = createSystemTools();
    const h = await setupHarness(null, tools);

    h.engine.fixedTranscript = 'Que horas são agora?';
    h.engine.detectToolSettleDelayMs = 5000;

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

    // Espera a barreira de detectTool travar antes de cancelar
    const deadline = Date.now() + 2000;
    while (!h.engine.isDetectToolPending(turnId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(h.engine.isDetectToolPending(turnId), 'detectTool() deveria estar pendente antes do cancel');

    const cancelRes = await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(cancelRes.status, 200);

    await new Promise((r) => setTimeout(r, 100));

    assert.ok(!h.engine.isDetectToolPending(turnId), 'cancel() deveria limpar a barreira de detectTool imediatamente');
    assert.ok(h.engine.cancelledTurnIds.includes(turnId));

    const types = (sse.events as Array<{ type: string }>).map((e) => e.type);
    assert.ok(!types.includes('routing'), 'turno cancelado durante detectTool não deve emitir routing');
    assert.ok(!types.includes('sentence_audio_ready'), 'turno cancelado não deve emitir áudio');

    sse.close();
    await teardownHarness(h);
  });

  describe('Ferramentas Mutantes (Fase 5c) — integração com o turno de voz', () => {
    let tmpDataDir: string;
    let currentH: Harness | null = null;
    let currentSse: ReturnType<typeof readSse> | null = null;

    beforeEach(() => {
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-mutating-test-'));
    });

    afterEach(async () => {
      try {
        currentSse?.close();
      } catch {}
      if (currentH) {
        await teardownHarness(currentH);
        currentH = null;
      }
      currentSse = null;
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    it('Fase 5c: detectMutation detecta intenção, sintetiza pergunta e arma armedMutation (pendingMutation continua null)', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar café';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1); // state: ouvindo

        const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId } = (await audioRes.json()) as { turnId: string };

        // attach(1) + processando(2) + transcript(3) + routing(4) + falando(5) + sentence_audio_ready(6) + turn_done(7) + ouvindo(8)
        await sse.waitFor(8, 5000);

        const routingEvent = sse.events.find((e) => (e as { type: string }).type === 'routing') as
          | { type: 'routing'; turnId: string; label: string; handled: boolean }
          | undefined;
        assert.equal(routingEvent?.label, 'GERAL');
        assert.equal(routingEvent?.handled, true);

        const audioEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
          | { type: 'sentence_audio_ready'; text: string }
          | undefined;
        assert.equal(audioEvent?.text, 'Posso criar o lembrete: comprar café?');

        const session = (h.sessionManager as any).current;
        assert.ok(session.armedMutation, 'armedMutation deve estar definido');
        assert.equal(session.armedMutation.kind, 'LEMBRETE_CRIAR');
        assert.equal(session.armedMutation.content, 'comprar café');
        assert.equal(session.armedMutation.turnId, turnId);
        assert.equal(session.pendingMutation, null, 'pendingMutation deve continuar null antes de markPlayed()');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 5c: markPlayed() com turnId correto promove armedMutation para pendingMutation com askedAt monotônico', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar café';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId } = (await audioRes.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        const beforePlayed = performance.now();
        const playedRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId, text: emittedText(sse) })
        });
        assert.equal(playedRes.status, 200);

        const session = (h.sessionManager as any).current;
        assert.equal(session.armedMutation, null, 'armedMutation deve ser consumido na promoção');
        assert.ok(session.pendingMutation, 'pendingMutation deve ser preenchido');
        assert.equal(session.pendingMutation.kind, 'LEMBRETE_CRIAR');
        assert.equal(session.pendingMutation.content, 'comprar café');
        assert.equal(session.pendingMutation.askedAtTurnId, turnId);
        assert.ok(session.pendingMutation.askedAt >= beforePlayed, 'askedAt deve ser monotônico (performance.now)');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 5c (Achado 1 / v4 §7): turno superado por barge-in nunca promove armedMutation para pendingMutation', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar café';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        // Turno 1: pergunta sobre o lembrete
        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        // Barge-in: Turno 2 inicia ANTES de o cliente chamar /played para o Turno 1
        h.engine.mutationToReturn = ['NENHUMA', null];
        h.engine.fixedTranscript = 'Que horas são?';
        const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes2.status, 200);

        // Cliente tenta tarde demais chamar /played do Turno 1
        const playedRes = await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });
        // Deve recusar (401) porque turnId1 != lastTurnId (markPlayed retorna false e routes.ts envia 401)
        assert.equal(playedRes.status, 401);

        const session = (h.sessionManager as any).current;
        assert.equal(session.pendingMutation, null, 'pendingMutation nunca deve ser promovido após barge-in');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 5c: confirmação com Sim executa mutação, sintetiza sucesso e persiste dado', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar pão';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar pão'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        // Turno 1: gera pergunta
        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        // Cliente toca até o fim e chama /played
        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });

        // Turno 2: usuário responde "Sim"
        h.engine.fixedTranscript = 'Sim!';
        const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId2 } = (await audioRes2.json()) as { turnId: string };
        assert.ok(turnId2);

        // Espera eventos do turno 2
        await sse.waitFor(15, 5000);

        const audioEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(audioEvent.text, 'Lembrete criado.');

        const session = (h.sessionManager as any).current;
        assert.equal(session.pendingMutation, null, 'pendingMutation deve ser limpo após execução');

        // Confirma que o arquivo em tmpDataDir realmente contém o lembrete
        const store = new JsonStore<{ id: string; text: string }>(tmpDataDir, 'lembretes.json');
        const data = store.read();
        assert.equal(data.items.length, 1);
        assert.equal(data.items[0].text, 'comprar pão');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 5c: negação com Não cancela mutação e sintetiza MUTATION_CANCELLED_TEXT sem persistir', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar leite';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar leite'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });

        // Turno 2: "Não"
        h.engine.fixedTranscript = 'Não';
        await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        await sse.waitFor(15, 5000);

        const audioEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(audioEvent.text, MUTATION_CANCELLED_TEXT);

        const session = (h.sessionManager as any).current;
        assert.equal(session.pendingMutation, null);

        // Nada gravado
        const store = new JsonStore<{ id: string; text: string }>(tmpDataDir, 'lembretes.json');
        const data = store.read();
        assert.equal(data.items.length, 0);
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('F11: SIM por vocabulário fechado executa a mutação sem consultar o LLM', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: lavar o carro';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'lavar o carro'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });

        // F11: fala inteira em vocabulário afirmativo fechado -> SIM, sem LLM
        h.engine.fixedTranscript = 'Pode sim, obrigado';
        h.engine.confirmationToReturn = 'NAO'; // prova que o LLM não participa mais da decisão

        await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        await sse.waitFor(15, 5000);

        assert.equal(h.engine.detectConfirmationCalls.length, 0, 'F11: o LLM não decide mais confirmação');
        const audioEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(audioEvent.text, 'Lembrete criado.');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('F15 Fatia 4 (A1): mutação pós-SIM passa pelo gatekeeper e consome o token do turno', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      h.engine.fixedTranscript = 'Lembrete: lavar o carro';
      h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'lavar o carro'];

      const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
      const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
      sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      currentSse = sse;
      await sse.waitFor(1);

      const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(1)
      });
      const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
      await sse.waitFor(8, 5000);
      await fetch(`${h.baseUrl}/api/voice/session/played`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
      });

      h.engine.fixedTranscript = 'Pode sim, obrigado';
      const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(1)
      });
      const { turnId: simTurnId } = (await audioRes2.json()) as { turnId: string };
      await sse.waitFor(15, 5000);

      const audioEvent = sse.events
        .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
        .pop() as { type: 'sentence_audio_ready'; text: string };
      assert.equal(audioEvent.text, 'Lembrete criado.');

      const trace = h.sessionManager.coordinator.getTrace(simTurnId);
      assert.ok(trace, 'o turno do SIM deve ter ExecutionTrace');
      assert.equal(trace.tasks.length, 1);
      assert.equal(trace.tasks[0].subAgentId, 'tool_lembrete');
      assert.equal(trace.tasks[0].isMutation, true);
      assert.equal(trace.tasks[0].status, 'completed');
      assert.equal(h.sessionManager.peekMutationConfirmationToken(simTurnId), undefined, 'token consumido pelo gatekeeper');
    });

    it('F15 Fatia 4 (A3): estouro de orçamento durante o turno do SIM é falado no próprio turno', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      // Os 2 slots assíncronos já ocupados; o subagente do lembrete adia (async_deferred) -> estoura max_async.
      const coordinator = h.sessionManager.coordinator;
      assert.ok(coordinator.tryAcquireAsyncSlot('ocupado-1'));
      assert.ok(coordinator.tryAcquireAsyncSlot('ocupado-2'));
      coordinator.register({
        id: 'tool_lembrete',
        name: 'LEMBRETE',
        capabilities: ['test'],
        grants: ['write_file'], // T3: o tool_lembrete real declara write_file (toda mutação a exige)
        async runTask() {
          return { success: true, output: '', kind: 'async_deferred', asyncTaskId: 'async-a3' };
        }
      });

      h.engine.fixedTranscript = 'Lembrete: lavar o carro';
      h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'lavar o carro'];

      const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
      const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
      sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      currentSse = sse;
      await sse.waitFor(1);

      const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(1)
      });
      const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
      await sse.waitFor(8, 5000);
      await fetch(`${h.baseUrl}/api/voice/session/played`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
      });

      h.engine.fixedTranscript = 'Pode sim, obrigado';
      const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(1)
      });
      const { turnId: simTurnId } = (await audioRes2.json()) as { turnId: string };
      await sse.waitFor(15, 5000);

      const audioEvent = sse.events
        .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
        .pop() as { type: 'sentence_audio_ready'; turnId: string; text: string };
      assert.equal(audioEvent.turnId, simTurnId);
      assert.match(audioEvent.text, /Não consegui terminar/);
      assert.ok(h.tts.synthesizeCalls.some((s) => /Não consegui terminar/.test(s)), 'a fala de estouro passa pelo TTS do turno');
      assert.equal(coordinator.getTrace(simTurnId)?.budgetExceeded, 'max_async');
    });

    it('Fase 5c v9 (achado 5 da auditoria de código, Hermes): SIM da Camada 0 nunca aciona o gate nem detectConfirmation', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: pagar a conta';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'pagar a conta'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });

        // "com certeza" bate na whitelist exata da Camada 0 (CONFIRM_YES_EXACT) — o gate v9
        // (Camada 2) mora dentro do bloco que só roda quando a Camada 0 devolve null, então
        // não deveria nem ser avaliado aqui. Regressão direta do achado crítico da rodada 1
        // de auditoria do plano v7 (gate fora de escopo rebaixava SIM da Camada 0).
        h.engine.fixedTranscript = 'Com certeza';

        await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        await sse.waitFor(15, 5000);

        assert.equal(
          h.engine.detectConfirmationCalls.length,
          0,
          'detectConfirmation NÃO deve ser chamado — "com certeza" resolve na Camada 0'
        );
        const audioEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(audioEvent.text, 'Lembrete criado.');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('F11: resíduo de STT sem afirmação (caso #18 real) nunca executa — repete a pergunta', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: lavar o carro';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'lavar o carro'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });

        // Texto residual real do caso #18 (docs/audits/phase-5c-v6-h-confirmacao-sample-2026-09-23.md):
        // o Whisper engoliu "nem" de "nem, depois eu faço", sobrando só "E, depois eu faço." — sem
        // nenhum marcador afirmativo. O LLM (simulado aqui) erra e responde SIM; o gate da Camada 2
        // precisa rebaixar para NAO mesmo assim.
        h.engine.fixedTranscript = 'E, depois eu faço.';
        h.engine.confirmationToReturn = 'SIM';

        await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        await sse.waitFor(15, 5000);

        assert.equal(h.engine.detectConfirmationCalls.length, 0, 'F11: o LLM não decide mais confirmação');
        const audioEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(
          audioEvent.text,
          'Não entendi. Posso confirmar? Diga só sim ou não.',
          'fala sem afirmação reconhecível deve repetir a pergunta, nunca executar'
        );
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 5c: TTL de 60s expira pendingMutation e enunciado seguinte segue caminho normal', async (t) => {
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(null, [], mutatingTools);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar água';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar água'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: emittedText(sse) })
        });

        const session = (h.sessionManager as any).current;
        assert.ok(session.pendingMutation);
        // Simula expiração de TTL (>= 60_000ms)
        session.pendingMutation.askedAt = performance.now() - 60_001;

        // Próximo turno: pergunta normal
        h.engine.mutationToReturn = ['NENHUMA', null];
        h.engine.fixedTranscript = 'Explique a virtude da coragem';
        h.engine.classificationToReturn = 'GERAL';

        await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        await sse.waitFor(16, 5000);

        assert.equal(session.pendingMutation, null, 'pendingMutation expirado deve ser descartado');
        assert.equal(h.engine.classifyCalls.length, 1, 'deve ter seguido para classificação normal');
        assert.equal(h.engine.generateCalls.length, 1, 'deve ter seguido para geração normal');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 5c (Achado 5 / v5 §6.3): preview() que lança fala MUTATION_FAILURE_TEXT sem armar nada', async (t) => {
      const brokenTool: IMutatingTool = {
        name: 'LEMBRETE',
        description: 'Ferramenta com erro em preview',
        isAvailable: () => true,
        preview: () => {
          throw new Error('Falha simulada em preview()');
        },
        execute: () => 'Lembrete criado.'
      };

      const h = await setupHarness(null, [], [brokenTool]);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar pão';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar pão'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes.status, 200);
        await sse.waitFor(8, 5000);

        const audioEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
          | { type: 'sentence_audio_ready'; text: string }
          | undefined;
        assert.equal(audioEvent?.text, MUTATION_FAILURE_TEXT);

        const session = (h.sessionManager as any).current;
        assert.equal(session.armedMutation, null, 'armedMutation NÃO deve ser armado quando preview falha');
        assert.equal(session.pendingMutation, null);
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });
  });

  describe('Memória de Contexto Entre Sessões (Fase 7 — H3, H4, H5, H6)', () => {
    let tmpMemoriaDir: string;
    let currentH: Harness | null = null;
    let currentSse: ReturnType<typeof readSse> | null = null;

    beforeEach(() => {
      tmpMemoriaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-memoria-test-'));
    });

    afterEach(async () => {
      try {
        currentSse?.close();
      } catch {}
      if (currentH) {
        await teardownHarness(currentH);
        currentH = null;
      }
      currentSse = null;
      try {
        fs.rmSync(tmpMemoriaDir, { recursive: true, force: true });
      } catch {}
    });

    it('H3 — MEMORIA_GUARDAR grava em memorias.json e injeta o fato em todos os 4 rótulos (GERAL, TEOLOGIA, VIRTOLOGIA, AMBIGUO)', async (t) => {
      const { tools: mutatingTools, memoriaStore } = createMutatingTools(tmpMemoriaDir);
      const h = await setupHarness(null, [], mutatingTools, memoriaStore);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        // Turno 1: usuário pede para guardar memória
        h.engine.fixedTranscript = 'Guarda que meu nome é Rodrigo';
        h.engine.mutationToReturn = ['MEMORIA_GUARDAR', 'seu nome é Rodrigo'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1); // ouvindo

        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        const previewEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
          | { type: 'sentence_audio_ready'; text: string }
          | undefined;
        assert.equal(previewEvent?.text, 'Posso guardar isso sobre você: seu nome é Rodrigo?');

        // Confirma reprodução da pergunta
        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: previewEvent!.text })
        });

        // Turno 2: confirmação pelo usuário ("Sim")
        h.engine.fixedTranscript = 'Sim';
        const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes2.status, 200);
        await sse.waitFor(15, 5000);

        const executedEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(executedEvent?.text, 'Guardado.');

        // Verifica que o fato foi gravado em memorias.json
        const store = new JsonStore<StoredItem>(tmpMemoriaDir, 'memorias.json');
        const savedData = store.read();
        assert.equal(savedData.items.length, 1);
        assert.equal(savedData.items[0].text, 'seu nome é Rodrigo');

        // Turno seguinte para cada um dos 4 rótulos: memória deve estar presente no systemPrompt de todos
        const labels: Array<'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'AMBIGUO'> = [
          'GERAL',
          'TEOLOGIA',
          'VIRTOLOGIA',
          'AMBIGUO'
        ];

        h.engine.mutationToReturn = ['NENHUMA', null];
        h.engine.fixedTranscript = 'Qual é o meu nome?';

        for (const label of labels) {
          h.engine.classificationToReturn = label;
          const currentEventsCount = sse.events.length;
          const turnRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
            method: 'POST',
            headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
            body: buildTestWav(1)
          });
          assert.equal(turnRes.status, 200);
          await sse.waitFor(currentEventsCount + 7, 5000);

          const lastGenerateCall = h.engine.generateCalls[h.engine.generateCalls.length - 1];
          assert.ok(lastGenerateCall, `Chamada generate() esperada para rótulo ${label}`);
          const systemMsg = lastGenerateCall.messages.find((m) => m.role === 'system');
          assert.ok(systemMsg, `Mensagem de system esperada para rótulo ${label}`);
          assert.ok(
            systemMsg.content.includes('[Fatos que o usuário pediu para você lembrar entre sessões'),
            `systemPrompt para ${label} deve conter o cabeçalho de memórias`
          );
          assert.ok(
            systemMsg.content.includes('- seu nome é Rodrigo'),
            `systemPrompt para ${label} deve conter a memória guardada`
          );
        }
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('H4 — MEMORIA_ESQUECER remove o item mais recente e frase não é vetada por hasAffirmativeMarker', async (t) => {
      // 1. Teste de regressão específico: provar que a frase e respostas afirmativas passam pelo gate
      const confirmationQuestion = 'Posso apagar a memória mais recente?';
      assert.equal(confirmationQuestion, 'Posso apagar a memória mais recente?');
      // Prova que a pergunta em si não contém radicais de negação (esquece/esquecer/cancela)
      assert.equal(/esquece|esquecer|cancela|cancelar/.test(confirmationQuestion), false);
      // Prova que as respostas afirmativas naturais são aceitas por hasAffirmativeMarker
      assert.equal(hasAffirmativeMarker('sim'), true);
      assert.equal(hasAffirmativeMarker('pode apagar'), true);
      assert.equal(hasAffirmativeMarker('claro'), true);
      assert.equal(hasAffirmativeMarker('com certeza'), true);

      // 2. Fluxo end-to-end com áudio/sessão
      const { tools: mutatingTools, memoriaStore } = createMutatingTools(tmpMemoriaDir);
      // Pré-popula duas memórias
      memoriaStore.write({
        items: [
          { id: '1', text: 'fato antigo', createdAt: new Date().toISOString() },
          { id: '2', text: 'fato mais recente', createdAt: new Date().toISOString() }
        ]
      });

      const h = await setupHarness(null, [], mutatingTools, memoriaStore);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Apaga essa memória sobre mim';
        h.engine.mutationToReturn = ['MEMORIA_ESQUECER', null];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        // Turno 1: gera pergunta
        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        const previewEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
          | { type: 'sentence_audio_ready'; text: string }
          | undefined;
        // F14: content=null cai pro item mais recente via findBestMatchingItemIndex, mas a
        // frase agora cita o texto real do item encontrado em vez da frase genérica antiga.
        assert.equal(previewEvent?.text, 'Posso apagar a memória "fato mais recente"?');

        // Confirma reprodução da pergunta
        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: previewEvent!.text })
        });

        // Turno 2: resposta afirmativa real ("pode apagar")
        // "pode apagar" não está na whitelist exata (Camada 0), então consulta detectConfirmation (Camada 1)
        // e é validado pelo gate afirmativo hasAffirmativeMarker (Camada 2).
        h.engine.fixedTranscript = 'Pode apagar';
        h.engine.confirmationToReturn = 'SIM';
        const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes2.status, 200);
        await sse.waitFor(15, 5000);

        const executedEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(executedEvent?.text, 'Apagado.');

        // Verifica que o item mais recente foi removido e restou apenas o antigo
        const remaining = memoriaStore.read();
        assert.equal(remaining.items.length, 1);
        assert.equal(remaining.items[0].text, 'fato antigo');
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('H5 — falha em memoriaStore.read() (JSON corrompido) degrada com segurança e loga erro sem emitir evento de erro', async (t) => {
      // Cria uma store mock que falha na leitura simulando JSON corrompido
      const brokenStore = {
        read: () => {
          throw new Error('Falha de leitura simulada em memorias.json');
        },
        write: () => {}
      } as unknown as JsonStore<StoredItem>;

      const errorsLogged: any[] = [];
      const origConsoleError = console.error;
      console.error = (...args: any[]) => {
        errorsLogged.push(args);
      };

      const h = await setupHarness(null, [], [], brokenStore);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        console.error = origConsoleError;
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Olá, tudo bem?';
        h.engine.mutationToReturn = ['NENHUMA', null];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes.status, 200);

        // Aguarda finalização normal do turno
        await sse.waitFor(8, 5000);

        // Turno completou com sucesso (turn_done e state: ouvindo)
        const turnDone = sse.events.find((e) => (e as { type: string }).type === 'turn_done');
        assert.ok(turnDone, 'Turno deve ter finalizado com turn_done');

        // Nenhum evento de erro emitido para o cliente
        const errorEvents = sse.events.filter((e) => (e as { type: string }).type === 'error');
        assert.equal(errorEvents.length, 0, 'Nenhum evento de erro deve ser enviado ao cliente');

        // console.error foi chamado reportando a falha de memória
        const memoryLog = errorsLogged.find((args) =>
          typeof args[0] === 'string' && args[0].includes('[memory] leitura de memórias falhou')
        );
        assert.ok(memoryLog, 'console.error deve logar falha da leitura de memórias');

        // O systemPrompt não contém bloco de memória
        const lastGenerateCall = h.engine.generateCalls[h.engine.generateCalls.length - 1];
        const systemMsg = lastGenerateCall.messages.find((m) => m.role === 'system');
        assert.equal(
          systemMsg?.content.includes('[Fatos que o usuário pediu para você lembrar entre sessões'),
          false
        );
      } finally {
        console.error = origConsoleError;
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('H6 — SessionManager construído sem memoriaStore funciona normalmente sem memórias', async (t) => {
      // setupHarness sem 4º argumento instancia com memoriaStore = null
      const h = await setupHarness(null, [], []);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Como você está?';
        h.engine.mutationToReturn = ['NENHUMA', null];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes.status, 200);
        await sse.waitFor(8, 5000);

        const turnDone = sse.events.find((e) => (e as { type: string }).type === 'turn_done');
        assert.ok(turnDone, 'Turno deve ter completado com turn_done');

        const lastGenerateCall = h.engine.generateCalls[h.engine.generateCalls.length - 1];
        const systemMsg = lastGenerateCall.messages.find((m) => m.role === 'system');
        assert.equal(
          systemMsg?.content.includes('[Fatos que o usuário pediu para você lembrar entre sessões'),
          false
        );
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });
  });

  describe('Edição por voz e novos marcadores afirmativos (Fase 8)', () => {
    let tmpPhase8Dir: string;
    let currentH: Harness | null = null;
    let currentSse: ReturnType<typeof readSse> | null = null;

    beforeEach(() => {
      tmpPhase8Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-phase8-test-'));
    });

    afterEach(async () => {
      try {
        currentSse?.close();
      } catch {}
      if (currentH) {
        await teardownHarness(currentH);
        currentH = null;
      }
      currentSse = null;
      try {
        fs.rmSync(tmpPhase8Dir, { recursive: true, force: true });
      } catch {}
    });

    it('H4 — teste de regressão provando que pode trocar/editar/corrigir/ser/mudar não são vetados por hasAffirmativeMarker', () => {
      // Marcadores afirmativos de edição
      assert.equal(hasAffirmativeMarker('pode trocar'), true);
      assert.equal(hasAffirmativeMarker('pode editar'), true);
      assert.equal(hasAffirmativeMarker('pode corrigir'), true);
      assert.equal(hasAffirmativeMarker('pode sim'), true);
      assert.equal(hasAffirmativeMarker('pode mudar'), true);

      // Com variações coloquiais e pontuação
      assert.equal(hasAffirmativeMarker('Pode trocar, por favor.'), true);
      assert.equal(hasAffirmativeMarker('sim, pode editar'), true);
      assert.equal(hasAffirmativeMarker('Pode corrigir!'), true);
      assert.equal(hasAffirmativeMarker('pode sim, obrigado'), true);
      assert.equal(hasAffirmativeMarker('pode mudar isso'), true);

      // Prova que negações na mesma frase continuam vetadas
      assert.equal(hasAffirmativeMarker('não, pode trocar'), false);
      assert.equal(hasAffirmativeMarker('pode editar não'), false);
      assert.equal(hasAffirmativeMarker('nem pensar, pode corrigir'), false);
      assert.equal(hasAffirmativeMarker('cancela, pode ser'), false);
      assert.equal(hasAffirmativeMarker('nunca, pode mudar'), false);
    });

    it('fluxo end-to-end: LEMBRETE_EDITAR por voz confirmado com "Pode trocar" atualiza lembrete mantendo dueAt', async (t) => {
      const { tools: mutatingTools, memoriaStore } = createMutatingTools(tmpPhase8Dir);
      const lembreteStore = new JsonStore<StoredItem>(tmpPhase8Dir, 'lembretes.json');
      const dueAt = new Date(Date.now() + 3600_000).toISOString();
      lembreteStore.write({
        items: [
          { id: 'rem-1', text: 'comprar café em pó', createdAt: new Date().toISOString(), dueAt, notifiedAt: null }
        ]
      });

      const h = await setupHarness(null, [], mutatingTools, memoriaStore);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Troca esse lembrete pra comprar café solúvel';
        h.engine.mutationToReturn = ['LEMBRETE_EDITAR', 'comprar café solúvel'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        // Turno 1: gera preview
        const audioRes1 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8, 5000);

        const previewEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
          | { type: 'sentence_audio_ready'; text: string }
          | undefined;
        // F14: EDITAR agora localiza o item por correspondência de conteúdo e cita o texto
        // real encontrado, em vez da frase genérica "o lembrete mais recente".
        assert.equal(previewEvent?.text, 'Posso trocar o lembrete "comprar café em pó" para: comprar café solúvel?');

        // Confirma reprodução da pergunta
        await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId: turnId1, text: previewEvent!.text })
        });

        // Turno 2: resposta afirmativa com "Pode trocar"
        h.engine.fixedTranscript = 'Pode trocar';
        const audioRes2 = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes2.status, 200);
        await sse.waitFor(15, 5000);

        const executedEvent = sse.events
          .filter((e) => (e as { type: string }).type === 'sentence_audio_ready')
          .pop() as { type: 'sentence_audio_ready'; text: string };
        assert.equal(executedEvent?.text, 'Lembrete atualizado.');

        // Verifica que o item foi atualizado e preservou o dueAt
        const saved = lembreteStore.read();
        assert.equal(saved.items.length, 1);
        assert.equal(saved.items[0].text, 'comprar café solúvel');
        assert.equal(saved.items[0].id, 'rem-1');
        assert.equal(saved.items[0].dueAt, dueAt);
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });

    it('Fase 14: LEMBRETE_CONSULTAR fala a resposta num único turno, sem pedir confirmação (achado 1 da auditoria r1)', async (t) => {
      const { tools: mutatingTools, memoriaStore } = createMutatingTools(tmpPhase8Dir);
      const lembreteStore = new JsonStore<StoredItem>(tmpPhase8Dir, 'lembretes.json');
      lembreteStore.write({
        items: [{ id: 'rem-pao', text: 'comprar pão', createdAt: new Date().toISOString() }]
      });

      const h = await setupHarness(null, [], mutatingTools, memoriaStore);
      currentH = h;
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      try {
        h.engine.fixedTranscript = 'Tem algum lembrete de pão?';
        h.engine.mutationToReturn = ['LEMBRETE_CONSULTAR', 'pão'];

        const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
        const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };

        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        currentSse = sse;
        await sse.waitFor(1);

        const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
        assert.equal(audioRes.status, 200);
        await sse.waitFor(8, 5000);

        // Resposta já é o resultado da consulta — nunca uma pergunta "Posso...?" esperando confirmação.
        const spoken = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
          | { type: 'sentence_audio_ready'; text: string }
          | undefined;
        assert.ok(spoken?.text.includes('comprar pão'), spoken?.text);
        assert.ok(!spoken?.text.startsWith('Posso'), spoken?.text);

        // Um único turno basta — não há segundo round de audio/played esperando "sim".
        const turnDone = sse.events.find((e) => (e as { type: string }).type === 'turn_done');
        assert.ok(turnDone);

        // Nenhum item foi alterado: consulta é leitura.
        assert.equal(lembreteStore.read().items.length, 1);
      } finally {
        sse?.close();
        await teardownHarness(h);
      }
    });
  });

  describe('Geração com Gemini e tratamento de erro condicional (Fase 10a — H5)', () => {
    let h: Harness;
    let sse: ReturnType<typeof readSse> | null = null;

    beforeEach(async () => {
      h = await setupHarness();
    });

    afterEach(async () => {
      sse?.close();
      sse = null;
      await teardownHarness(h);
    });

    it('H5 (Cenário A): falha do Gemini sem nenhuma frase emitida sintetiza GENERATION_FAILURE_TEXT com índice 0', async () => {
      // Simula erro da API do Gemini antes de qualquer frase (ex.: timeout de 20s ou erro de cota)
      h.engine.generate = async () => {
        throw new Error('Gemini API 503: Service Unavailable');
      };

      const res = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
      const { sessionId, token } = (await res.json()) as { sessionId: string; token: string };

      sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      await sse.waitFor(1);

      const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(0.5)
      });
      assert.equal(audioRes.status, 200);

      // Espera o turno concluir (state ouvindo, processando, transcript, routing, falando, sentence_audio_ready, turn_done, ouvindo)
      await sse.waitFor(8, 5000);

      const readyEvents = sse.events.filter(
        (e) => (e as { type: string }).type === 'sentence_audio_ready'
      ) as Array<{ type: string; sentenceIndex: number; text: string }>;

      assert.equal(readyEvents.length, 1, 'deve emitir exatamente 1 evento de áudio (o erro falado)');
      assert.equal(readyEvents[0].sentenceIndex, 0, 'deve ter índice 0');
      assert.equal(readyEvents[0].text, GENERATION_FAILURE_TEXT);
      assert.ok(h.tts.synthesizeCalls.includes(GENERATION_FAILURE_TEXT), 'TTS deve ter sintetizado a frase de erro');

      // Turno deve terminar normalmente (turn_done + ouvindo), sem entrar em state: 'erro'
      const turnDone = sse.events.find((e) => (e as { type: string }).type === 'turn_done');
      assert.ok(turnDone, 'deve emitir turn_done');

      const stateEvents = sse.events.filter((e) => (e as { type: string }).type === 'state') as Array<{
        type: string;
        state: string;
      }>;
      const lastState = stateEvents[stateEvents.length - 1];
      assert.equal(lastState.state, 'ouvindo', 'estado final deve ser ouvindo');
      assert.ok(!stateEvents.some((e) => e.state === 'erro'), 'não deve entrar em estado erro');
    });

    it('H5 (Cenário B): falha do Gemini após pelo menos 1 frase encerra com o que já foi dito sem colisão de índice', async () => {
      // Simula erro de streaming do Gemini após a frase 0 já ter sido entregue
      h.engine.generate = async (_turnId, _epoch, _messages, callbacks) => {
        callbacks.onSentence('Primeira frase gerada pelo modelo com sucesso.', 0);
        throw new Error('Gemini network stream broken mid-turn');
      };

      const res = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
      const { sessionId, token } = (await res.json()) as { sessionId: string; token: string };

      sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      await sse.waitFor(1);

      const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(0.5)
      });
      assert.equal(audioRes.status, 200);

      await sse.waitFor(8, 5000);

      const readyEvents = sse.events.filter(
        (e) => (e as { type: string }).type === 'sentence_audio_ready'
      ) as Array<{ type: string; sentenceIndex: number; text: string }>;

      assert.equal(readyEvents.length, 1, 'deve emitir apenas a frase que completou');
      assert.equal(readyEvents[0].sentenceIndex, 0);
      assert.equal(readyEvents[0].text, 'Primeira frase gerada pelo modelo com sucesso.');

      // NÃO deve sintetizar GENERATION_FAILURE_TEXT
      assert.ok(
        !h.tts.synthesizeCalls.includes(GENERATION_FAILURE_TEXT),
        'NÃO deve sintetizar GENERATION_FAILURE_TEXT quando já houve frase falada'
      );

      const turnDone = sse.events.find((e) => (e as { type: string }).type === 'turn_done');
      assert.ok(turnDone, 'deve emitir turn_done normalmente');

      const stateEvents = sse.events.filter((e) => (e as { type: string }).type === 'state') as Array<{
        type: string;
        state: string;
      }>;
      assert.equal(stateEvents[stateEvents.length - 1].state, 'ouvindo');
      assert.ok(!stateEvents.some((e) => e.state === 'erro'));
    });

    it('H5 (Cenário C): turno cancelado/superado durante a falha do Gemini não sintetiza erro nem afeta o novo turno', async () => {
      let turnId1 = '';
      const res = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
      const { sessionId, token } = (await res.json()) as { sessionId: string; token: string };

      h.engine.generate = async (turnId) => {
        turnId1 = turnId;
        // Simula cancelamento do turno pelo cliente antes da falha ser tratada
        await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId })
        });
        throw new Error('Gemini failed after cancel');
      };

      sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      await sse.waitFor(1);

      await fetch(`${h.baseUrl}/api/voice/session/audio`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
        body: buildTestWav(0.5)
      });

      // Aguarda um tempo para garantir que nada foi sintetizado para o turno cancelado
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(
        !h.tts.synthesizeCalls.includes(GENERATION_FAILURE_TEXT),
        'NÃO deve sintetizar GENERATION_FAILURE_TEXT para turno superado'
      );
      assert.ok(h.engine.cancelledTurnIds.includes(turnId1));
    });
  });
});




// ---------------------------------------------------------------------------------------------
// Fase 12 — controles de saída para o Gemini (docs/phase-12-v2.md §2.1, critérios H12.2/H12.3).
// Cada teste "ausente" tem um controle positivo (mesmo cenário com o envio ligado mostra o conteúdo).
// ---------------------------------------------------------------------------------------------
describe('Privacidade (Fase 12) — controles de saída', () => {
  const MARCADOR_MEMORIA = 'MARCADOR-MEMORIA-7731';
  const MARCADOR_FALA = 'MARCADOR-FALA-4412';
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function waitForType(sse: ReturnType<typeof readSse>, type: string, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((sse.events as Array<{ type: string }>).some((e) => e.type === type)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`evento "${type}" não chegou em ${ms}ms`);
  }

  async function openSession(h: Harness): Promise<{ sessionId: string; token: string; sse: ReturnType<typeof readSse> }> {
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);
    cleanups.push(async () => {
      sse.close();
    });
    return { sessionId, token, sse };
  }

  async function speak(h: Harness, s: { sessionId: string; token: string }): Promise<void> {
    const res = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    assert.equal(res.status, 200);
  }

  async function start(
    privacy: PrivacyConfig,
    opts: { retriever?: KnowledgeRetriever | null; tools?: readonly ITool[]; memorias?: string[] } = {}
  ): Promise<Harness> {
    let memoriaStore: JsonStore<StoredItem> | null = null;
    let mutatingTools: readonly IMutatingTool[] = [];
    if (opts.memorias) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-f12-mem-'));
      cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
      const made = createMutatingTools(dir);
      made.memoriaStore.write({
        items: opts.memorias.map((text, i) => ({ id: String(i + 1), text, createdAt: new Date().toISOString() }))
      });
      memoriaStore = made.memoriaStore;
      mutatingTools = made.tools;
    }
    const h = await setupHarness(opts.retriever ?? null, opts.tools ?? [], mutatingTools, memoriaStore, privacy);
    cleanups.push(async () => teardownHarness(h));
    return h;
  }

  it('memórias: SEND_MEMORIES=0 não põe o bloco no prompt; SEND_MEMORIES=1 põe (controle positivo)', async () => {
    for (const [sendMemories, expected] of [[false, false], [true, true]] as const) {
      const h = await start({ ...DEFAULT_PRIVACY, sendMemories }, { memorias: [MARCADOR_MEMORIA] });
      const s = await openSession(h);
      h.engine.fixedTranscript = 'conta uma curiosidade qualquer';
      await speak(h, s);
      await waitForType(s.sse, 'turn_done');
      const prompt = h.engine.generateCalls[0]?.messages[0]?.content ?? '';
      assert.equal(prompt.includes(MARCADOR_MEMORIA), expected, `sendMemories=${sendMemories}`);
      await cleanups.pop()!(); // h
    }
  });

  it('conhecimento: padrão (D1) não envia o trecho; SEND_KNOWLEDGE=1 envia (controle positivo)', async () => {
    const chunks = [...chunkMarkdown('teologia', KNOWLEDGE_FIXTURE)];
    for (const [sendKnowledge, expected] of [[false, false], [true, true]] as const) {
      const h = await start({ ...DEFAULT_PRIVACY, sendKnowledge }, { retriever: new KnowledgeRetriever(chunks) });
      const s = await openSession(h);
      h.engine.classificationToReturn = 'TEOLOGIA' as never;
      h.engine.fixedTranscript = 'Faça uma análise exegética desse texto';
      await speak(h, s);
      await waitForType(s.sse, 'turn_done');
      const prompt = h.engine.generateCalls[0]?.messages[0]?.content ?? '';
      assert.equal(prompt.includes(KNOWLEDGE_PREAMBLE), expected, `sendKnowledge=${sendKnowledge}`);
      await cleanups.pop()!();
    }
    assert.equal(DEFAULT_PRIVACY.sendKnowledge, false, 'D1: o padrão de produção NÃO envia o trecho de docs/research');
  });

  it('histórico: SEND_HISTORY=0 manda só a fala atual; padrão manda o turno anterior (controle positivo)', async () => {
    for (const [sendHistory, expectPrevious] of [[false, false], [true, true]] as const) {
      const h = await start({ ...DEFAULT_PRIVACY, sendHistory });
      const s = await openSession(h);
      h.engine.fixedTranscript = `${MARCADOR_FALA} primeira fala`;
      await speak(h, s);
      await waitForType(s.sse, 'turn_done');
      const first = (s.sse.events as Array<{ type: string; turnId?: string }>).find((e) => e.type === 'turn_done')!;
      // a frase do assistente só entra no histórico depois de tocada
      await fetch(`${h.baseUrl}/api/voice/session/played`, {
        method: 'POST',
        headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: first.turnId, text: 'Olá!' })
      });
      h.engine.fixedTranscript = 'segunda fala sem marcador';
      await speak(h, s);
      await new Promise((r) => setTimeout(r, 250));
      const second = h.engine.generateCalls[1]?.messages ?? [];
      const body = second.filter((m) => m.role !== 'system');
      const mentionsFirst = body.some((m) => m.content.includes(MARCADOR_FALA));
      assert.equal(mentionsFirst, expectPrevious, `sendHistory=${sendHistory}`);
      if (!sendHistory) {
        assert.equal(body.length, 1, 'só a fala do turno atual');
        assert.equal(body[0].role, 'user');
        assert.ok(body[0].content.includes('segunda fala'));
      }
      await cleanups.pop()!();
    }
  });

  it('mestre RODRIGO_CLOUD=0: nenhuma geração, nenhuma intenção; o turno diz que a geração está desligada', async () => {
    const h = await start({ ...DEFAULT_PRIVACY, cloud: false }, { tools: createSystemTools(() => new Date('2026-10-03T14:30:00-03:00')) });
    const s = await openSession(h);
    h.engine.fixedTranscript = 'que horas são agora';
    await speak(h, s);
    await waitForType(s.sse, 'turn_done');
    assert.equal(h.engine.detectIntentCalls.length, 0, 'intenção em nuvem NÃO pode ser chamada com o mestre desligado');
    assert.equal(h.engine.generateCalls.length, 0, 'geração NÃO pode ser chamada com o mestre desligado');

    h.engine.fixedTranscript = 'conta uma curiosidade qualquer';
    await speak(h, s);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.engine.generateCalls.length, 0, 'geração continua não chamada');
    assert.ok(h.tts.synthesizeCalls.includes(GENERATION_DISABLED_TEXT), 'a fala diz que a geração está desligada');
  });

  it('controle positivo da intenção: com a nuvem ligada, "que horas são" chama a intenção; cloudIntent=false não chama mas gera', async () => {
    const tools = () => createSystemTools(() => new Date('2026-10-03T14:30:00-03:00'));
    for (const [cloudIntent, expectedCalls] of [[true, 1], [false, 0]] as const) {
      const h = await start({ ...DEFAULT_PRIVACY, cloudIntent }, { tools: tools() });
      const s = await openSession(h);
      h.engine.fixedTranscript = 'que horas são agora';
      await speak(h, s);
      await waitForType(s.sse, 'turn_done');
      assert.equal(h.engine.detectIntentCalls.length, expectedCalls, `cloudIntent=${cloudIntent}`);
      await cleanups.pop()!();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Transcrição vazia = ruído/eco/fragmento: ignorada em silêncio (uso real, 2026-10-07: "Texto vazio para classificação"
// aparecia como erro vermelho a cada estalo do microfone).
// ---------------------------------------------------------------------------------------------
describe('Transcrição sem fala reconhecível é ignorada em silêncio', () => {
  it('hasRecognizableSpeech: só letras/números contam (inclui acentos e dígitos)', async () => {
    const { hasRecognizableSpeech } = await import('../voice/sessionManager.js');
    for (const nothing of ['', '   ', '\n', '!', '...', ' . ', '♪', '—', '?!']) assert.equal(hasRecognizableSpeech(nothing), false, JSON.stringify(nothing));
    for (const speech of ['oi', 'Sim', 'ã', '7', 'que horas são?', ' ok ']) assert.equal(hasRecognizableSpeech(speech), true, JSON.stringify(speech));
  });

  it('turno com transcrição vazia: sem erro, sem bolha "transcript", sem classificação, sem histórico; volta a ouvir e o próximo turno funciona', async () => {
    const h = await setupHarness();
    try {
      const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
      const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
      const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      await sse.waitFor(1);
      const post = async (): Promise<void> => {
        await fetch(`${h.baseUrl}/api/voice/session/audio`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
          body: buildTestWav(1)
        });
      };
      const types = (): string[] => (sse.events as Array<{ type: string }>).map((e) => e.type);
      const until = async (pred: () => boolean): Promise<void> => {
        const end = Date.now() + 4000;
        while (Date.now() < end && !pred()) await new Promise((r) => setTimeout(r, 15));
        assert.ok(pred(), `condição não atendida; eventos: ${types().join(',')}`);
      };

      for (const nothing of ['', '  ', '!', '...']) {
        const before = types().length;
        h.engine.fixedTranscript = nothing;
        await post();
        await until(() => types().slice(before).includes('turn_done'));
        const fresh = types().slice(before);
        assert.ok(!fresh.includes('error') && !fresh.includes('transcript') && !fresh.includes('routing'), `${JSON.stringify(nothing)}: ${fresh.join(',')}`);
        assert.equal(fresh[fresh.length - 1], 'state', 'termina voltando a ouvir');
        assert.equal((sse.events[sse.events.length - 1] as { state?: string }).state, 'ouvindo');
      }
      assert.equal(h.engine.classifyCalls.length, 0, 'nenhuma classificação para ruído');
      assert.equal(h.engine.generateCalls.length, 0, 'nenhuma geração para ruído');

      // CONTROLE POSITIVO: fala de verdade logo depois segue o fluxo normal inteiro
      const before = types().length;
      h.engine.fixedTranscript = 'oi, tudo bem';
      await post();
      await until(() => types().slice(before).includes('turn_done'));
      assert.ok(types().slice(before).includes('transcript') && types().slice(before).includes('routing'));
      assert.equal(h.engine.classifyCalls.length, 1);
      assert.equal(h.engine.generateCalls.length, 1);
      const history = h.engine.generateCalls[0].messages.filter((m) => m.role !== 'system');
      assert.equal(history.length, 1, 'o ruído NÃO entrou no histórico');
      assert.equal(history[0].content, 'oi, tudo bem');
      sse.close();
    } finally {
      await teardownHarness(h);
    }
  });
});
