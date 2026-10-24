import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DynamicVoiceProvider, SayVoiceProvider, type VoiceProviderDeps, parseSayVoiceNames, resolveSayVoiceName } from '../ttsProviders.js';
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
  it('aceita qualquer voz local instalada do macOS por nome, inclusive nomes fora da lista fixa antiga', () => {
    const installed = ['Fernanda (Enhanced)', 'Personal Voice'];
    assert.equal(resolveSayVoiceName('Fernanda', installed), 'Fernanda (Enhanced)');
    assert.equal(resolveSayVoiceName('Personal', installed), 'Personal Voice');
  });

  it('faz parse da listagem do say preservando nomes completos das vozes do sistema', () => {
    const listed = parseSayVoiceNames(
      [
        'Felipe (Enhanced)   pt_BR    # Olá, meu nome é Felipe.',
        'Fernanda (Enhanced) pt_BR    # Olá, meu nome é Fernanda.',
        'Personal Voice      en_US    # Hello! My name is Personal Voice.'
      ].join('\n')
    );
    assert.deepEqual(listed, ['Felipe (Enhanced)', 'Fernanda (Enhanced)', 'Personal Voice']);
  });

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

  it('troca para uma voz local instalada fora da lista antiga e persiste a escolha', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-voice-switch-'));
    try {
      const base = new SayVoiceProvider();
      const dynamic = new DynamicVoiceProvider(base, {
        engine: makeDummyEngine(),
        privacy: DEFAULT_PRIVACY,
        rootDir: tmpRoot,
        installedSayVoices: ['Fernanda (Enhanced)', 'Personal Voice']
      });
      const tool = new ConfigurarVozTool(dynamic);

      const res = tool.execute('CONFIGURAR_VOZ', 'voz:Personal');
      assert.match(res, /Personal Voice do sistema/);
      assert.equal(dynamic.id, 'say');
      assert.match(dynamic.name, /Personal Voice/);

      const prefFile = path.join(tmpRoot, '.runtime', 'voice-preference.json');
      const saved = JSON.parse(fs.readFileSync(prefFile, 'utf-8'));
      assert.equal(saved.engine, 'say');
      assert.equal(saved.voice, 'Personal Voice');
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
