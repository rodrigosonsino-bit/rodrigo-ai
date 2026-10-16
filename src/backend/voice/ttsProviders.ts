import { execFile, execFileSync } from 'node:child_process';
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
  installedSayVoices?: readonly string[];
}

import type { SynthesizeOptions } from '../../shared/extensions/voice.js';
import { ttsOffReason } from '../privacy.js';

export interface VoicePreferenceRecord {
  engine: 'gemini' | 'say' | 'kokoro';
  voice: string;
  updatedAt: string;
}

const GEMINI_VOICES: Readonly<Record<string, string>> = {
  charon: 'Charon',
  puck: 'Puck',
  aoede: 'Aoede',
  fenrir: 'Fenrir',
  kore: 'Kore',
  zephyr: 'Zephyr',
  orbit: 'Orbit',
  gemini: 'Charon',
  google: 'Charon',
  nuvem: 'Charon'
};

const SAY_VOICES: Readonly<Record<string, string>> = {
  felipe: 'Felipe (Enhanced)',
  'felipe (enhanced)': 'Felipe (Enhanced)',
  luciana: 'Luciana (Enhanced)',
  'luciana (enhanced)': 'Luciana (Enhanced)',
  sistema: DEFAULT_SAY_VOICE,
  local: DEFAULT_SAY_VOICE,
  mac: DEFAULT_SAY_VOICE
};

function normalizeVoiceLookupKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSayVoiceNames(output: string): string[] {
  const voices: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\s+\S+\s+#/);
    const voice = match?.[1]?.trim();
    if (!voice || seen.has(voice)) continue;
    seen.add(voice);
    voices.push(voice);
  }
  return voices;
}

let cachedSayVoices: readonly string[] | null = null;

function getInstalledSayVoices(): readonly string[] {
  if (cachedSayVoices) return cachedSayVoices;
  if (process.platform !== 'darwin') return [];
  try {
    const output = execFileSync('/usr/bin/say', ['-v', '?'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    cachedSayVoices = parseSayVoiceNames(output);
  } catch {
    cachedSayVoices = [];
  }
  return cachedSayVoices;
}

export function resolveSayVoiceName(
  rawRequest: string,
  installedVoices: readonly string[] = getInstalledSayVoices()
): string | null {
  const normalized = normalizeVoiceLookupKey(rawRequest);
  if (!normalized) return null;

  const alias = SAY_VOICES[normalized];
  if (alias) return alias;
  if (normalized.includes('luciana')) return 'Luciana (Enhanced)';
  if (normalized.includes('felipe')) return 'Felipe (Enhanced)';

  const candidates = Array.from(
    new Map(installedVoices.map((voice) => [normalizeVoiceLookupKey(voice), voice])).entries(),
    ([key, name]) => ({ key, name })
  ).filter((candidate) => candidate.key.length > 0);

  const exact = candidates.find((candidate) => candidate.key === normalized);
  if (exact) return exact.name;

  const fuzzy = candidates.filter((candidate) => candidate.key.includes(normalized) || normalized.includes(candidate.key));
  return fuzzy.length === 1 ? fuzzy[0].name : null;
}

function formatSystemVoiceName(voice: string): string {
  return voice.replace(/\s+\((enhanced|aprimorada)\)$/i, '');
}

/**
 * Pilar 3 — Provedor dinâmico que permite troca autônoma de voz em runtime sem quebrar
 * sínteses em voo nem violar `ttsCloudEffective(privacy)`.
 */
export class DynamicVoiceProvider implements IVoiceProvider {
  private currentProvider: IVoiceProvider;
  private fallbackHandler?: (info: { turnId?: string; reason: string }) => void;
  private readonly deps: VoiceProviderDeps;
  private readonly preferencePath: string;
  private sharedBudget: TtsBudget | null = null;

  constructor(initialProvider: IVoiceProvider, deps: VoiceProviderDeps) {
    this.currentProvider = initialProvider;
    this.deps = deps;
    this.preferencePath = path.join(deps.rootDir, '.runtime', 'voice-preference.json');
    this.bindFallback(initialProvider);
  }

  private bindFallback(provider: IVoiceProvider): void {
    provider.onFallback = (info): void => {
      this.fallbackHandler?.(info);
    };
  }

  get id(): string {
    return this.currentProvider.id;
  }

  get name(): string {
    return this.currentProvider.name;
  }

  get prefersCoalescing(): boolean | undefined {
    return this.currentProvider.prefersCoalescing;
  }

  get onFallback(): ((info: { turnId?: string; reason: string }) => void) | undefined {
    return this.fallbackHandler;
  }

  set onFallback(fn: ((info: { turnId?: string; reason: string }) => void) | undefined) {
    this.fallbackHandler = fn;
    this.bindFallback(this.currentProvider);
  }

  isAvailable(): boolean {
    return this.currentProvider.isAvailable();
  }

  getActiveProvider(): IVoiceProvider {
    return this.currentProvider;
  }

  /**
   * Captura `const provider = this.currentProvider` no início da chamada: se `switchVoice()`
   * ocorrer durante uma síntese em andamento, a síntese em voo termina íntegra no provedor
   * original e a próxima frase já usa o novo provedor.
   */
  async synthesize(text: string, outputPath: string, signal?: AbortSignal, options?: SynthesizeOptions): Promise<void> {
    const provider = this.currentProvider;
    return provider.synthesize(text, outputPath, signal, options);
  }

  endTurn(turnId: string): void {
    this.currentProvider.endTurn?.(turnId);
  }

  switchVoice(rawRequest: string): { ok: boolean; speech: string; engine?: string; voice?: string } {
    const normalized = rawRequest
      .trim()
      .toLowerCase()
      .replace(/^voz\s*[:|]?\s*/i, '')
      .trim();

    if (!normalized) {
      return {
        ok: false,
        speech: 'Não entendi qual voz você quer usar. Você pode escolher Kokoro, uma voz do Gemini como Charon, Puck e Aoede, ou qualquer voz local instalada do macOS.'
      };
    }

    // 1. Kokoro local
    if (normalized === 'kokoro' || normalized === 'dora' || normalized === 'pf_dora') {
      const kokoro = new KokoroVoiceProvider();
      if (!kokoro.isAvailable()) {
        return {
          ok: false,
          speech: 'A voz local Kokoro não está disponível neste computador no momento.'
        };
      }
      this.setProvider(kokoro, { engine: 'kokoro', voice: 'pf_dora' });
      return { ok: true, speech: 'Pronto, mudei para a voz local Kokoro.', engine: 'kokoro', voice: 'pf_dora' };
    }

    // 2. macOS say local (qualquer voz instalada no sistema)
    const sayMatch = resolveSayVoiceName(normalized, this.deps.installedSayVoices);
    if (sayMatch) {
      const sayProvider = new SayVoiceProvider('ffmpeg', sayMatch);
      if (!sayProvider.isAvailable()) {
        return {
          ok: false,
          speech: `A voz do sistema ${sayMatch} não está disponível neste computador.`
        };
      }
      this.setProvider(sayProvider, { engine: 'say', voice: sayMatch });
      const friendlyName = formatSystemVoiceName(sayMatch);
      return { ok: true, speech: `Pronto, mudei minha voz para ${friendlyName} do sistema.`, engine: 'say', voice: sayMatch };
    }

    // 3. Vozes em nuvem do Gemini
    const geminiMatch =
      GEMINI_VOICES[normalized] ??
      Object.entries(GEMINI_VOICES).find(([k]) => normalized.includes(k))?.[1] ??
      null;

    if (geminiMatch) {
      if (!ttsCloudEffective(this.deps.privacy)) {
        const reason = ttsOffReason(this.deps.privacy);
        const explanation =
          reason === 'master-off'
            ? 'o modo de nuvem está desligado nas configurações de privacidade'
            : reason === 'history-off'
              ? 'o envio de histórico está desligado por privacidade'
              : 'o canal de voz em nuvem está desligado nas configurações de privacidade';
        return {
          ok: false,
          speech: `Não posso ativar a voz em nuvem ${geminiMatch} porque ${explanation}.`
        };
      }

      const env = this.deps.env ?? process.env;
      const key = env.GEMINI_API_KEY;
      if (typeof key !== 'string' || key.trim().length === 0 || typeof this.deps.engine.synthesize !== 'function') {
        return {
          ok: false,
          speech: `Não consegui ativar a voz ${geminiMatch} porque a chave do Gemini ou o motor de síntese em nuvem não está disponível.`
        };
      }

      const cfg = parseTtsEnv(env);
      const log = this.deps.log ?? ((m: string) => console.warn(m));
      if (!this.sharedBudget) {
        this.sharedBudget = new TtsBudget({
          filePath: path.join(this.deps.rootDir, '.runtime', 'tts-budget.json'),
          rpm: cfg.rpm,
          rpd: cfg.rpd,
          log
        });
      }
      const localFallback = new SayVoiceProvider();
      const geminiProvider = new GeminiVoiceProvider(
        this.deps.engine,
        localFallback,
        this.sharedBudget,
        this.deps.privacy,
        DEFAULT_GEMINI_VOICE_CONFIG(cfg.model, geminiMatch),
        () => Date.now(),
        log
      );
      this.setProvider(geminiProvider, { engine: 'gemini', voice: geminiMatch });
      return { ok: true, speech: `Pronto, mudei para a voz ${geminiMatch} do Gemini.`, engine: 'gemini', voice: geminiMatch };
    }

    return {
      ok: false,
      speech: `Não reconheci a voz ${rawRequest}. Você pode pedir Kokoro, Charon, Puck, Aoede, Fenrir, Kore ou Zephyr, ou dizer o nome de qualquer voz local instalada no macOS.`
    };
  }

  private setProvider(next: IVoiceProvider, pref: { engine: 'gemini' | 'say' | 'kokoro'; voice: string }): void {
    this.bindFallback(next);
    this.currentProvider = next;
    this.savePreference(pref);
  }

  private savePreference(pref: { engine: 'gemini' | 'say' | 'kokoro'; voice: string }): void {
    try {
      const dir = path.dirname(this.preferencePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.preferencePath}.${process.pid}.${Date.now()}.tmp`;
      const record: VoicePreferenceRecord = {
        engine: pref.engine,
        voice: pref.voice,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.preferencePath);
    } catch (err) {
      const log = this.deps.log ?? ((m: string) => console.warn(m));
      log(`[voice] falha ao persistir preferência de voz: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

/**
 * Cria um `DynamicVoiceProvider` envelopando o provedor base e restaurando preferência salva em
 * `.runtime/voice-preference.json` (somente se compatível com a política de privacidade atual).
 */
export function createDynamicVoiceProvider(deps: VoiceProviderDeps): DynamicVoiceProvider {
  const base = createVoiceProvider(deps);
  const dynamic = new DynamicVoiceProvider(base, deps);
  const prefPath = path.join(deps.rootDir, '.runtime', 'voice-preference.json');
  if (fs.existsSync(prefPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(prefPath, 'utf-8')) as Partial<VoicePreferenceRecord>;
      if (raw && typeof raw.voice === 'string' && raw.voice.trim()) {
        dynamic.switchVoice(raw.voice);
      }
    } catch {
      // preferência corrompida — ignora e mantém o padrão
    }
  }
  return dynamic;
}
