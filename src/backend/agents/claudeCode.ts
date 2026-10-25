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
import { spawnSync } from 'node:child_process';
import { CLAUDE_PROXY_PORT, sharedClaudeProxy, type ProxyAuth, type ProxyMode } from './claudeProxy.js';
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

/**
 * A1 da auditoria do Code: o filho NUNCA usa o `~/.claude` do usuário (hooks, comandos, agentes e transcrições de outros
 * projetos). Ele recebe um CLAUDE_CONFIG_DIR próprio dentro de `.runtime` e um TMPDIR próprio; o resto do ambiente é a lista de permissão.
 */
/** F2: fd em que o filho recebe o nonce do job (pipe de uso único; fechado logo após a escrita). */
export const CLAUDE_NONCE_FD = 3;
/** stdio do spawn: stdin/stdout/stderr + o pipe do nonce no fd 3. */
export const CLAUDE_CHILD_STDIO = ['pipe', 'pipe', 'pipe', 'pipe'] as const;

/** F2: escreve o nonce no fd 3 do filho e fecha o pipe. false se o pipe não existir (o chamador falha fechado). */
export function passNonceFd(child: { stdio?: ReadonlyArray<unknown> }, auth: ProxyAuth): boolean {
  const w = child.stdio?.[CLAUDE_NONCE_FD] as { end?: (d: string) => void; on?: (e: string, f: () => void) => void } | null | undefined;
  if (!w || typeof w.end !== 'function') return false;
  w.on?.('error', () => {});
  w.end(auth.nonce);
  return true;
}

export function claudeChildEnv(parent: Readonly<Record<string, string | undefined>>, paths: SandboxPaths, auth?: ProxyAuth | null): Record<string, string> {
  // R3: CLAUDE_CODE_TMPDIR tira o Claude do /tmp/claude-<uid> compartilhado (sessões de outros projetos), agora ilegível.
  const env: Record<string, string> = { ...scrubEnv(parent), CLAUDE_CONFIG_DIR: paths.configDir, CLAUDE_CODE_TMPDIR: paths.tmpDir, TMPDIR: paths.tmpDir };
  // A3: o token dedicado NUNCA entra no filho. Ele fala só com o proxy local (que injeta o token) e se autentica com um nonce.
  if (auth) {
    env['ANTHROPIC_BASE_URL'] = auth.baseUrl;
    // F2: o nonce NÃO vai no env (legível por `ps eww`/KERN_PROCARGS2): o Claude o lê uma vez do fd 3 (pipe), ver passNonceFd.
    env['CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'] = String(CLAUDE_NONCE_FD);
  }
  env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
  env['DISABLE_AUTOUPDATER'] = '1';
  return env;
}

// ---------------------------------------------------------------------------------------------------------------------
// N2 do Code: token dedicado e revogável (`claude setup-token`) em vez do Keychain (agora negado ao filho).
// Arquivo FORA do repositório, dono = usuário, modo 0600, sem symlink. O valor nunca é logado nem entra em mensagens de erro.
// ---------------------------------------------------------------------------------------------------------------------

export const CLAUDE_OAUTH_TOKEN_FILE = path.join('.config', 'rodrigo-ai', 'claude-oauth-token');

export type OAuthTokenResult = { ok: true; token: string } | { ok: false; reason: string };

export interface TokenFs {
  lstat: (p: string) => { isFile: () => boolean; isSymbolicLink: () => boolean; mode: number; uid: number } | null;
  read: (p: string) => string;
  uid: () => number;
}

export const defaultTokenFs: TokenFs = {
  lstat: (p) => {
    try {
      return fs.lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  read: (p) => fs.readFileSync(p, 'utf8'),
  uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1)
};

/** Lê o token dedicado. Recusa (sem mostrar o conteúdo) se o arquivo for symlink, de outro dono, legível por grupo/outros ou mal formado. */
export function loadClaudeOAuthToken(home: string = os.homedir(), tfs: TokenFs = defaultTokenFs): OAuthTokenResult {
  const p = path.join(home, CLAUDE_OAUTH_TOKEN_FILE);
  let st: ReturnType<TokenFs['lstat']>;
  try {
    st = tfs.lstat(p);
  } catch {
    return { ok: false, reason: `não foi possível verificar ${p}` };
  }
  if (!st) return { ok: false, reason: `token dedicado ausente (${p}); rode  claude setup-token  e salve o token nesse arquivo com chmod 600` };
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: `${p} precisa ser um arquivo comum (sem symlink)` };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `${p} está acessível por grupo/outros; rode  chmod 600 ${p}` };
  const uid = tfs.uid();
  if (uid >= 0 && st.uid !== uid) return { ok: false, reason: `${p} não pertence ao usuário atual` };
  let raw: string;
  try {
    raw = tfs.read(p);
  } catch {
    return { ok: false, reason: `não foi possível ler ${p}` };
  }
  const token = raw.trim();
  if (token === '' || !/^[A-Za-z0-9._~+/=-]{20,4096}$/.test(token)) return { ok: false, reason: `${p} não contém um token válido (uma linha, sem espaços)` };
  return { ok: true, token };
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
  // M6 do Code: um ANCESTRAL do HOME (ex.: /Users) reabriria o HOME inteiro no perfil (e, no modo escrita, a gravação).
  const toHome = path.relative(abs, path.resolve(home));
  if (toHome === '' || (!toHome.startsWith('..') && !path.isAbsolute(toHome))) return { ok: false, reason: 'a raiz contém o HOME' };
  // M6: o único uso previsto é um worktree sob <projeto>/.runtime/ (scripts/setup-claude-readonly.sh).
  const runtimeDir = path.resolve(projectRoot, '.runtime');
  const inRuntime = path.relative(runtimeDir, abs);
  if (inRuntime === '' || inRuntime.startsWith('..') || path.isAbsolute(inRuntime)) {
    return { ok: false, reason: 'a raiz precisa ficar dentro de <projeto>/.runtime/' };
  }
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
  // M6: worktree do git => `.git` é ARQUIVO (não pasta, não link). Pasta qualquer ou clone completo não servem.
  if (rfs.lstatIsSymlinkOrMissing(path.join(abs, '.git')) !== 'other') return { ok: false, reason: 'a raiz precisa ser um worktree do git (.git como arquivo)' };
  if (rfs.exists(path.join(abs, 'docs', 'research'))) {
    return { ok: false, reason: 'a raiz contém docs/research (material pessoal); use um worktree limpo' };
  }
  return { ok: true, root: abs };
}

export const CLAUDE_ROOTS_CONFIG = path.join('config', 'claude-code-roots.json');

/** Lê a lista fechada de raízes e devolve a PRIMEIRA válida. Sem arquivo/lista/raiz válida => indisponível, com motivo. */
export function resolveClaudeRoot(projectRoot: string, rfs: RootFs = defaultRootFs, home?: string): RootResolution {
  return resolveRootList(projectRoot, 'roots', rfs, home);
}

function resolveRootList(projectRoot: string, key: 'roots' | 'writeRoots', rfs: RootFs, home?: string): RootResolution {
  const raw = rfs.readConfig(path.join(projectRoot, CLAUDE_ROOTS_CONFIG));
  if (raw === null) return { ok: false, reason: `falta ${CLAUDE_ROOTS_CONFIG}` };
  let roots: unknown;
  try {
    roots = (JSON.parse(raw) as Record<string, unknown>)[key];
  } catch {
    return { ok: false, reason: `${CLAUDE_ROOTS_CONFIG} não é JSON válido` };
  }
  if (!Array.isArray(roots) || roots.length === 0 || !roots.every((r) => typeof r === 'string' && r.length > 0)) {
    return { ok: false, reason: `${CLAUDE_ROOTS_CONFIG} precisa de "${key}": [ ...caminhos ]` };
  }
  let lastReason = 'nenhuma raiz válida';
  for (const r of roots as string[]) {
    const v = validateClaudeRoot(r, projectRoot, rfs, home);
    if (v.ok) return v;
    lastReason = v.reason;
  }
  return { ok: false, reason: lastReason };
}

/** Duas pastas não podem ser iguais nem uma dentro da outra. */
export function rootsOverlap(a: string, b: string): boolean {
  const r1 = path.relative(a, b);
  const r2 = path.relative(b, a);
  const inside = (r: string) => r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
  return inside(r1) || inside(r2);
}

/**
 * A3, item 3: raiz de ESCRITA separada (worktree próprio em `.runtime/`, `"writeRoots"` em config/claude-code-roots.json).
 * Mesma validação da raiz de leitura e, além disso, não pode coincidir nem se aninhar com ela: o perfil de escrita
 * reabre só a raiz de escrita, então o modo escrita não lê a raiz de leitura (e vice-versa).
 */
export function resolveClaudeWriteRoot(projectRoot: string, rfs: RootFs = defaultRootFs, home?: string): RootResolution {
  const w = resolveRootList(projectRoot, 'writeRoots', rfs, home);
  if (!w.ok) return w;
  const r = resolveClaudeRoot(projectRoot, rfs, home);
  if (r.ok && rootsOverlap(r.root, w.root)) return { ok: false, reason: 'a raiz de escrita não pode ser a raiz de leitura nem ficar dentro/fora dela' };
  return w;
}

// ---------------------------------------------------------------------------------------------------------------------
// Isolamento de leitura (achados 1 e 3 da auditoria do agy): `--tools Read,Grep,Glob` aceita caminhos absolutos e `../`,
// então a raiz sozinha NÃO isola. O processo roda dentro de um perfil do macOS (sandbox-exec) que NEGA leitura do HOME
// inteiro e reabre só a raiz validada e os arquivos do próprio Claude Code. docs/research, ~/.ssh, .env, etc. ficam fora.
// ---------------------------------------------------------------------------------------------------------------------

/** Sobe quando o perfil muda: invalida a prova de isolamento (selftest) anterior. v2: config própria, escrita negada por padrão, rede só 443/DNS.
 *  v3 (R1–R3 do Code): config de hooks/MCP não gravável, sem LaunchServices/AppleEvents/launchctl/security, sem leitura de /Volumes e temporários do sistema.
 *  v4 (N1/N4 da reauditoria 2): exec só de uma lista de pastas do sistema/Homebrew/claude (cópia de binário em pasta gravável não roda),
 *  Keychain negado (securityd + ~/Library/Keychains) e skills/plugins/output-styles protegidos. */
export const SANDBOX_PROFILE_VERSION = 7;
/* v5 (A3 da reauditoria 3): rede só para o proxy local (sem 443/DNS diretos), job-creation e smd/secur* negados,
 *  file-map-executable por lista (dlopen de biblioteca copiada falha), ~/.local/bin só o literal claude, mais leituras negadas
 *  e raiz de escrita separada da de leitura. */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function sbQuote(p: string): string {
  if (/["\\\n\r]/.test(p)) throw new Error('caminho com caractere inválido para o perfil de isolamento');
  return `"${p}"`;
}

/** Pastas próprias do filho, dentro de `<projeto>/.runtime`: configuração do Claude (login separado) e TMPDIR. */
export interface SandboxPaths {
  configDir: string;
  tmpDir: string;
}

/** A4: pastas próprias SEPARADAS por modo (o modo escrita não deixa instruções/contexto para o de leitura, nem o contrário). */
export function claudeSandboxPaths(projectRoot: string, mode: ProxyMode = 'leitura'): SandboxPaths {
  const sfx = mode === 'escrita' ? '-write' : '';
  return { configDir: path.join(projectRoot, '.runtime', `claude-home${sfx}`), tmpDir: path.join(projectRoot, '.runtime', `claude-tmp${sfx}`) };
}

/** Cria as duas pastas (modo 0700) antes de qualquer spawn. */
export function ensureSandboxDirs(paths: SandboxPaths): void {
  for (const d of [paths.configDir, paths.tmpDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** R1: caminhos que o filho NÃO pode gravar (hooks, MCP, comandos, agentes persistiriam entre sessões e modos e rodariam fora do sandbox no login). */
export function protectedConfigPaths(root: string, configDir: string): { literals: string[]; subpaths: string[] } {
  return {
    literals: [
      ...['settings.json', 'settings.local.json', 'CLAUDE.md'].map((f) => path.join(configDir, f)),
      ...['settings.json', 'settings.local.json'].map((f) => path.join(root, '.claude', f)),
      path.join(root, '.mcp.json')
    ],
    subpaths: [...['commands', 'agents', 'hooks', 'skills', 'plugins', 'output-styles'].flatMap((d) => [path.join(configDir, d), path.join(root, '.claude', d)])]
  };
}

/** R2: binários que saem do sandbox (launchd, LaunchServices, AppleEvents) ou leem o Keychain do usuário (A1/R1). */
export const SANDBOX_DENIED_EXECS = ['/bin/launchctl', '/usr/bin/open', '/usr/bin/osascript', '/usr/bin/security'] as const;
/** R3: leitura fora do HOME que vira exfiltração pela 443 (discos externos e temporários de outros apps). */
/** N1: o filho só executa binários destas pastas (nenhuma gravável por ele). Cópias em claude-tmp, claude-home ou na raiz dão EPERM. */
export const SANDBOX_EXEC_ALLOWED_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/libexec', '/System', '/opt/homebrew'] as const;
/** Pastas do próprio Claude Code dentro do HOME (instalador nativo: ~/.local/bin/claude -> ~/.local/share/claude/versions/X). */
export function claudeExecDirs(home: string): string[] {
  return [path.join(home, '.local', 'share', 'claude')];
}
/** A3: de ~/.local/bin só o link do claude (antes a pasta inteira: delegar, codex, gemini... eram executáveis no filho). */
export function claudeExecLiterals(home: string): string[] {
  return [path.join(home, '.local', 'bin', 'claude')];
}
/** A3: bibliotecas só podem ser mapeadas como executáveis a partir destas pastas (ctypes/DynaLoader de .dylib copiada falha). */
export function sandboxMapExecDirs(home: string): string[] {
  return ['/usr', '/System', '/Library/Apple', '/opt/homebrew', '/Applications/Xcode.app', '/Library/Developer/CommandLineTools', ...claudeExecDirs(home)];
}
/** N1: serviços mach do Keychain. */
export const SANDBOX_DENIED_MACH_KEYCHAIN = ['com.apple.SecurityServer', 'com.apple.securityd'] as const;
/** A3: launchd por XPC (SMJobSubmit/SMAppService) e todo serviço com.apple.secur* (Keychain por python/perl via Security.framework). */
/** A4: área de transferência (pbpaste/pbcopy: token copiado, canal entre processos) e nsurlsessiond (download/upload feito pelo daemon, fora da rede do sandbox). */
export const SANDBOX_DENIED_MACH_NAMES = ['com.apple.xpc.smd', 'com.apple.pasteboard.1', 'com.apple.nsurlsessiond'] as const;
export const SANDBOX_DENIED_MACH_REGEX = ['^com\\.apple\\.secur', '^com\\.apple\\.pasteboard', '^com\\.apple\\.nsurlsession'] as const;
export const SANDBOX_DENIED_READS = ['/Volumes', '/private/var/folders', '/private/tmp', '/Users/Shared', '/opt/homebrew/var', '/Library/Application Support'] as const;

/** R1: chaves que executam código ou ligam servidores; não podem existir na config do filho. */
const TAINT_KEYS = new Set(['env', 'hooks', 'mcpServers', 'apiKeyHelper', 'enabledPlugins', 'statusLine', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper']);
function hasTaint(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasTaint);
  if (v === null || typeof v !== 'object') return false;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (TAINT_KEYS.has(k)) {
      const empty = x === null || x === '' || (Array.isArray(x) && x.length === 0) || (typeof x === 'object' && x !== null && Object.keys(x).length === 0);
      if (!empty) return true;
    }
    if (hasTaint(x)) return true;
  }
  return false;
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * R1: verificação de boot. Recusa (devolve o motivo) se a config própria do filho ou a da raiz tiver hooks, MCP ou
 * auxiliares executáveis, ou se não der para ler/entender os arquivos (falha fechada).
 */
export function claudeConfigTaint(root: string, configDir: string, read: (p: string) => string | null = readIfExists): string | null {
  const files = [
    path.join(configDir, 'settings.json'), path.join(configDir, 'settings.local.json'), path.join(configDir, '.claude.json'),
    path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'), path.join(root, '.mcp.json')
  ];
  for (const f of files) {
    let raw: string | null;
    try {
      raw = read(f);
    } catch {
      return `não foi possível ler ${f}`;
    }
    if (raw === null) continue;
    if (f.endsWith('.mcp.json')) return `${f} existe (servidores MCP de projeto não são permitidos)`;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return `${f} não é JSON válido`;
    }
    if (hasTaint(obj)) return `${f} contém hooks, mcpServers ou auxiliar executável`;
  }
  return null;
}

export interface SandboxProfileOpts {
  /** Modo escrita (opção C): a raiz isolada também é gravável. Padrão: leitura. */
  writable?: boolean;
  paths: SandboxPaths;
  /** N1: o binário que o sandbox-exec vai executar (literal; nunca a pasta dele). */
  execBin?: string;
  /** A4: porta (efêmera) do proxy deste processo. Ausente => NENHUMA rede (falha fechada). */
  proxyPort?: number;
}

/**
 * Perfil SBPL (regras posteriores vencem as anteriores).
 *  - LEITURA: nega o HOME inteiro e reabre só a raiz, a configuração/TMPDIR próprios e o necessário para executar o binário e usar o Keychain.
 *    O `~/.claude` do usuário NÃO é reaberto (A1/M2 do Code).
 *  - ESCRITA: nega TODA gravação (A2) e reabre só a configuração própria, o TMPDIR próprio, /dev/{null,tty,...} e, no modo escrita, a raiz.
 *  - REDE: nega tudo e reabre só tcp localhost:<porta do proxy> (A3). O proxy é quem fala com api.anthropic.com.
 */
export function buildSandboxProfile(root: string, home: string, opts: SandboxProfileOpts): string {
  const q = sbQuote;
  const { configDir, tmpDir } = opts.paths;
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data (subpath ${q(home)}))`,
    ...SANDBOX_DENIED_READS.map((d) => `(deny file-read-data (subpath ${q(d)}))`),
    '(deny file-write*)',
    ...['/dev/null', '/dev/tty', '/dev/dtracehelper', '/dev/zero'].map((d) => `(allow file-write* (literal ${q(d)}))`),
    `(allow file-read-data (subpath ${q(root)}))`,
    `(allow file-read-data (subpath ${q(configDir)}))`,
    `(allow file-read-data (subpath ${q(tmpDir)}))`,
    `(allow file-read-data (subpath ${q(path.join(home, '.local', 'share', 'claude'))}))`,
    ...claudeExecLiterals(home).map((b) => `(allow file-read-data (literal ${q(b)}))`),
    // N1: o Keychain NÃO é reaberto (o login agora é o token dedicado do N2); negado também explicitamente, por clareza.
    `(deny file-read* (subpath ${q(path.join(home, 'Library', 'Keychains'))}))`,
    `(allow file-write* (subpath ${q(configDir)}))`,
    `(allow file-write* (subpath ${q(tmpDir)}))`,
    ...(opts.writable ? [`(allow file-write* (subpath ${q(root)}))`] : []),
    ...(() => {
      const pc = protectedConfigPaths(root, configDir);
      return [...pc.literals.map((f) => `(deny file-write* (literal ${q(f)}))`), ...pc.subpaths.map((d) => `(deny file-write* (subpath ${q(d)}))`)];
    })(),
    '(deny appleevent-send)',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents"))',
    `(deny mach-lookup ${SANDBOX_DENIED_MACH_KEYCHAIN.map((n) => `(global-name ${q(n)})`).join(' ')})`,
    `(deny mach-lookup ${SANDBOX_DENIED_MACH_NAMES.map((n) => `(global-name ${q(n)})`).join(' ')} ${SANDBOX_DENIED_MACH_REGEX.map((r) => `(global-name-regex #"${r}")`).join(' ')})`,
    '(deny job-creation)',
    // F2 (v7): sem ler informações (env/argv/fds) nem sinalizar processos FORA deste sandbox — inclusive sobreviventes de
    // jobs anteriores (outra instância). Provado: `(target others)` não tem efeito; same-sandbox sim.
    '(deny process-info*)',
    '(allow process-info* (target same-sandbox))',
    '(allow process-info-listpids)',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny file-map-executable)',
    `(allow file-map-executable ${sandboxMapExecDirs(home).map((d) => `(subpath ${q(d)})`).join(' ')})`,
    // N1: exec por lista de permissão; depois os binários proibidos mesmo dentro dela (regras posteriores vencem).
    '(deny process-exec*)',
    `(allow process-exec* ${[...SANDBOX_EXEC_ALLOWED_DIRS, ...claudeExecDirs(home)].map((d) => `(subpath ${q(d)})`).join(' ')} ${claudeExecLiterals(home).map((b) => `(literal ${q(b)})`).join(' ')})`,
    ...(opts.execBin ? [`(allow process-exec* (literal ${q(opts.execBin)}))`] : []),
    ...SANDBOX_DENIED_EXECS.map((b) => `(deny process-exec (literal ${q(b)}))`),
    // A3: rede SÓ para o proxy local do pai (que injeta o token e só fala com api.anthropic.com). Sem 443 direto, sem DNS.
    '(deny network*)',
    ...(opts.proxyPort !== undefined ? [`(allow network-outbound (remote tcp "localhost:${proxyPortChecked(opts.proxyPort)}"))`] : [])
  ].join('\n');
}

function proxyPortChecked(p: number): number {
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('porta do proxy inválida para o perfil de isolamento');
  return p;
}

export function wrapSandbox(bin: string, args: readonly string[], root: string, home: string, opts: SandboxProfileOpts): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ['-p', buildSandboxProfile(root, home, { ...opts, execBin: bin }), bin, ...args] };
}

/** Impressão digital dos DOIS perfis (leitura na raiz de leitura; escrita na raiz de escrita, A3) gerados para este HOME/pastas: entra na prova (M3 do Code). */
/** A4: a porta do proxy é efêmera; a impressão digital usa a porta de referência (a única diferença admitida é o número da porta). */
export function profileFingerprint(root: string, home: string, paths: SandboxPaths, writeRoot?: string | null, writePaths?: SandboxPaths | null): string {
  const a = buildSandboxProfile(root, home, { paths, proxyPort: CLAUDE_PROXY_PORT });
  const b = writeRoot && writePaths ? buildSandboxProfile(writeRoot, home, { paths: writePaths, writable: true, proxyPort: CLAUDE_PROXY_PORT }) : 'sem-raiz-de-escrita';
  return crypto.createHash('sha256').update(`${a}\n--\n${b}`).digest('hex');
}

/** Dependências do isolamento, compartilhadas pelo modo leitura (runner) e pelo modo escrita (ClaudeCodeSubAgent). */
export interface IsolationDeps {
  resolveRoot: () => RootResolution;
  claudeBin: () => string | null;
  home: string;
  /** Pastas próprias do filho (configuração do Claude e TMPDIR). */
  paths: SandboxPaths;
  exists: (p: string) => boolean;
  selftestOk: (root: string, bin: string) => boolean;
  /** A3: raiz de ESCRITA (separada da de leitura). Ausente => modo escrita indisponível. */
  resolveWriteRoot?: () => RootResolution;
  /** A4: pastas próprias do modo ESCRITA (separadas das do modo leitura). Ausentes => modo escrita indisponível. */
  writePaths?: SandboxPaths;
  /** A3/A4: autenticação do filho via proxy local: um nonce NOVO por job, revogado no fim. null => não roda (falha fechada). */
  proxyAuth?: (home: string, mode: ProxyMode) => ProxyAuth | null;
  /** A4 (setsid): no fim do job, mata processos que sobraram com cwd nas pastas do job. Padrão: lsof no macOS. */
  sweep?: (dirs: string[]) => number;
}

/**
 * A4: mitigação de `setsid`/daemonização: processos do usuário cujo diretório atual está dentro das pastas do job
 * (raiz, config e TMPDIR próprios) são encerrados com SIGKILL. Parcial (um processo pode dar `cd /`); a revogação do
 * nonce por job é o que corta o acesso à API. Devolve quantos foram mortos.
 */
export function sweepSurvivors(dirs: string[], run: typeof spawnSync = spawnSync): number {
  if (process.platform !== 'darwin' || dirs.length === 0) return 0;
  // o lsof mostra caminhos reais (/private/var/...): compara com os dois.
  dirs = [...new Set(dirs.flatMap((d) => { try { return [d, fs.realpathSync(d)]; } catch { return [d]; } }))];
  const r = run('/usr/sbin/lsof', ['-nP', '-w', '-a', '-u', String(process.getuid?.() ?? ''), '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 5000 });
  if (typeof r.stdout !== 'string') return 0;
  const inside = (p: string) => dirs.some((d) => p === d || p.startsWith(d.endsWith(path.sep) ? d : d + path.sep));
  let pid = 0;
  let n = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('p')) pid = parseInt(line.slice(1), 10);
    else if (line.startsWith('n') && pid > 1 && pid !== process.pid && inside(line.slice(1))) {
      try {
        process.kill(pid, 'SIGKILL');
        n++;
      } catch {
        /* já morreu */
      }
      pid = 0;
    }
  }
  return n;
}

/** A3: modo escrita só com raiz de escrita válida, separada da de leitura e com config limpa. */
export function writeRootReadiness(d: IsolationDeps, readRoot: string): RootResolution {
  if (!d.resolveWriteRoot) return { ok: false, reason: 'falta a raiz de escrita ("writeRoots")' };
  if (!d.writePaths) return { ok: false, reason: 'faltam as pastas próprias do modo escrita' };
  if ([d.writePaths.configDir, d.writePaths.tmpDir].some((w) => [d.paths.configDir, d.paths.tmpDir].some((p) => rootsOverlap(p, w)))) {
    return { ok: false, reason: 'as pastas próprias do modo escrita coincidem com as do modo leitura' };
  }
  const w = d.resolveWriteRoot();
  if (!w.ok) return w;
  if (rootsOverlap(readRoot, w.root)) return { ok: false, reason: 'a raiz de escrita coincide com a de leitura' };
  const taint = claudeConfigTaint(w.root, d.writePaths.configDir);
  if (taint) return { ok: false, reason: `configuração do Claude insegura: ${taint}` };
  return w;
}

export type IsolationReadiness = { ready: true; root: string; bin: string } | { ready: false; reason: string };

/** Sem binário, raiz limpa, sandbox-exec e prova de isolamento, nenhum modo (leitura ou escrita) roda. */
export function isolationReadiness(d: IsolationDeps): IsolationReadiness {
  const bin = d.claudeBin();
  if (!bin) return { ready: false, reason: 'o binário "claude" não foi encontrado' };
  const r = d.resolveRoot();
  if (!r.ok) return { ready: false, reason: r.reason };
  const taint = claudeConfigTaint(r.root, d.paths.configDir);
  if (taint) return { ready: false, reason: `configuração do Claude insegura: ${taint}` };
  if (!d.exists(SANDBOX_EXEC)) return { ready: false, reason: 'o isolamento do macOS (sandbox-exec) não está disponível' };
  if (!d.selftestOk(r.root, bin)) return { ready: false, reason: 'falta a prova de isolamento (rode scripts/claude-code-selftest.mjs)' };
  return { ready: true, root: r.root, bin };
}

/** Prova de isolamento: gravada pelo scripts/claude-code-selftest.mjs só depois de um teste real passar. */
export interface SelftestMarker {
  profileVersion: number;
  root: string;
  claudeBin: string;
  /** sha256 dos perfis de leitura e escrita provados (M3). */
  profileHash: string;
  passedAt: string;
}

export const SELFTEST_MARKER_FILE = path.join('.runtime', 'claude-code-selftest.json');

export function selftestMatches(raw: string | null, expect: { root: string; claudeBin: string; profileHash: string }): boolean {
  if (raw === null) return false;
  try {
    const m = JSON.parse(raw) as Partial<SelftestMarker>;
    return m.profileVersion === SANDBOX_PROFILE_VERSION && m.root === expect.root && m.claudeBin === expect.claudeBin && m.profileHash === expect.profileHash && typeof m.passedAt === 'string';
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
  store: JsonStore<ClaudeJob>;
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
   * Isolamento do macOS: OBRIGATÓRIO (A3 do Code). Sem /usr/bin/sandbox-exec, raiz limpa e prova de isolamento a tarefa não roda,
   * e não existe caminho sem isolamento: nem em produção, nem nos testes (que injetam um `spawnFn` falso).
   */
  isolation: IsolationDeps;
}

/** N2: carrega o token dedicado; ausente ou inseguro => null (o motivo vai ao console sem o valor). */
export function defaultOAuthToken(home: string): string | null {
  const r = loadClaudeOAuthToken(home);
  if (r.ok) return r.token;
  console.warn(`[claude] ${r.reason}`);
  return null;
}

/** A3: proxy compartilhado do pai; null se não houver token ou se o proxy ainda não estiver escutando. */
export function defaultProxyAuth(home: string, mode: ProxyMode = 'leitura'): ProxyAuth | null {
  return sharedClaudeProxy(() => defaultOAuthToken(home))?.issue(mode) ?? null;
}

/** A4: aquece o proxy (sem emitir nonce). */
export function warmClaudeProxy(home: string): void {
  sharedClaudeProxy(() => defaultOAuthToken(home));
}

type FinishExtra = { exitCode?: number | null; result?: string; error?: string };

export type StartResult = { ok: true; id: string } | { ok: false; error: string };

export class ClaudeCodeRunner {
  private readonly spawnFn: SpawnFn;
  private readonly timeoutMs: number;
  /** M1 do Code: `done` é o ÚNICO caminho de término do job (close, error, timeout, cancel, shutdown); idempotente por job. */
  private current: { job: ClaudeJob; child: ChildProcess; timer: NodeJS.Timeout; done: (status: ClaudeJobStatus, extra: FinishExtra, notify?: boolean) => void } | null = null;

  constructor(private readonly opts: ClaudeRunnerOptions) {
    this.spawnFn = opts.spawnFn ?? ((c, a, o) => nodeSpawn(c, [...a], o));
    this.timeoutMs = opts.timeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Pronto = há binário e há raiz válida. (O mestre/canal de privacidade é checado por quem constrói a ferramenta.) */
  readiness(): IsolationReadiness {
    return isolationReadiness(this.opts.isolation);
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
    // B1 do Code: o binário e a raiz do spawn são EXATAMENTE os que a prova de isolamento conferiu (uma única leitura).
    const bin = ready.bin;
    const rootRes = { ok: true as const, root: ready.root };

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

    const auth = (this.opts.isolation.proxyAuth ?? defaultProxyAuth)(this.opts.isolation.home, 'leitura');
    if (!auth) {
      this.finish(job, 'failed', { error: 'O proxy do Claude não está pronto (token dedicado ausente ou porta ocupada). Tente de novo em instantes.' });
      return { ok: true, id: job.id };
    }

    let child: ChildProcess;
    try {
      const iso = this.opts.isolation;
      ensureSandboxDirs(iso.paths);
      const cmd = wrapSandbox(bin, buildClaudeArgv(), rootRes.root, iso.home, { paths: iso.paths, proxyPort: auth.port });
      child = this.spawnFn(cmd.command, cmd.args, {
        cwd: rootRes.root,
        env: claudeChildEnv((this.opts.parentEnv ?? (() => process.env))(), iso.paths, auth),
        stdio: [...CLAUDE_CHILD_STDIO],
        detached: true,
        shell: false
      });
    } catch (err) {
      auth.revoke();
      this.finish(job, 'failed', { error: `Não consegui iniciar o Claude (${err instanceof Error ? err.name : 'erro'}).` });
      return { ok: true, id: job.id };
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (status: ClaudeJobStatus, extra: FinishExtra, notify = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // P2: o nonce deste job morre com ele; sobreviventes (setsid) perdem a API e são varridos.
      auth.revoke();
      this.killGroup(child);
      const iso = this.opts.isolation;
      try {
        (iso.sweep ?? sweepSurvivors)([rootRes.root, iso.paths.configDir, iso.paths.tmpDir]);
      } catch {
        /* varredura é melhor esforço */
      }
      // M1: só libera o slot se ele ainda for DESTE job (nunca zera um job iniciado depois).
      if (this.current?.job === job) this.current = null;
      this.finish(job, status, extra, notify);
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

    this.current = { job, child, timer, done };
    try {
      if (!passNonceFd(child, auth)) {
        this.killGroup(child);
        done('failed', { error: 'Não consegui entregar a credencial do job ao Claude.' });
        return { ok: true, id: job.id };
      }
      child.stdin?.on('error', () => {});
      child.stdin?.end(order);
    } catch {
      /* o close/error acima resolve o job */
    }
    return { ok: true, id: job.id };
  }

  cancel(): boolean {
    if (!this.current) return false;
    const { child, done } = this.current;
    this.killGroup(child);
    done('cancelled', { error: 'Cancelada.' });
    return true;
  }

  shutdown(): void {
    if (this.current) {
      const { child, done } = this.current;
      this.killGroup(child);
      done('interrupted', { error: 'O app foi encerrado durante a execução.' }, false);
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

  private finish(job: ClaudeJob, status: ClaudeJobStatus, extra: FinishExtra, notify = true): void {
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
