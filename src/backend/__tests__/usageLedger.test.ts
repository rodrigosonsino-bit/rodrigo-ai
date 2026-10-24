import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger, parseUsageCaps, msUntilLaMidnight } from '../voice/usageLedger.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-'));
  return path.join(dir, 'usage-ledger.jsonl');
}

describe('UsageLedger', () => {
  it('agrega por (fonte, modelo) com % sobre o teto', () => {
    const ledger = new UsageLedger({ filePath: tmpFile(), now: () => Date.now() });
    ledger.record({ source: 'geracao', model: 'gemini-flash-latest', req: 1, in: 100, out: 20 });
    ledger.record({ source: 'geracao', model: 'gemini-flash-latest', req: 1, in: 50, out: 10 });
    ledger.record({ source: 'tts', model: 'gemini-3.8-flash-lite-tts', req: 1, in: 9, out: 15, chars: 42 });
    const s = ledger.summary();
    assert.equal(s.models.length, 2);
    const g = s.models.find((m) => m.source === 'geracao')!;
    assert.equal(g.req, 2);
    assert.equal(g.inTokens, 150);
    assert.equal(g.outTokens, 30);
    assert.equal(g.cap, 100);
    assert.equal(g.pct, 0.02);
    const t = s.models.find((m) => m.source === 'tts')!;
    assert.equal(t.cap, 90);
    assert.ok(s.resetInMs > 0 && s.resetInMs <= 24 * 3600 * 1000);
  });

  it('satura pct em 1 ao passar do teto', () => {
    const ledger = new UsageLedger({ filePath: tmpFile(), rpd: 2, now: () => Date.now() });
    for (let i = 0; i < 5; i += 1) {
      ledger.record({ source: 'intencao', model: 'm', req: 1, in: null, out: null });
    }
    const s = ledger.summary();
    assert.equal(s.models[0].pct, 1);
  });

  it('persiste entre instâncias e ignora linha corrompida', () => {
    const file = tmpFile();
    const a = new UsageLedger({ filePath: file, now: () => Date.now() });
    a.record({ source: 'visao', model: 'gemini-flash-latest', req: 1, in: 300, out: 25, image: 1 });
    fs.appendFileSync(file, 'não é json\n');
    fs.appendFileSync(file, JSON.stringify({ source: 'x', model: 'y' }) + '\n');
    const b = new UsageLedger({ filePath: file, now: () => Date.now() });
    const s = b.summary();
    assert.equal(s.models.length, 1);
    assert.equal(s.models[0].req, 1);
  });

  it('vira o dia (registros de ontem não entram)', () => {
    const file = tmpFile();
    let now = Date.now();
    const ledger = new UsageLedger({ filePath: file, now: () => now });
    ledger.record({ source: 'geracao', model: 'm', req: 1, in: 1, out: 1 });
    now += 48 * 3600 * 1000;
    ledger.record({ source: 'geracao', model: 'm', req: 1, in: 1, out: 1 });
    const s = ledger.summary();
    assert.equal(s.models[0].req, 1);
  });

  it('parseUsageCaps: padrões e falha alta em inválido', () => {
    assert.deepEqual(parseUsageCaps({}), { rpd: 100, rpdTts: 90 });
    assert.deepEqual(parseUsageCaps({ RODRIGO_USAGE_RPD: '50', RODRIGO_USAGE_RPD_TTS: '40' }), {
      rpd: 50,
      rpdTts: 40
    });
    assert.throws(() => parseUsageCaps({ RODRIGO_USAGE_RPD: 'abc' }), /RODRIGO_USAGE_RPD/);
    assert.throws(() => parseUsageCaps({ RODRIGO_USAGE_RPD_TTS: '0' }), /RODRIGO_USAGE_RPD_TTS/);
  });

  it('msUntilLaMidnight: sempre entre 0 e 24h', () => {
    const now = Date.now();
    const ms = msUntilLaMidnight(now);
    assert.ok(ms > 0 && ms <= 24 * 3600 * 1000, String(ms));
  });
});
