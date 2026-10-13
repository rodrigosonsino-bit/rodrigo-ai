import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager } from '../voice/sessionManager.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { createSystemTools } from '../tools/index.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import { parsePrivacyConfig, OUTBOUND_BLOCKED_TEXT, type PrivacyConfig } from '../privacy.js';
import { buildTestWav } from './helpers/egress.js';
import { resetOutboundCounts, getOutboundCounts, maskFor } from '../privacy/outboundGuard.js';

/**
 * T1: o guarda de saída no fluxo REAL do SessionManager (motor falso). Marcadores sintéticos plantados na fala e nas
 * memórias não aparecem no prompt de geração nem no texto da intenção em nuvem nos modos redact e block; com o guarda
 * em off eles SAEM (controle positivo). Prova de mutação: ver docs/audits/ (remover guardMessages/guardText reprova).
 */
const CPF = '529.982.247-25';
const KEY = 'AIzaSyD' + 'q'.repeat(32);
const MEMORY_SECRET = 'a senha do cofre é Cofre2026Azul';

class FakeVoiceProvider implements IVoiceProvider {
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

interface H {
  server: http.Server;
  baseUrl: string;
  engine: FakeVoiceEngine;
  tts: FakeVoiceProvider;
  sm: SessionManager;
  dir: string;
}

async function setup(env: Record<string, string>, withMemory: boolean): Promise<H> {
  const port = 25100 + Math.floor(Math.random() * 3000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-guard-test-'));
  const engine = new FakeVoiceEngine();
  const tts = new FakeVoiceProvider();
  const audioStore = new AudioStore(dir);
  let memoriaStore: JsonStore<StoredItem> | null = null;
  if (withMemory) {
    memoriaStore = new JsonStore<StoredItem>(dir, 'memorias.json');
    memoriaStore.write({ items: [{ id: 'm1', text: MEMORY_SECRET, createdAt: new Date().toISOString() }] });
  }
  const privacy: PrivacyConfig = parsePrivacyConfig(env);
  const sm = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), null, createSystemTools(), [], memoriaStore, privacy);
  const server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, sm, dir };
}

async function teardown(h: H): Promise<void> {
  await h.sm.shutdownAll();
  const closed = new Promise<void>((resolve) => h.server.close(() => resolve()));
  h.server.closeAllConnections();
  h.server.closeIdleConnections();
  await closed;
  await fs.promises.rm(h.dir, { recursive: true, force: true }).catch(() => {});
}

async function oneTurn(h: H, transcript: string): Promise<void> {
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

const FALA = `que horas são? meu cpf é ${CPF} e a chave ${KEY}`;
function everythingSentToCloud(h: H): string {
  return JSON.stringify({
    generate: h.engine.generateCalls.map((c) => c.messages),
    intent: h.engine.detectIntentCalls.map((c) => c.text)
  });
}

describe('guarda de saída no fluxo real do SessionManager (T1)', () => {
  it('redact (padrão): nem a fala nem a memória chegam em claro ao prompt de geração nem à intenção em nuvem', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'redact' }, true);
    t.after(() => teardown(h));
    await oneTurn(h, FALA);
    const sent = everythingSentToCloud(h);
    assert.ok(h.engine.generateCalls.length > 0, 'precondição: houve geração (senão o teste não prova nada)');
    for (const secret of [CPF, KEY, 'Cofre2026Azul']) assert.equal(sent.includes(secret), false, `vazou: ${secret.slice(0, 6)}…`);
    assert.ok(sent.includes(maskFor('cpf')), 'o marcador de tipo aparece no lugar do CPF');
    const c = getOutboundCounts();
    assert.ok((c['cpf'] ?? 0) >= 1 && (c['api-key'] ?? 0) >= 1 && (c['spoken-password'] ?? 0) >= 1, `contadores: ${JSON.stringify(c)}`);
    assert.equal(JSON.stringify(c).includes(CPF), false, 'contador nunca guarda conteúdo');
  });

  it('controle positivo: com o guarda em off os mesmos marcadores SAEM (o teste enxerga a diferença)', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'off' }, true);
    t.after(() => teardown(h));
    await oneTurn(h, FALA);
    const sent = everythingSentToCloud(h);
    assert.ok(h.engine.generateCalls.length > 0);
    assert.equal(sent.includes(CPF), true);
    assert.equal(sent.includes(KEY), true);
    assert.equal(sent.includes('Cofre2026Azul'), true);
    assert.deepEqual(getOutboundCounts(), {});
  });

  it('block: nada é enviado (nenhuma geração, nenhuma intenção em nuvem) e o app fala o aviso fixo, sem eco do conteúdo', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'block' }, true);
    t.after(() => teardown(h));
    await oneTurn(h, FALA);
    assert.equal(h.engine.generateCalls.length, 0, 'nada foi enviado à geração');
    assert.equal(h.engine.detectIntentCalls.length, 0, 'nada foi enviado à intenção em nuvem');
    assert.ok(h.tts.synthesizeCalls.includes(OUTBOUND_BLOCKED_TEXT), 'o aviso fixo foi falado');
    for (const spoken of h.tts.synthesizeCalls) {
      for (const secret of [CPF, KEY, 'Cofre2026Azul']) assert.equal(spoken.includes(secret), false);
    }
  });

  it('texto sem segredo passa idêntico em redact: o guarda não altera fala comum nem memória comum', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'redact' }, false);
    t.after(() => teardown(h));
    await oneTurn(h, 'que horas são? marque dentista dia 20');
    const sent = everythingSentToCloud(h);
    assert.ok(sent.includes('marque dentista dia 20'));
    assert.deepEqual(getOutboundCounts(), {});
  });
});
