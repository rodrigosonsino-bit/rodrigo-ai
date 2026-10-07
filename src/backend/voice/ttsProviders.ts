import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';

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
