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
// A4: no macOS, sandbox que não aplica é FALHA (nunca pulo silencioso). Só fora do macOS os testes reais são pulados.
const realSkip = !canSandbox;
const mustSandbox = () => assert.equal(sandboxWorks(), true, 'sandbox-exec não aplicou neste macOS');

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
    // A3: `root` é a raiz de ESCRITA (onde o agente roda); a de leitura é outra pasta, separada.
    const readRoot = mk(os.tmpdir());
    return fakeIsolation({
      resolveRoot: () => ({ ok: true, root: readRoot }),
      resolveWriteRoot: () => ({ ok: true, root }),
      claudeBin: () => bin,
      home: os.homedir(),
      paths: { configDir: path.join(base, 'claude-home'), tmpDir: path.join(base, 'claude-tmp') },
      writePaths: { configDir: path.join(base, 'claude-home-write'), tmpDir: path.join(base, 'claude-tmp-write') },
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
    // R5: o caso positivo não depende do SO (sandbox-exec simulado); os negativos acima continuam valendo.
    assert.equal(isolationReadiness(deps(root, fake, { exists: () => true })).ready, true);
  });

  it('A3: o isolamento é obrigatório no tipo e na construção (não existe agente sem ele)', () => {
    // @ts-expect-error — omitir o isolamento tem de ser erro de compilação
    const sem = () => new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true);
    assert.ok(sem, 'o ts-expect-error acima é a prova: se a omissão compilasse, o teste não compilaria');
  });

  it('com isolamento pronto: roda na raiz limpa (cwd), com config/TMPDIR próprios, sem chaves do app, via sandbox-exec', { skip: realSkip }, async () => {
    mustSandbox();
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
    assert.ok(r.output.includes(`cfg=${d.writePaths!.configDir}`), 'config própria do modo escrita');
    assert.ok(r.output.includes(`tmp=${d.writePaths!.tmpDir}`), 'TMPDIR próprio do modo escrita');
    assert.ok(!r.output.includes(`cfg=${d.paths.configDir} `), 'A4: não usa a config do modo leitura');
    assert.match(r.output, /gemini=none/);
    assert.match(r.output, /rodrigo=none/);
  });

  it('M5: cancelar no modo escrita mata o GRUPO inteiro (filhos do Bash em segundo plano não sobrevivem)', { skip: realSkip }, async () => {
    mustSandbox();
    const root = mk(os.tmpdir());
    const pidFile = path.join(root, 'neto.pid');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\nsleep 100 &\necho $! > "${pidFile}"\nsleep 100\n`, { mode: 0o755 });
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake));
    const ac = new AbortController();
    const p = agent.runTask(req(), ac.signal);
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf-8').trim() === '') {
      if (Date.now() - t0 > 5000) throw new Error('o neto não nasceu');
      await new Promise((r) => setTimeout(r, 50));
    }
    const neto = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    ac.abort();
    const r = await p;
    assert.equal(r.success, false);
    const vivo = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const t1 = Date.now();
    while (vivo(neto) && Date.now() - t1 < 3000) await new Promise((res) => setTimeout(res, 50));
    const sobreviveu = vivo(neto);
    if (sobreviveu) process.kill(neto, 'SIGKILL');
    assert.equal(sobreviveu, false, 'o sleep em segundo plano sobreviveu ao cancelamento');
  });

  it('A3: sem raiz de escrita válida, ou com ela igual/aninhada à de leitura, o modo escrita NÃO cria processo', async () => {
    const root = mk(os.tmpdir());
    const marker = path.join(root, 'processo-criado');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const casos: Partial<IsolationDeps>[] = [
      { resolveWriteRoot: undefined },
      { resolveWriteRoot: () => ({ ok: false, reason: 'sem raiz de escrita' }) },
      { resolveRoot: () => ({ ok: true, root }) },
      { resolveRoot: () => ({ ok: true, root: path.dirname(root) }) }
    ];
    for (const over of casos) {
      // exists: () => true — isola o motivo testado (sem depender de /usr/bin/sandbox-exec existir: portável no Linux).
      const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake, { exists: () => true, ...over }));
      const r = await agent.runTask(req(), new AbortController().signal);
      assert.equal(r.success, false);
      assert.match(r.error ?? '', /modo escrita do Claude não está pronto/);
    }
    assert.equal(fs.existsSync(marker), false);
  });

  it('A4: sem pastas próprias do modo escrita, ou com elas iguais às da leitura, o modo escrita NÃO cria processo', async () => {
    const root = mk(os.tmpdir());
    const marker = path.join(root, 'processo-criado');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const base = mk(os.tmpdir());
    const same = { configDir: path.join(base, 'h'), tmpDir: path.join(base, 't') };
    for (const over of [{ writePaths: undefined }, { paths: same, writePaths: same }] as Partial<IsolationDeps>[]) {
      const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake, { exists: () => true, ...over }));
      const r = await agent.runTask(req(), new AbortController().signal);
      assert.equal(r.success, false);
    }
    assert.equal(fs.existsSync(marker), false);
  });

  it('A4: nonce por job — pedido no modo escrita e revogado ao fim do job (sucesso ou falha)', { skip: realSkip }, async () => {
    mustSandbox();
    const root = mk(os.tmpdir());
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '{"result":"ok"}'\n`, { mode: 0o755 });
    const modes: string[] = [];
    let revoked = 0;
    let swept = 0;
    let n = 0;
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake, {
      proxyAuth: (_h, mode) => { modes.push(mode); n++; return { baseUrl: 'http://127.0.0.1:47817', nonce: `n${n}`, port: 47817, revoke: () => void revoked++ }; },
      sweep: () => { swept++; return 0; }
    }));
    assert.equal((await agent.runTask(req('t1'), new AbortController().signal)).success, true);
    assert.equal((await agent.runTask(req('t2'), new AbortController().signal)).success, true);
    assert.deepEqual(modes, ['escrita', 'escrita'], 'um nonce novo por job, do modo escrita');
    assert.ok(revoked >= 2, 'revogado ao fim de cada job');
    assert.ok(swept >= 2, 'varredura de sobreviventes ao fim de cada job');
  });

  it('A3: sem proxy pronto o modo escrita NÃO cria processo', async () => {
    const root = mk(os.tmpdir());
    const marker = path.join(root, 'processo-criado');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake, { exists: () => true, proxyAuth: () => null }));
    const r = await agent.runTask(req(), new AbortController().signal);
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /proxy/);
    assert.equal(fs.existsSync(marker), false);
  });

  it('A3 (macOS real): o modo escrita NÃO lê a raiz de leitura e o filho não recebe o token, só a URL do proxy e o nonce', { skip: realSkip }, async () => {
    mustSandbox();
    const root = mk(os.tmpdir());
    const readRoot = mk(os.tmpdir());
    fs.writeFileSync(path.join(readRoot, 'leitura.txt'), 'SEGREDO-DA-LEITURA\n');
    const fake = path.join(root, 'fake-claude.sh');
    fs.writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nL=$(cat "${readRoot}/leitura.txt" 2>&1)\nN=$(cat <&3)\nN2=$(cat <&3 2>/dev/null)\nE=$(env | grep -c "$N")\nprintf '{"result":"leu=%s base=%s nonce=%s denovo=[%s] noenv=%s envtok=%s fd=%s tok=%s"}' "$L" "$ANTHROPIC_BASE_URL" "$N" "$N2" "$E" "\${ANTHROPIC_AUTH_TOKEN:-none}" "$CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" "\${CLAUDE_CODE_OAUTH_TOKEN:-none}"\n`, { mode: 0o755 });
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, fake, { resolveRoot: () => ({ ok: true, root: readRoot }) }));
    const r = await agent.runTask(req(), new AbortController().signal);
    assert.equal(r.success, true, r.error);
    assert.ok(!r.output.includes('SEGREDO-DA-LEITURA'), 'leu a raiz de leitura no modo escrita');
    assert.match(r.output, /not permitted/i);
    assert.match(r.output, /base=http:\/\/127\.0\.0\.1:47817/);
    assert.match(r.output, /nonce=nonce-de-teste /, 'F2: nonce lido do fd 3');
    assert.match(r.output, /denovo=\[\]/, 'F2: o fd 3 é de uso único (segunda leitura vazia)');
    assert.match(r.output, /noenv=0 /, 'F2: o nonce não está em nenhuma variável de ambiente');
    assert.match(r.output, /envtok=none/);
    assert.match(r.output, /fd=3 /);
    assert.match(r.output, /tok=none/);
  });

  it('o token continua obrigatório também com isolamento (o isolamento não substitui a confirmação)', async () => {
    const root = mk(os.tmpdir());
    const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, () => true, deps(root, '/bin/echo'));
    const r = await agent.runTask({ ...req(), confirmationToken: undefined }, new AbortController().signal);
    assert.equal(r.success, false);
    assert.match(r.error ?? '', /confirmationToken/);
  });
});
