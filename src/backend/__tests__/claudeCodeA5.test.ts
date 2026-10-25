import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeRunner, SANDBOX_EXEC, SANDBOX_PROFILE_VERSION, buildSandboxProfile, passNonceFd } from '../agents/claudeCode.js';
import { JsonStore } from '../storage/jsonStore.js';
import { fakeIsolation } from './helpers/claudeIsolation.js';

/** Reauditoria 5 (F2): processos fora do sandbox ficam invisíveis/intocáveis e o nonce vai pelo fd 3, nunca pelo env. */
const ROOT = '/Users/me/proj/.runtime/ro';
const PATHS = { configDir: '/Users/me/proj/.runtime/claude-home', tmpDir: '/Users/me/proj/.runtime/claude-tmp' };
const darwinReal = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

class NoFdChild extends EventEmitter {
  pid: number | undefined = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  stdin = new Writable({ write: (_c: Buffer, _e, cb) => cb() });
  stdio = [this.stdin, this.stdout, this.stderr];
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (f: () => boolean, ms = 5000): Promise<boolean> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
};

describe('F2: process-info/signal só dentro do próprio sandbox; nonce fora do env', () => {
  it('perfil v7 nega process-info*/signal e só libera o mesmo sandbox (nos dois modos)', () => {
    assert.equal(SANDBOX_PROFILE_VERSION, 7);
    for (const writable of [false, true]) {
      const p = buildSandboxProfile(ROOT, '/Users/me', { paths: PATHS, writable, proxyPort: 47817 });
      for (const r of ['(deny process-info*)', '(allow process-info* (target same-sandbox))', '(deny signal)', '(allow signal (target same-sandbox))']) assert.ok(p.includes(r), r);
      assert.ok(p.indexOf('(deny process-info*)') < p.indexOf('(allow process-info* (target same-sandbox))'), 'a liberação vem depois (vence)');
      assert.ok(p.indexOf('(deny signal)') < p.indexOf('(allow signal (target same-sandbox))'));
      assert.ok(!/\(allow (signal|process-info\*)\)/.test(p), 'nenhuma liberação ampla');
    }
  });

  it('passNonceFd: escreve só no fd 3 e fecha; sem fd 3 => false', () => {
    let got = '';
    let ended = false;
    const w = new Writable({ write: (c: Buffer, _e, cb) => { got += c.toString(); cb(); } });
    w.on('finish', () => (ended = true));
    const auth = { baseUrl: 'http://127.0.0.1:47817', nonce: 'abc123', port: 47817, revoke: () => {} };
    assert.equal(passNonceFd({ stdio: [null, null, null, w] }, auth), true);
    return new Promise<void>((r) => setImmediate(() => {
      assert.equal(got, 'abc123');
      assert.equal(ended, true, 'pipe fechado: o nonce só pode ser lido uma vez');
      assert.equal(passNonceFd({ stdio: [null, null, null] }, auth), false);
      assert.equal(passNonceFd({}, auth), false);
      r();
    }));
  });

  it('runner: sem o pipe do fd 3 o job falha fechado, o nonce é revogado e o processo é encerrado', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f17a5-'));
    let revoked = false;
    const kids: NoFdChild[] = [];
    const runner = new ClaudeCodeRunner({
      isolation: fakeIsolation({ proxyAuth: () => ({ baseUrl: 'http://127.0.0.1:50001', nonce: 'nonce-x', port: 50001, revoke: () => void (revoked = true) }), sweep: () => 0 }),
      store: new JsonStore(dir, 'claude-jobs.json'),
      spawnFn: () => {
        const c = new NoFdChild();
        kids.push(c);
        return c as unknown as ChildProcess;
      },
      parentEnv: () => ({ PATH: '/usr/bin', HOME: '/home/x' })
    });
    try {
      const r = runner.start('análise do projeto sem fd');
      assert.equal(r.ok, true);
      const j = runner.jobs().find((x) => x.id === (r as { id: string }).id);
      assert.ok(j);
      assert.equal(j.status, 'failed');
      assert.equal(revoked, true);
      assert.equal(kids.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prova real (macOS): de dentro NÃO lê info nem sinaliza processo de fora nem sobrevivente de outro job; o próprio filho sim; fora tudo funciona (controle)', { skip: !darwinReal }, async () => {
    const home = os.homedir();
    const base = fs.realpathSync(fs.mkdtempSync(path.join(home, '.f17-a5-')));
    const root = path.join(base, 'root');
    const paths = { configDir: path.join(base, 'claude-home'), tmpDir: path.join(base, 'claude-tmp') };
    for (const d of [root, paths.configDir, paths.tmpDir]) fs.mkdirSync(d, { recursive: true });
    const outside = spawn('/bin/sleep', ['120'], { cwd: base, stdio: 'ignore' });
    const pids: number[] = [outside.pid!];
    try {
      // controle positivo FORA do sandbox: lsof lê o cwd e o sinal 0 funciona
      const ctl = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(outside.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      assert.equal(ctl.status, 0, 'controle: fora do sandbox o lsof lê o processo');
      assert.match(ctl.stdout, new RegExp(`^n${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      for (const writable of [false, true]) {
        const profile = buildSandboxProfile(root, home, { paths, writable, proxyPort: 47817 });
        const r = spawnSync(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', [
          `/usr/sbin/lsof -a -p ${outside.pid} -d cwd -Fn >/dev/null 2>&1; echo info_outro=$?`,
          `kill -TERM ${outside.pid} 2>/dev/null; echo sinal_outro=$?`,
          `/bin/sleep 30 & c=$!`,
          `/usr/sbin/lsof -a -p $c -d cwd -Fn >/dev/null 2>&1; echo info_proprio=$?`,
          `kill -TERM $c; echo sinal_proprio=$?`
        ].join('\n')], { encoding: 'utf8' });
        assert.equal(r.status, 0, `sandbox não aplicado (writable=${writable}): ${r.stderr}`);
        assert.match(r.stdout, /info_outro=[1-9]/, `leu info de processo de fora (writable=${writable})`);
        assert.match(r.stdout, /sinal_outro=[1-9]/, `sinalizou processo de fora (writable=${writable})`);
        assert.match(r.stdout, /info_proprio=0/, 'controle: o próprio filho é visível');
        assert.match(r.stdout, /sinal_proprio=0/, 'controle: o próprio filho pode ser encerrado');
        assert.equal(alive(outside.pid!), true, 'o processo de fora morreu');
      }
      // sobrevivente de um job ANTERIOR (outra instância do mesmo perfil, com setsid) é intocável pelo próximo job
      const profile = buildSandboxProfile(root, home, { paths, writable: true, proxyPort: 47817 });
      const pidFile = path.join(base, 'surv.pid');
      const launcher = spawn('/usr/bin/perl', ['-e', `use POSIX; if (fork()) { exit 0 } POSIX::setsid(); open(my $f, ">", "${pidFile}"); print $f $$; close $f; exec "${SANDBOX_EXEC}", "-p", $ARGV[0], "/bin/sleep", "120";`, profile], { stdio: 'ignore' });
      await new Promise((r) => launcher.on('close', r));
      assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== ''), 'o sobrevivente não nasceu');
      const surv = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      pids.push(surv);
      assert.ok(await until(() => alive(surv)));
      const r2 = spawnSync(SANDBOX_EXEC, ['-p', profile, '/bin/sh', '-c', `/usr/sbin/lsof -a -p ${surv} -d cwd -Fn >/dev/null 2>&1; echo info_surv=$?; kill -TERM ${surv} 2>/dev/null; echo sinal_surv=$?`], { encoding: 'utf8' });
      assert.match(r2.stdout, /info_surv=[1-9]/, 'o próximo job leu info do sobrevivente');
      assert.match(r2.stdout, /sinal_surv=[1-9]/, 'o próximo job sinalizou o sobrevivente');
      assert.equal(alive(surv), true);
      // controle: o pai (fora do sandbox) encerra o sobrevivente
      process.kill(surv, 'SIGTERM');
      assert.ok(await until(() => !alive(surv), 3000), 'controle: o pai encerra o sobrevivente');
    } finally {
      for (const p of pids) if (alive(p)) try { process.kill(p, 'SIGKILL'); } catch { /* já saiu */ }
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
