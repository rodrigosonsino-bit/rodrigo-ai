import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import type { IntentName } from '../../shared/voiceProtocol.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';
import { guardText } from '../privacy/outboundGuard.js';
import type { DynamicVoiceProvider } from '../voice/ttsProviders.js';
import {
  DefaultMacAccessibilityAdapter,
  type AccessibilityAdapter,
  type AccessibilityInsertMode,
  type FocusedTargetSnapshot
} from './macosAccessibility.js';

const execFileAsync = promisify(execFile);

export class ToolPreviewRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPreviewRefusedError';
  }
}

export interface AllowedAppSpec {
  readonly canonicalName: string;
  readonly bundleId: string;
  readonly aliases: readonly string[];
  readonly appPath?: string;
}

export const ALLOWLIST_APPS: readonly AllowedAppSpec[] = [
  { canonicalName: 'Safari', bundleId: 'com.apple.Safari', aliases: ['safari', 'navegador safari'] },
  { canonicalName: 'Google Chrome', bundleId: 'com.google.Chrome', aliases: ['google chrome', 'chrome'] },
  { canonicalName: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', aliases: ['slack'] },
  { canonicalName: 'Spotify', bundleId: 'com.spotify.client', aliases: ['spotify'] },
  { canonicalName: 'TextEdit', bundleId: 'com.apple.TextEdit', aliases: ['textedit', 'editor de texto'] },
  { canonicalName: 'WhatsApp', bundleId: 'net.whatsapp.WhatsApp', aliases: ['whatsapp', 'whats', 'zap'] },
  { canonicalName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', aliases: ['cursor'] },
  { canonicalName: 'Music', bundleId: 'com.apple.Music', aliases: ['music', 'musica', 'música', 'apple music'] },
  { canonicalName: 'Notes', bundleId: 'com.apple.Notes', aliases: ['notes', 'notas', 'bloco de notas', 'bloco de notas da apple'] },
  { canonicalName: 'Finder', bundleId: 'com.apple.finder', aliases: ['finder', 'arquivos'] },
  {
    canonicalName: 'DitadoLocal',
    bundleId: 'br.com.rodrigo.ditadolocal',
    aliases: ['ditadolocal', 'ditado local', 'texto em voz', 'ditado em voz'],
    appPath: path.join(os.homedir(), 'Applications', 'DitadoLocal.app')
  },
  {
    canonicalName: 'System Settings',
    bundleId: 'com.apple.systempreferences',
    aliases: ['system settings', 'ajustes do sistema', 'ajustes', 'preferencias do sistema', 'preferências do sistema']
  }
] as const;

export const DENIED_TYPING_BUNDLE_IDS: readonly string[] = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'com.microsoft.VSCode',
  'com.apple.dt.Xcode',
  'local.rodrigo-ai.desktop'
] as const;

export const CANONICAL_FOLDERS: Readonly<Record<string, string>> = {
  downloads: path.join(os.homedir(), 'Downloads'),
  download: path.join(os.homedir(), 'Downloads'),
  documentos: path.join(os.homedir(), 'Documents'),
  documents: path.join(os.homedir(), 'Documents'),
  desktop: path.join(os.homedir(), 'Desktop'),
  'area de trabalho': path.join(os.homedir(), 'Desktop'),
  'área de trabalho': path.join(os.homedir(), 'Desktop'),
  developer: path.join(os.homedir(), 'Developer'),
  projetos: path.join(os.homedir(), 'Developer')
};

/**
 * Kill-switch fail-closed: aceita apenas "0" ou "1" (ou vazio/ausente = true).
 * Qualquer outro valor lança erro de configuração.
 */
export function parseDesktopControlFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RODRIGO_DESKTOP_CONTROL;
  if (raw === undefined || raw.trim() === '') return true;
  const v = raw.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  throw new Error(`Configuração inválida: RODRIGO_DESKTOP_CONTROL deve ser exatamente "0" ou "1". Valor recebido: "${raw}"`);
}

export function resolveAllowedApp(rawName: string): AllowedAppSpec | null {
  const norm = rawName.trim().toLowerCase();
  if (!norm) return null;
  for (const spec of ALLOWLIST_APPS) {
    if (
      spec.canonicalName.toLowerCase() === norm ||
      spec.bundleId.toLowerCase() === norm ||
      spec.aliases.some((a) => a.toLowerCase() === norm)
    ) {
      return spec;
    }
  }
  return null;
}

export function sanitizeTypingText(raw: string): string {
  return raw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTccError(err: unknown, targetLabel: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('-1743') || /Not authorized to send Apple events/i.test(msg)) {
    return `Não tenho permissão de Automação para controlar ${targetLabel}. Ative em Ajustes do Sistema, Privacidade e Segurança, Automação.`;
  }
  if (msg.includes('-25211') || msg.includes('-1719') || /assistive access|acessibilidade/i.test(msg)) {
    return `Não tenho permissão de Acessibilidade para controlar ${targetLabel}. Ative em Ajustes do Sistema, Privacidade e Segurança, Acessibilidade.`;
  }
  return `Não consegui executar a ação em ${targetLabel} agora.`;
}

export interface CommandExecResult {
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (
  file: string,
  args: readonly string[],
  options?: { cwd?: string; timeout?: number; input?: string; env?: NodeJS.ProcessEnv }
) => Promise<CommandExecResult>;

export const defaultCommandExecutor: CommandExecutor = async (file, args, options = {}) => {
  if (options.input !== undefined) {
    return new Promise<CommandExecResult>((resolve, reject) => {
      const proc = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const timer = options.timeout
        ? setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error(`Timeout executando ${file}`));
          }, options.timeout)
        : null;
      proc.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`Comando ${file} saiu com código ${code}: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
      proc.stdin.write(options.input);
      proc.stdin.end();
    });
  }
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    cwd: options.cwd,
    timeout: options.timeout ?? 10_000,
    env: options.env ?? process.env
  });
  return { stdout: String(stdout), stderr: String(stderr) };
};

export interface DesktopToolDeps {
  exec?: CommandExecutor;
  env?: NodeJS.ProcessEnv;
  schedulePostSpeechAction?: (action: () => Promise<void>) => void;
}

const CG_SESSION_BIN =
  '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession';

/**
 * Pilar 1 — Controle nativo do Desktop macOS (`DESKTOP_COMANDO` e `DESKTOP_CRITICO`).
 * Nome 'DESKTOP' casa com `selectMutatingToolByAction` para o prefixo `DESKTOP_*`.
 */
export class DesktopTool implements IMutatingTool {
  readonly name = 'DESKTOP';
  readonly description = 'Controle nativo de volume, mídia, aplicativos, janelas e energia do macOS.';
  private readonly exec: CommandExecutor;
  private readonly env: NodeJS.ProcessEnv;
  private schedulePostSpeechAction?: (action: () => Promise<void>) => void;

  constructor(deps: DesktopToolDeps = {}) {
    this.exec = deps.exec ?? defaultCommandExecutor;
    this.env = deps.env ?? process.env;
    this.schedulePostSpeechAction = deps.schedulePostSpeechAction;
  }

  setPostSpeechScheduler(fn: (action: () => Promise<void>) => void): void {
    this.schedulePostSpeechAction = fn;
  }

  isAvailable(): boolean {
    try {
      return parseDesktopControlFlag(this.env);
    } catch {
      return false;
    }
  }

  preview(kind: IntentName, content: string | null): string {
    if (!this.isAvailable()) {
      throw new ToolPreviewRefusedError('O controle do desktop está desativado pela configuração de privacidade.');
    }
    if (kind !== 'DESKTOP_CRITICO') {
      throw new Error(`Preview não suportado para ${kind}`);
    }
    const raw = (content ?? '').trim();
    if (!raw) {
      throw new ToolPreviewRefusedError('Não entendi qual ação crítica do sistema você quer executar.');
    }
    const [sub, ...rest] = raw.split(':');
    const action = sub.trim().toLowerCase();
    const target = rest.join(':').trim();

    if (action === 'fechar' || action === 'app_quit' || action === 'quit') {
      const spec = resolveAllowedApp(target);
      if (!spec) {
        throw new ToolPreviewRefusedError(`Por segurança, o aplicativo ${target || 'solicitado'} não está na lista autorizada para encerramento.`);
      }
      return `Vou fechar o aplicativo ${spec.canonicalName}. Pode confirmar?`;
    }
    if (action === 'lixeira' || action === 'empty_trash') {
      return 'Vou esvaziar a lixeira do Finder permanentemente. Pode confirmar?';
    }
    if (action === 'bloquear' || action === 'lock_screen') {
      return 'Vou bloquear a tela do seu Mac. Pode confirmar?';
    }
    if (action === 'repouso' || action === 'system_sleep' || action === 'dormir') {
      return 'Vou colocar o seu Mac em repouso. Pode confirmar?';
    }
    throw new ToolPreviewRefusedError('Essa ação crítica de desktop não é reconhecida.');
  }

  async execute(kind: IntentName, content: string | null): Promise<string> {
    if (!this.isAvailable()) {
      return 'O controle do desktop está desativado pela configuração de privacidade.';
    }
    const raw = (content ?? '').trim();
    if (!raw) {
      return 'Não recebi os detalhes do comando do computador.';
    }
    const [sub, ...rest] = raw.split(':');
    const action = sub.trim().toLowerCase();
    const param = rest.join(':').trim();

    if (kind === 'DESKTOP_COMANDO') {
      return this.executeImmediate(action, param);
    }
    if (kind === 'DESKTOP_CRITICO') {
      return this.executeCritical(action, param);
    }
    throw new Error(`Ação inválida para DesktopTool: ${kind}`);
  }

  private async executeImmediate(action: string, param: string): Promise<string> {
    // 1. Volume
    if (action === 'volume' || action === 'volume_set') {
      const parsed = Number.parseInt(param, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return 'Por favor, informe um nível de volume entre zero e cem por cento.';
      }
      try {
        if (parsed === 0) {
          await this.exec('/usr/bin/osascript', [
            '-e',
            'on run argv\n  set v to (item 1 of argv) as integer\n  set volume output volume v with output muted\nend run',
            '--',
            '0'
          ]);
          return 'Volume ajustado para zero e silenciado.';
        }
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set v to (item 1 of argv) as integer\n  set volume output volume v without output muted\nend run',
          '--',
          String(parsed)
        ]);
        return `Volume ajustado para ${parsed} por cento.`;
      } catch (err) {
        return formatTccError(err, 'o volume do sistema');
      }
    }

    if (action === 'volume_up' || action === 'aumentar_volume') {
      try {
        const cur = await this.getCurrentVolume();
        const next = Math.min(100, cur + 15);
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set v to (item 1 of argv) as integer\n  set volume output volume v without output muted\nend run',
          '--',
          String(next)
        ]);
        return `Volume aumentado para ${next} por cento.`;
      } catch (err) {
        return formatTccError(err, 'o volume do sistema');
      }
    }

    if (action === 'volume_down' || action === 'baixar_volume' || action === 'diminuir_volume') {
      try {
        const cur = await this.getCurrentVolume();
        // A10: piso mínimo de 10% + without output muted para não silenciar o assistente por acidente.
        const next = Math.max(10, cur - 15);
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set v to (item 1 of argv) as integer\n  set volume output volume v without output muted\nend run',
          '--',
          String(next)
        ]);
        return `Volume reduzido para ${next} por cento.`;
      } catch (err) {
        return formatTccError(err, 'o volume do sistema');
      }
    }

    if (action === 'mute' || action === 'volume_mute' || action === 'mudo' || action === 'silenciar') {
      try {
        await this.exec('/usr/bin/osascript', ['-e', 'set volume with output muted']);
        return 'Áudio do sistema silenciado.';
      } catch (err) {
        return formatTccError(err, 'o áudio do sistema');
      }
    }

    if (action === 'unmute' || action === 'volume_unmute' || action === 'desmutar' || action === 'ativar_som') {
      try {
        await this.exec('/usr/bin/osascript', ['-e', 'set volume without output muted']);
        return 'Áudio do sistema reativado.';
      } catch (err) {
        return formatTccError(err, 'o áudio do sistema');
      }
    }

    // 2. Mídia (Spotify / Music)
    if (
      action === 'midia' ||
      action === 'media_play_pause' ||
      action === 'media_next' ||
      action === 'media_prev'
    ) {
      const subCmd =
        action === 'media_play_pause'
          ? 'playpause'
          : action === 'media_next'
            ? 'next track'
            : action === 'media_prev'
              ? 'previous track'
              : param === 'proxima' || param === 'next'
                ? 'next track'
                : param === 'anterior' || param === 'prev'
                  ? 'previous track'
                  : 'playpause';
      const targetApp = param.toLowerCase().includes('music') ? 'com.apple.Music' : 'com.spotify.client';
      const targetLabel = targetApp === 'com.apple.Music' ? 'o Apple Music' : 'o Spotify';
      try {
        await this.exec('/usr/bin/osascript', [
          '-e',
          `on run argv\n  set bId to item 1 of argv\n  tell application id bId to ${subCmd}\nend run`,
          '--',
          targetApp
        ]);
        return subCmd === 'next track'
          ? 'Passei para a próxima faixa.'
          : subCmd === 'previous track'
            ? 'Voltei para a faixa anterior.'
            : 'Reprodução de mídia alternada.';
      } catch (err) {
        return formatTccError(err, targetLabel);
      }
    }

    // 3. Abrir aplicativo da allowlist
    if (action === 'abrir' || action === 'app_open' || action === 'open_app') {
      const spec = resolveAllowedApp(param);
      if (!spec) {
        return `Por segurança, o aplicativo ${param || 'solicitado'} não está na lista de aplicativos permitidos.`;
      }
      try {
        if (spec.appPath) {
          await this.exec('/usr/bin/open', ['-a', spec.appPath]);
        } else {
          await this.exec('/usr/bin/open', ['-b', spec.bundleId]);
        }
        return `Abrindo ${spec.canonicalName}.`;
      } catch (err) {
        return formatTccError(err, spec.canonicalName);
      }
    }

    // 4. Modo escuro / claro
    if (action === 'modo' || action === 'dark_mode' || action === 'dark_mode_on' || action === 'dark_mode_off') {
      const dark = action === 'dark_mode_on' || param.toLowerCase() === 'escuro' || param.toLowerCase() === 'on';
      try {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set isDark to (item 1 of argv) is "true"\n  tell application id "com.apple.systemevents" to tell appearance preferences to set dark mode to isDark\nend run',
          '--',
          dark ? 'true' : 'false'
        ]);
        return dark ? 'Modo escuro ativado.' : 'Modo claro ativado.';
      } catch (err) {
        return formatTccError(err, 'os Eventos do Sistema');
      }
    }

    // 5. Minimizar janela ativa
    if (action === 'minimizar' || action === 'window_minimize') {
      try {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'tell application id "com.apple.systemevents" to set miniaturized of front window of (first application process whose frontmost is true) to true'
        ]);
        return 'Janela minimizada.';
      } catch (err) {
        return formatTccError(err, 'a janela atual');
      }
    }

    // 6. Abrir pasta canônica
    if (action === 'pasta' || action === 'folder_open' || action === 'open_folder') {
      const folderPath = CANONICAL_FOLDERS[param.trim().toLowerCase()];
      if (!folderPath) {
        return `A pasta ${param || 'solicitada'} não está na lista de pastas rápidas permitidas.`;
      }
      try {
        await this.exec('/usr/bin/open', [folderPath]);
        return `Abrindo a pasta ${param}.`;
      } catch (err) {
        return formatTccError(err, `a pasta ${param}`);
      }
    }

    return 'Não reconheci esse comando de desktop.';
  }

  private async executeCritical(action: string, param: string): Promise<string> {
    if (action === 'fechar' || action === 'app_quit' || action === 'quit') {
      const spec = resolveAllowedApp(param);
      if (!spec) {
        return `Por segurança, o aplicativo ${param || 'solicitado'} não está na lista permitida para encerramento.`;
      }
      try {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set bId to item 1 of argv\n  tell application id bId to quit saving ask\nend run',
          '--',
          spec.bundleId
        ]);
        return `Fechei o aplicativo ${spec.canonicalName}.`;
      } catch (err) {
        return formatTccError(err, spec.canonicalName);
      }
    }

    if (action === 'lixeira' || action === 'empty_trash') {
      try {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'tell application id "com.apple.finder" to empty trash'
        ]);
        return 'Lixeira esvaziada.';
      } catch (err) {
        return formatTccError(err, 'o Finder');
      }
    }

    if (action === 'bloquear' || action === 'lock_screen') {
      const runLock = async (): Promise<void> => {
        await this.exec(CG_SESSION_BIN, ['-suspend']);
      };
      if (this.schedulePostSpeechAction) {
        this.schedulePostSpeechAction(runLock);
      } else {
        await runLock();
      }
      return 'Bloqueando a tela.';
    }

    if (action === 'repouso' || action === 'system_sleep' || action === 'dormir') {
      const runSleep = async (): Promise<void> => {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'tell application id "com.apple.systemevents" to sleep'
        ]);
      };
      if (this.schedulePostSpeechAction) {
        this.schedulePostSpeechAction(runSleep);
      } else {
        await runSleep();
      }
      return 'Colocando o Mac em repouso.';
    }

    throw new Error(`Ação crítica desconhecida: ${action}`);
  }

  private async getCurrentVolume(): Promise<number> {
    try {
      const { stdout } = await this.exec('/usr/bin/osascript', [
        '-e',
        'output volume of (get volume settings)'
      ]);
      const v = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(v) ? v : 50;
    } catch {
      return 50;
    }
  }
}

export interface FrontmostAppInfo {
  bundleId: string;
  name: string;
}

export interface ClipboardAdapter {
  getSnapshot(): Promise<{ text: string; changeCount: number }>;
  setText(text: string): Promise<{ changeCount: number }>;
  getChangeCount(): Promise<number>;
}

class DefaultMacClipboardAdapter implements ClipboardAdapter {
  private syntheticChangeCount = 0;

  constructor(private readonly exec: CommandExecutor) {}

  async getSnapshot(): Promise<{ text: string; changeCount: number }> {
    const { stdout } = await this.exec('/usr/bin/pbpaste', []);
    return { text: stdout, changeCount: this.syntheticChangeCount };
  }

  async setText(text: string): Promise<{ changeCount: number }> {
    await this.exec('/usr/bin/pbcopy', [], { input: text });
    this.syntheticChangeCount += 1;
    return { changeCount: this.syntheticChangeCount };
  }

  async getChangeCount(): Promise<number> {
    return this.syntheticChangeCount;
  }
}

export interface DigitarToolDeps {
  exec?: CommandExecutor;
  env?: NodeJS.ProcessEnv;
  getFrontmostAppSync?: () => FrontmostAppInfo;
  getFrontmostApp?: () => Promise<FrontmostAppInfo>;
  activateApp?: (bundleId: string) => Promise<void>;
  accessibility?: AccessibilityAdapter;
  clipboard?: ClipboardAdapter;
  pasteRestoreDelayMs?: number;
  transformText?: (mode: 'limpar' | 'traduzir_pt' | 'traduzir', text: string, targetLang?: string) => Promise<string>;
}

function defaultGetFrontmostAppSync(): FrontmostAppInfo {
  const out = execFileSync(
    '/usr/bin/osascript',
    [
      '-e',
      'tell application id "com.apple.systemevents"\n  set p to first application process whose frontmost is true\n  return (bundle identifier of p) & "|" & (name of p)\nend tell'
    ],
    { encoding: 'utf-8', timeout: 3_000 }
  ).trim();
  const [bundleId, ...rest] = out.split('|');
  return { bundleId: bundleId.trim(), name: rest.join('|').trim() || bundleId.trim() };
}

type DigitarIntentKind =
  | 'DIGITAR_TEXTO'
  | 'DIGITAR_INSERIR'
  | 'DIGITAR_SUBSTITUIR_SELECAO'
  | 'DIGITAR_ANEXAR'
  | 'DIGITAR_LIMPAR_INSERIR'
  | 'DIGITAR_TRADUZIR_INSERIR';

interface ShortcutRequest {
  type: 'shortcut';
  shortcut: string;
}

interface TextRequest {
  type: 'text';
  mode: AccessibilityInsertMode;
  text: string;
  transform?: 'clean' | 'translate';
  targetLang?: string;
}

type DigitarRequest = ShortcutRequest | TextRequest;

function isDigitarIntentKind(kind: IntentName): kind is DigitarIntentKind {
  return (
    kind === 'DIGITAR_TEXTO' ||
    kind === 'DIGITAR_INSERIR' ||
    kind === 'DIGITAR_SUBSTITUIR_SELECAO' ||
    kind === 'DIGITAR_ANEXAR' ||
    kind === 'DIGITAR_LIMPAR_INSERIR' ||
    kind === 'DIGITAR_TRADUZIR_INSERIR'
  );
}

function parseTranslateInsertContent(raw: string): { text: string; targetLang: string } {
  const trimmed = raw.trim();
  const sep = trimmed.indexOf(':');
  if (sep > 0 && sep <= 24) {
    const maybeLang = trimmed.slice(0, sep).trim();
    const maybeText = sanitizeTypingText(trimmed.slice(sep + 1));
    if (maybeLang && maybeText) {
      return { text: maybeText, targetLang: maybeLang };
    }
  }
  return { text: sanitizeTypingText(trimmed), targetLang: 'português' };
}

function parseDigitarRequest(kind: DigitarIntentKind, raw: string): DigitarRequest {
  if (kind === 'DIGITAR_TEXTO' && raw.toLowerCase().startsWith('atalho:')) {
    return { type: 'shortcut', shortcut: raw.slice('atalho:'.length).trim().toLowerCase() };
  }

  if (kind === 'DIGITAR_TRADUZIR_INSERIR') {
    const translated = parseTranslateInsertContent(raw);
    return {
      type: 'text',
      mode: 'insert',
      text: translated.text,
      transform: 'translate',
      targetLang: translated.targetLang
    };
  }

  const baseText =
    kind === 'DIGITAR_TEXTO' ? raw.replace(/^texto\s*:/i, '') : raw;
  const clean = sanitizeTypingText(baseText);
  if (kind === 'DIGITAR_LIMPAR_INSERIR') {
    return { type: 'text', mode: 'insert', text: clean, transform: 'clean' };
  }
  if (kind === 'DIGITAR_SUBSTITUIR_SELECAO') {
    return { type: 'text', mode: 'replaceSelection', text: clean };
  }
  if (kind === 'DIGITAR_ANEXAR') {
    return { type: 'text', mode: 'append', text: clean };
  }
  return { type: 'text', mode: 'insert', text: clean };
}

function buildDigitarPreview(appName: string, request: DigitarRequest): string {
  if (request.type === 'shortcut') {
    return `Vou acionar o atalho ${request.shortcut} do Ditado Local em ${appName}. Pode confirmar?`;
  }
  if (request.transform === 'clean') {
    return `Vou limpar o ditado e inserir em ${appName}: ${request.text}. Pode confirmar?`;
  }
  if (request.transform === 'translate') {
    return `Vou traduzir para ${request.targetLang ?? 'português'} e inserir em ${appName}: ${request.text}. Pode confirmar?`;
  }
  if (request.mode === 'replaceSelection') {
    return `Vou substituir a seleção em ${appName} por: ${request.text}. Pode confirmar?`;
  }
  if (request.mode === 'append') {
    return `Vou anexar ao campo atual em ${appName}: ${request.text}. Pode confirmar?`;
  }
  return `Vou digitar em ${appName}: ${request.text}. Pode confirmar?`;
}

function buildDigitarSuccess(appName: string, request: TextRequest, strategy: 'ax' | 'paste'): string {
  if (request.transform === 'clean') {
    return strategy === 'ax'
      ? `Pronto, limpei o ditado e inseri o texto em ${appName}.`
      : `Pronto, limpei o ditado e colei o texto em ${appName}.`;
  }
  if (request.transform === 'translate') {
    return strategy === 'ax'
      ? `Pronto, traduzi e inseri o texto em ${appName}.`
      : `Pronto, traduzi e colei o texto em ${appName}.`;
  }
  if (request.mode === 'replaceSelection') {
    return strategy === 'ax'
      ? `Pronto, substituí a seleção em ${appName}.`
      : `Pronto, substituí a seleção em ${appName} colando o texto.`;
  }
  if (request.mode === 'append') {
    return `Pronto, anexei o texto em ${appName}.`;
  }
  return strategy === 'ax'
    ? `Pronto, inseri o texto em ${appName}.`
    : `Pronto, digitei o texto em ${appName}.`;
}

/** Erro de leitura AX por falta de permissão/helper (não por alvo inseguro): vale o fallback via paste. */
function isAxUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /AX_BAD|accessibilityDisabled|AXError|apiDisabled|AX_TRUST|not trusted/i.test(msg);
}

function formatAccessibilityFailure(err: unknown, targetLabel: string): string {  const msg = err instanceof Error ? err.message : String(err);
  if (/not editable/i.test(msg)) {
    return `Cancelado por segurança: ${targetLabel} está em foco, mas o elemento atual não é um campo editável.`;
  }
  if (/disabled/i.test(msg)) {
    return `Cancelado por segurança: o campo atual em ${targetLabel} está desativado.`;
  }
  if (/selection required|no selected text/i.test(msg)) {
    return 'Cancelado por segurança: não encontrei texto selecionado para substituir.';
  }
  if (/selection unavailable|AXSelectedTextRange/i.test(msg)) {
    return `Não consegui inserir direto no campo atual de ${targetLabel}.`;
  }
  if (/AXValue|value unavailable/i.test(msg)) {
    return `Não consegui ler o conteúdo do campo atual em ${targetLabel}.`;
  }
  return formatTccError(err, targetLabel);
}

/**
 * Pilar 2 — Digitação segura no aplicativo em primeiro plano (`DIGITAR_TEXTO`) +
 * acionamento confirmado de atalhos do DitadoLocal.
 * Nome 'DIGITAR' casa com `selectMutatingToolByAction` para `DIGITAR_TEXTO`.
 */
export class DigitarTool implements IMutatingTool {
  readonly name = 'DIGITAR';
  readonly description = 'Digita texto ou dispara atalho do DitadoLocal no aplicativo focado após confirmação.';
  private readonly exec: CommandExecutor;
  private readonly env: NodeJS.ProcessEnv;
  private readonly getFrontmostAppSync: () => FrontmostAppInfo;
  private readonly getFrontmostApp: () => Promise<FrontmostAppInfo>;
  private readonly activateApp: (bundleId: string) => Promise<void>;
  private readonly accessibility: AccessibilityAdapter;
  private readonly clipboard: ClipboardAdapter;
  private readonly pasteRestoreDelayMs: number;
  private readonly transformText?: (mode: 'limpar' | 'traduzir_pt' | 'traduzir', text: string, targetLang?: string) => Promise<string>;
  private armedTarget: { bundleId: string; appName: string; request: DigitarRequest } | null = null;

  constructor(deps: DigitarToolDeps = {}) {
    this.exec = deps.exec ?? defaultCommandExecutor;
    this.env = deps.env ?? process.env;
    this.getFrontmostAppSync = deps.getFrontmostAppSync ?? defaultGetFrontmostAppSync;
    this.getFrontmostApp =
      deps.getFrontmostApp ?? (async () => this.getFrontmostAppSync());
    this.activateApp =
      deps.activateApp ??
      (async (bundleId: string) => {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set bId to item 1 of argv\n  tell application id bId to activate\nend run',
          '--',
          bundleId
        ]);
      });
    this.accessibility = deps.accessibility ?? new DefaultMacAccessibilityAdapter(this.exec);
    this.clipboard = deps.clipboard ?? new DefaultMacClipboardAdapter(this.exec);
    this.pasteRestoreDelayMs = deps.pasteRestoreDelayMs ?? 500;
    this.transformText = deps.transformText;
  }

  isAvailable(): boolean {
    try {
      return parseDesktopControlFlag(this.env);
    } catch {
      return false;
    }
  }

  preview(kind: IntentName, content: string | null): string {
    if (!isDigitarIntentKind(kind)) {
      throw new Error(`Preview não suportado para ${kind}`);
    }
    const raw = (content ?? '').trim();
    if (!raw) {
      throw new ToolPreviewRefusedError('Não entendi o que você quer digitar.');
    }

    let front: FrontmostAppInfo;
    try {
      front = this.getFrontmostAppSync();
    } catch (err) {
      throw new ToolPreviewRefusedError(formatTccError(err, 'o aplicativo em primeiro plano'));
    }

    if (DENIED_TYPING_BUNDLE_IDS.includes(front.bundleId)) {
      this.armedTarget = null;
      throw new ToolPreviewRefusedError(
        `Por segurança, não posso digitar nem injetar atalhos em ${front.name} (${front.bundleId}).`
      );
    }

    const request = parseDigitarRequest(kind, raw);
    if (request.type === 'text' && !request.text) {
      throw new ToolPreviewRefusedError('O texto para digitar ficou vazio após remover caracteres de controle.');
    }
    this.armedTarget = { bundleId: front.bundleId, appName: front.name, request };
    return buildDigitarPreview(front.name, request);
  }

  async execute(kind: IntentName, content: string | null): Promise<string> {
    if (!isDigitarIntentKind(kind)) {
      throw new Error(`Ação inválida para DigitarTool: ${kind}`);
    }
    if (!this.isAvailable()) {
      return 'A digitação no desktop está desativada pela configuração de privacidade.';
    }

    const armed = this.armedTarget;
    this.armedTarget = null;

    let currentFront: FrontmostAppInfo;
    try {
      currentFront = await this.getFrontmostApp();
    } catch (err) {
      return formatTccError(err, 'o aplicativo em primeiro plano');
    }

    if (DENIED_TYPING_BUNDLE_IDS.includes(currentFront.bundleId)) {
      return `Cancelado por segurança: o aplicativo atual (${currentFront.name}) não permite digitação automática.`;
    }
    if (!armed) {
      return 'Cancelado por segurança: o aplicativo em primeiro plano mudou desde o pedido de confirmação.';
    }
    if (currentFront.bundleId !== armed.bundleId) {
      try {
        await this.activateApp(armed.bundleId);
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        currentFront = await this.getFrontmostApp();
      } catch {
        // Se não conseguir reativar, cai no cancelamento seguro logo abaixo.
      }
    }
    if (DENIED_TYPING_BUNDLE_IDS.includes(currentFront.bundleId)) {
      return `Cancelado por segurança: o aplicativo atual (${currentFront.name}) não permite digitação automática.`;
    }
    if (currentFront.bundleId !== armed.bundleId) {
      return 'Cancelado por segurança: o aplicativo em primeiro plano mudou desde o pedido de confirmação.';
    }

    const request = armed.request;
    if (request.type === 'shortcut') {
      const shortcut = request.shortcut;
      const keyChar =
        shortcut === 'ditar'
          ? 'f'
          : shortcut === 'perguntar'
            ? 'a'
            : shortcut === 'traduzir_selecao'
              ? 't'
              : shortcut === 'ditar_traduzir'
                ? 's'
                : null;
      if (!keyChar) {
        return `Atalho do Ditado Local desconhecido: ${shortcut}.`;
      }
      try {
        await this.exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n  set k to item 1 of argv\n  tell application id "com.apple.systemevents" to keystroke k using {command down, option down}\nend run',
          '--',
          keyChar
        ]);
        return `Acionei o Ditado Local (${shortcut}) em ${currentFront.name}.`;
      } catch (err) {
        return formatTccError(err, 'o Ditado Local');
      }
    }

    const resolvedText = await this.resolveTextRequest(request);
    if (resolvedText.error) {
      return resolvedText.error;
    }
    if (!resolvedText.text) {
      return 'Não havia texto válido para digitar.';
    }

    let focusedTarget: FocusedTargetSnapshot | null = null;
    let axUnavailable = false;
    try {
      focusedTarget = await this.accessibility.inspectFocusedTarget();
    } catch (err) {
      // Sem permissão de Acessibilidade (AXError -25204) ou helper ausente: a leitura
      // fina do campo é impossível, mas a colagem via System Events (Cmd+V) NÃO exige
      // essa permissão. Inserção simples cai para o paste; modos que dependem de ler o
      // campo (anexar/substituir seleção) continuam recusados abaixo.
      if (isAxUnavailableError(err)) {
        axUnavailable = true;
      } else {
        return formatAccessibilityFailure(err, currentFront.name);
      }
    }

    if (focusedTarget) {
      if (focusedTarget.app.bundleId !== armed.bundleId) {
        return 'Cancelado por segurança: o aplicativo em primeiro plano mudou desde o pedido de confirmação.';
      }
      if (!focusedTarget.enabled) {
        return `Cancelado por segurança: o campo atual em ${currentFront.name} está desativado.`;
      }
      if (!focusedTarget.editable) {
        return `Cancelado por segurança: ${currentFront.name} está em foco, mas o elemento atual não é um campo editável.`;
      }
      if (
        request.mode === 'replaceSelection' &&
        !(focusedTarget.selectedText && focusedTarget.selectedText.length > 0) &&
        !(focusedTarget.selectedRange && focusedTarget.selectedRange.length > 0)
      ) {
        return 'Cancelado por segurança: não encontrei texto selecionado para substituir.';
      }
    } else if (request.mode !== 'insert') {
      // Sem leitura AX não há como verificar seleção nem anexar com segurança.
      return `Não consegui verificar o campo atual em ${currentFront.name} (sem permissão de Acessibilidade); só a inserção simples por colagem está disponível.`;
    }

    const preferredAxMode =
      !axUnavailable &&
      focusedTarget &&
      (request.mode === 'append'
        ? focusedTarget.appendSupported
        : focusedTarget.directInsertSupported);
    if (preferredAxMode) {
      try {
        await this.accessibility.insertText(resolvedText.text, request.mode);
        return buildDigitarSuccess(currentFront.name, request, 'ax');
      } catch (err) {
        if (request.mode === 'append') {
          return formatAccessibilityFailure(err, currentFront.name);
        }
        const formatted = formatAccessibilityFailure(err, currentFront.name);
        if (
          /não consegui inserir direto|não consegui ler o conteúdo/i.test(formatted) ||
          /não consegui executar a ação/i.test(formatted)
        ) {
          // Cai para o fallback via paste logo abaixo.
        } else {
          return formatted;
        }
      }
    }

    if (request.mode === 'append') {
      return `Não consegui anexar o texto diretamente em ${currentFront.name}.`;
    }

    try {
      const strategy = await this.pasteText(resolvedText.text);
      if (strategy !== 'paste') {
        return `Não consegui digitar o texto em ${currentFront.name} agora.`;
      }
      return buildDigitarSuccess(currentFront.name, request, 'paste');
    } catch (err) {
      return formatTccError(err, currentFront.name);
    }
  }

  private async resolveTextRequest(request: TextRequest): Promise<{ text: string | null; error?: string }> {
    if (request.transform === 'clean') {
      const cleaned = cleanDictatedTextLocally(request.text);
      return { text: cleaned || null };
    }
    if (request.transform === 'translate') {
      if (!this.transformText) {
        return { text: null, error: 'A tradução local para inserir não está disponível agora.' };
      }
      const mode = request.targetLang?.trim().toLowerCase() === 'português' ? 'traduzir_pt' : 'traduzir';
      const translated = await this.transformText(mode, request.text, request.targetLang);
      return { text: sanitizeTypingText(translated) || null };
    }
    return { text: request.text };
  }

  private async pasteText(text: string): Promise<'paste'> {
    // Mecanismo fiel ao ClipboardPaster.swift do DitadoLocal:
    // 1. Snapshot do clipboard atual
    const previous = await this.clipboard.getSnapshot();
    // 2. Grava o texto e registra ourChangeCount
    const { changeCount: ourChangeCount } = await this.clipboard.setText(text);
    // 3. Dispara Cmd+V sintético com modificador explícito command down
    await this.exec('/usr/bin/osascript', [
      '-e',
      'tell application id "com.apple.systemevents" to keystroke "v" using {command down}'
    ]);
    // 4. Aguarda 500ms e só restaura se changeCount == ourChangeCount
    await new Promise<void>((resolve) => setTimeout(resolve, this.pasteRestoreDelayMs));
    const latestCount = await this.clipboard.getChangeCount();
    if (latestCount === ourChangeCount) {
      await this.clipboard.setText(previous.text);
    }
    return 'paste';
  }
}

export interface DitadoLocalToolDeps {
  env?: NodeJS.ProcessEnv;
  transformText?: (mode: 'limpar' | 'traduzir_pt' | 'traduzir', text: string, targetLang?: string) => Promise<string>;
}

/**
 * Limpeza determinística local + opcionalmente worker local para o Pilar 2 (`DITADO_LOCAL`).
 * IMPORTANTE (Achado da auditoria v3): `DITADO_LOCAL` está em `QUERY_NAMES` (`isMutation: false`),
 * portanto NUNCA injeta teclas (`keystroke`) nem cola no aplicativo focado — apenas processa/traduz
 * o texto e devolve a resposta falada. Para colar ou disparar atalho no app focado, o fluxo é `DIGITAR_TEXTO`.
 */
export function cleanDictatedTextLocally(raw: string): string {
  let cleaned = raw
    .replace(/(?:^|\s+)(?:hã|uhum|éé|tipo assim|né)(?=\s|$|[,.!?])/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (!/[.!?]$/.test(cleaned)) cleaned += '.';
  return cleaned;
}

export class DitadoLocalTool implements IMutatingTool {
  readonly name = 'DITADO';
  readonly description = 'Usa as capacidades de limpeza de texto e tradução do DitadoLocal (100% local, sem injeção de teclado).';
  private readonly env: NodeJS.ProcessEnv;
  private readonly transformText?: (mode: 'limpar' | 'traduzir_pt' | 'traduzir', text: string, targetLang?: string) => Promise<string>;

  constructor(deps: DitadoLocalToolDeps = {}) {
    this.env = deps.env ?? process.env;
    this.transformText = deps.transformText;
  }

  isAvailable(): boolean {
    try {
      return parseDesktopControlFlag(this.env);
    } catch {
      return false;
    }
  }

  preview(_kind: IntentName, _content: string | null): string {
    return 'Processando texto com o Ditado Local.';
  }

  async execute(kind: IntentName, content: string | null): Promise<string> {
    if (kind !== 'DITADO_LOCAL') {
      throw new Error(`Ação inválida para DitadoLocalTool: ${kind}`);
    }
    if (!this.isAvailable()) {
      return 'A integração com o Ditado Local está desativada.';
    }
    const raw = (content ?? '').trim();
    if (!raw) {
      return 'Não recebi o texto para processar no Ditado Local.';
    }

    const [modeRaw, ...rest] = raw.split(':');
    const mode = modeRaw.trim().toLowerCase();
    const payload = rest.join(':').trim();

    if (mode === 'limpar') {
      const target = payload || raw;
      if (this.transformText) {
        const res = await this.transformText('limpar', target);
        return `Texto limpo pelo Ditado Local: ${res}`;
      }
      return `Texto limpo pelo Ditado Local: ${cleanDictatedTextLocally(target)}`;
    }

    if (mode === 'traduzir_pt') {
      const target = payload || raw;
      if (this.transformText) {
        const res = await this.transformText('traduzir_pt', target);
        return `Tradução para português: ${res}`;
      }
      return `Tradução para português preparada: ${cleanDictatedTextLocally(target)}`;
    }

    if (mode === 'traduzir') {
      const [lang, ...textParts] = payload.split(':');
      const targetLang = (lang ?? 'inglês').trim();
      const textToTranslate = textParts.join(':').trim() || payload;
      if (this.transformText) {
        const res = await this.transformText('traduzir', textToTranslate, targetLang);
        return `Tradução para ${targetLang}: ${res}`;
      }
      return `Tradução para ${targetLang} preparada: ${cleanDictatedTextLocally(textToTranslate)}`;
    }

    const fallbackClean = cleanDictatedTextLocally(raw);
    return `Texto revisado pelo Ditado Local: ${fallbackClean}`;
  }
}

/**
 * Pilar 3 — Ferramenta de autoconfiguração de voz (`CONFIGURAR_VOZ`).
 * Nome 'CONFIGURAR' casa com `selectMutatingToolByAction` para `CONFIGURAR_VOZ`.
 */
export class ConfigurarVozTool implements IMutatingTool {
  readonly name = 'CONFIGURAR';
  readonly description = 'Altera autonomamente a voz do assistente respeitando as configurações de privacidade.';

  constructor(private readonly voiceProvider: DynamicVoiceProvider) {}

  isAvailable(): boolean {
    return true;
  }

  preview(_kind: IntentName, content: string | null): string {
    return `Vou mudar minha voz para ${content ?? 'a solicitada'}.`;
  }

  execute(kind: IntentName, content: string | null): string {
    if (kind !== 'CONFIGURAR_VOZ') {
      throw new Error(`Ação inválida para ConfigurarVozTool: ${kind}`);
    }
    const res = this.voiceProvider.switchVoice(content ?? '');
    return res.speech;
  }
}

const AUTO_FIX_ENV_DENY_LIST: readonly string[] = [
  'GEMINI_API_KEY',
  'TYPESAFE_API_KEY',
  'GROK_WEBHOOK_URL',
  'GROK_WEBHOOK_KEY',
  'MIMO_API_KEY'
];

function buildSafeAgentEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (!v) continue;
    if (AUTO_FIX_ENV_DENY_LIST.includes(k)) continue;
    if (k.startsWith('RODRIGO_')) continue;
    child[k] = v;
  }
  return child;
}

export interface AutoCorrecaoToolDeps {
  rootDir: string;
  privacy?: PrivacyConfig;
  exec?: CommandExecutor;
  idGenerator?: () => string;
}

/**
 * Pilar 4 — Auto-correção e melhoria do próprio código em worktree isolada (`AUTO_CORRECAO`).
 * Nome 'AUTO' casa com `selectMutatingToolByAction` para `AUTO_CORRECAO`.
 *
 * Garantias de segurança (v4):
 * - Roda sempre após `SIM` via `delegateToolInTurn(..., isMutation: true)` (`withAudit` + `consumeMutationToken`).
 * - Cria worktree descartável em `.runtime/worktrees/auto-fix-<id>` sem tocar na árvore principal.
 * - Invoca `claude -p` com `--permission-mode acceptEdits --tools Read,Write,Edit,Glob,Grep`
 *   (SEM `Bash` e SEM `bypassPermissions`).
 * - Verifica que nenhum arquivo de teste existente foi deletado e executa `npm run typecheck` e `npm test` via `execFile`.
 */
export class AutoCorrecaoTool implements IMutatingTool {
  readonly name = 'AUTO';
  readonly description = 'Inspeciona e propõe auto-correções do próprio código em uma worktree isolada validada por testes.';
  private readonly rootDir: string;
  private readonly privacy: PrivacyConfig;
  private readonly exec: CommandExecutor;
  private readonly idGenerator: () => string;

  constructor(deps: AutoCorrecaoToolDeps) {
    this.rootDir = deps.rootDir;
    this.privacy = deps.privacy ?? DEFAULT_PRIVACY;
    this.exec = deps.exec ?? defaultCommandExecutor;
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomBytes(4).toString('hex'));
  }

  isAvailable(): boolean {
    return this.privacy.cloud && this.privacy.claudeCode;
  }

  preview(kind: IntentName, content: string | null): string {
    if (kind !== 'AUTO_CORRECAO') {
      throw new Error(`Preview não suportado para ${kind}`);
    }
    if (!this.isAvailable()) {
      throw new ToolPreviewRefusedError('A auto-correção de código está desligada. Ative RODRIGO_CLOUD=1 e RODRIGO_CLAUDE_CODE=1.');
    }
    const clean = (content ?? '').trim();
    if (!clean) {
      throw new ToolPreviewRefusedError('Não entendi qual melhoria ou correção de código você quer que eu faça.');
    }
    const guarded = guardText(clean, this.privacy.outboundGuard);
    if (guarded.blocked || guarded.findings.length > 0) {
      throw new ToolPreviewRefusedError('Pedido bloqueado pela segurança de saída por conter dados sensíveis.');
    }
    return `Vou criar uma branch isolada para implementar e testar: ${guarded.text}. Pode confirmar?`;
  }

  async execute(kind: IntentName, content: string | null): Promise<string> {
    if (kind !== 'AUTO_CORRECAO') {
      throw new Error(`Ação inválida para AutoCorrecaoTool: ${kind}`);
    }
    if (!this.isAvailable()) {
      return 'A auto-correção de código está desligada. Ative RODRIGO_CLOUD=1 e RODRIGO_CLAUDE_CODE=1.';
    }
    const rawPrompt = (content ?? '').trim();
    if (!rawPrompt) {
      return 'Pedido de auto-correção vazio.';
    }

    const guarded = guardText(rawPrompt, this.privacy.outboundGuard);
    if (guarded.blocked || guarded.findings.length > 0) {
      return 'Pedido de auto-correção bloqueado pelo guarda de saída por conter dados sensíveis.';
    }

    const fixId = `auto-fix-${this.idGenerator()}`;
    const branchName = `auto-fix/${fixId}`;
    const worktreePath = path.join(this.rootDir, '.runtime', 'worktrees', fixId);

    const cleanupWorktreeAndBranch = async (): Promise<void> => {
      await this.exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.rootDir }).catch(() => {});
      await this.exec('git', ['branch', '-D', branchName], { cwd: this.rootDir }).catch(() => {});
    };

    try {
      // 1. Cria worktree isolada a partir de HEAD (sem tocar nos arquivos sujos do rootDir)
      await this.exec('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
        cwd: this.rootDir,
        timeout: 30_000
      });

      // 2. Executa o subagente confinado ao worktreePath SEM Bash e SEM bypassPermissions
      const safeEnv = buildSafeAgentEnv();
      const agentArgs = [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'acceptEdits',
        '--tools',
        'Read,Write,Edit,Glob,Grep',
        '--no-session-persistence'
      ];
      await this.exec('claude', agentArgs, {
        cwd: worktreePath,
        env: safeEnv,
        input: guarded.text,
        timeout: 300_000
      });

      // 3. Verifica que nenhum arquivo de teste existente foi deletado
      const { stdout: deletedTests } = await this.exec(
        'git',
        ['diff', '--diff-filter=D', '--name-only', '--', 'src/**/__tests__'],
        { cwd: worktreePath }
      );
      if (deletedTests.trim().length > 0) {
        await cleanupWorktreeAndBranch();
        return 'Auto-correção abortada e revertida: o subagente tentou remover arquivos de teste existentes.';
      }

      // 4. Valida typecheck e suíte de testes determinísticos via execFile
      await this.exec('npm', ['run', 'typecheck'], { cwd: worktreePath, timeout: 120_000 });
      await this.exec('npm', ['test'], { cwd: worktreePath, timeout: 180_000 });

      // 5. Registra o commit na branch isolada e remove o diretório de trabalho temporário
      await this.exec('git', ['add', '-A'], { cwd: worktreePath });
      await this.exec('git', ['commit', '-m', `chore(auto-fix): ${guarded.text.slice(0, 72)}`], {
        cwd: worktreePath
      });
      await this.exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd: this.rootDir });

      return `Auto-correção concluída e validada pelos testes na branch isolada ${branchName}, pronta para sua revisão.`;
    } catch (err) {
      await cleanupWorktreeAndBranch();
      const reason = err instanceof Error ? err.message : String(err);
      return `A auto-correção na branch isolada não passou na validação e foi descartada com segurança (${reason.slice(0, 120)}).`;
    }
  }
}

export interface CreateDesktopAndSelfToolsDeps {
  rootDir: string;
  privacy: PrivacyConfig;
  voiceProvider: DynamicVoiceProvider;
  env?: NodeJS.ProcessEnv;
  schedulePostSpeechAction?: (action: () => Promise<void>) => void;
}

export function createDesktopAndSelfTools(deps: CreateDesktopAndSelfToolsDeps): {
  desktopTool: DesktopTool;
  digitarTool: DigitarTool;
  ditadoLocalTool: DitadoLocalTool;
  configurarVozTool: ConfigurarVozTool;
  autoCorrecaoTool: AutoCorrecaoTool;
  allTools: IMutatingTool[];
} {
  const desktopTool = new DesktopTool({
    env: deps.env,
    schedulePostSpeechAction: deps.schedulePostSpeechAction
  });
  const digitarTool = new DigitarTool({ env: deps.env });
  const ditadoLocalTool = new DitadoLocalTool({ env: deps.env });
  const configurarVozTool = new ConfigurarVozTool(deps.voiceProvider);
  const autoCorrecaoTool = new AutoCorrecaoTool({
    rootDir: deps.rootDir,
    privacy: deps.privacy
  });
  return {
    desktopTool,
    digitarTool,
    ditadoLocalTool,
    configurarVozTool,
    autoCorrecaoTool,
    allTools: [desktopTool, digitarTool, ditadoLocalTool, configurarVozTool, autoCorrecaoTool]
  };
}
