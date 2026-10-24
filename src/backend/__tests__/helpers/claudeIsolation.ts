import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { SANDBOX_EXEC, type IsolationDeps } from '../../agents/claudeCode.js';

/**
 * Isolamento FALSO para os testes (A3: o isolamento é obrigatório no código; os testes injetam dependências, não o desligam).
 * As pastas próprias são reais (mkdtemp) porque o código as cria antes do spawn.
 */
export function fakeIsolation(over: Partial<IsolationDeps> = {}): IsolationDeps {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f17-iso-'));
  return {
    resolveRoot: () => ({ ok: true, root: '/work/claude-readonly' }),
    claudeBin: () => '/fake/bin/claude',
    home: '/home/x',
    paths: { configDir: path.join(base, 'claude-home'), tmpDir: path.join(base, 'claude-tmp') },
    exists: () => true,
    selftestOk: () => true,
    ...over
  };
}

/** O spawn sempre vem embrulhado por `sandbox-exec -p <perfil> <bin> <args...>`; devolve o que o Claude realmente recebe. */
export function unwrapSpawn(call: { command: string; args: readonly string[] }): { bin: string; argv: string[]; profile: string } {
  if (call.command !== SANDBOX_EXEC || call.args[0] !== '-p') throw new Error(`spawn sem isolamento: ${call.command}`);
  return { profile: call.args[1], bin: call.args[2], argv: call.args.slice(3) as string[] };
}

export type { ChildProcess };
