import { execFile } from 'node:child_process';
import fs from 'node:fs';

/**
 * Sinal de que a fala foi para a Ogra. Não é TTS e não tem palavras.
 *
 * O usuário ouve o assistente pelo navegador (WKWebView): o servidor grava um WAV,
 * emite `sentence_audio_ready` e o cliente busca `/api/voice/session/audio/:id`.
 * `afplay` tocaria os alto-falantes do processo Node e ficaria fora dessa fila
 * (sem ordem com a resposta, sem barge-in). O arquivo configurado — no Mac, o
 * Tink do sistema — é portanto convertido para WAV e entregue por esse caminho.
 * A reprodução em si não segura o turno: quem chama só espera o WAV ficar pronto
 * para o cliente, não o fim do toque.
 */

export const DEFAULT_OGRA_CUE_SOUND = '/System/Library/Sounds/Tink.aiff';

/** Índice negativo: o toque ordena antes de qualquer frase falada do turno (0, ou -1 no aviso de reserva). */
export const OGRA_CUE_SENTENCE_INDEX = -100;

/** Teto do arquivo lido e do WAV entregue. Um som de sistema cabe; um arquivo grande não atrasa o turno. */
export const OGRA_CUE_MAX_BYTES = 256 * 1024;

const FFMPEG_TIMEOUT_MS = 2_000;

export interface OgraCuePlayback {
  /** WAV PCM já pronto para o cliente. Não bloqueia até o usuário ouvir. */
  deliverWav: (wav: Buffer) => void;
}

export type PlayOgraCue = (playback: OgraCuePlayback) => void | Promise<void>;

type Env = Readonly<Record<string, string | undefined>>;

export interface CueFileStat {
  size: number;
  isFile: () => boolean;
}

export interface CueLoaderDeps {
  readFile?: (filePath: string) => Buffer;
  stat?: (filePath: string) => CueFileStat;
  /** Converte um arquivo que não é WAV nem AIFF PCM. Ausente: `ffmpeg` no PATH, com prazo curto. */
  ffmpeg?: (filePath: string) => Promise<Buffer>;
}

/** `''` e `off` (qualquer caixa) desligam. Ausente: o Tink do macOS. */
export function resolveOgraCueSoundPath(env: Env): string | null {
  const raw = env.RODRIGO_OGRA_CUE_SOUND;
  if (raw === undefined) return DEFAULT_OGRA_CUE_SOUND;
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'off') return null;
  return value;
}

export function isCueWav(buf: Buffer): boolean {
  return buf.length >= 44 && buf.length <= OGRA_CUE_MAX_BYTES && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
}

/**
 * Implementação padrão. Erro de leitura, formato ou ffmpeg: registra e não lança,
 * para o webhook seguir. Não espera o toque terminar no cliente.
 */
export function createDefaultPlayOgraCue(env: Env = process.env, deps: CueLoaderDeps = {}): PlayOgraCue {
  return async (playback) => {
    try {
      const soundPath = resolveOgraCueSoundPath(env);
      if (!soundPath) return;
      const wav = await loadCueWav(soundPath, deps);
      if (!wav) return;
      playback.deliverWav(wav);
    } catch (err) {
      console.warn(`[ogra] sinal sonoro não saiu: ${err instanceof Error ? err.message : 'erro'}`);
    }
  };
}

export async function loadCueWav(soundPath: string, deps: CueLoaderDeps = {}): Promise<Buffer | null> {
  let raw: Buffer;
  try {
    const stat = deps.stat ? deps.stat(soundPath) : fs.statSync(soundPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > OGRA_CUE_MAX_BYTES) {
      console.warn('[ogra] sinal sonoro ignorado: arquivo ausente, vazio ou grande demais.');
      return null;
    }
    raw = deps.readFile ? deps.readFile(soundPath) : fs.readFileSync(soundPath);
  } catch (err) {
    console.warn(`[ogra] sinal sonoro não lido: ${err instanceof Error ? err.message : 'erro'}`);
    return null;
  }
  if (raw.length > OGRA_CUE_MAX_BYTES) {
    console.warn('[ogra] sinal sonoro ignorado: arquivo ausente, vazio ou grande demais.');
    return null;
  }
  if (isCueWav(raw)) return raw;
  const pcm = aiffPcmToWav(raw);
  if (pcm && isCueWav(pcm)) return pcm;
  try {
    const converted = deps.ffmpeg ? await deps.ffmpeg(soundPath) : await ffmpegToWav(soundPath);
    if (converted && isCueWav(converted)) return converted;
  } catch (err) {
    console.warn(`[ogra] não converti o som do sinal: ${err instanceof Error ? err.message : 'erro'}`);
    return null;
  }
  console.warn('[ogra] sinal sonoro ignorado: formato que o navegador não toca.');
  return null;
}

function ffmpegToWav(soundPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-nostdin', '-v', 'error', '-i', soundPath, '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '22050', '-ac', '1', 'pipe:1'],
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: OGRA_CUE_MAX_BYTES, encoding: 'buffer' },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

/**
 * AIFF/AIFC PCM 16-bit (`NONE`, `twos`, `sowt`) para WAV little-endian.
 * IMA e outros comprimidos devolvem null: o chamador tenta o ffmpeg.
 */
export function aiffPcmToWav(buf: Buffer): Buffer | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'FORM') return null;
  const form = buf.toString('ascii', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return null;

  let channels = 0;
  let frames = 0;
  let sampleSize = 0;
  let sampleRate = 0;
  let littleEndian = false;
  let ssnd: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (size < 0 || end > buf.length) return null;
    if (id === 'COMM') {
      const parsed = parseComm(buf.subarray(start, end), form === 'AIFC');
      if (!parsed) return null;
      channels = parsed.channels;
      frames = parsed.frames;
      sampleSize = parsed.sampleSize;
      sampleRate = parsed.sampleRate;
      littleEndian = parsed.littleEndian;
    } else if (id === 'SSND') {
      ssnd = buf.subarray(start, end);
    }
    offset = end + (size % 2);
  }

  if (!ssnd || channels < 1 || channels > 2 || frames < 1 || sampleSize !== 16) return null;
  if (sampleRate < 8_000 || sampleRate > 96_000) return null;
  if (ssnd.length < 8) return null;
  const dataOffset = ssnd.readUInt32BE(0);
  const pcmStart = 8 + dataOffset;
  const need = frames * channels * 2;
  if (pcmStart < 8 || pcmStart + need > ssnd.length) return null;
  const pcm = Buffer.from(ssnd.subarray(pcmStart, pcmStart + need));
  if (!littleEndian) swap16(pcm);
  return pcm16ToWav(pcm, channels, sampleRate);
}

function parseComm(
  comm: Buffer,
  aifc: boolean
): { channels: number; frames: number; sampleSize: number; sampleRate: number; littleEndian: boolean } | null {
  if (comm.length < 18) return null;
  const channels = comm.readInt16BE(0);
  const frames = comm.readUInt32BE(2);
  const sampleSize = comm.readInt16BE(6);
  const sampleRate = readExtended80(comm, 8);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  if (!aifc) return { channels, frames, sampleSize, sampleRate, littleEndian: false };
  if (comm.length < 22) return null;
  const compression = comm.toString('ascii', 18, 22);
  if (compression === 'sowt') return { channels, frames, sampleSize, sampleRate, littleEndian: true };
  if (compression === 'NONE' || compression === 'twos') {
    return { channels, frames, sampleSize, sampleRate, littleEndian: false };
  }
  return null;
}

function readExtended80(buf: Buffer, offset: number): number {
  if (offset + 10 > buf.length) return Number.NaN;
  const expRaw = buf.readUInt16BE(offset);
  const hi = buf.readUInt32BE(offset + 2);
  const lo = buf.readUInt32BE(offset + 6);
  const biased = expRaw & 0x7fff;
  if (biased === 0 && hi === 0 && lo === 0) return 0;
  const exp = biased - 16383;
  const sign = (expRaw & 0x8000) !== 0 ? -1 : 1;
  const value = hi * 2 ** (exp - 31) + lo * 2 ** (exp - 63);
  return sign * value;
}

function swap16(pcm: Buffer): void {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const a = pcm[i];
    pcm[i] = pcm[i + 1];
    pcm[i + 1] = a;
  }
}

function pcm16ToWav(pcm: Buffer, channels: number, sampleRate: number): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}
