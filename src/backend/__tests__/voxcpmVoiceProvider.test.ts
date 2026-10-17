import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseVoxCpmEnv,
  VoxCpmVoiceProvider,
  type VoxCpmConfig
} from '../voice/voxcpmVoiceProvider.js';
import { DynamicVoiceProvider, selectVoiceProvider, type VoiceProviderDeps } from '../voice/ttsProviders.js';
import { DEFAULT_PRIVACY } from '../privacy.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';

function tinyWav(): Buffer {
  // Cabeçalho WAV mínimo + 1 frame de silêncio (44 + 2 bytes) — o provider exige >= 44.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(2, 40);
  return Buffer.concat([header, Buffer.from([0, 0])]);
}

describe('VoxCpmVoiceProvider', () => {
  it('parseVoxCpmEnv rejeita host remoto (só loopback)', () => {
    assert.throws(() => parseVoxCpmEnv({ RODRIGO_VOXCPM_URL: 'http://example.com:5077' }), /loopback/);
  });

  it('parseVoxCpmEnv aceita 127.0.0.1 e localhost', () => {
    assert.equal(parseVoxCpmEnv({ RODRIGO_VOXCPM_URL: 'http://127.0.0.1:5077' }).baseUrl, 'http://127.0.0.1:5077');
    assert.equal(parseVoxCpmEnv({ RODRIGO_VOXCPM_URL: 'http://localhost:5077' }).baseUrl, 'http://127.0.0.1:5077');
  });

  it('synthesize grava WAV do servidor fake e respeita AbortSignal', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voxcpm-'));
    const out = path.join(tmp, 'out.wav');
    const wav = tinyWav();
    const calls: string[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      if (String(input).endsWith('/')) {
        return new Response('voxcpm-server ok', { status: 200 });
      }
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.input, 'Olá, tudo bem?');
      assert.equal(body.response_format, 'wav');
      assert.ok(typeof body.control === 'string' && body.control.length > 0);
      return new Response(wav, { status: 200 });
    };

    const cfg: VoxCpmConfig = {
      baseUrl: 'http://127.0.0.1:5077',
      control: 'voz de teste',
      inferenceTimesteps: 7,
      timeoutMs: 5_000,
      fetchImpl
    };
    const p = new VoxCpmVoiceProvider(cfg);
    assert.equal(await p.probeHealth(), true);
    await p.synthesize('Olá, tudo bem?', out);
    assert.ok(fs.existsSync(out));
    assert.ok(fs.statSync(out).size >= 44);
    assert.ok(calls.some((c) => c.includes('/v1/audio/speech')));

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => p.synthesize('x', out, ac.signal));

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('cai no fallback say quando o servidor responde erro', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voxcpm-fb-'));
    const out = path.join(tmp, 'out.wav');
    let fallbackCalled = false;
    const fallback: IVoiceProvider = {
      id: 'say',
      name: 'fake-say',
      isAvailable: () => true,
      synthesize: async (_t, outputPath) => {
        fallbackCalled = true;
        fs.writeFileSync(outputPath, tinyWav());
      }
    };
    const fetchImpl: typeof fetch = async () => new Response('busy', { status: 503 });
    const p = new VoxCpmVoiceProvider(
      {
        baseUrl: 'http://127.0.0.1:5077',
        control: 'x',
        inferenceTimesteps: 7,
        timeoutMs: 2_000,
        fetchImpl
      },
      fallback
    );
    await p.synthesize('texto', out);
    assert.equal(fallbackCalled, true);
    assert.ok(fs.existsSync(out));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('selectVoiceProvider(TTS_ENGINE=voxcpm) retorna id voxcpm', () => {
    const p = selectVoiceProvider({ TTS_ENGINE: 'voxcpm', RODRIGO_VOXCPM_URL: 'http://127.0.0.1:5077' });
    assert.equal(p.id, 'voxcpm');
  });

  it('CONFIGURAR_VOZ / switchVoice ativa voxcpm e persiste preferência', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-vox-pref-'));
    const engine: VoiceProviderDeps['engine'] = {
      isReadySync: () => true,
      waitUntilReady: async () => {},
      transcribe: async () => '',
      classify: async () => 'GERAL',
      detectTool: async () => 'NENHUMA',
      detectMutation: async () => ['NENHUMA', null],
      detectIntent: async () => null,
      detectConfirmation: async () => 'NAO',
      generate: async () => {},
      cancel: () => {},
      shutdown: async () => {}
    };
    const base: IVoiceProvider = {
      id: 'say',
      name: 'say',
      isAvailable: () => true,
      synthesize: async () => {}
    };
    const dynamic = new DynamicVoiceProvider(base, {
      engine,
      privacy: DEFAULT_PRIVACY,
      rootDir: tmpRoot,
      env: { RODRIGO_VOXCPM_URL: 'http://127.0.0.1:5077' }
    });
    const res = dynamic.switchVoice('voz:VoxCPM');
    assert.equal(res.ok, true);
    assert.equal(res.engine, 'voxcpm');
    assert.equal(dynamic.id, 'voxcpm');
    const pref = JSON.parse(fs.readFileSync(path.join(tmpRoot, '.runtime', 'voice-preference.json'), 'utf8'));
    assert.equal(pref.engine, 'voxcpm');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
