import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parsePrivacyConfig, effectivePrivacy, workerPrivacyEnv, DEFAULT_PRIVACY } from '../privacy.js';
import { windowHistory } from '../voice/sessionManager.js';
import { VOICE_LIMITS } from '../../shared/voiceProtocol.js';
import { startServer } from '../server.js';
import type { AppConfig, PrivacyStatus } from '../../shared/types.js';
import type { ConversationMessage } from '../../shared/voiceProtocol.js';

describe('parsePrivacyConfig (Fase 12)', () => {
  it('padrões de produção: tudo ligado exceto o trecho de pesquisa (D1)', () => {
    assert.deepEqual(DEFAULT_PRIVACY, {
      cloud: true,
      cloudIntent: true,
      sendHistory: true,
      historyTurns: VOICE_LIMITS.MAX_CONTEXT_TURNS,
      sendMemories: true,
      sendKnowledge: false
    });
  });

  it('aceita só "0"/"1"; qualquer outro valor LANÇA (nunca adivinha padrão)', () => {
    for (const bad of ['true', 'false', 'yes', 'off', '2', '01', ' 1 x']) {
      assert.throws(() => parsePrivacyConfig({ RODRIGO_CLOUD: bad }), /RODRIGO_CLOUD/, `valor ${JSON.stringify(bad)}`);
    }
    assert.equal(parsePrivacyConfig({ RODRIGO_CLOUD: ' 0 ' }).cloud, false);
    assert.equal(parsePrivacyConfig({ RODRIGO_SEND_KNOWLEDGE: '1' }).sendKnowledge, true);
    assert.equal(parsePrivacyConfig({ RODRIGO_SEND_HISTORY: '' }).sendHistory, true, 'vazio = padrão');
  });

  it('HISTORY_TURNS: inteiro 1..MAX, sem zero à esquerda, sem texto', () => {
    assert.equal(parsePrivacyConfig({ RODRIGO_HISTORY_TURNS: '3' }).historyTurns, 3);
    for (const bad of ['0', '09', '-1', '3.5', 'abc', String(VOICE_LIMITS.MAX_CONTEXT_TURNS + 1), '１２']) {
      assert.throws(() => parsePrivacyConfig({ RODRIGO_HISTORY_TURNS: bad }), /RODRIGO_HISTORY_TURNS/, bad);
    }
  });

  it('workerPrivacyEnv: mestre desligado força a intenção desligada no worker', () => {
    assert.deepEqual(workerPrivacyEnv({ ...DEFAULT_PRIVACY, cloud: false }), { RODRIGO_CLOUD: '0', RODRIGO_CLOUD_INTENT: '0' });
    assert.deepEqual(workerPrivacyEnv({ ...DEFAULT_PRIVACY, cloudIntent: false }), { RODRIGO_CLOUD: '1', RODRIGO_CLOUD_INTENT: '0' });
    assert.deepEqual(workerPrivacyEnv(DEFAULT_PRIVACY), { RODRIGO_CLOUD: '1', RODRIGO_CLOUD_INTENT: '1' });
  });
});

describe('effectivePrivacy (Fase 12)', () => {
  it('com tudo ligado reflete exatamente o gabarito escrito à mão (não circular)', () => {
    const st = effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_SEND_KNOWLEDGE: '1' });
    const gabarito: PrivacyStatus = {
      mode: 'cloud',
      intent: 'gemini',
      keyPresent: true,
      sends: { utteranceForIntent: true, history: true, historyTurns: VOICE_LIMITS.MAX_CONTEXT_TURNS, memories: true, knowledgeSnippet: true },
      models: { generation: 'gemini-flash-latest', intent: 'gemini-3.5-flash-lite' },
      neverSends: ['audio']
    };
    assert.deepEqual(st, gabarito);
  });

  it('mestre desligado: nada sai, mesmo com os sub-controles ligados', () => {
    const st = effectivePrivacy({ RODRIGO_CLOUD: '0', RODRIGO_SEND_KNOWLEDGE: '1', RODRIGO_SEND_MEMORIES: '1' });
    assert.equal(st.mode, 'local-only');
    assert.equal(st.intent, 'local');
    assert.deepEqual(st.sends, { utteranceForIntent: false, history: false, historyTurns: null, memories: false, knowledgeSnippet: false });
    assert.deepEqual(st.models, { generation: null, intent: null });
  });

  it('nunca expõe o valor da chave (nem tamanho): só keyPresent', () => {
    const secret = 'AIzaSyD-SEGREDO-SINTETICO-0123456789';
    const json = JSON.stringify(effectivePrivacy({ GEMINI_API_KEY: secret }));
    assert.ok(!json.includes(secret) && !json.includes('SEGREDO'));
    assert.ok(!/"keyLength"|"length"/.test(json));
    assert.equal(effectivePrivacy({}).keyPresent, false);
    assert.equal(effectivePrivacy({ GEMINI_API_KEY: '   ' }).keyPresent, false);
  });
});

describe('windowHistory (Fase 12)', () => {
  const h = (...r: Array<['user' | 'assistant', string]>): ConversationMessage[] => r.map(([role, content]) => ({ role, content }));

  it('SEND_HISTORY=0: só a última mensagem (a fala atual); vazio => vazio', () => {
    const hist = h(['user', 'a'], ['assistant', 'b'], ['user', 'c']);
    assert.deepEqual(windowHistory(hist, { sendHistory: false, historyTurns: 8 }), [{ role: 'user', content: 'c' }]);
    assert.deepEqual(windowHistory([], { sendHistory: false, historyTurns: 8 }), []);
  });

  it('janela de HISTORY_TURNS turnos e nunca começa por mensagem do assistente', () => {
    const hist = h(['user', '1'], ['assistant', '2'], ['user', '3'], ['assistant', '4'], ['user', '5']);
    const w = windowHistory(hist, { sendHistory: true, historyTurns: 2 });
    assert.deepEqual(w.map((m) => m.content), ['3', '4', '5']); // corte em 4 msgs = [2,3,4,5]; descarta o '2' inicial do assistente
    assert.equal(w[0].role, 'user');
    assert.deepEqual(windowHistory(hist, { sendHistory: true, historyTurns: 8 }).map((m) => m.content), ['1', '2', '3', '4', '5']);
  });
});

describe('GET /api/privacy (Fase 12)', () => {
  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    const port = 26000 + Math.floor(Math.random() * 2000);
    const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
    const server: http.Server = await startServer(config);
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('200 com JSON estrito, sem segredo, no-store; 405 para POST; Host estranho => 403', async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIzaSyD-SEGREDO-ROTA-0123456789';
    try {
      await withServer(async (base) => {
        const res = await fetch(`${base}/api/privacy`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('cache-control') ?? '', /no-store/);
        const text = await res.text();
        assert.ok(!text.includes('SEGREDO'), 'a rota não pode vazar a chave');
        const body = JSON.parse(text) as PrivacyStatus;
        assert.equal(body.keyPresent, true);
        assert.deepEqual(body.neverSends, ['audio']);

        const post = await fetch(`${base}/api/privacy`, { method: 'POST' });
        assert.equal(post.status, 405);

        const bad = await new Promise<number>((resolve, reject) => {
          const u = new URL(`${base}/api/privacy`);
          const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'evil.example.com' } }, (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          });
          rq.on('error', reject);
          rq.end();
        });
        assert.equal(bad, 403);
      });
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    }
  });
});
