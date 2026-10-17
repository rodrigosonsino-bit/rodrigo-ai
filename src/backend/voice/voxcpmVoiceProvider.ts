import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';

/**
 * TTS local via servidor MLX VoxCPM2 (`leoli-dev/tts-server-voxcpm`) em loopback.
 * Sem canal de nuvem: só HTTP para `RODRIGO_VOXCPM_URL` (padrão http://127.0.0.1:5077).
 * Em falha/indisponibilidade, o chamador (DynamicVoiceProvider / createVoiceProvider)
 * deve cair no `say` — este provedor lança erro em synthesize() se o servidor falhar.
 */

const DEFAULT_URL = 'http://127.0.0.1:5077';
const DEFAULT_CONTROL =
  'Homem brasileiro adulto, voz calma, clara e natural, tom conversacional';

export interface VoxCpmConfig {
  baseUrl: string;
  /** Prompt de voice-design enviado no campo `control` (instr do VoxCPM2). */
  control: string;
  inferenceTimesteps: number;
  /** Timeout HTTP por síntese (ms). */
  timeoutMs: number;
  /** Fetch injetável para testes. */
  fetchImpl?: typeof fetch;
}

export function parseVoxCpmEnv(env: NodeJS.ProcessEnv = process.env): VoxCpmConfig {
  const rawUrl = (env.RODRIGO_VOXCPM_URL || DEFAULT_URL).trim();
  let baseUrl: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('protocolo inválido');
    }
    // Só loopback: defesa — não enviar texto de fala a hosts remotos por engano.
    const host = u.hostname.toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      throw new Error(
        `RODRIGO_VOXCPM_URL deve apontar para loopback (127.0.0.1/localhost). Recebido: ${host}`
      );
    }
    // Preferir IP literal: `localhost` em /etc/hosts pode apontar para fora do loopback.
    const safeHost = host === 'localhost' || host === '::1' ? '127.0.0.1' : host;
    const port = u.port ? `:${u.port}` : '';
    baseUrl = `${u.protocol}//${safeHost}${port}`;
  } catch (err) {
    throw new Error(
      `Configuração inválida: RODRIGO_VOXCPM_URL. ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const control = (env.RODRIGO_VOXCPM_CONTROL || DEFAULT_CONTROL).trim() || DEFAULT_CONTROL;
  if (control.length > 500) {
    throw new Error('Configuração inválida: RODRIGO_VOXCPM_CONTROL (máx. 500 caracteres).');
  }

  let inferenceTimesteps = 7;
  const rawSteps = env.RODRIGO_VOXCPM_STEPS;
  if (rawSteps !== undefined && rawSteps.trim() !== '') {
    if (!/^[1-9][0-9]?$/.test(rawSteps.trim()) || parseInt(rawSteps, 10) > 50) {
      throw new Error('Configuração inválida: RODRIGO_VOXCPM_STEPS deve ser 1–50.');
    }
    inferenceTimesteps = parseInt(rawSteps.trim(), 10);
  }

  // Default 8s: alinhado ao orçamento de voz do app; acima disso cai no `say` (H2 pede ≤4s — medido 4–6s no M5 16GB).
  let timeoutMs = 8_000;
  const rawTimeout = env.RODRIGO_VOXCPM_TIMEOUT_MS;
  if (rawTimeout !== undefined && rawTimeout.trim() !== '') {
    if (!/^[1-9][0-9]{2,5}$/.test(rawTimeout.trim()) || parseInt(rawTimeout, 10) > 120_000) {
      throw new Error('Configuração inválida: RODRIGO_VOXCPM_TIMEOUT_MS deve ser 100–120000.');
    }
    timeoutMs = parseInt(rawTimeout.trim(), 10);
  }

  return { baseUrl, control, inferenceTimesteps, timeoutMs };
}

function nodeHttpGet(urlStr: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function nodeHttpPostJson(
  urlStr: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ status: number; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, buf: Buffer.concat(chunks) });
        });
      }
    );
    const onAbort = (): void => {
      req.destroy();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(data);
    req.end();
  });
}

export class VoxCpmVoiceProvider implements IVoiceProvider {
  readonly id = 'voxcpm';
  readonly name: string;
  /** Frases curtas/confirmações não devem coalescer (markPlayed compara texto exato). */
  readonly prefersCoalescing = false;
  /** T9-política (a): aviso quando a reserva `say` assume. */
  onFallback?: (info: { turnId?: string; reason: string }) => void;

  private readonly config: VoxCpmConfig;
  private readonly fallback: IVoiceProvider | null;
  private healthyCache: { ok: boolean; at: number } | null = null;
  private readonly healthTtlMs = 5_000;

  constructor(config: VoxCpmConfig, fallback: IVoiceProvider | null = null) {
    this.config = config;
    this.fallback = fallback;
    this.name = `VoxCPM2 local (${config.baseUrl})`;
  }

  isAvailable(): boolean {
    // Saúde real é assíncrona; disponibilidade estática = URL parseada + fallback opcional.
    // createVoiceProvider / switchVoice usam probeHealth() antes de ativar.
    return true;
  }

  async probeHealth(): Promise<boolean> {
    const now = Date.now();
    if (this.healthyCache && now - this.healthyCache.at < this.healthTtlMs) {
      return this.healthyCache.ok;
    }
    try {
      if (this.config.fetchImpl) {
        const res = await this.config.fetchImpl(`${this.config.baseUrl}/`, {
          signal: AbortSignal.timeout(2_000)
        });
        const text = await res.text();
        const ok = res.ok && /voxcpm|ok/i.test(text);
        this.healthyCache = { ok, at: now };
        return ok;
      }
      const { status, body } = await nodeHttpGet(`${this.config.baseUrl}/`, 2_000);
      const ok = status >= 200 && status < 300 && /voxcpm|ok/i.test(body);
      this.healthyCache = { ok, at: now };
      return ok;
    } catch {
      this.healthyCache = { ok: false, at: now };
      return false;
    }
  }

  async synthesize(text: string, outputPath: string, signal?: AbortSignal, _options?: SynthesizeOptions): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('VoxCPM: texto vazio');

    try {
      await this.synthesizeRemote(trimmed, outputPath, signal);
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      if (this.fallback) {
        const reason = err instanceof Error ? err.message : String(err);
        this.onFallback?.({ turnId: _options?.turnId, reason: `voxcpm:${reason.slice(0, 80)}` });
        await this.fallback.synthesize(text, outputPath, signal, _options);
        return;
      }
      throw err;
    }
  }

  private async synthesizeRemote(text: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    const url = `${this.config.baseUrl}/v1/audio/speech`;
    const body = {
      input: text,
      response_format: 'wav',
      control: this.config.control,
      inference_timesteps: this.config.inferenceTimesteps
    };

    let status: number;
    let buf: Buffer;

    if (this.config.fetchImpl) {
      const res = await this.config.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(this.config.timeoutMs)
      });
      status = res.status;
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      const r = await nodeHttpPostJson(url, body, this.config.timeoutMs, signal);
      status = r.status;
      buf = r.buf;
    }

    if (status < 200 || status >= 300) {
      throw new Error(`VoxCPM HTTP ${status}: ${buf.toString('utf8').slice(0, 200)}`);
    }
    if (buf.length < 44) {
      throw new Error('VoxCPM: resposta de áudio vazia ou inválida');
    }

    const tmp = `${outputPath}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, outputPath);
  }
}
