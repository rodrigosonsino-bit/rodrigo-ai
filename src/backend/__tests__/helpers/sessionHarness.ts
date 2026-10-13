import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from '../../server.js';
import type { AppConfig } from '../../../shared/types.js';
import { AudioStore } from '../../voice/audioStore.js';
import { FakeVoiceEngine } from '../../voice/fakeEngine.js';
import { SessionManager } from '../../voice/sessionManager.js';
import type { IVoiceProvider } from '../../../shared/extensions/voice.js';
import { createSpecialistAgents } from '../../agents/specialistAgents.js';
import { createSystemTools } from '../../tools/index.js';
import { JsonStore, type StoredItem } from '../../storage/jsonStore.js';
import { parsePrivacyConfig, type PrivacyConfig } from '../../privacy.js';
import { buildTestWav } from './egress.js';

/** Harness compartilhado (T1): SessionManager real com motor e voz falsos, para os testes de guarda e de canais de injeção. */
export const MEMORY_SECRET = 'a senha do cofre é Cofre2026Azul';

export class FakeVoiceProvider implements IVoiceProvider {
  readonly id = 'fake';
  readonly name = 'Fake TTS';
  public synthesizeCalls: string[] = [];
  isAvailable(): boolean {
    return true;
  }
  async synthesize(text: string, outputPath: string): Promise<void> {
    this.synthesizeCalls.push(text);
    await fs.promises.writeFile(outputPath, buildTestWav(0.1));
  }
}

export interface H {
  server: http.Server;
  baseUrl: string;
  engine: FakeVoiceEngine;
  tts: FakeVoiceProvider;
  sm: SessionManager;
  dir: string;
}

export async function setup(env: Record<string, string>, withMemory: boolean, memoryText: string = MEMORY_SECRET): Promise<H> {
  const port = 25100 + Math.floor(Math.random() * 3000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-guard-test-'));
  const engine = new FakeVoiceEngine();
  const tts = new FakeVoiceProvider();
  const audioStore = new AudioStore(dir);
  let memoriaStore: JsonStore<StoredItem> | null = null;
  if (withMemory) {
    memoriaStore = new JsonStore<StoredItem>(dir, 'memorias.json');
    memoriaStore.write({ items: [{ id: 'm1', text: memoryText, createdAt: new Date().toISOString() }] });
  }
  const privacy: PrivacyConfig = parsePrivacyConfig(env);
  const sm = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), null, createSystemTools(), [], memoriaStore, privacy);
  const server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, sm, dir };
}

export async function teardown(h: H): Promise<void> {
  await h.sm.shutdownAll();
  const closed = new Promise<void>((resolve) => h.server.close(() => resolve()));
  h.server.closeAllConnections();
  h.server.closeIdleConnections();
  await closed;
  await fs.promises.rm(h.dir, { recursive: true, force: true }).catch(() => {});
}

export async function oneTurn(h: H, transcript: string): Promise<void> {
  h.engine.fixedTranscript = transcript;
  const res = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
  const { sessionId, token } = (await res.json()) as { sessionId: string; token: string };
  await fetch(`${h.baseUrl}/api/voice/session/audio`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' },
    body: buildTestWav(1)
  });
  // espera o turno chegar à geração (ou ser bloqueado e falado)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (h.engine.generateCalls.length > 0 || h.tts.synthesizeCalls.length > 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 150));
}

