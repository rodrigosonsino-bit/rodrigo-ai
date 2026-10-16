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
  supportsValue: boolean;
  directInsertSupported: boolean;
  appendSupported: boolean;
  value: string | null;
  selectedText: string | null;
  selectedRange: AccessibilitySelectedRange | null;
}

export interface AccessibilityAdapter {
  inspectFocusedTarget(): Promise<FocusedTargetSnapshot>;
  insertText(text: string, mode: AccessibilityInsertMode): Promise<'ax'>;
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
    supportsValue?: boolean;
    directInsertSupported?: boolean;
    appendSupported?: boolean;
    value?: string | null;
    selectedText?: string | null;
    selectedRange?: { location?: number; length?: number } | null;
  };
  strategy?: string | null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SWIFT_PATH = path.resolve(__dirname, '../../../../scripts/desktop_accessibility.swift');
// Binário pré-compilado (setup-voice): executa em ms e tem identidade estável para a
// permissão de Acessibilidade do macOS. `swift` JIT muda de processo e demora segundos.
const DEFAULT_BIN_PATH = path.resolve(__dirname, '../../../../.runtime/bin/desktop-accessibility');

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
    if (!snapshot?.bundleId || !snapshot.appName) {
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

  async insertText(text: string, mode: AccessibilityInsertMode): Promise<'ax'> {
    const payload = await this.runHelper(['insert', mode, text]);
    if (payload.strategy !== 'ax') {
      throw new Error('AX_BAD_PAYLOAD: insert helper returned an unexpected strategy.');
    }
    return 'ax';
  }

  private async runHelper(args: readonly string[]): Promise<HelperJson> {
    // Fonte .swift roda via JIT (lento, identidade instável); binário executa direto.
    const cmd = this.helperPath.endsWith('.swift') ? '/usr/bin/xcrun' : this.helperPath;
    const cmdArgs = this.helperPath.endsWith('.swift')
      ? ['swift', this.helperPath, ...args]
      : [...args];
    const { stdout } = await this.exec(cmd, cmdArgs, {
      timeout: 15_000
    });
    let parsed: HelperJson;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`AX_BAD_JSON: ${stdout.trim() || '(empty stdout)'}`);
    }
    if (!parsed || parsed.ok !== true) {
      throw new Error('AX_BAD_PAYLOAD: helper did not return ok=true.');
    }
    return parsed;
  }
}
