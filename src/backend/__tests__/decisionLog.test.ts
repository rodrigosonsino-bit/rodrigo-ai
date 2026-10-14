import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditSchemaError, DecisionLog, normalizeName, realAuditFs, sanitize, withAudit, type AuditFs, type AuditIntent } from '../audit/decisionLog.js';

/** T4: uma barreira por teste (allow-list, normalização, guarda residual, cadeia de hashes, protocolo em duas fases). */
const intent = (over: Partial<AuditIntent> = {}): AuditIntent => ({
  kind: 'intent', mid: 'm-1', turnId: 'turno-1', action: 'LEMBRETE_CRIAR', tool: 'LembreteTool', executor: 'tool', dataClass: 'ordinary', ...over
});

describe('T4: registro de decisões sem conteúdo', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')); file = path.join(dir, 'audit', 'decisions.jsonl'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('(1) lista fechada (allow-list/DTO)', () => {
    it('propriedade extra livre é REJEITADA e nada é gravado', () => {
      const log = new DecisionLog(file);
      assert.throws(() => log.append({ ...intent(), query: 'cria um lembrete de comprar pão' }), AuditSchemaError);
      assert.throws(() => log.append({ ...intent(), error: 'texto livre de erro' }), AuditSchemaError);
      assert.equal(fs.existsSync(file), false);
    });
    it('propriedade ausente, kind desconhecido e enumerado fora da lista são rejeitados', () => {
      const { tool: _t, ...faltando } = intent();
      assert.throws(() => sanitize(faltando), AuditSchemaError);
      assert.throws(() => sanitize({ ...intent(), kind: 'outro' }), AuditSchemaError);
      assert.throws(() => sanitize({ ...intent(), dataClass: 'segredo' }), AuditSchemaError);
      assert.throws(() => sanitize({ kind: 'completion', mid: 'm', turnId: 't', outcome: 'quem-sabe', ms: 1 }), AuditSchemaError);
    });
    it('texto livre (espaços, acentos, aspas) não passa nos campos de texto', () => {
      assert.throws(() => sanitize(intent({ tool: 'compre pão amanhã' })), AuditSchemaError);
      assert.throws(() => sanitize(intent({ action: 'LEMBRETE("x")' })), AuditSchemaError);
    });
  });

  describe('(2) normalização', () => {
    it('nome de ferramenta com argumento embutido é cortado no primeiro caractere fora do identificador', () => {
      assert.equal(normalizeName('LembreteTool("compre pão")'), 'LembreteTool');
      assert.equal(normalizeName('NotaTool com texto'), 'NotaTool');
      assert.equal(normalizeName('  '), 'desconhecido');
    });
  });

  describe('(3) guarda residual da T1 em block', () => {
    it('um marcador sensível que passa no alfabeto é DESCARTADO e contado; o valor nunca chega ao arquivo', () => {
      const log = new DecisionLog(file);
      const chave = 'AIzaSyD1234567890abcdefghijklmnopqrstuvw'; // 39 caracteres, formato de chave de API
      const rec = log.append(intent({ tool: chave }));
      assert.equal(rec.tool, '[descartado]');
      assert.equal(log.droppedFields, 1);
      assert.equal(fs.readFileSync(file, 'utf-8').includes('AIzaSy'), false);
    });
  });

  describe('(4) cadeia de hashes', () => {
    it('registros encadeados verificam; adulterar, remover ou reordenar é detectado', () => {
      const log = new DecisionLog(file);
      log.append(intent({ mid: 'a' }));
      log.append({ kind: 'completion', mid: 'a', turnId: 'turno-1', outcome: 'ok', ms: 5 });
      log.append(intent({ mid: 'b' }));
      assert.deepEqual(log.verify(), { ok: true, count: 3 });
      const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
      // adulteração do conteúdo
      fs.writeFileSync(file, [lines[0].replace('LembreteTool', 'OutraTool'), lines[1], lines[2]].join('\n') + '\n');
      let v = log.verify(); assert.equal(v.ok, false); if (!v.ok) assert.match(v.reason, /adulterado/);
      // remoção do meio
      fs.writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
      v = log.verify(); assert.equal(v.ok, false); if (!v.ok) assert.match(v.reason, /encadeamento|sequência/);
      // reordenação
      fs.writeFileSync(file, [lines[1], lines[0], lines[2]].join('\n') + '\n');
      assert.equal(log.verify().ok, false);
    });
    it('reabrir o arquivo continua a MESMA cadeia (seq e hash anterior)', () => {
      const a = new DecisionLog(file); a.append(intent({ mid: 'a' }));
      const b = new DecisionLog(file); b.append(intent({ mid: 'b' }));
      assert.deepEqual(b.verify(), { ok: true, count: 2 });
    });
    it('intenção sem conclusão aparece como pendente (indeterminada)', () => {
      const log = new DecisionLog(file);
      log.append(intent({ mid: 'a' })); log.append(intent({ mid: 'b' }));
      log.append({ kind: 'completion', mid: 'a', turnId: 'turno-1', outcome: 'ok', ms: 1 });
      assert.deepEqual(log.pending(), ['b']);
    });
  });

  describe('(5) protocolo em duas fases (falha de escrita injetada por um invólucro do sistema de arquivos)', () => {
    function flaky(failOn: number): AuditFs & { writes: number } {
      const f = { writes: 0, mkdir: realAuditFs.mkdir, read: realAuditFs.read, append(file: string, line: string): void {
        f.writes += 1;
        if (f.writes === failOn) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        realAuditFs.append(file, line);
      } };
      return f;
    }
    const { kind: _k, ...base } = intent();

    it('uma escrita que FALHA não avança a cadeia: o próximo registro continua do último gravado e a cadeia verifica', () => {
      const io = flaky(1);
      const log = new DecisionLog(file, io);
      assert.throws(() => log.append(intent({ mid: 'perdida' })));
      const rec = log.append(intent({ mid: 'gravada' }));
      assert.equal(rec.seq, 1, 'seq não pode ter avançado com a escrita que falhou');
      assert.deepEqual(log.verify(), { ok: true, count: 1 });
    });
    it('fase 1 falha => a mutação é RECUSADA e run() nem é chamado', async () => {
      const log = new DecisionLog(file, flaky(1));
      let ran = 0;
      const r = await withAudit(log, base, async () => { ran += 1; return 'ok'; }, () => 'ok');
      assert.deepEqual(r, { refused: true });
      assert.equal(ran, 0);
    });
    it('fase 2 falha => a mutação JÁ ocorreu, não é desfeita, e conclusionLost avisa', async () => {
      const log = new DecisionLog(file, flaky(2));
      let ran = 0;
      const r = await withAudit(log, base, async () => { ran += 1; return 'feito'; }, () => 'ok');
      assert.equal(ran, 1);
      assert.deepEqual(r, { refused: false, result: 'feito', conclusionLost: true });
      assert.deepEqual(log.pending(), ['m-1'], 'a intenção ficou sem conclusão');
    });
    it('caminho feliz grava intenção e conclusão com o mesmo mid', async () => {
      const log = new DecisionLog(file);
      const r = await withAudit(log, base, async () => 'ok', () => 'ok');
      assert.equal(r.refused, false); if (!r.refused) assert.equal(r.conclusionLost, false);
      assert.deepEqual(log.verify(), { ok: true, count: 2 });
      assert.deepEqual(log.pending(), []);
    });
    it('exceção em run() grava conclusão failed e propaga o erro', async () => {
      const log = new DecisionLog(file);
      await assert.rejects(withAudit(log, base, async () => { throw new Error('boom'); }, () => 'ok'), /boom/);
      const last = JSON.parse(fs.readFileSync(file, 'utf-8').trim().split('\n').pop()!) as { outcome: string };
      assert.equal(last.outcome, 'failed');
    });
    it('marcadores plantados em fala, resposta e argumentos NÃO chegam ao arquivo', async () => {
      const log = new DecisionLog(file);
      await withAudit(log, base, async () => 'SEGREDO-NA-RESPOSTA cpf 529.982.247-25', () => 'ok');
      const txt = fs.readFileSync(file, 'utf-8');
      assert.doesNotMatch(txt, /SEGREDO|529\.982/);
    });
  });
});
