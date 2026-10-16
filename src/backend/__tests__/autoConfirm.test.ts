import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager, parseAutoConfirm } from '../voice/sessionManager.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { createSystemTools } from '../tools/index.js';
import { createMutatingTools } from '../tools/index.js';
import { DesktopTool } from '../tools/desktopControlTool.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import { DEFAULT_PRIVACY } from '../privacy.js';

function buildTestWav(durationSeconds = 0.2, sampleRate = 16000): Buffer {
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const buffer = Buffer.alloc(44 + totalSamples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + totalSamples * 2, 4);
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
  buffer.writeUInt32LE(totalSamples * 2, 40);
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
    if (signal?.aborted) throw new Error('aborted');
    await fs.promises.writeFile(outputPath, buildTestWav(0.1));
  }
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
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          events.push(JSON.parse(line.slice(5)));
        } catch {}
        if (events.length >= waitCount && resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      }
    }
  });
  return {
    events,
    close: () => controller.abort(),
    waitFor: (n: number, timeoutMs = 5000) =>
      new Promise<void>((resolve, reject) => {
        if (events.length >= n) {
          resolve();
          return;
        }
        waitCount = n;
        const t = setTimeout(() => reject(new Error(`SSE timeout esperando ${n} eventos`)), timeoutMs);
        resolveWait = () => {
          clearTimeout(t);
          resolve();
        };
      })
  };
}

describe('RODRIGO_AUTO_CONFIRM', () => {
  it('parse: padrão 0, 1 liga, inválido aborta', () => {
    assert.equal(parseAutoConfirm({}), false);
    assert.equal(parseAutoConfirm({ RODRIGO_AUTO_CONFIRM: '' }), false);
    assert.equal(parseAutoConfirm({ RODRIGO_AUTO_CONFIRM: '0' }), false);
    assert.equal(parseAutoConfirm({ RODRIGO_AUTO_CONFIRM: '1' }), true);
    assert.throws(() => parseAutoConfirm({ RODRIGO_AUTO_CONFIRM: 'sim' }), /RODRIGO_AUTO_CONFIRM/);
  });
});

describe('autonomia direta (autoConfirm)', () => {
  let tmpDataDir = '';
  let currentH: {
    server: http.Server;
    baseUrl: string;
    engine: FakeVoiceEngine;
    sessionManager: SessionManager;
    tmpDir: string;
  } | null = null;
  let currentSse: { close: () => void } | null = null;

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-auto-'));
  });

  afterEach(async () => {
    currentSse?.close();
    currentSse = null;
    if (currentH) {
      await currentH.sessionManager.shutdownAll();
      const closePromise = new Promise<void>((resolve) => currentH!.server.close(() => resolve()));
      currentH.server.closeAllConnections();
      currentH.server.closeIdleConnections();
      await closePromise;
      await fs.promises.rm(currentH.tmpDir, { recursive: true, force: true }).catch(() => {});
      currentH = null;
    }
    try {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  async function setup(autoConfirm: boolean, withDesktop = false) {
    const port = 20000 + Math.floor(Math.random() * 5000);
    const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-test-'));
    const engine = new FakeVoiceEngine();
    const tts = new FakeVoiceProvider();
    const audioStore = new AudioStore(tmpDir);
    const { tools: baseTools } = createMutatingTools(tmpDataDir);
    const tools: readonly IMutatingTool[] = withDesktop
      ? [...baseTools, new DesktopTool({ env: { RODRIGO_DESKTOP_CONTROL: '1' } })]
      : baseTools;
    const sessionManager = new SessionManager(
      engine,
      tts,
      audioStore,
      createSpecialistAgents(),
      null,
      createSystemTools(),
      tools,
      null,
      DEFAULT_PRIVACY,
      { autoConfirm },
      null
    );
    const server = await startServer(config, undefined, { config, sessionManager, audioStore });
    const h = { server, baseUrl: `http://127.0.0.1:${port}`, engine, sessionManager, tmpDir };
    currentH = h;
    return h;
  }

  async function runTurn(
    h: NonNullable<typeof currentH>,
    transcript: string,
    action: string,
    content: string | null
  ): Promise<{ turnId: string; speech: string }> {
    h.engine.fixedTranscript = transcript;
    h.engine.mutationToReturn = [action as never, content];
    const createRes = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await createRes.json()) as { sessionId: string; token: string };
    const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    currentSse = sse;
    await sse.waitFor(1);
    const audioRes = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
      body: buildTestWav(1)
    });
    const { turnId } = (await audioRes.json()) as { turnId: string };
    await sse.waitFor(8, 8000);
    const audioEvent = sse.events.find((e) => (e as { type: string }).type === 'sentence_audio_ready') as
      | { text: string }
      | undefined;
    return { turnId, speech: audioEvent?.text ?? '' };
  }

  it('ligado: LEMBRETE_CRIAR executa já, sem pergunta, e o retorno é falado', async () => {
    const h = await setup(true);
    const { speech } = await runTurn(h, 'lembra de comprar café', 'LEMBRETE_CRIAR', 'comprar café');
    assert.match(speech, /Lembrete criado/, `deveria falar o resultado, não a pergunta: ${speech}`);
    assert.doesNotMatch(speech, /Posso criar/i);
    const session = (h.sessionManager as unknown as { current: { armedMutation: unknown; pendingMutation: unknown } }).current;
    assert.equal(session.armedMutation, null, 'nada armado no modo direto');
    assert.equal(session.pendingMutation, null);
    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 1, 'lembrete gravado no store');
  });

  it('ligado: DESKTOP_CRITICO continua pedindo SIM', async () => {
    const h = await setup(true, true);
    const { speech } = await runTurn(h, 'fecha o safari', 'DESKTOP_CRITICO', 'app_quit:Safari');
    assert.match(speech, /Pode confirmar/, `crítico ainda pergunta: ${speech}`);
    const session = (h.sessionManager as unknown as { current: { armedMutation: { kind: string } | null } }).current;
    assert.equal(session.armedMutation?.kind, 'DESKTOP_CRITICO');
  });

  it('desligado (padrão): LEMBRETE_CRIAR pergunta antes', async () => {
    const h = await setup(false);
    const { speech } = await runTurn(h, 'lembra de comprar café', 'LEMBRETE_CRIAR', 'comprar café');
    assert.match(speech, /Posso criar o lembrete/i);
    const session = (h.sessionManager as unknown as { current: { armedMutation: { kind: string } | null } }).current;
    assert.equal(session.armedMutation?.kind, 'LEMBRETE_CRIAR');
  });
});
