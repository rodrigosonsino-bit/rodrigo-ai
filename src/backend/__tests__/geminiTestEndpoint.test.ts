import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseGeminiBaseUrl, workerGeminiEnv } from '../geminiTestEndpoint.js';

const CASES = (JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'src', 'backend', '__tests__', 'fixtures', 'gemini-base-url-cases.json'), 'utf-8')
) as { cases: Array<{ input: string; accept: boolean }> }).cases;

describe('parseGeminiBaseUrl — mesmos casos do worker Python (Fase 12, §2.5)', () => {
  it('o arquivo de casos foi carregado (≥40, com aceitos e rejeitados)', () => {
    assert.ok(CASES.length >= 40);
    assert.ok(CASES.some((c) => c.accept) && CASES.some((c) => !c.accept));
  });

  for (const c of CASES) {
    it(`${c.accept ? 'aceita' : 'REJEITA'} ${JSON.stringify(c.input)}`, () => {
      assert.equal(parseGeminiBaseUrl(c.input), c.accept ? c.input : null);
    });
  }

  it('o regex antigo (\\d{1,5}$ com match) aceitaria payloads que este rejeita (controle: a bateria discrimina)', () => {
    const OLD = /^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/;
    const bad = CASES.filter((c) => !c.accept && OLD.test(c.input));
    assert.ok(bad.length >= 4, `o regex antigo deveria deixar passar ≥4 payloads ruins; deixou ${bad.length}: ${JSON.stringify(bad.map((b) => b.input))}`);
  });
});

describe('workerGeminiEnv — o que o worker recebe (sempre definido, para sobrescrever o ambiente herdado)', () => {
  const warns: string[] = [];
  const warn = (m: string): void => { warns.push(m); };

  it('sem a variável: vazia, sem aviso', () => {
    warns.length = 0;
    assert.deepEqual(workerGeminiEnv({}, warn), { RODRIGO_GEMINI_BASE_URL: '' });
    assert.equal(warns.length, 0);
  });
  it('com a variável mas SEM RODRIGO_TEST=1: ignorada (vazia) com aviso — nunca vai ao worker', () => {
    warns.length = 0;
    assert.deepEqual(workerGeminiEnv({ RODRIGO_GEMINI_BASE_URL: 'http://127.0.0.1:9000' }, warn), { RODRIGO_GEMINI_BASE_URL: '' });
    assert.equal(warns.length, 1);
    assert.deepEqual(workerGeminiEnv({ RODRIGO_GEMINI_BASE_URL: 'http://127.0.0.1:9000', RODRIGO_TEST: '0' }, warn), { RODRIGO_GEMINI_BASE_URL: '' });
  });
  it('modo de teste + URL válida: repassada', () => {
    assert.deepEqual(workerGeminiEnv({ RODRIGO_GEMINI_BASE_URL: 'http://[::1]:5555', RODRIGO_TEST: '1' }), { RODRIGO_GEMINI_BASE_URL: 'http://[::1]:5555' });
  });
  it('modo de teste + URL inválida: vazia com aviso (o Node nunca repassa o que o regex rejeita)', () => {
    warns.length = 0;
    for (const bad of ['http://evil.com:9000', 'http://localhost:9000', 'http://127.0.0.1@evil.com:9000', 'http://127.0.0.1:9000/']) {
      assert.deepEqual(workerGeminiEnv({ RODRIGO_GEMINI_BASE_URL: bad, RODRIGO_TEST: '1' }, warn), { RODRIGO_GEMINI_BASE_URL: '' }, bad);
    }
    assert.equal(warns.length, 4);
  });
});
