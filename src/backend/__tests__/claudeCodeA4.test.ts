import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeRunner, SANDBOX_EXEC, buildSandboxProfile, sweepSurvivors, type IsolationDeps } from '../agents/claudeCode.js';
import { JsonStore } from '../storage/jsonStore.js';
import { fakeIsolation, unwrapSpawn } from './helpers/claudeIsolation.js';

/** Reauditoria 4 (A4): nonce por job, porta efêmera no perfil, pasteboard/nsurlsessiond, controles positivos e sobreviventes de setsid. */
const ROOT = '/Users/me/proj/.runtime/ro';
const PATHS = { configDir: '/Users/me/proj/.runtime/claude-home', tmpDir: '/Users/me/proj/.runtime/claude-tmp' };
const darwinReal = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  stdin = new Writable({ write: (_c: Buffer, _e, cb) => cb() });
  fd3 = '';
  nonceFd = new Writable({
    write: (chunk: Buffer, _enc, cb) => {
      this.fd3 += chunk.toString();
      cb();
    }
  });
  noFd = false;
  get stdio(): unknown[] {
    return this.noFd ? [this.stdin, this.stdout, this.stderr] : [this.stdin, this.stdout, this.stderr, this.nonceFd];
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function runnerWith(over: Partial<IsolationDeps>, timeoutMs?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f17a4-'));
  const calls: { args: readonly string[]; child: FakeChild; env: NodeJS.ProcessEnv | undefined }[] = [];
  let throwOnSpawn = false;
  const runner = new ClaudeCodeRunner({
    isolation: fakeIsolation(over),
    store: new JsonStore(dir, 'claude-jobs.json'),
    spawnFn: (command, args, options) => {
      if (throwOnSpawn) throw new Error('EAGAIN');
      const child = new FakeChild();
      calls.push({ args: [command, ...args], child, env: options.env });
      return child as unknown as ChildProcess;
    },
    parentEnv: () => ({ PATH: '/usr/bin', HOME: '/home/x' }),
    timeoutMs
  });
  return { runner, calls, failSpawn: () => (throwOnSpawn = true), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('A4: perfil, nonce por job e sobreviventes', () => {
  it('pasteboard e nsurlsessiond negados por mach-lookup nos dois modos', () => {
    for (const writable of [false, true]) {
      const p = buildSandboxProfile(ROOT, '/Users/me', { paths: PATHS, writable, proxyPort: 47817 });
      for (const n of ['com.apple.pasteboard.1', 'com.apple.nsurlsessiond', 'com.apple.xpc.smd']) assert.ok(p.includes(`(global-name "${n}")`), n);
      assert.ok(p.includes('(global-name-regex #"^com\\.apple\\.pasteboard")'));
      assert.ok(p.includes('(global-name-regex #"^com\\.apple\\.nsurlsession")'));
    }
  });

  it('porta efêmera: o perfil real só difere do de referência (impressão digital) no número da porta; porta inválida é recusada', () => {
    for (const writable of [false, true]) {
      const ref = buildSandboxProfile(ROOT, '/Users/me', { paths: PATHS, writable, proxyPort: 47817 });
      const real = buildSandboxProfile(ROOT, '/Users/me', { paths: PATHS, writable, proxyPort: 51234 });
      assert.ok(real.includes('(remote tcp "localhost:51234")'));
      assert.equal(real.replace('localhost:51234', 'localhost:47817'), ref);
    }
    for (const bad of [0, 80, 1023, 65536, 1.5, NaN]) assert.throws(() => buildSandboxProfile(ROOT, '/Users/me', { paths: PATHS, proxyPort: bad }), /porta/i, String(bad));
  });

  it('runner: nonce novo por job (modo leitura), porta dele no perfil, revogado no fim (sucesso, cancel, timeout, erro de spawn) e varredura chamada', async () => {
    const issued: { mode: string; revoked: boolean }[] = [];
    let swept = 0;
    const over: Partial<IsolationDeps> = {
      proxyAuth: (_h, mode) => {
        const e = { mode, revoked: false };
        issued.push(e);
        return { baseUrl: `http://127.0.0.1:${50000 + issued.length}`, nonce: `nonce-${issued.length}`, port: 50000 + issued.length, revoke: () => void (e.revoked = true) };
      },
      sweep: () => {
        swept++;
        return 0;
      }
    };
    const h = runnerWith(over, 40);
    try {
      assert.equal(h.runner.start('primeira análise do projeto').ok, true);
      const p1 = unwrapSpawn({ command: String(h.calls[0].args[0]), args: h.calls[0].args.slice(1) }).profile;
      assert.ok(p1.includes('localhost:50001'), 'a porta do job vai para o perfil');
      assert.equal(h.calls[0].child.fd3, 'nonce-1', 'F2: nonce pelo fd 3');
      assert.ok(!Object.values(h.calls[0].env ?? {}).includes('nonce-1'), 'F2: nonce fora do env');
      assert.equal(issued[0].revoked, false, 'vivo enquanto o job roda');
      h.calls[0].child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
      h.calls[0].child.emit('close', 0);
      assert.equal(issued[0].revoked, true, 'revogado ao concluir');
      assert.ok(swept >= 1);

      assert.equal(h.runner.start('segunda análise do projeto').ok, true);
      assert.equal(h.calls[1].child.fd3, 'nonce-2', 'sem reuso entre jobs');
      h.runner.cancel();
      h.calls[1].child.emit('close', null);
      assert.equal(issued[1].revoked, true, 'revogado no cancelamento');

      assert.equal(h.runner.start('terceira análise do projeto').ok, true);
      await new Promise((r) => setTimeout(r, 120));
      h.calls[2].child.emit('close', null);
      assert.equal(issued[2].revoked, true, 'revogado no timeout');

      h.failSpawn();
      const r4 = h.runner.start('quarta análise do projeto');
      assert.equal(r4.ok, true);
      const j4 = h.runner.jobs().find((j) => j.id === (r4 as { id: string }).id);
      assert.ok(j4, 'o quarto job existe');
      assert.equal(j4.status, 'failed', 'spawn falho => o QUARTO job falha');
      assert.equal(issued[3].revoked, true, 'revogado quando o spawn falha');
      assert.deepEqual(issued.map((i) => i.mode), ['leitura', 'leitura', 'leitura', 'leitura']);
      assert.ok(swept >= 3, 'varredura ao fim de cada job');
    } finally {
      h.cleanup();
    }
  });

  it('sweepSurvivors: fora do macOS não faz nada; lista vazia não faz nada', () => {
    let called = 0;
    const run = (() => {
      called++;
      return { stdout: '', status: 0 };
    }) as unknown as typeof spawnSync;
    assert.equal(sweepSurvivors([], run), 0);
    if (process.platform !== 'darwin') assert.equal(sweepSurvivors(['/x'], run), 0);
    assert.equal(called, 0);
  });

  it('prova real (macOS): processo que fez setsid (fora do grupo) com cwd na pasta do job é morto pela varredura', { skip: !darwinReal }, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f17-setsid-')));
    const pidFile = path.join(dir, 'pid');
    const c = spawn('/usr/bin/perl', ['-e', `use POSIX; my $p = fork(); if ($p) { exit 0 } POSIX::setsid(); chdir "${dir}"; open(my $f, ">", "${pidFile}"); print $f $$; close $f; sleep 100;`], { detached: false, stdio: 'ignore' });
    await new Promise((r) => c.on('close', r));
    const t0 = Date.now();
    while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim())) {
      if (Date.now() - t0 > 5000) throw new Error('o sobrevivente não nasceu');
      await new Promise((r) => setTimeout(r, 50));
    }
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      assert.equal(alive(), true);
      assert.ok(sweepSurvivors([dir]) >= 1, 'a varredura achou o sobrevivente');
      const t1 = Date.now();
      while (alive() && Date.now() - t1 < 3000) await new Promise((r) => setTimeout(r, 50));
      assert.equal(alive(), false, 'o processo com setsid sobreviveu');
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prova real (macOS) S1: controles POSITIVOS fora do sandbox (launchctl submit e SMJobSubmit criam job) e NEGATIVOS dentro; área de transferência negada', { skip: !darwinReal }, async () => {
    const home = os.homedir();
    const base = fs.mkdtempSync(path.join(home, '.f17-a4-'));
    const root = path.join(base, 'root');
    const paths = { configDir: path.join(base, 'claude-home'), tmpDir: path.join(base, 'claude-tmp') };
    for (const d of [root, paths.configDir, paths.tmpDir]) fs.mkdirSync(d, { recursive: true });
    const label = `rodrigo.f17a4.${process.pid}`;
    const bait = (s: string) => path.join(base, `isca-${s}.txt`);
    const run = (writable: boolean, cmd: string) =>
      spawnSync(SANDBOX_EXEC, ['-p', buildSandboxProfile(root, home, { paths, writable, proxyPort: 47817 }), '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    const wait = () => new Promise((r) => setTimeout(r, 2000));
    const py = ['/opt/homebrew/bin/python3', '/usr/bin/python3'].find((p) => fs.existsSync(p));
    const attack = path.join(paths.tmpDir, 'smjob.py');
    fs.writeFileSync(attack, [
      'import ctypes, sys',
      "cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')",
      'cf.CFDataCreate.restype = ctypes.c_void_p; cf.CFDataCreate.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long]',
      'cf.CFPropertyListCreateWithData.restype = ctypes.c_void_p',
      'cf.CFPropertyListCreateWithData.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]',
      'label, isca = sys.argv[1], sys.argv[2]',
      "sm = ctypes.CDLL('/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement')",
      "plist = ('<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>%s</string><key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>%s</string></array><key>RunAtLoad</key><true/></dict></plist>' % (label, isca)).encode()",
      'd = cf.CFDataCreate(None, plist, len(plist)); job = cf.CFPropertyListCreateWithData(None, d, 0, None, None)',
      "dom = ctypes.c_void_p.in_dll(sm, 'kSMDomainUserLaunchd')",
      'sm.SMJobSubmit.restype = ctypes.c_bool; sm.SMJobSubmit.argtypes = [ctypes.c_void_p] * 4',
      'sys.exit(0 if sm.SMJobSubmit(dom, job, None, None) else 1)',
      ''
    ].join('\n'));
    const labels: string[] = [];
    try {
      assert.equal(run(false, '/usr/bin/true').status, 0, 'sandbox não aplicado');
      // controle positivo: launchctl submit FORA do sandbox cria e roda um job inofensivo
      labels.push(`${label}.lc`);
      assert.equal(spawnSync('/bin/launchctl', ['submit', '-l', `${label}.lc`, '--', '/usr/bin/touch', bait('lc')]).status, 0);
      await wait();
      assert.equal(fs.existsSync(bait('lc')), true, 'controle: fora do sandbox o launchctl submit roda o job');
      let smjobControl = false;
      if (py) {
        labels.push(`${label}.py`);
        const r0 = spawnSync(py, [attack, `${label}.py`, bait('py')]);
        await wait();
        smjobControl = r0.status === 0 && fs.existsSync(bait('py'));
        if (!smjobControl) console.warn('[A4] SMJobSubmit não funciona fora do sandbox neste macOS: o negativo abaixo vale só como defesa extra');
      }
      for (const w of [false, true]) {
        const t = w ? 'w' : 'r';
        labels.push(`${label}.lc${t}`, `${label}.py${t}`);
        const lc = run(w, `/bin/launchctl submit -l ${label}.lc${t} -- /usr/bin/touch "${bait('lc' + t)}"`);
        assert.notEqual(lc.status, 0);
        if (py) {
          const r = run(w, `"${py}" "${attack}" ${label}.py${t} "${bait('py' + t)}"`);
          assert.notEqual(r.status, 0, `SMJobSubmit dentro do sandbox (writable=${w})`);
        }
        await wait();
        assert.equal(fs.existsSync(bait('lc' + t)), false, 'job do launchctl rodou de dentro do sandbox');
        assert.equal(fs.existsSync(bait('py' + t)), false, 'job do SMJobSubmit rodou de dentro do sandbox');
        // A4: área de transferência (fora ela funciona: controle; a saída é descartada)
        assert.notEqual(run(w, '/usr/bin/pbpaste >/dev/null 2>&1').status, 0, `pbpaste (writable=${w})`);
        assert.notEqual(run(w, 'echo x | /usr/bin/pbcopy 2>/dev/null').status, 0, `pbcopy (writable=${w})`);
      }
      assert.equal(spawnSync('/bin/sh', ['-c', '/usr/bin/pbpaste >/dev/null 2>&1']).status, 0, 'controle: fora do sandbox o pbpaste funciona');
    } finally {
      for (const l of labels) spawnSync('/bin/launchctl', ['remove', l]);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
