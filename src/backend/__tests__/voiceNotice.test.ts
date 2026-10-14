import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import type { AppConfig } from '../../shared/types.js';
import { VOICE_FALLBACK_NOTICE } from '../../shared/voiceProtocol.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { startServer } from '../server.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager } from '../voice/sessionManager.js';
import { freePort } from './helpers/freePort.js';

/** T9-política (a): o aviso de troca de voz chega ao cliente no máximo UMA vez por sessão, e é informativo (não é erro). */
function wav(): Buffer {
  const pcm = Buffer.alloc(3200);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

class FlakyCloudVoice implements IVoiceProvider {
  readonly id = 'flaky'; readonly name = 'flaky';
  onFallback?: (info: { turnId?: string; reason: string }) => void;
  isAvailable(): boolean { return true; }
  async synthesize(_t: string, out: string, _s?: AbortSignal, o?: SynthesizeOptions): Promise<void> {
    this.onFallback?.({ turnId: o?.turnId, reason: 'server' }); // simula a nuvem caindo a CADA frase
    await fs.promises.writeFile(out, wav());
  }
}

describe('T9-política (a): aviso de troca de voz', () => {
  let server: http.Server; let sm: SessionManager; let tmp: string; let base: string; let voice: FlakyCloudVoice;
  afterEach(async () => {
    await sm.shutdownAll();
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections(); server.closeIdleConnections(); await closed;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(): Promise<{ engine: FakeVoiceEngine }> {
    const port = await freePort();
    const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't9-notice-'));
    const engine = new FakeVoiceEngine();
    const audioStore = new AudioStore(tmp);
    voice = new FlakyCloudVoice();
    sm = new SessionManager(engine, voice, audioStore, createSpecialistAgents(), null, [], [], null);
    server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
    base = `http://127.0.0.1:${port}`;
    return { engine };
  }
  async function session(): Promise<{ sessionId: string; token: string; events: Array<Record<string, unknown>> }> {
    const r = await fetch(`${base}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await r.json()) as { sessionId: string; token: string };
    const events: Array<Record<string, unknown>> = [];
    fetch(`${base}/api/voice/session/events?sessionId=${sessionId}&token=${token}`).then(async (res) => {
      const rd = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
        for (const p of parts) { const l = p.split('\n').find((x) => x.startsWith('data: ')); if (l) events.push(JSON.parse(l.slice(6))); } }
    }).catch(() => {});
    for (let i = 0; i < 300 && events.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    return { sessionId, token, events };
  }
  async function turn(s: { sessionId: string; token: string; events: Array<Record<string, unknown>> }): Promise<void> {
    const before = s.events.filter((e) => e.type === 'turn_done').length;
    const r = await fetch(`${base}/api/voice/session/audio`, { method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'audio/wav' }, body: wav() });
    assert.equal(r.status, 200);
    for (let i = 0; i < 400 && s.events.filter((e) => e.type === 'turn_done').length === before; i++) await new Promise((r2) => setTimeout(r2, 10));
    assert.equal(s.events.filter((e) => e.type === 'turn_done').length, before + 1, 'turno concluído');
  }
  const notices = (s: { events: Array<Record<string, unknown>> }) => s.events.filter((e) => e.type === 'voice_notice');

  it('dois turnos com a nuvem caindo em todas as frases => UM aviso, com a mensagem fixa e código tts_fallback', async () => {
    const { engine } = await boot();
    engine.sentencesToEmit = ['Primeira frase.', 'Segunda frase.'];
    const s = await session();
    await turn(s); await turn(s);
    assert.equal(notices(s).length, 1);
    assert.deepEqual(notices(s)[0], { type: 'voice_notice', code: 'tts_fallback', message: VOICE_FALLBACK_NOTICE });
    assert.equal(s.events.some((e) => e.type === 'error'), false, 'o aviso não é erro');
  });

  it('callback TARDIO de um turno que não é desta sessão NÃO avisa (achado do Codex)', async () => {
    await boot();
    const s = await session();
    voice.onFallback?.({ turnId: 'turno-de-outra-sessao', reason: 'server' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notices(s).length, 0);
  });

  it('uma sessão NOVA recebe o seu próprio aviso (é por sessão, não global)', async () => {
    const { engine } = await boot();
    engine.sentencesToEmit = ['Frase única.'];
    const a = await session(); await turn(a);
    const b = await session(); await turn(b);
    assert.equal(notices(b).length, 1);
  });
});
