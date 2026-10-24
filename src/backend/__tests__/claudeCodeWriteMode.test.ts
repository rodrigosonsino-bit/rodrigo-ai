import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ClaudeCodeSubAgent } from '../agents/claudeCodeSubAgent.js';
import { DEFAULT_PRIVACY } from '../privacy.js';
import { SANDBOX_EXEC, buildSandboxProfile, isolationReadiness, type IsolationDeps } from '../agents/claudeCode.js';

/** Opção C da Fase 17: o modo ESCRITA (agente `claude_code` da main) roda no mesmo isolamento do modo leitura. */
const canSandbox = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

function sandboxWorks(): boolean {
  const r = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  return r.status === 0;
}

describe('Fase 17 (opção C): modo escrita isolado', () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
    delete process.env.GEMINI_API_KEY;
  });
  const mk = (dir: string): string => {
    const d = fs.mkdtempSync(path.join(dir, 'f17w-'));
    tmps.push(d);
    return fs.realpathSync(d);
  };

  function deps(root: string, bin: string, over: Partial<IsolationDeps> = {}): IsolationDeps {
    return {
      resolveRoot: () => ({ ok: true, root }),
      claudeBin: () => bin,
      home: os.homedir(),
      exists: (p) => fs.existsSync(p),
      selftestOk: () => true,
      ...over
    };
  }
  const req = (turnId = 't1') => ({ taskId: 'x', turnId, prompt: 'faça algo', isMutation: true, confirmationToken: `${turnId}:abc` });

  it('o perfil do modo escrita libera SÓ a raiz para gravar; o resto do HOME segue negado (processo real)', { skip: !canSandbox || !sandboxWorks() }, () => {
    const home = os.homedir();
    const root = fs.mkdtempSync(path.join(home, '.f17-wroot-'));
    const outside = path.join(home, `.f17-wout-${process.pid}.txt`);
    try {
      const prof = buildSandboxProfile(root, home, { writable: true });
      const run = (cmd: string) => spawnSync(SANDBOX_EXEC, ['-p', prof, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
      assert.equal(run(`echo ok > "${path.join(root, 'novo.txt')}"`).status, 0, 'gravar na raiz deve funcionar');
      assert.notEqual(run(`echo no > "${outside}"`).status, 0, 'gravar fora da raiz, no HOME, deve ser negado');
      assert.equal(fs.existsSync(outside), false);
      // o perfil de LEITURA (padrão) continua sem escrita nenhuma na raiz
      const ro = spawnSync(SANDBOX_EXEC, ['-p', buildSandboxProfile(root, home), '/bin/sh', '-c', `echo x > "${path.join(root, 'ro.txt')}"`]);
      assert.notEqual(ro.status, 0, 'o modo leitura não pode gravar nem na raiz');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { force: true });
    }
  });

  it('com isolamento: sem a prova (selftest) ou sem raiz válida o agente NÃO cria processo', async () => {
    const root = mk(os.tmpdir());
    const marker = path.join(root, 'processo-criado');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nprintf '{"result":"x"}'\n`, { mode: 0o755 });
    for (const over of [{ selftestOk: () => false }, { resolveRoot: () => ({ ok: false as const, reason: 'sem raiz' }) }, { claudeBin: () => null }]) {
      const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, root, () => true, deps(root, fake, over));
      const r = await agent.runTask(req(), new AbortController().signal);
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /não está pronta/);
    }
    assert.equal(fs.existsSync(marker), false, 'nenhum processo pode ter nascido');
    assert.equal(isolationReadiness(deps(root, fake)).ready, canSandbox);
  });

  it('com isolamento pronto: roda na raiz limpa (cwd), sem as chaves do app, via sandbox-exec', { skip: !canSandbox || !sandboxWorks() }, async () => {
    const root = mk(os.tmpdir());
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '{"result":"cwd=%s gemini=%s rodrigo=%s"}' "$PWD" "\${GEMINI_API_KEY:-none}" "\${RODRIGO_X:-none}"\n`, { mode: 0o755 });
    process.env.GEMINI_API_KEY = 'segredo-que-nao-pode-passar';
    process.env.RODRIGO_X = 'x';
    try {
      const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, '/nao/e/aqui', () => true, deps(root, fake));
      const r = await agent.runTask(req(), new AbortController().signal);
      assert.equal(r.success, true, r.error);
      assert.match(r.output, new RegExp(`cwd=${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'cwd precisa ser a raiz isolada, não o rootDir do app');
      assert.match(r.output, /gemini=none/);
      assert.match(r.output, /rodrigo=none/);
    } finally {
      delete process.env.RODRIGO_X;
    }
  });

  it('o token continua obrigatório também com isolamento (o isolamento não substitui a confirmação)', async () => {
    const root = mk(os.tmpdir());
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, root, () => true, deps(root, '/bin/echo'));
    const r = await agent.runTask({ ...req(), confirmationToken: undefined }, new AbortController().signal);
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /confirmationToken/);
  });
});
