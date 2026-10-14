import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MlxWorkerEngine } from '../voice/mlxWorkerEngine.js';
import { HAVE_VENV, VENV_PY, WORKER } from './helpers/egress.js';

/**
 * T2: o cliente `fileRead`/`fileWrite` do Node contra o worker Python REAL (sem modelos). Cobre a política de ponta a ponta
 * (nome, symlink, hard link, escrita com destino final), a confirmação por sha256 e a falha FECHADA com o worker morto.
 * Pula (declarando) quando o venv do worker não existe.
 */
const skip = !HAVE_VENV ? 'venv do worker ausente (npm run setup:voice)' : false;
const SECRET = 'SEGREDO-FALSO-123';

describe('T2: arquivos pela política do worker (IPC)', { skip }, () => {
  let tmp: string;
  let engine: MlxWorkerEngine;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-ipc-')));
    fs.writeFileSync(path.join(tmp, 'ok.txt'), 'conteudo');
    fs.writeFileSync(path.join(tmp, '.env'), SECRET);
    fs.symlinkSync(path.join(tmp, '.env'), path.join(tmp, 'link.txt'));
    fs.linkSync(path.join(tmp, '.env'), path.join(tmp, 'inofensivo.txt'));
    engine = new MlxWorkerEngine({
      pythonBin: VENV_PY,
      workerScript: WORKER,
      hfCacheDir: path.join(tmp, 'hf'),
      env: { RODRIGO_TEST: '1', RODRIGO_WORKER_NO_MODELS: '1', RODRIGO_FILE_ROOTS: tmp }
    });
    await engine.waitUntilReady(20000);
  });
  afterEach(async () => {
    await engine.shutdown().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lê arquivo comum e devolve os bytes, o tamanho e a classe', async () => {
    const r = await engine.fileRead(path.join(tmp, 'ok.txt'));
    assert.equal(r.ok, true);
    if (r.ok) { assert.equal(r.data.toString(), 'conteudo'); assert.equal(r.size, 8); assert.equal(r.fileClass, 'ordinary'); }
  });

  it('recusa .env, symlink para o .env e hard link com nome inofensivo — sem devolver o conteúdo', async () => {
    for (const [name, reason] of [['.env', 'sensitive'], ['link.txt', 'symlink']] as const) {
      const r = await engine.fileRead(path.join(tmp, name));
      assert.deepEqual(r, { ok: false, reason });
    }
    // o hard link só é pego pelo inode carregado na inicialização do worker: criado ANTES do boot, então vale aqui
    const h = await engine.fileRead(path.join(tmp, 'inofensivo.txt'));
    assert.deepEqual(h, { ok: false, reason: 'sensitive' });
    assert.doesNotMatch(JSON.stringify(h), /SEGREDO/);
  });

  it('recusa caminho fora das raízes, relativo, e arquivo grande demais', async () => {
    assert.equal((await engine.fileRead('/etc/hosts') as { reason: string }).reason, 'bad_request');
    assert.equal((await engine.fileRead('relativo/x') as { reason: string }).reason, 'bad_request');
    assert.equal((await engine.fileRead(path.join(tmp, 'ok.txt'), 3) as { reason: string }).reason, 'too_large');
    assert.equal((await engine.fileRead(path.join(tmp, 'nao-existe')) as { reason: string }).reason, 'not_found');
  });

  it('escreve e confere o sha256; não escreve em destino sensível, em symlink nem em hard link', async () => {
    const data = Buffer.from('dados novos');
    const w = await engine.fileWrite(path.join(tmp, 'novo.txt'), data);
    assert.equal(w.ok, true);
    if (w.ok) assert.equal(w.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(fs.readFileSync(path.join(tmp, 'novo.txt'), 'utf-8'), 'dados novos');
    for (const [name, reason] of [['.env', 'sensitive'], ['novo.pem', 'sensitive'], ['link.txt', 'symlink'], ['inofensivo.txt', 'sensitive']] as const) {
      assert.deepEqual(await engine.fileWrite(path.join(tmp, name), Buffer.from('X')), { ok: false, reason });
    }
    assert.equal(fs.readFileSync(path.join(tmp, '.env'), 'utf-8'), SECRET, 'o segredo não pode ser truncado nem alterado');
    assert.equal(fs.existsSync(path.join(tmp, 'novo.pem')), false, 'destino sensível inexistente não é criado');
  });

  it('falha FECHADA: com o worker encerrado, nada é lido nem gravado direto pelo Node', async () => {
    await engine.shutdown();
    assert.deepEqual(await engine.fileRead(path.join(tmp, 'ok.txt')), { ok: false, reason: 'worker_unavailable' });
    assert.deepEqual(await engine.fileWrite(path.join(tmp, 'x.txt'), Buffer.from('x')), { ok: false, reason: 'worker_unavailable' });
    assert.equal(fs.existsSync(path.join(tmp, 'x.txt')), false);
  });
});
