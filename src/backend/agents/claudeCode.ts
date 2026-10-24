/**
 * Fase 17 (docs/phase-17-v1.md): o app delega tarefas de LEITURA ao Claude Code (`claude -p`).
 *
 * Desenho, em uma frase: nenhum servidor novo, nenhum endpoint que execute texto. A ordem falada vira (1) uma pergunta
 * de confirmação pelo mesmo fluxo das mutações (preview -> markPlayed -> "sim" determinístico -> token de uso único) e
 * (2) um processo filho com vetor de argumentos fixo, prompt por stdin, ambiente em lista de permissão e raiz de leitura
 * validada. O resultado volta como DADO NÃO CONFIÁVEL: é guardado e falado, nunca executado.
 *
 * Segurança estrutural (cada item tem teste em __tests__/claudeCode.test.ts):
 *  - argv fixo e fechado: `--permission-mode plan` e `--tools Read,Grep,Glob`; a ordem NUNCA entra no argv;
 *  - ambiente do filho em LISTA DE PERMISSÃO (nenhuma chave, token nem webhook herdado);
 *  - raiz de leitura: caminho absoluto, sem symlink, existente, fora do HOME/"/" e SEM `docs/research` (material pessoal);
 *  - um processo por vez, tempo limite duro, saída truncada, grupo de processos encerrado ao estourar.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import type { IntentName } from '../../shared/voiceProtocol.js';
import type { Capability } from './capabilityPolicy.js';
import { JsonStore } from '../storage/jsonStore.js';
import type { DelegationObserver } from './delegationNotice.js';

export const CLAUDE_TOOL_NAME = 'CLAUDE';
export const CLAUDE_KIND = 'CLAUDE_DELEGAR';

/** Ferramentas internas do Claude Code liberadas na v1: leitura. Sem Bash, Edit, Write, WebFetch, MCP. */
export const CLAUDE_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'] as const;

export const CLAUDE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const CLAUDE_MAX_ORDER_CHARS = 2000;
export const CLAUDE_MAX_RESULT_CHARS = 12_000;
const MAX_STDERR_CHARS = 4000;
const MAX_JOBS_KEPT = 50;

/** Vetor de argumentos FIXO. A ordem do usuário não aparece aqui: vai por stdin. */
export function buildClaudeArgv(): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--no-session-persistence',
    '--tools', CLAUDE_ALLOWED_TOOLS.join(',')
  ];
}

/** Lista de permissão: o filho recebe SÓ estas variáveis. Segredo nenhum atravessa por herança. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|CREDENTIAL)/i;

export function scrubEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const v = parent[name];
    if (typeof v === 'string' && v !== '' && !SECRET_NAME.test(name)) out[name] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Raiz de leitura
// ---------------------------------------------------------------------------------------------------------------------

export type RootResolution = { ok: true; root: string } | { ok: false; reason: string };

/** Quem valida existência/symlink. Injetável para teste; o padrão usa `fs` (só stat/realpath, nunca lê conteúdo). */
export interface RootFs {
  lstatIsSymlinkOrMissing(p: string): 'symlink' | 'missing' | 'dir' | 'other';
  realpath(p: string): string;
  exists(p: string): boolean;
  readConfig(p: string): string | null;
}

export const defaultRootFs: RootFs = {
  lstatIsSymlinkOrMissing(p) {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return 'symlink';
      return st.isDirectory() ? 'dir' : 'other';
    } catch {
      return 'missing';
    }
  },
  realpath: (p) => fs.realpathSync(p),
  exists: (p) => fs.existsSync(p),
  readConfig(p) {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch {
      return null;
    }
  }
};

/**
 * Valida UMA raiz candidata. Recusa: relativa depois de resolvida contra `projectRoot` que escape, symlink em qualquer
 * componente, inexistente, "/", o HOME inteiro, e QUALQUER pasta que contenha `docs/research` (material pessoal do
 * Rodrigo: a ausência dele na raiz é o que garante, por construção, que o Claude não o alcança).
 */
export function validateClaudeRoot(candidate: string, projectRoot: string, rfs: RootFs = defaultRootFs, home: string = os.homedir()): RootResolution {
  const abs = path.resolve(projectRoot, candidate);
  if (abs === path.parse(abs).root) return { ok: false, reason: 'raiz "/" não é permitida' };
  if (abs === path.resolve(home)) return { ok: false, reason: 'o HOME inteiro não é permitido como raiz' };
  // Todo componente do caminho precisa existir e não ser symlink.
  const parts = abs.split(path.sep).filter(Boolean);
  let cur: string = path.sep;
  for (const part of parts) {
    cur = path.join(cur, part);
    const kind = rfs.lstatIsSymlinkOrMissing(cur);
    if (kind === 'symlink') return { ok: false, reason: 'a raiz tem um link simbólico no caminho' };
    if (kind === 'missing') return { ok: false, reason: 'a raiz não existe' };
  }
  if (rfs.lstatIsSymlinkOrMissing(abs) !== 'dir') return { ok: false, reason: 'a raiz não é uma pasta' };
  if (rfs.realpath(abs) !== abs) return { ok: false, reason: 'a raiz muda ao resolver o caminho real' };
  if (rfs.exists(path.join(abs, 'docs', 'research'))) {
    return { ok: false, reason: 'a raiz contém docs/research (material pessoal); use um worktree limpo' };
  }
  return { ok: true, root: abs };
}

export const CLAUDE_ROOTS_CONFIG = path.join('config', 'claude-code-roots.json');

/** Lê a lista fechada de raízes e devolve a PRIMEIRA válida. Sem arquivo/lista/raiz válida => indisponível, com motivo. */
export function resolveClaudeRoot(projectRoot: string, rfs: RootFs = defaultRootFs, home?: string): RootResolution {
  const raw = rfs.readConfig(path.join(projectRoot, CLAUDE_ROOTS_CONFIG));
  if (raw === null) return { ok: false, reason: `falta ${CLAUDE_ROOTS_CONFIG}` };
  let roots: unknown;
  try {
    roots = (JSON.parse(raw) as { roots?: unknown }).roots;
  } catch {
    return { ok: false, reason: `${CLAUDE_ROOTS_CONFIG} não é JSON válido` };
  }
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every((r) => typeof r === 'string' && r.length > 0)) {
    return { ok: false, reason: `${CLAUDE_ROOTS_CONFIG} precisa de "roots": [ ...caminhos ]` };
  }
  let lastReason = 'nenhuma raiz válida';
  for (const r of roots as string[]) {
    const v = validateClaudeRoot(r, projectRoot, rfs, home);
    if (v.ok) return v;
    lastReason = v.reason;
  }
  return { ok: false, reason: lastReason };
}

// ---------------------------------------------------------------------------------------------------------------------
// Isolamento de leitura (achados 1 e 3 da auditoria do agy): `--tools Read,Grep,Glob` aceita caminhos absolutos e `../`,
// então a raiz sozinha NÃO isola. O processo roda dentro de um perfil do macOS (sandbox-exec) que NEGA leitura do HOME
// inteiro e reabre só a raiz validada e os arquivos do próprio Claude Code. docs/research, ~/.ssh, .env, etc. ficam fora.
// ---------------------------------------------------------------------------------------------------------------------

/** Sobe quando o perfil muda: invalida a prova de isolamento (selftest) anterior. */
export const SANDBOX_PROFILE_VERSION = 1;
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function sbQuote(p: string): string {
  if (/["\\\n\r]/.test(p)) throw new Error('caminho com caractere inválido para o perfil de isolamento');
  return `"${p}"`;
}

/**
 * Perfil SBPL. Regras posteriores vencem as anteriores: nega o HOME, reabre o necessário. Leitura de metadados (stat) dos
 * ancestrais fica liberada para a resolução de caminhos; o CONTEÚDO fora da raiz não.
 */
export function buildSandboxProfile(root: string, home: string, opts: { writable?: boolean } = {}): string {
  const h = sbQuote(home);
  return [
    '(version 1)',
    '(allow default)',
    // Nada de leitura nem escrita no HOME por padrão...
    `(deny file-read-data (subpath ${h}))`,
    `(deny file-write* (subpath ${h}))`,
    // ...exceto a raiz validada (leitura) e o que o próprio Claude Code precisa para iniciar e manter o login.
    `(allow file-read-data (subpath ${sbQuote(root)}))`,
    // Modo escrita (opção C): a ÚNICA pasta gravável do HOME é a raiz isolada; o resto do HOME segue negado.
    ...(opts.writable ? [`(allow file-write* (subpath ${sbQuote(root)}))`] : []),
    `(allow file-read-data (subpath ${sbQuote(path.join(home, '.claude'))}))`,
    `(allow file-read-data (literal ${sbQuote(path.join(home, '.claude.json'))}))`,
    `(allow file-read-data (subpath ${sbQuote(path.join(home, '.local', 'share', 'claude'))}))`,
    `(allow file-read-data (subpath ${sbQuote(path.join(home, '.local', 'bin'))}))`,
    `(allow file-read-data (subpath ${sbQuote(path.join(home, 'Library', 'Keychains'))}))`,
    `(allow file-read-data (subpath ${sbQuote(path.join(home, 'Library', 'Preferences'))}))`,
    `(allow file-read-data (subpath ${sbQuote(path.join(home, 'Library', 'Caches'))}))`,
    `(allow file-write* (subpath ${sbQuote(path.join(home, '.claude'))}))`,
    `(allow file-write* (prefix ${sbQuote(path.join(home, '.claude.json'))}))`,
    `(allow file-write* (subpath ${sbQuote(path.join(home, 'Library', 'Caches'))}))`
  ].join('\n');
}

export function wrapSandbox(bin: string, args: readonly string[], root: string, home: string, opts: { writable?: boolean } = {}): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ['-p', buildSandboxProfile(root, home, opts), bin, ...args] };
}

/** Dependências do isolamento, compartilhadas pelo modo leitura (runner) e pelo modo escrita (ClaudeCodeSubAgent). */
export interface IsolationDeps {
  resolveRoot: () => RootResolution;
  claudeBin: () => string | null;
  home: string;
  exists: (p: string) => boolean;
  selftestOk: (root: string, bin: string) => boolean;
}

export type IsolationReadiness = { ready: true; root: string; bin: string } | { ready: false; reason: string };

/** Sem binário, raiz limpa, sandbox-exec e prova de isolamento, nenhum modo (leitura ou escrita) roda. */
export function isolationReadiness(d: IsolationDeps): IsolationReadiness {
  const bin = d.claudeBin();
  if (!bin) return { ready: false, reason: 'o binário "claude" não foi encontrado' };
  const r = d.resolveRoot();
  if (!r.ok) return { ready: false, reason: r.reason };
  if (!d.exists(SANDBOX_EXEC)) return { ready: false, reason: 'o isolamento do macOS (sandbox-exec) não está disponível' };
  if (!d.selftestOk(r.root, bin)) return { ready: false, reason: 'falta a prova de isolamento (rode scripts/claude-code-selftest.mjs)' };
  return { ready: true, root: r.root, bin };
}

/** Prova de isolamento: gravada pelo scripts/claude-code-selftest.mjs só depois de um teste real passar. */
export interface SelftestMarker {
  profileVersion: number;
  root: string;
  claudeBin: string;
  passedAt: string;
}

export const SELFTEST_MARKER_FILE = path.join('.runtime', 'claude-code-selftest.json');

export function selftestMatches(raw: string | null, expect: { root: string; claudeBin: string }): boolean {
  if (raw === null) return false;
  try {
    const m = JSON.parse(raw) as Partial<SelftestMarker>;
    return m.profileVersion === SANDBOX_PROFILE_VERSION && m.root === expect.root && m.claudeBin === expect.claudeBin && typeof m.passedAt === 'string';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Detecção determinística da fala (sem LLM, sem nuvem)
// ---------------------------------------------------------------------------------------------------------------------

function foldAccents(s: string): string {
  let out = '';
  for (const ch of s) out += ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return out;
}

const DELEGATE_TRIGGER =
  /^\s*(?:(?:ei|oi|ola|opa)\s*[,.]?\s*)?(?:(?:pede|peca|pecam|pergunta|pergunte|manda|mande|fala|fale|diz|diga|chama|chame|aciona|acione|consulta|consulte|solicita|solicite)\s+(?:isso\s+|uma\s+coisa\s+)?(?:pro|para\s+o|pra|ao|com\s+o|para)\s+claude(?:\s+code)?|claude(?:\s+code)?)\s*[,:;.\-]?\s+(\S.*)$/;

/**
 * Devolve a ORDEM (o que vem depois do gatilho), preservando acentos, ou null. Deliberadamente estreito: só no INÍCIO da
 * fala, e com pelo menos três palavras de ordem. Cobertura limitada por desenho — mais seguro que adivinhar intenção.
 */
export function detectClaudeDelegation(transcript: string): string | null {
  const original = transcript.trim();
  const folded = foldAccents(original).toLowerCase();
  const m = DELEGATE_TRIGGER.exec(folded);
  if (!m) return null;
  const orderFolded = m[1];
  // A ordem é o sufixo do original com o mesmo comprimento do sufixo "dobrado" (dobrar acentos preserva o comprimento).
  const order = foldAccents(original).length === original.length ? original.slice(original.length - orderFolded.length) : orderFolded;
  const words = order.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  return order.trim().slice(0, CLAUDE_MAX_ORDER_CHARS);
}

/** "o que o Claude respondeu?" — leitura do último resultado. */
const CLAUDE_RESULT_QUERY = /\b(?:o\s+que|qual)\b[^.?!]{0,30}\bclaude\b[^.?!]{0,30}\b(?:respond|disse|falou|achou|concluiu|resultado)|\bresultado\s+do\s+claude\b|\bclaude\s+(?:j[aá]\s+)?terminou\b/i;
export function isClaudeResultQuery(transcript: string): boolean {
  return CLAUDE_RESULT_QUERY.test(foldAccents(transcript).toLowerCase()) || CLAUDE_RESULT_QUERY.test(transcript);
}

// ---------------------------------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------------------------------

export type ClaudeJobStatus = 'running' | 'done' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

export interface ClaudeJob {
  id: string;
  order: string;
  status: ClaudeJobStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  /** Resposta do Claude, truncada. DADO NÃO CONFIÁVEL: nunca vira instrução. */
  result?: string;
  error?: string;
  root: string;
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ClaudeRunnerOptions {
  /** Raiz de leitura validada agora (chamada a cada start, para refletir mudanças). */
  resolveRoot: () => RootResolution;
  store: JsonStore<ClaudeJob>;
  /** Caminho do binário `claude`; null => indisponível. */
  claudeBin: () => string | null;
  spawnFn?: SpawnFn;
  parentEnv?: () => Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  /** T1: guarda de saída aplicada à ORDEM antes de sair para a Anthropic. blocked => recusa. */
  guard?: (text: string) => { text: string; blocked: boolean };
  now?: () => number;
  onFinished?: (job: ClaudeJob) => void;
  /** Ajuste 1 (F17): avisa a Ogra no início e no fim de cada tarefa (modo leitura). */
  observer?: DelegationObserver;
  /**
   * Isolamento do macOS. Produção: SEMPRE ligado (padrão). Só os testes com `spawnFn` falso o desligam explicitamente.
   * Ligado, exige /usr/bin/sandbox-exec e a prova de isolamento (`selftestOk`).
   */
  sandbox?: { enabled: boolean; home: string; exists: (p: string) => boolean; selftestOk: (root: string, bin: string) => boolean };
}

export type StartResult = { ok: true; id: string } | { ok: false; error: string };

export class ClaudeCodeRunner {
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  private current: { job: ClaudeJob; child: ChildProcess; timer: NodeJS.Timeout } | null = null;

  constructor(private readonly opts: ClaudeRunnerOptions) {
    this.spawnFn = opts.spawnFn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
    this.timeoutMs = opts.timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Pronto = há binário e há raiz válida. (O mestre/canal de privacidade é checado por quem constrói a ferramenta.) */
  readiness(): { ready: true } | { ready: false; reason: string } {
    if (!this.opts.claudeBin()) return { ready: false, reason: 'o binário "claude" não foi encontrado' };
    const r = this.opts.resolveRoot();
    if (!r.ok) return { ready: false, reason: r.reason };
    const sb = this.opts.sandbox;
    if (sb?.enabled) {
      if (!sb.exists(SANDBOX_EXEC)) return { ready: false, reason: 'o isolamento do macOS (sandbox-exec) não está disponível' };
      if (!sb.selftestOk(r.root, this.opts.claudeBin() as string)) {
        return { ready: false, reason: 'falta a prova de isolamento (rode scripts/claude-code-selftest.mjs)' };
      }
    }
    return { ready: true };
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  jobs(): ClaudeJob[] {
    return this.opts.store.read().items;
  }

  latestFinished(): ClaudeJob | undefined {
    return [...this.jobs()].reverse().find((j) => j.status !== 'running');
  }

  /** Na subida: o que ficou "running" de uma execução anterior foi interrompido; NUNCA é retomado nem reexecutado. */
  recoverInterrupted(): number {
    const { items } = this.opts.store.read();
    let n = 0;
    for (const j of items) {
      if (j.status === 'running') {
        j.status = 'interrupted';
        j.finishedAt = new Date(this.now()).toISOString();
        j.error = 'O app foi reiniciado durante a execução; a tarefa não foi retomada.';
        n++;
      }
    }
    if (n > 0) this.opts.store.write({ items });
    return n;
  }

  start(orderRaw: string): StartResult {
    if (this.current) return { ok: false, error: 'Já há uma tarefa do Claude em andamento.' };
    const ready = this.readiness();
    if (!ready.ready) return { ok: false, error: `A delegação ao Claude não está pronta: ${ready.reason}.` };
    const bin = this.opts.claudeBin() as string;
    const rootRes = this.opts.resolveRoot();
    if (!rootRes.ok) return { ok: false, error: `Raiz de leitura inválida: ${rootRes.reason}.` };

    let order = orderRaw.trim().slice(0, CLAUDE_MAX_ORDER_CHARS);
    if (order.length === 0) return { ok: false, error: 'A ordem para o Claude está vazia.' };
    if (this.opts.guard) {
      const g = this.opts.guard(order);
      if (g.blocked) return { ok: false, error: 'Detectei um dado sensível na ordem e, pela configuração de privacidade, não enviei ao Claude.' };
      order = g.text;
    }

    const job: ClaudeJob = {
      id: crypto.randomUUID(),
      order,
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      root: rootRes.root
    };
    this.persist(job);
    this.notify(job);

    let child: ChildProcess;
    try {
      const sb = this.opts.sandbox;
      const cmd = sb?.enabled ? wrapSandbox(bin, buildClaudeArgv(), rootRes.root, sb.home) : { command: bin, args: buildClaudeArgv() };
      child = this.spawnFn(cmd.command, cmd.args, {
        cwd: rootRes.root,
        env: scrubEnv((this.opts.parentEnv ?? (() => process.env))()),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        shell: false
      });
    } catch (err) {
      this.finish(job, 'failed', { error: `Não consegui iniciar o Claude (${err instanceof Error ? err.name : 'erro'}).` });
      return { ok: true, id: job.id };
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (status: ClaudeJobStatus, extra: { exitCode?: number | null; result?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.current = null;
      this.finish(job, status, extra);
    };
    const timer = setTimeout(() => {
      this.killGroup(child);
      done('timeout', { error: `O Claude passou de ${Math.round(this.timeoutMs / 1000)} s e foi encerrado.` });
    }, this.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer | string) => {
      if (stdout.length < CLAUDE_MAX_RESULT_CHARS * 4) stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += d.toString();
    });
    child.on('error', (err: Error) => {
      done('failed', { error: `Falha ao executar o Claude (${err.name}).` });
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      const parsed = parseClaudeOutput(stdout);
      if (code === 0 && !parsed.isError) done('done', { exitCode: code, result: parsed.text });
      else done('failed', { exitCode: code, result: parsed.text || undefined, error: parsed.isError ? `O Claude respondeu com erro${parsed.text ? `: ${parsed.text.replace(/\s+/g, ' ').slice(0, 200)}` : '.'}` : `O Claude terminou com código ${code}.` });
    });

    this.current = { job, child, timer };
    try {
      child.stdin?.on('error', () => {});
      child.stdin?.end(order);
    } catch {
      /* o close/error acima resolve o job */
    }
    return { ok: true, id: job.id };
  }

  cancel(): boolean {
    if (!this.current) return false;
    const { job, child, timer } = this.current;
    clearTimeout(timer);
    this.killGroup(child);
    this.current = null;
    this.finish(job, 'cancelled', { error: 'Cancelada.' });
    return true;
  }

  shutdown(): void {
    if (this.current) {
      const { job, child, timer } = this.current;
      clearTimeout(timer);
      this.killGroup(child);
      this.current = null;
      this.finish(job, 'interrupted', { error: 'O app foi encerrado durante a execução.' }, false);
    }
  }

  private killGroup(child: ChildProcess): void {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* já morreu */
      }
    }
  }

  private finish(job: ClaudeJob, status: ClaudeJobStatus, extra: { exitCode?: number | null; result?: string; error?: string }, notify = true): void {
    job.status = status;
    job.finishedAt = new Date(this.now()).toISOString();
    job.durationMs = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
    if (extra.exitCode !== undefined) job.exitCode = extra.exitCode;
    if (extra.result !== undefined) job.result = extra.result.slice(0, CLAUDE_MAX_RESULT_CHARS);
    if (extra.error !== undefined) job.error = extra.error;
    this.persist(job);
    this.notify(job);
    if (notify) {
      try {
        this.opts.onFinished?.(job);
      } catch (err) {
        console.error('[claude] onFinished falhou:', err instanceof Error ? err.name : 'erro');
      }
    }
  }

  private notify(job: ClaudeJob): void {
    try {
      this.opts.observer?.onEvent({
        id: job.id,
        mode: 'leitura',
        order: job.order,
        status: job.status === 'running' ? 'started' : job.status,
        at: job.finishedAt ?? job.startedAt,
        ...(job.status === 'running' ? {} : { conclusion: job.status === 'done' ? job.result : job.error ?? job.result })
      });
    } catch {
      /* o aviso nunca derruba a tarefa */
    }
  }

  private persist(job: ClaudeJob): void {
    const { items } = this.opts.store.read();
    const i = items.findIndex((j) => j.id === job.id);
    if (i >= 0) items[i] = { ...job };
    else items.push({ ...job });
    this.opts.store.write({ items: items.slice(-MAX_JOBS_KEPT) });
  }
}

/** `claude -p --output-format json` imprime um objeto com `result` e `is_error`; qualquer outra coisa vira texto cru. */
export function parseClaudeOutput(stdout: string): { text: string; isError: boolean } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '', isError: false };
  try {
    const obj = JSON.parse(trimmed) as { result?: unknown; is_error?: unknown };
    if (obj && typeof obj === 'object') {
      const text = typeof obj.result === 'string' ? obj.result : '';
      return { text, isError: obj.is_error === true };
    }
  } catch {
    /* texto cru */
  }
  return { text: trimmed.slice(0, CLAUDE_MAX_RESULT_CHARS), isError: false };
}

/** Procura o binário `claude` no PATH (ou em RODRIGO_CLAUDE_BIN). Só existência, nunca executa. */
export function findClaudeBinary(env: Readonly<Record<string, string | undefined>> = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const explicit = env['RODRIGO_CLAUDE_BIN'];
  if (explicit && path.isAbsolute(explicit)) return exists(explicit) ? explicit : null;
  for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (exists(candidate)) return candidate;
  }
  const home = env['HOME'];
  if (home) {
    const local = path.join(home, '.local', 'bin', 'claude');
    if (exists(local)) return local;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ferramenta (entra no fluxo de mutação: pergunta falada + "sim" determinístico + token de uso único)
// ---------------------------------------------------------------------------------------------------------------------

export const CLAUDE_STARTED_TEXT = 'Pedi ao Claude. Aviso quando terminar.';
export const CLAUDE_BUSY_TEXT = 'Já há uma tarefa do Claude em andamento. Espere ela terminar.';

export class ClaudeDelegateTool implements IMutatingTool {
  readonly name = CLAUDE_TOOL_NAME;
  readonly description = 'Delega ao Claude Code uma tarefa de leitura e análise nos arquivos do projeto (confirmada por voz).';
  /** T3: processo (shell) que lê arquivos; `write_file` porque grava o registro da tarefa no store do app. */
  readonly extraGrants: readonly Capability[] = ['shell', 'read_file'];

  constructor(
    private readonly runner: ClaudeCodeRunner,
    /** Mestre + canal RODRIGO_CLAUDE_CODE (claudeCodeEffective). Avaliado a cada uso. */
    private readonly channelOn: () => boolean
  ) {}

  isAvailable(): boolean {
    return this.channelOn() && this.runner.readiness().ready;
  }

  preview(kind: IntentName, content: string | null): string {
    void kind;
    const order = (content ?? '').trim();
    if (!order) throw new Error('ordem vazia');
    return `Vou pedir ao Claude, só para ler e analisar, o seguinte: ${order}. Pode ser?`;
  }

  execute(kind: IntentName, content: string | null): string {
    void kind;
    const r = this.runner.start(content ?? '');
    if (r.ok) return CLAUDE_STARTED_TEXT;
    return r.error === 'Já há uma tarefa do Claude em andamento.' ? CLAUDE_BUSY_TEXT : r.error;
  }
}

/** Resumo falado de um job concluído: poucas frases, o texto completo fica na tela. */
export function spokenSummary(job: ClaudeJob, maxChars = 420): string {
  if (job.status === 'done') {
    const body = (job.result ?? '').replace(/\s+/g, ' ').trim();
    if (!body) return 'O Claude terminou, mas não trouxe resposta.';
    const clipped = body.length > maxChars ? `${body.slice(0, maxChars).replace(/\s+\S*$/, '')}…` : body;
    return `O Claude terminou. ${clipped} O texto completo está na tela.`;
  }
  if (job.status === 'timeout') return 'O Claude demorou demais e eu encerrei a tarefa.';
  if (job.status === 'cancelled') return 'A tarefa do Claude foi cancelada.';
  if (job.status === 'interrupted') return 'A tarefa do Claude foi interrompida.';
  return `A tarefa do Claude falhou. ${job.error ?? ''}`.trim();
}
