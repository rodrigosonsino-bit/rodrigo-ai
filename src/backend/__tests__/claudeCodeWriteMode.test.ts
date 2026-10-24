import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClaudeCodeSubAgent } from '../agents/claudeCodeSubAgent.js';
import { DEFAULT_PRIVACY } from '../privacy.js';
import { SANDBOX_EXEC, isolationReadiness, type IsolationDeps } from '../agents/claudeCode.js';
import { fakeIsolation } from './helpers/claudeIsolation.js';

/** Opção C da Fase 17: o modo ESCRITA (agente `claude_code` da main) roda no mesmo isolamento do modo leitura, e ele é OBRIGATÓRIO (A3). */
const canSandbox = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

function sandboxWorks(): boolean {
  const r = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  return r.status === 0;
}

describe('Fase 17 (opção C): modo escrita isolado e obrigatório', () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
    delete process.env.GEMINI_API_KEY;
    delete process.env.RODRIGO_X;
  });
  const mk = (dir: string): string => {
    const d = fs.mkdtempSync(path.join(dir, 'f17w-'));
    tmps.push(d);
    return fs.realpathSync(d);
  };

  function deps(root: string, bin: string, over: Partial<IsolationDeps> = {}): IsolationDeps {
    const base = mk(os.tmpdir());
    return fakeIsolation({
      resolveRoot: () => ({ ok: true, root }),
      claudeBin: () => bin,
      home: os.homedir(),
      paths: { configDir: path.join(base, 'claude-home'), tmpDir: path.join(base, 'claude-tmp') },
      exists: (p) => fs.existsSync(p),
      ...over
    });
  }
  const req = (turnId = 't1') => ({ taskId: 'x', turnId, prompt: 'faça algo', isMutation: true, confirmationToken: `${turnId}:abc` });

  it('A3: sem a prova (selftest), sem raiz válida, sem binário ou sem sandbox-exec o agente NÃO cria processo', async () => {
    const root = mk(os.tmpdir());
    const marker = path.join(root, 'processo-criado');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nprintf '{"result":"x"}'\n`, { mode: 0o755 });
    for (const over of [{ selftestOk: () => false }, { resolveRoot: () => ({ ok: false as const, reason: 'sem raiz' }) }, { claudeBin: () => null }, { exists: () => false }]) {
      const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake, over));
      const r = await agent.runTask(req(), new AbortController().signal);
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /não está pronta/);
    }
    assert.equal(fs.existsSync(marker), false, 'nenhum processo pode ter nascido');
    assert.equal(isolationReadiness(deps(root, fake)).ready, true);
  });

  it('A3: o isolamento é obrigatório no tipo e na construção (não existe agente sem ele)', () => {
    // @ts-expect-error — omitir o isolamento tem de ser erro de compilação
    const sem = () => new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true);
    assert.ok(sem, 'o ts-expect-error acima é a prova: se a omissão compilasse, o teste não compilaria');
  });

  it('com isolamento pronto: roda na raiz limpa (cwd), com config/TMPDIR próprios, sem chaves do app, via sandbox-exec', { skip: !canSandbox || !sandboxWorks() }, async () => {
    const root = mk(os.tmpdir());
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '{"result":"cwd=%s cfg=%s tmp=%s gemini=%s rodrigo=%s"}' "$PWD" "$CLAUDE_CONFIG_DIR" "$TMPDIR" "\${GEMINI_API_KEY:-none}" "\${RODRIGO_X:-none}"\n`, { mode: 0o755 });
    process.env.GEMINI_API_KEY = 'segredo-que-nao-pode-passar';
    process.env.RODRIGO_X = 'x';
    const d = deps(root, fake);
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, d);
    const r = await agent.runTask(req(), new AbortController().signal);
    assert.equal(r.success, true, r.error);
    assert.match(r.output, new RegExp(`cwd=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'cwd precisa ser a raiz isolada');
    assert.ok(r.output.includes(`cfg=${d.paths.configDir}`), 'config própria');
    assert.ok(r.output.includes(`tmp=${d.paths.tmpDir}`), 'TMPDIR próprio');
    assert.match(r.output, /gemini=none/);
    assert.match(r.output, /rodrigo=none/);
  });

  it('o token continua obrigatório também com isolamento (o isolamento não substitui a confirmação)', async () => {
    const root = mk(os.tmpdir());
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, '/bin/echo'));
    const r = await agent.runTask({ ...req(), confirmationToken: undefined }, new AbortController().signal);
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /confirmationToken/);
  });
});
