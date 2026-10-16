import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DynamicVoiceProvider, SayVoiceProvider, type VoiceProviderDeps } from '../ttsProviders.js';
import { ConfigurarVozTool } from '../../tools/desktopControlTool.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../../privacy.js';
import type { IVoiceProvider, SynthesizeOptions } from '../../../shared/extensions/index.js';

function makeDummyEngine(): VoiceProviderDeps['engine'] {
  return {
    isReadySync: () => true,
    waitUntilReady: async () => {},
    transcribe: async () => '',
    classify: async () => 'GERAL',
    detectTool: async () => 'NENHUMA',
    detectMutation: async () => ['NENHUMA', null],
    detectIntent: async () => null,
    detectConfirmation: async () => 'NAO',
    generate: async () => {},
    synthesize: async (req) => {
      fs.writeFileSync(req.outPath, Buffer.from('RIFF-dummy'));
      return { ok: true, seconds: 0.5, tokensIn: 10, tokensOut: 20 };
    },
    cancel: () => {},
    shutdown: async () => {}
  };
}

describe('Pilar 3 — DynamicVoiceProvider & ConfigurarVozTool', () => {
  it('bloqueia troca para voz do Gemini quando a política de privacidade desliga TTS em nuvem', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-switch-'));
    try {
      const privacyOff: PrivacyConfig = {
        ...DEFAULT_PRIVACY,
        cloud: false
      };
      const base = new SayVoiceProvider();
      const dynamic = new DynamicVoiceProvider(base, {
        engine: makeDummyEngine(),
        privacy: privacyOff,
        rootDir: tmpRoot,
        env: { GEMINI_API_KEY: 'AIzaSyDummyKeyForTest123456' }
      });
      const tool = new ConfigurarVozTool(dynamic);

      const res = tool.execute('CONFIGURAR_VOZ', 'voz:Charon');
      assert.match(res, /Não posso ativar a voz em nuvem Charon/);
      assert.match(res, /privacidade/);
      assert.equal(dynamic.id, 'say');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('troca entre vozes do Gemini e persiste atomicamente em .runtime/voice-preference.json', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-switch-'));
    try {
      const base = new SayVoiceProvider();
      const dynamic = new DynamicVoiceProvider(base, {
        engine: makeDummyEngine(),
        privacy: DEFAULT_PRIVACY,
        rootDir: tmpRoot,
        env: { GEMINI_API_KEY: 'AIzaSyDummyKeyForTest123456' }
      });
      const tool = new ConfigurarVozTool(dynamic);

      const res = tool.execute('CONFIGURAR_VOZ', 'voz:Aoede');
      assert.match(res, /Aoede do Gemini/);
      assert.equal(dynamic.id, 'gemini');
      assert.match(dynamic.name, /Aoede/);

      const prefFile = path.join(tmpRoot, '.runtime', 'voice-preference.json');
      assert.equal(fs.existsSync(prefFile), true);
      const saved = JSON.parse(fs.readFileSync(prefFile, 'utf-8'));
      assert.equal(saved.engine, 'gemini');
      assert.equal(saved.voice, 'Aoede');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('isola síntese em voo: trocar de provedor durante synthesize() não corrompe a chamada em andamento', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-inflight-'));
    try {
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const slowProvider: IVoiceProvider = {
        id: 'slow-initial',
        name: 'Slow Initial',
        isAvailable: () => true,
        synthesize: async (_text: string, _out: string, _sig?: AbortSignal, _opt?: SynthesizeOptions) => {
          events.push('slow:start');
          await firstStarted;
          events.push('slow:end');
        }
      };

      const dynamic = new DynamicVoiceProvider(slowProvider, {
        engine: makeDummyEngine(),
        privacy: DEFAULT_PRIVACY,
        rootDir: tmpRoot,
        env: { GEMINI_API_KEY: 'AIzaSyDummyKeyForTest123456' }
      });

      // Inicia síntese no provedor inicial e troca para Puck antes de terminar
      const inFlight = dynamic.synthesize('Frase 1', path.join(tmpRoot, 'out1.wav'));
      const switched = dynamic.switchVoice('Puck');
      assert.equal(switched.ok, true);
      assert.equal(dynamic.id, 'gemini');

      releaseFirst();
      await inFlight;
      assert.deepEqual(events, ['slow:start', 'slow:end']);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
