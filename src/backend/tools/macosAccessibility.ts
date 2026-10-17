import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandExecutor, FrontmostAppInfo } from './desktopControlTool.js';

export type AccessibilityInsertMode = 'insert' | 'replaceSelection' | 'append';

export interface AccessibilitySelectedRange {
  location: number;
  length: number;
}

export interface FocusedTargetSnapshot {
  app: FrontmostAppInfo;
  role: string | null;
  subrole: string | null;
  title: string | null;
  focused: boolean;
  enabled: boolean;
  editable: boolean;
  /** Campo de senha / AXSecureTextField — nunca digitar automaticamente. */
  secure: boolean;
  supportsValue: boolean;
  directInsertSupported: boolean;
  appendSupported: boolean;
  value: string | null;
  selectedText: string | null;
  selectedRange: AccessibilitySelectedRange | null;
}

export interface AxTreeNode {
  path: string;
  role: string | null;
  title: string | null;
  value: string | null;
  enabled: boolean | null;
  focused: boolean | null;
  secure: boolean;
}

export interface AxClickTarget {
  path?: string;
  title?: string;
  role?: string;
}

export class SecureFieldDeniedError extends Error {
  constructor(message = 'AX_SECURE_DENIED: campos de senha não podem ser manipulados pela automação.') {
    super(message);
    this.name = 'SecureFieldDeniedError';
  }
}

/** Contrato mínimo usado por DigitarTool (inspect + insert). */
export interface AccessibilityInspectInsert {
  inspectFocusedTarget(): Promise<FocusedTargetSnapshot>;
  insertText(text: string, mode: AccessibilityInsertMode): Promise<'ax'>;
}

/** Adapter completo para automação desktop (computer-use). */
export interface AccessibilityAdapter extends AccessibilityInspectInsert {
  /** Resumo truncado da árvore AX do app em foco. */
  tree(): Promise<readonly AxTreeNode[]>;
  click(target: AxClickTarget): Promise<void>;
  press(target: AxClickTarget): Promise<void>;
  hotkey(key: string, modifiers?: readonly string[]): Promise<void>;
  selectMenu(menuPath: string): Promise<void>;
  copySelection(): Promise<string>;
  getSelectedText(): Promise<string>;
  isTrusted?(): Promise<boolean>;
}

interface HelperJson {
  ok: boolean;
  snapshot?: {
    bundleId?: string;
    appName?: string;
    role?: string | null;
    subrole?: string | null;
    title?: string | null;
    focused?: boolean;
    enabled?: boolean;
    editable?: boolean;
    secure?: boolean;
    supportsValue?: boolean;
    directInsertSupported?: boolean;
    appendSupported?: boolean;
    value?: string | null;
    selectedText?: string | null;
    selectedRange?: { location?: number; length?: number } | null;
  };
  strategy?: string | null;
  tree?: Array<{
    path?: string;
    role?: string | null;
    title?: string | null;
    value?: string | null;
    enabled?: boolean | null;
    focused?: boolean | null;
    secure?: boolean;
  }>;
  text?: string | null;
  trusted?: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SWIFT_PATH = path.resolve(__dirname, '../../../../scripts/desktop_accessibility.swift');
// Binário pré-compilado (setup-voice): executa em ms e tem identidade estável para a
// permissão de Acessibilidade do macOS. `swift` JIT muda de processo e demora segundos.
const DEFAULT_BIN_PATH = path.resolve(__dirname, '../../../../.runtime/bin/desktop-accessibility');

function mapSnapshot(snapshot: NonNullable<HelperJson['snapshot']>): FocusedTargetSnapshot {
  if (!snapshot.bundleId || !snapshot.appName) {
    throw new Error('AX_BAD_PAYLOAD: focused target snapshot is incomplete.');
  }
  return {
    app: { bundleId: snapshot.bundleId, name: snapshot.appName },
    role: snapshot.role ?? null,
    subrole: snapshot.subrole ?? null,
    title: snapshot.title ?? null,
    focused: snapshot.focused ?? true,
    enabled: snapshot.enabled ?? true,
    editable: snapshot.editable ?? false,
    secure:
      snapshot.secure === true ||
      snapshot.role === 'AXSecureTextField' ||
      snapshot.subrole === 'AXSecureTextField',
    supportsValue: snapshot.supportsValue ?? false,
    directInsertSupported: snapshot.directInsertSupported ?? false,
    appendSupported: snapshot.appendSupported ?? false,
    value: snapshot.value ?? null,
    selectedText: snapshot.selectedText ?? null,
    selectedRange:
      snapshot.selectedRange &&
      typeof snapshot.selectedRange.location === 'number' &&
      typeof snapshot.selectedRange.length === 'number'
        ? {
            location: snapshot.selectedRange.location,
            length: snapshot.selectedRange.length
          }
        : null
  };
}

export class DefaultMacAccessibilityAdapter implements AccessibilityAdapter {
  private readonly helperPath: string;

  constructor(
    private readonly exec: CommandExecutor,
    helperPath?: string
  ) {
    if (helperPath) {
      this.helperPath = helperPath;
    } else if (fs.existsSync(DEFAULT_BIN_PATH)) {
      this.helperPath = DEFAULT_BIN_PATH;
    } else {
      this.helperPath = DEFAULT_SWIFT_PATH;
    }
  }

  async inspectFocusedTarget(): Promise<FocusedTargetSnapshot> {
    const payload = await this.runHelper(['inspect']);
    const snapshot = payload.snapshot;
    if (!snapshot) {
      throw new Error('AX_BAD_PAYLOAD: focused target snapshot is incomplete.');
    }
    return mapSnapshot(snapshot);
  }

  async insertText(text: string, mode: AccessibilityInsertMode): Promise<'ax'> {
    const payload = await this.runHelper(['insert', mode, text]);
    if (payload.strategy !== 'ax') {
      throw new Error('AX_BAD_PAYLOAD: insert helper returned an unexpected strategy.');
    }
    return 'ax';
  }

  async tree(): Promise<readonly AxTreeNode[]> {
    const payload = await this.runHelper(['tree']);
    const raw = payload.tree ?? [];
    return raw.map((n) => ({
      path: n.path ?? '',
      role: n.role ?? null,
      title: n.title ?? null,
      value: n.value ?? null,
      enabled: n.enabled ?? null,
      focused: n.focused ?? null,
      secure: n.secure === true
    }));
  }

  async click(target: AxClickTarget): Promise<void> {
    await this.runHelper(['click', ...targetArgs(target)]);
  }

  async press(target: AxClickTarget): Promise<void> {
    await this.runHelper(['press', ...targetArgs(target)]);
  }

  async hotkey(key: string, modifiers: readonly string[] = []): Promise<void> {
    const args = ['hotkey', key];
    if (modifiers.length > 0) args.push(modifiers.join(','));
    await this.runHelper(args);
  }

  async selectMenu(menuPath: string): Promise<void> {
    await this.runHelper(['select_menu', menuPath]);
  }

  async copySelection(): Promise<string> {
    const payload = await this.runHelper(['copy_selection']);
    if (typeof payload.text !== 'string') {
      throw new Error('AX_BAD_PAYLOAD: copy_selection returned no text.');
    }
    return payload.text;
  }

  async getSelectedText(): Promise<string> {
    const payload = await this.runHelper(['get_selected_text']);
    if (typeof payload.text !== 'string') {
      throw new Error('AX_BAD_PAYLOAD: get_selected_text returned no text.');
    }
    return payload.text;
  }

  async isTrusted(): Promise<boolean> {
    const payload = await this.runHelper(['trusted']);
    return payload.trusted === true;
  }

  private async runHelper(args: readonly string[]): Promise<HelperJson> {
    const isSwiftSource = this.helperPath.endsWith('.swift');
    const cmd = isSwiftSource ? '/usr/bin/xcrun' : this.helperPath;
    const cmdArgs = isSwiftSource ? ['swift', this.helperPath, ...args] : [...args];
    let stdout: string;
    let stderr = '';
    try {
      const result = await this.exec(cmd, cmdArgs, {
        timeout: 15_000
      });
      stdout = result.stdout;
      stderr = result.stderr ?? '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const combined = `${msg}\n${stderr}`;
      if (/secure field denied/i.test(combined)) {
        throw new SecureFieldDeniedError();
      }
      throw err;
    }
    if (/secure field denied/i.test(stderr) || /secure field denied/i.test(stdout)) {
      throw new SecureFieldDeniedError();
    }
    let parsed: HelperJson;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      if (/secure field denied/i.test(stdout + stderr)) {
        throw new SecureFieldDeniedError();
      }
      throw new Error(`AX_BAD_JSON: ${stdout.trim() || '(empty stdout)'}`);
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error('AX_BAD_PAYLOAD: helper did not return ok=true.');
    }
    return parsed;
  }
}

function targetArgs(target: AxClickTarget): string[] {
  const out: string[] = [];
  if (target.path) out.push(`path:${target.path}`);
  if (target.title) out.push(`title:${target.title}`);
  if (target.role) out.push(`role:${target.role}`);
  return out;
}
