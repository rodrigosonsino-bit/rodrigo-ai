import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_FAILURE_TEXT } from '../../shared/voiceProtocol.js';
import { HAVE_VENV, REAL_LOOKING_KEY, startEgressHarness, type EgressHarness } from './helpers/egress.js';

/**
 * Plano B da geração (decisão do usuário, 2026-10-07): se o gemini-flash-latest falhar ANTES de qualquer frase ser
 * dita (5xx, timeout, 404, 429), o worker tenta o gemini-3.5-flash-lite com as MESMAS mensagens. Falha depois de uma
 * frase dita, ou erro de requisição/credencial (400/401/403), NÃO tenta de novo. Cadeia real: worker Python -> Gemini falso.
 */
const skip = !HAVE_VENV && 'venv do worker (.runtime/.venv) ausente';
const PRIMARY = 'gemini-flash-latest';
const FALLBACK = 'gemini-3.5-flash-lite';
const MEM = 'MARCADOR-MEMORIA-FB-77';

async function turn(h: EgressHarness, text: string) {
  const s = await h.newSession();
  const r = await h.say(s, text);
  s.close();
  return r;
}

describe('geração com plano B (Fase 12 / pedido do usuário) — worker real, Gemini falso', { skip }, () => {
  for (const status of [503, 500, 404, 429]) {
    it(`principal responde ${status}: o plano B responde, com as MESMAS mensagens, e o usuário ouve a resposta`, async () => {
      const h = await startEgressHarness({ memories: [MEM] });
      try {
        h.gemini.modelModes[PRIMARY] = { kind: 'status', status, echo: 'sobrecarga simulada' };
        const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
        assert.deepEqual(h.gemini.streamModels(), [PRIMARY, FALLBACK], 'ordem dos modelos');
        assert.ok(!r.spoken.includes(GENERATION_FAILURE_TEXT), `não deve cair na fala de falha: ${JSON.stringify(r.spoken)}`);
        assert.equal(r.spoken.length, 2, JSON.stringify(r.spoken));
        const [a, b] = h.gemini.streamRequests();
        // Fronteira de dados: o plano B recebe EXATAMENTE as mesmas mensagens e o mesmo prompt. A ÚNICA diferença permitida entre as
        // duas requisições é o raciocínio desligado no principal (thinking_budget 0): sem isso o flash-latest gasta 150 dos 160 tokens
        // pensando e a resposta sai cortada (medido em 2026-10-08), e o reserva rejeita esse parâmetro com HTTP 400.
        const pa = JSON.parse(a.body) as { contents: unknown; systemInstruction?: unknown; generationConfig?: Record<string, unknown> };
        const pb = JSON.parse(b.body) as { contents: unknown; systemInstruction?: unknown; generationConfig?: Record<string, unknown> };
        assert.deepEqual(pa.contents, pb.contents, 'as mesmas mensagens');
        assert.deepEqual(pa.systemInstruction, pb.systemInstruction, 'o mesmo prompt de sistema');
        assert.deepEqual(pa.generationConfig?.thinking_config ?? pa.generationConfig?.thinkingConfig, { thinking_budget: 0 }, 'principal: raciocínio desligado (o SDK serializa em snake_case, formato aceito pelo Google)');
        assert.ok(pb.generationConfig?.thinking_config === undefined && pb.generationConfig?.thinkingConfig === undefined, 'plano B: sem thinking_config (o modelo reserva o rejeita)');
        const { thinking_config: _ta, thinkingConfig: _ta2, ...restA } = pa.generationConfig ?? {};
        const { thinking_config: _tb, thinkingConfig: _tb2, ...restB } = pb.generationConfig ?? {};
        assert.deepEqual(restA, restB, 'o resto da configuração é idêntico');
        assert.ok(b.body.includes(MEM) && b.body.includes('MARCADOR-FALA-FB'));
        for (const req of h.gemini.requests) {
          assert.equal(req.headers['x-goog-api-key'], 'test-dummy-key');
          assert.ok(!req.body.includes(REAL_LOOKING_KEY));
        }
        assert.ok(h.logs.join('\n').includes(`tentando ${FALLBACK}`), 'o fallback fica registrado nos logs');
      } finally {
        await h.stop();
      }
    });
  }

  it('principal TRAVADO: estoura o prazo e o plano B responde em seguida', async () => {
    const h = await startEgressHarness({ workerEnv: { RODRIGO_TEST_GEMINI_TIMEOUT_MS: '1500' } });
    try {
      h.gemini.modelModes[PRIMARY] = { kind: 'hang' };
      const t0 = Date.now();
      const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
      assert.ok(Date.now() - t0 < 9000, `demorou ${Date.now() - t0} ms`);
      assert.deepEqual(h.gemini.streamModels(), [PRIMARY, FALLBACK]);
      assert.equal(r.spoken.length, 2, JSON.stringify(r.spoken));
    } finally {
      await h.stop();
    }
  });

  for (const status of [400, 401, 403]) {
    it(`erro ${status} (igual em qualquer modelo): NÃO tenta o plano B e diz a verdade`, async () => {
      const h = await startEgressHarness();
      try {
        h.gemini.modelModes[PRIMARY] = { kind: 'status', status, echo: 'x' };
        const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
        assert.deepEqual(h.gemini.streamModels(), [PRIMARY], 'só uma tentativa');
        assert.ok(r.spoken.includes(GENERATION_FAILURE_TEXT), JSON.stringify(r.spoken));
      } finally {
        await h.stop();
      }
    });
  }

  it('os DOIS falham: duas tentativas, fala de falha honesta, nada vaza nos logs', async () => {
    const h = await startEgressHarness();
    try {
      h.gemini.mode = { kind: 'status', status: 503, echo: 'AIzaSyD-ECO-FALLBACK-0123456789' };
      const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
      assert.deepEqual(h.gemini.streamModels(), [PRIMARY, FALLBACK]);
      assert.ok(r.spoken.includes(GENERATION_FAILURE_TEXT));
      const all = h.logs.join('\n');
      assert.ok(!all.includes('ECO-FALLBACK') && !all.includes(REAL_LOOKING_KEY), all.slice(0, 800));
    } finally {
      await h.stop();
    }
  });

  it('falha NO MEIO, depois de uma frase dita: NÃO recomeça nem duplica (1 requisição, a frase uma única vez)', async () => {
    const h = await startEgressHarness();
    try {
      h.gemini.modelModes[PRIMARY] = { kind: 'break-after-sentence' };
      const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
      assert.deepEqual(h.gemini.streamModels(), [PRIMARY], 'sem plano B depois de a resposta já ter começado');
      assert.deepEqual(r.spoken, ['Primeira frase completa.'], JSON.stringify(r.spoken));
    } finally {
      await h.stop();
    }
  });

  it('redirecionamento 307 no principal não é motivo de plano B (e o destino segue sem receber nada)', async () => {
    const h = await startEgressHarness();
    try {
      h.gemini.modelModes[PRIMARY] = { kind: 'redirect', to: 'http://127.0.0.1:9/exfil' };
      const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
      assert.deepEqual(h.gemini.streamModels(), [PRIMARY]);
      assert.ok(r.spoken.includes(GENERATION_FAILURE_TEXT));
    } finally {
      await h.stop();
    }
  });

  it('com o principal saudável, o plano B nunca é tocado', async () => {
    const h = await startEgressHarness();
    try {
      const r = await turn(h, 'conta uma curiosidade MARCADOR-FALA-FB');
      assert.deepEqual(h.gemini.streamModels(), [PRIMARY]);
      assert.equal(r.spoken.length, 2);
    } finally {
      await h.stop();
    }
  });
});
