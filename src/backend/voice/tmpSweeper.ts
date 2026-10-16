import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Fase 12 (docs/phase-12-v2.md §2.4): limpeza de resíduos de áudio sem `rm -rf` cego da base.
 * Cada processo usa `.runtime/tmp/<pid>-<startEpochMs>/`; na inicialização, os subdiretórios de
 * processos que não existem mais (ou cujo pid foi reciclado) são removidos, e os de instâncias
 * vivas ficam intactos.
 */

/** Tolerância entre o `startEpochMs` do nome e o início real lido de `ps` (que tem resolução de 1 s). */
export const START_TOLERANCE_MS = 2000;
/** Diretórios fora do padrão `<pid>-<epoch>` (versões antigas: UUID solto) só saem se estiverem parados há mais que isso. */
export const LEGACY_MAX_AGE_MS = 60 * 60 * 1000;

/** Início real deste processo, independente de quando a pasta é criada. */
export function ownStartEpochMs(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

export function processDirName(pid: number, startEpochMs: number): string {
  return `${pid}-${startEpochMs}`;
}

export function parseProcessDirName(name: string): { pid: number; startEpochMs: number } | null {
  const m = /^([1-9][0-9]{0,9})-([1-9][0-9]{9,14})$/.exec(name);
  return m ? { pid: Number(m[1]), startEpochMs: Number(m[2]) } : null;
}

/**
 * Converte a saída de `ps -o lstart=` no locale C ("Wed Oct  7 10:00:35 2026", hora local) para epoch ms.
 * Qualquer coisa que não vire número (locale em português, vazio, lixo) devolve null — nunca NaN.
 */
export function parseLstart(output: string): number | null {
  const text = output.trim().replace(/\s+/g, ' ');
  if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(text)) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Início real do processo via `ps`, SEMPRE com LC_ALL=C LANG=C: em pt_BR a saída é "qua  7 out …",
 * que o Node lê como NaN (reproduzido em 2026-10-07). Falha/parse inválido => null (fail-safe do chamador).
 */
export function readProcessStartMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseLstart(out);
  } catch {
    return null;
  }
}

export type PidState = 'dead' | 'alive' | 'eperm';

export function checkPid(pid: number, kill: (pid: number, signal: 0) => unknown = (p, s) => process.kill(p, s)): PidState {
  try {
    kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'eperm'; // existe, sob outro usuário
    return 'alive'; // erro desconhecido: nunca assumir morto
  }
}

export interface SweepOptions {
  /** Nome do subdiretório DESTE processo — nunca é tocado. */
  selfDirName: string;
  pidCheck?: (pid: number) => PidState;
  startTime?: (pid: number) => number | null;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SweepResult {
  removed: string[];
  kept: string[];
}

/**
 * Regras (§2.4 do plano, v2.2):
 *  1. pid morto (ESRCH) => remove.
 *  2. pid existe (ou EPERM) => compara o início real (`ps`, LC_ALL=C) com o do nome (tolerância 2 s):
 *     divergência => pid reciclado => remove; coerente => instância viva => não toca.
 *  3. consulta falhou/parse inválido => NUNCA remove (fail-safe), registra aviso.
 *  4. nome fora do padrão (legado) => só remove se parado há mais de LEGACY_MAX_AGE_MS.
 *  5. só diretórios reais: arquivos e links simbólicos são ignorados.
 */
export function sweepStaleTmpDirs(baseDir: string, opts: SweepOptions): SweepResult {
  const pidCheck = opts.pidCheck ?? checkPid;
  const startTime = opts.startTime ?? readProcessStartMs;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const result: SweepResult = { removed: [], kept: [] };

  let names: string[];
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return result; // base ainda não existe: nada a varrer
  }

  for (const name of names) {
    if (name === opts.selfDirName) continue;
    const full = path.join(baseDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue; // inclui links simbólicos (lstat)

    const parsed = parseProcessDirName(name);
    let remove = false;
    if (!parsed) {
      remove = now() - st.mtimeMs > LEGACY_MAX_AGE_MS;
      if (!remove) log(`[tmp] "${name}" fora do padrão e recente — mantido.`);
    } else {
      const state = pidCheck(parsed.pid);
      if (state === 'dead') {
        remove = true;
      } else {
        const realStart = startTime(parsed.pid);
        if (realStart === null) {
          log(`[tmp] não consegui ler o início do pid ${parsed.pid} — "${name}" mantido (fail-safe).`);
        } else if (Math.abs(realStart - parsed.startEpochMs) > START_TOLERANCE_MS) {
          remove = true; // pid reciclado por outro processo
        }
      }
    }

    if (remove) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        result.removed.push(name);
      } catch (err) {
        log(`[tmp] falha ao remover "${name}": ${err instanceof Error ? err.message : String(err)}`);
        result.kept.push(name);
      }
    } else {
      result.kept.push(name);
    }
  }
  return result;
}

/**
 * Inicialização do diretório temporário DESTE processo: varre os resíduos de processos mortos/reciclados e
 * devolve o caminho do subdiretório próprio (que o AudioStore cria sob demanda). É a única entrada usada
 * pelo voiceRuntime — fica aqui para ser testável sem carregar os modelos de voz.
 */
export function prepareProcessTmpDir(
  tmpRoot: string,
  log: (msg: string) => void = () => {}
): { dir: string; selfDirName: string; removed: string[] } {
  const selfDirName = processDirName(process.pid, ownStartEpochMs());
  const swept = sweepStaleTmpDirs(tmpRoot, { selfDirName, log });
  const baseDir = fs.existsSync(tmpRoot) ? fs.realpathSync.native(tmpRoot) : tmpRoot;
  return { dir: path.join(baseDir, selfDirName), selfDirName, removed: swept.removed };
}
