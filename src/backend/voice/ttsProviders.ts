import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import { type PrivacyConfig, TTS_DEFAULT_MODEL, TTS_DEFAULT_VOICE, ttsCloudEffective } from '../privacy.js';
import type { VoiceEngine } from './engine.js';
import { DEFAULT_GEMINI_VOICE_CONFIG, GeminiVoiceProvider } from './geminiVoiceProvider.js';
import { TtsBudget } from './ttsBudget.js';

const execFileAsync = promisify(execFile);

const DEFAULT_SAY_VOICE = 'Felipe (Enhanced)';

/**
 * Provedor padrão: `/usr/bin/say` + `ffmpeg`. Foco em latência mínima (~0,5s medido em
 * auditoria e confirmado com a voz "Enhanced" — a qualidade "Enhanced/Aprimorada" do
 * macOS não tem custo de latência sobre a compacta, então não há razão pra usar a
 * compacta). Voz configurável via `SAY_VOICE` (padrão "Felipe (Enhanced)", escolhida
 * pelo usuário em 2026-09-14 após comparar com a compacta e com Kokoro). Todo texto
 * dinâmico (gerado pelo LLM) é passado após o delimitador de fim-de-opções `--`, nunca
 * concatenado em string de shell — Achado 3 da auditoria v1: sem isso, texto começando
 * com "-" trava o `say` esperando stdin.
 */
export class SayVoiceProvider implements IVoiceProvider {
  readonly id = 'say';
  readonly name: string;

  private readonly sayBin = '/usr/bin/say';
  private readonly ffmpegBin: string;
  private readonly voice: string;

  constructor(ffmpegBin = 'ffmpeg', voice = process.env.SAY_VOICE || DEFAULT_SAY_VOICE) {
    this.ffmpegBin = ffmpegBin;
    this.voice = voice;
    this.name = `macOS say (${voice})`;
  }

  isAvailable(): boolean {
    return process.platform === 'darwin' && fs.existsSync(this.sayBin);
  }

  async synthesize(text: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    // Fase 12: o .aiff intermediário vai para o MESMO diretório da sessão (já recebemos outputPath), não para
    // os.tmpdir(): assim cleanupSession()/dispose()/a varredura de inicialização o alcançam e uma queda no
    // meio da síntese não deixa resíduo fora de .runtime/tmp.
    const tmpAiff = `${outputPath}.aiff`;

    try {
      await execFileAsync(
        this.sayBin,
        ['-v', this.voice, '-o', tmpAiff, '--', text],
        { timeout: 15_000, signal }
      );

      // Achado v2-7: -y (sobrescreve sem perguntar) e -nostdin (nunca espera confirmação
      // interativa) — sem isso, o ffmpeg trava esperando "Overwrite? [y/N]" no stdin.
      await execFileAsync(
        this.ffmpegBin,
        ['-y', '-nostdin', '-i', tmpAiff, outputPath],
        { timeout: 15_000, signal }
      );
    } finally {
      fs.promises.unlink(tmpAiff).catch(() => {
        // arquivo temporário intermediário — falha ao limpar não é fatal
      });
    }
  }
}

/**
 * Provedor opcional (TTS_ENGINE=kokoro): reaproveita os pesos do Kokoro-82M já
 * baixados em ~/.venvs/tts-say, mas via um script dedicado que só grava o WAV
 * (nunca toca áudio nem apaga o arquivo) — Achado v2-4: o servidor MCP existente
 * usa `afplay` e não pode ser reaproveitado diretamente para isso.
 */
export class KokoroVoiceProvider implements IVoiceProvider {
  readonly id = 'kokoro';
  readonly name = 'Kokoro-82M (pf_dora)';

  private readonly pythonBin: string;
  private readonly scriptPath: string;

  constructor(
    pythonBin = path.join(os.homedir(), '.venvs', 'tts-say', 'bin', 'python3'),
    scriptPath = path.resolve(process.cwd(), 'scripts', 'worker', 'kokoro_synth.py')
  ) {
    this.pythonBin = pythonBin;
    this.scriptPath = scriptPath;
  }

  isAvailable(): boolean {
    return fs.existsSync(this.pythonBin) && fs.existsSync(this.scriptPath);
  }

  async synthesize(text: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        this.pythonBin,
        [this.scriptPath, outputPath],
        { timeout: 30_000, signal },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
      child.stdin?.write(text);
      child.stdin?.end();
    });
  }
}

export function selectVoiceProvider(env: NodeJS.ProcessEnv = process.env): IVoiceProvider {
  const engine = (env.TTS_ENGINE || 'say').toLowerCase();
  if (engine === 'kokoro') {
    const kokoro = new KokoroVoiceProvider();
    if (kokoro.isAvailable()) return kokoro;
    console.error('[voice] TTS_ENGINE=kokoro solicitado, mas indisponível — usando "say" como padrão.');
  }
  return new SayVoiceProvider();
}


export interface TtsEnvConfig {
  model: string;
  voice: string;
  rpm: number;
  rpd: number;
}

function parseBoundedInt(env: NodeJS.ProcessEnv, name: string, def: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,3}$/.test(v) || parseInt(v, 10) > max) {
    throw new Error(`Configuração inválida: ${name} deve ser um inteiro entre 1 e ${max}. Valor recebido: "${raw}"`);
  }
  return parseInt(v, 10);
}

function parseName(env: NodeJS.ProcessEnv, name: string, def: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const v = raw.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) {
    throw new Error(`Configuração inválida: ${name} aceita só letras, números, ponto, hífen e sublinhado (até 64). Valor recebido: "${raw}"`);
  }
  return v;
}

/** Fase 13a: modelo, voz e limites do TTS em nuvem; valor inválido LANÇA no startup (como a privacidade da Fase 12). */
export function parseTtsEnv(env: NodeJS.ProcessEnv): TtsEnvConfig {
  return {
    model: parseName(env, 'RODRIGO_TTS_MODEL', TTS_DEFAULT_MODEL),
    voice: parseName(env, 'RODRIGO_TTS_VOICE', TTS_DEFAULT_VOICE),
    // Margem sobre a cota do Google no Nível 1 (10/min e 100/dia por modelo): 8 e 90.
    rpm: parseBoundedInt(env, 'RODRIGO_TTS_RPM', 8, 1000),
    rpd: parseBoundedInt(env, 'RODRIGO_TTS_RPD', 90, 9000)
  };
}

export interface VoiceProviderDeps {
  engine: VoiceEngine;
  privacy: PrivacyConfig;
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

/**
 * Fase 13a: escolhe a voz do app. TTS_ENGINE: `gemini` (padrão quando ausente) usa o TTS do Gemini com a voz do sistema de
 * reserva; `say`/`kokoro` forçam uma voz local. O Gemini só é escolhido se o canal estiver EFETIVAMENTE ligado (mestre +
 * RODRIGO_CLOUD_TTS + histórico enviado), houver chave e o motor suportar síntese; senão cai na voz local com um aviso.
 */
export function createVoiceProvider(deps: VoiceProviderDeps): IVoiceProvider {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const requested = (env.TTS_ENGINE || 'gemini').toLowerCase();
  if (requested !== 'gemini') return selectVoiceProvider(env);

  const local = new SayVoiceProvider();
  const key = env.GEMINI_API_KEY;
  if (!ttsCloudEffective(deps.privacy)) {
    log('[voice] Voz do Gemini desligada pela configuração de privacidade — usando a voz do sistema.');
    return local;
  }
  if (typeof key !== 'string' || key.trim().length === 0) {
    log('[voice] GEMINI_API_KEY ausente — usando a voz do sistema.');
    return local;
  }
  if (typeof deps.engine.synthesize !== 'function') {
    log('[voice] O motor de voz não suporta TTS em nuvem — usando a voz do sistema.');
    return local;
  }
  const cfg = parseTtsEnv(env);
  const budget = new TtsBudget({
    filePath: path.join(deps.rootDir, '.runtime', 'tts-budget.json'),
    rpm: cfg.rpm,
    rpd: cfg.rpd,
    log
  });
  return new GeminiVoiceProvider(deps.engine, local, budget, deps.privacy, DEFAULT_GEMINI_VOICE_CONFIG(cfg.model, cfg.voice), () => Date.now(), log);
}
