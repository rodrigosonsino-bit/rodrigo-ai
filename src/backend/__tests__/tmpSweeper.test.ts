import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  START_TOLERANCE_MS,
  checkPid,
  ownStartEpochMs,
  parseLstart,
  parseProcessDirName,
  prepareProcessTmpDir,
  processDirName,
  readProcessStartMs,
  sweepStaleTmpDirs,
  type PidState
} from '../voice/tmpSweeper.js';
import { AudioStore } from '../voice/audioStore.js';

const SELF = processDirName(999999, 1700000000000);
const START = 1790000000000;

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-sweep-'));
}
function mkDir(root: string, name: string, withFile = true): string {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, 'sess'), { recursive: true });
  if (withFile) fs.writeFileSync(path.join(d, 'sess', 'out-x.wav'), 'x');
  return d;
}
const psAvailable = readProcessStartMs(process.pid) !== null;

describe('nome do diretório por processo (Fase 12, §2.4)', () => {
  it('ida e volta; rejeita nomes fora do padrão', () => {
    assert.deepEqual(parseProcessDirName(processDirName(4242, START)), { pid: 4242, startEpochMs: START });
    for (const bad of ['', 'abc', '0-1790000000000', '4242-45', '4242', '4242-1790000000000-extra', '9a1c-1790000000000', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', '４２-1790000000000']) {
      assert.equal(parseProcessDirName(bad), null, bad);
    }
  });

  it('ownStartEpochMs é o início do processo (não "agora")', () => {
    const own = ownStartEpochMs();
    assert.ok(own <= Date.now());
    assert.ok(Date.now() - own >= Math.floor(process.uptime() * 1000) - 50);
  });
});

describe('parseLstart / readProcessStartMs — locale (Fase 12, achado 1 da rodada 3)', () => {
  it('locale C vira epoch; pt_BR, vazio e lixo viram null (nunca NaN)', () => {
    assert.equal(typeof parseLstart('Wed Oct  7 10:00:35 2026    '), 'number');
    assert.equal(parseLstart('Wed Oct  7 10:00:35 2026'), new Date('2026-10-07T10:00:35').getTime());
    for (const bad of ['qua  7 out 10:00:35 2026', '', '   ', 'lixo', 'Wed Oct 7', 'Wed Oct  7 25:00:99 2026 extra']) {
      assert.equal(parseLstart(bad), null, JSON.stringify(bad));
    }
  });

  it('readProcessStartMs funciona MESMO com o ambiente em pt_BR (força LC_ALL=C) e bate com o início do processo', (t) => {
    if (!psAvailable) return t.skip('ps indisponível neste ambiente (ex.: sandbox)');
    const saved = { a: process.env.LC_ALL, b: process.env.LANG };
    process.env.LC_ALL = 'pt_BR.UTF-8';
    process.env.LANG = 'pt_BR.UTF-8';
    try {
      const ms = readProcessStartMs(process.pid);
      assert.notEqual(ms, null);
      assert.ok(Math.abs(ms! - ownStartEpochMs()) <= START_TOLERANCE_MS, `ps=${ms} own=${ownStartEpochMs()}`);
    } finally {
      if (saved.a === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved.a;
      if (saved.b === undefined) delete process.env.LANG; else process.env.LANG = saved.b;
    }
  });

  it('pid inexistente => null', () => {
    assert.equal(readProcessStartMs(2147483000), null);
  });
});

describe('checkPid — mapeamento de erros do kill(pid, 0)', () => {
  const thrower = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  it('ESRCH => dead; EPERM => eperm (existe sob outro usuário); sem erro => alive; erro desconhecido => alive (nunca assume morto)', () => {
    assert.equal(checkPid(10, thrower('ESRCH')), 'dead');
    assert.equal(checkPid(10, thrower('EPERM')), 'eperm');
    assert.equal(checkPid(10, () => true), 'alive');
    assert.equal(checkPid(10, thrower('EINVAL')), 'alive');
  });
});

describe('sweepStaleTmpDirs — regras com dependências injetadas', () => {
  const run = (root: string, pid: Record<number, PidState>, start: Record<number, number | null>, extra: { log?: (m: string) => void; now?: () => number } = {}) =>
    sweepStaleTmpDirs(root, {
      selfDirName: SELF,
      pidCheck: (p) => pid[p] ?? 'dead',
      startTime: (p) => (p in start ? start[p] : null),
      ...extra
    });

  it('pid morto => remove; pid vivo e coerente => mantém; pid vivo com início divergente (reciclado) => remove', () => {
    const root = mkRoot();
    const dead = processDirName(1001, START);
    const alive = processDirName(1002, START);
    const recycled = processDirName(1003, START);
    for (const n of [dead, alive, recycled]) mkDir(root, n);
    const r = run(root, { 1001: 'dead', 1002: 'alive', 1003: 'alive' }, { 1002: START + 900, 1003: START + 60_000 });
    assert.deepEqual(r.removed.sort(), [dead, recycled].sort());
    assert.deepEqual(r.kept, [alive]);
    assert.ok(fs.existsSync(path.join(root, alive, 'sess', 'out-x.wav')), 'instância viva intacta');
    assert.ok(!fs.existsSync(path.join(root, dead)));
  });

  it('tolerância FIXADA em 2000 ms (valor literal, não a constante): +2000 mantém, +2001 remove', () => {
    assert.equal(START_TOLERANCE_MS, 2000, 'o plano (§2.4) fixa a tolerância em 2 s');
    const root = mkRoot();
    const a = processDirName(2001, START);
    const b = processDirName(2002, START);
    mkDir(root, a); mkDir(root, b);
    const r = run(root, { 2001: 'alive', 2002: 'alive' }, { 2001: START + 2000, 2002: START + 2001 });
    assert.deepEqual(r.removed, [b]);
    assert.deepEqual(r.kept, [a]);
  });

  it('EPERM é tratado como existente: o início real decide (não existe "vivo eterno")', () => {
    const root = mkRoot();
    const keep = processDirName(3001, START);
    const drop = processDirName(3002, START);
    mkDir(root, keep); mkDir(root, drop);
    const r = run(root, { 3001: 'eperm', 3002: 'eperm' }, { 3001: START + 100, 3002: START - 86_400_000 });
    assert.deepEqual(r.kept, [keep]);
    assert.deepEqual(r.removed, [drop]);
  });

  it('FAIL-SAFE: se o início não puder ser lido (null), NUNCA remove e registra aviso', () => {
    const root = mkRoot();
    const n = processDirName(4001, START);
    mkDir(root, n);
    const logs: string[] = [];
    const r = run(root, { 4001: 'alive' }, { 4001: null }, { log: (m) => logs.push(m) });
    assert.deepEqual(r.removed, []);
    assert.ok(fs.existsSync(path.join(root, n)));
    assert.ok(logs.some((m) => /fail-safe/.test(m)), logs.join('|'));
  });

  it('nunca toca o próprio diretório, mesmo que o pid pareça morto', () => {
    const root = mkRoot();
    mkDir(root, SELF);
    const r = run(root, { 999999: 'dead' }, {});
    assert.deepEqual(r.removed, []);
    assert.ok(fs.existsSync(path.join(root, SELF)));
  });

  it('legado (fora do padrão): remove se parado há > 1 h, mantém se recente', () => {
    const root = mkRoot();
    const oldDir = mkDir(root, 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    const newDir = mkDir(root, '0e02b2c3-d479-4372-a567-f47ac10b58cc');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(oldDir, twoHoursAgo, twoHoursAgo);
    const r = run(root, {}, {});
    assert.deepEqual(r.removed, [path.basename(oldDir)]);
    assert.ok(fs.existsSync(newDir));
  });

  it('ignora arquivos soltos e NÃO segue link simbólico (o alvo sobrevive)', () => {
    const root = mkRoot();
    const outside = mkRoot();
    fs.writeFileSync(path.join(outside, 'precioso.txt'), 'não apagar');
    fs.symlinkSync(outside, path.join(root, processDirName(5001, START)));
    fs.writeFileSync(path.join(root, 'solto.wav'), 'x');
    const r = run(root, { 5001: 'dead' }, {});
    assert.deepEqual(r.removed, []);
    assert.ok(fs.existsSync(path.join(outside, 'precioso.txt')));
    assert.ok(fs.existsSync(path.join(root, 'solto.wav')));
  });

  it('base inexistente => resultado vazio, sem lançar', () => {
    assert.deepEqual(run(path.join(os.tmpdir(), 'nao-existe-' + Date.now()), {}, {}), { removed: [], kept: [] });
  });
});

describe('sweepStaleTmpDirs — processos REAIS (H12.4)', () => {
  function liveChild(): ChildProcess {
    return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  }
  async function waitDead(pid: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && checkPid(pid) !== 'dead') await new Promise((r) => setTimeout(r, 20));
  }

  it('instância viva real fica intacta; órfão de pid morto e pid reciclado somem', async (t) => {
    if (!psAvailable) return t.skip('ps indisponível neste ambiente (ex.: sandbox)');
    const root = mkRoot();
    const live = liveChild();
    const doomed = liveChild();
    try {
      await new Promise((r) => setTimeout(r, 150));
      const liveStart = readProcessStartMs(live.pid!)!;
      assert.ok(liveStart > 0);
      const liveName = processDirName(live.pid!, liveStart);
      const recycledName = processDirName(live.pid!, liveStart - 60_000); // mesmo pid vivo, início diferente
      const deadName = processDirName(doomed.pid!, readProcessStartMs(doomed.pid!)!);
      mkDir(root, liveName); mkDir(root, recycledName); mkDir(root, deadName);
      doomed.kill('SIGKILL');
      await waitDead(doomed.pid!);

      const r = sweepStaleTmpDirs(root, { selfDirName: SELF });
      assert.deepEqual(r.removed.sort(), [deadName, recycledName].sort());
      assert.deepEqual(r.kept, [liveName]);
      assert.ok(fs.existsSync(path.join(root, liveName, 'sess', 'out-x.wav')), 'a pasta da instância viva continua com seu arquivo');
    } finally {
      live.kill('SIGKILL');
      doomed.kill('SIGKILL');
    }
  });

  it('EPERM real (pid 1, outro usuário): o início real decide', (t) => {
    if (!psAvailable) return t.skip('ps indisponível neste ambiente');
    if (typeof process.getuid === 'function' && process.getuid() === 0) return t.skip('rodando como root: kill(1,0) não dá EPERM');
    if (checkPid(1) !== 'eperm') return t.skip(`kill(1,0) => ${checkPid(1)} neste sistema`);
    const start1 = readProcessStartMs(1);
    assert.notEqual(start1, null, 'ps -o lstart= -p 1 deve funcionar sem privilégio');
    const root = mkRoot();
    const keep = processDirName(1, start1!);
    const drop = processDirName(1, start1! + 5 * 24 * 3600 * 1000);
    mkDir(root, keep); mkDir(root, drop);
    const r = sweepStaleTmpDirs(root, { selfDirName: SELF });
    assert.deepEqual(r.kept, [keep]);
    assert.deepEqual(r.removed, [drop]);
  });

  it('kill -9 no meio do uso: a pasta do processo morto é limpa na inicialização seguinte', (t) => {
    const root = mkRoot();
    const modUrl = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'voice', 'tmpSweeper.js')).href;
    const script = `
      import { ownStartEpochMs, processDirName } from ${JSON.stringify(modUrl)};
      import fs from 'node:fs'; import path from 'node:path';
      const dir = path.join(process.argv[1], processDirName(process.pid, ownStartEpochMs()));
      fs.mkdirSync(path.join(dir, 'sess'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sess', 'in-x.wav'), 'x');
      fs.writeFileSync(path.join(dir, 'sess', 'out-x.wav.aiff'), 'x');
      process.kill(process.pid, 'SIGKILL');
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { stdio: 'ignore' });
    assert.equal(child.signal, 'SIGKILL');
    const before = fs.readdirSync(root);
    assert.equal(before.length, 1, 'o processo morto deixou exatamente a sua pasta');
    const r = sweepStaleTmpDirs(root, { selfDirName: SELF });
    assert.deepEqual(r.removed, before);
    assert.deepEqual(fs.readdirSync(root), [], 'zero resíduos .wav/.aiff após a limpeza');
  });
});

describe('AudioStore dentro do diretório do processo (Fase 12)', () => {
  it('dirFor recria a pasta da sessão se alguém a apagou (sem ENOENT)', () => {
    const base = path.join(mkRoot(), processDirName(process.pid, ownStartEpochMs()));
    const store = new AudioStore(base);
    const first = store.newOutputPath('s1');
    fs.writeFileSync(first.filePath, 'x');
    fs.rmSync(path.dirname(first.filePath), { recursive: true, force: true }); // "outra instância" apagou
    const second = store.newOutputPath('s1');
    assert.doesNotThrow(() => fs.writeFileSync(second.filePath, 'y'));
  });

  it('dispose() remove o diretório do processo e não recria', async () => {
    const root = mkRoot();
    const base = path.join(root, processDirName(process.pid, ownStartEpochMs()));
    const store = new AudioStore(base);
    fs.writeFileSync(store.newOutputPath('s1').filePath, 'x');
    await store.dispose();
    assert.ok(!fs.existsSync(base));
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('cleanupSession remove só a sessão (e um .aiff ao lado do .wav vai junto)', async () => {
    const base = path.join(mkRoot(), processDirName(process.pid, ownStartEpochMs()));
    const store = new AudioStore(base);
    const out = store.newOutputPath('s1');
    fs.writeFileSync(out.filePath, 'x');
    fs.writeFileSync(`${out.filePath}.aiff`, 'x'); // como o TTS say passa a fazer
    const other = store.newOutputPath('s2');
    fs.writeFileSync(other.filePath, 'x');
    await store.cleanupSession('s1');
    assert.ok(!fs.existsSync(`${out.filePath}.aiff`));
    assert.ok(fs.existsSync(other.filePath), 'outra sessão intacta');
  });
});

describe('prepareProcessTmpDir e a ligação no voiceRuntime (Fase 12)', () => {
  it('varre os órfãos, devolve o diretório próprio <pid>-<início> e não o cria (o AudioStore cria sob demanda)', () => {
    const root = mkRoot();
    const orphan = mkDir(root, processDirName(2147483000, START)); // pid inexistente
    const r = prepareProcessTmpDir(root);
    assert.deepEqual(r.removed, [path.basename(orphan)]);
    assert.equal(path.basename(r.dir), r.selfDirName);
    const parsed = parseProcessDirName(r.selfDirName)!;
    assert.equal(parsed.pid, process.pid);
    assert.ok(Math.abs(parsed.startEpochMs - ownStartEpochMs()) < 1000);
    assert.ok(!fs.existsSync(r.dir));
  });

  it('quando a base temporária é symlink, devolve o caminho REAL do processo', () => {
    const base = mkRoot();
    const realRoot = path.join(base, 'real-tmp');
    const linkRoot = path.join(base, 'linked-tmp');
    fs.mkdirSync(realRoot, { recursive: true });
    fs.symlinkSync(realRoot, linkRoot);
    const r = prepareProcessTmpDir(linkRoot);
    assert.equal(path.dirname(r.dir), fs.realpathSync.native(realRoot));
    assert.equal(path.basename(r.dir), r.selfDirName);
  });

  it('o voiceRuntime realmente usa a varredura e o dispose (guarda estrutural: a ligação não tem teste de integração sem os modelos)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'backend', 'voice', 'voiceRuntime.ts'), 'utf-8');
    assert.match(src, /prepareProcessTmpDir\(tmpRoot/);
    assert.match(src, /new AudioStore\(tmp\.dir\)/);
    assert.match(src, /RODRIGO_FILE_ROOTS:/);
    assert.match(src, /await audioStore\.dispose\(\)/);
    assert.ok(!/new AudioStore\(path\.join\(rootDir, '\.runtime', 'tmp'\)\)/.test(src), 'o AudioStore não pode voltar a usar a base compartilhada');
    assert.ok(!/cleanupAll\(\)/.test(src), 'nenhum rm -rf cego da base');
  });
});
