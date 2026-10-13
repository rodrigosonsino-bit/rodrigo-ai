import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parsePrivacyConfig, effectivePrivacy, workerPrivacyEnv, DEFAULT_PRIVACY } from '../privacy.js';
import { windowHistory } from '../voice/sessionManager.js';
import { VOICE_LIMITS } from '../../shared/voiceProtocol.js';
import { startServer } from '../server.js';
import { describeTtsStatus, describePrivacy, PRIVACY_UNAVAILABLE_TEXT, FREE_TIER_NOTICE } from '../../shared/privacyText.js';
import { ExtensionRegistry } from '../../shared/extensions/registry.js';
import type { AppConfig, PrivacyStatus, TtsStatus } from '../../shared/types.js';
import { findViolations } from './privacyClaims.js';
import type { ConversationMessage } from '../../shared/voiceProtocol.js';

describe('parsePrivacyConfig (Fase 12)', () => {
  it('padrões de produção: tudo ligado exceto o trecho de pesquisa (D1), a imagem da tela (Fase V) e a busca web', () => {
    assert.deepEqual(DEFAULT_PRIVACY, {
      cloud: true,
      cloudIntent: true,
      sendHistory: true,
      historyTurns: VOICE_LIMITS.MAX_CONTEXT_TURNS,
      sendMemories: true,
      sendKnowledge: false,
      cloudTts: true,
      ttsDictated: true,
      cloudVision: false,
      webSearch: false,
      outboundGuard: 'redact'
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

  it('RODRIGO_OUTBOUND_GUARD (T1): aceita off|warn|redact|block; vazio = redact; qualquer outro valor LANÇA', () => {
    for (const m of ['off', 'warn', 'redact', 'block'] as const) {
      assert.equal(parsePrivacyConfig({ RODRIGO_OUTBOUND_GUARD: m }).outboundGuard, m);
    }
    assert.equal(parsePrivacyConfig({ RODRIGO_OUTBOUND_GUARD: ' block ' }).outboundGuard, 'block');
    assert.equal(parsePrivacyConfig({ RODRIGO_OUTBOUND_GUARD: '' }).outboundGuard, 'redact');
    assert.equal(parsePrivacyConfig({}).outboundGuard, 'redact');
    for (const bad of ['REDACT', 'on', '1', 'true', 'mask', 'redact,block']) {
      assert.throws(() => parsePrivacyConfig({ RODRIGO_OUTBOUND_GUARD: bad }), /RODRIGO_OUTBOUND_GUARD/, `valor ${JSON.stringify(bad)}`);
    }
  });

  it('HISTORY_TURNS: inteiro 1..MAX, sem zero à esquerda, sem texto', () => {
    assert.equal(parsePrivacyConfig({ RODRIGO_HISTORY_TURNS: '3' }).historyTurns, 3);
    for (const bad of ['0', '09', '-1', '3.5', 'abc', String(VOICE_LIMITS.MAX_CONTEXT_TURNS + 1), '１２']) {
      assert.throws(() => parsePrivacyConfig({ RODRIGO_HISTORY_TURNS: bad }), /RODRIGO_HISTORY_TURNS/, bad);
    }
  });

  it('workerPrivacyEnv: mestre desligado força a intenção desligada no worker', () => {
    assert.deepEqual(workerPrivacyEnv({ ...DEFAULT_PRIVACY, cloud: false }), { RODRIGO_CLOUD: '0', RODRIGO_CLOUD_INTENT: '0', RODRIGO_CLOUD_TTS: '0', RODRIGO_CLOUD_VISION: '0', RODRIGO_OUTBOUND_GUARD: 'redact' });
    assert.deepEqual(workerPrivacyEnv({ ...DEFAULT_PRIVACY, cloudIntent: false }), { RODRIGO_CLOUD: '1', RODRIGO_CLOUD_INTENT: '0', RODRIGO_CLOUD_TTS: '1', RODRIGO_CLOUD_VISION: '0', RODRIGO_OUTBOUND_GUARD: 'redact' });
    assert.deepEqual(workerPrivacyEnv(DEFAULT_PRIVACY), { RODRIGO_CLOUD: '1', RODRIGO_CLOUD_INTENT: '1', RODRIGO_CLOUD_TTS: '1', RODRIGO_CLOUD_VISION: '0', RODRIGO_OUTBOUND_GUARD: 'redact' });
  });

  it('imagem da tela (Fase V): desligada por padrão; o worker recebe o valor JÁ resolvido (mestre + canal), nunca um padrão próprio', () => {
    assert.equal(parsePrivacyConfig({}).cloudVision, false, 'padrão de produção = desligado');
    assert.equal(parsePrivacyConfig({ RODRIGO_CLOUD_VISION: '' }).cloudVision, false, 'vazio = padrão');
    assert.equal(parsePrivacyConfig({ RODRIGO_CLOUD_VISION: '1' }).cloudVision, true);
    for (const bad of ['true', 'on', '2', '01']) {
      assert.throws(() => parsePrivacyConfig({ RODRIGO_CLOUD_VISION: bad }), /RODRIGO_CLOUD_VISION/, bad);
    }
    const on = parsePrivacyConfig({ RODRIGO_CLOUD_VISION: '1' });
    assert.equal(workerPrivacyEnv(on).RODRIGO_CLOUD_VISION, '1');
    assert.equal(workerPrivacyEnv({ ...on, cloud: false }).RODRIGO_CLOUD_VISION, '0', 'mestre desligado vence o canal');
    assert.equal(effectivePrivacy({ GEMINI_API_KEY: 'x' }).sends.visionImage, false, 'padrão: a imagem da tela não sai');
    assert.equal(effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_CLOUD_VISION: '1' }).sends.visionImage, true);
    assert.equal(effectivePrivacy({ RODRIGO_CLOUD: '0', RODRIGO_CLOUD_VISION: '1' }).sends.visionImage, false);
  });
});

describe('TTS em nuvem (Fase 13a) — regra efetiva e canal', () => {
  it('padrão: ligado, com o conteúdo ditado também indo à voz (D-b opção 1)', () => {
    const st = effectivePrivacy({ GEMINI_API_KEY: 'x' });
    assert.deepEqual(st.tts, { cloud: true, reason: null, dictatedViaCloud: true });
    assert.equal(st.sends.ttsText, true);
    assert.equal(st.models.tts, 'gemini-3.8-flash-lite-tts');
  });

  it('RODRIGO_CLOUD_TTS=0 desliga só o canal de voz; a geração segue em nuvem', () => {
    const st = effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_CLOUD_TTS: '0' });
    assert.equal(st.mode, 'cloud');
    assert.deepEqual(st.tts, { cloud: false, reason: 'channel-off', dictatedViaCloud: false });
    assert.equal(st.sends.ttsText, false);
    assert.equal(st.models.tts, null);
  });

  it('regra conservadora: RODRIGO_SEND_HISTORY=0 desliga o TTS em nuvem mesmo com a flag ligada (motivo: history-off)', () => {
    const st = effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_SEND_HISTORY: '0', RODRIGO_CLOUD_TTS: '1' });
    assert.deepEqual(st.tts, { cloud: false, reason: 'history-off', dictatedViaCloud: false });
    assert.equal(st.sends.ttsText, false);
  });

  it('D-b: confirmações com conteúdo ditado ficam locais com RODRIGO_SEND_MEMORIES=0 ou RODRIGO_TTS_DICTATED=0 (o resto segue na nuvem)', () => {
    for (const env of [{ RODRIGO_SEND_MEMORIES: '0' }, { RODRIGO_TTS_DICTATED: '0' }]) {
      const st = effectivePrivacy({ GEMINI_API_KEY: 'x', ...env });
      assert.equal(st.tts.cloud, true, JSON.stringify(env));
      assert.equal(st.tts.dictatedViaCloud, false, JSON.stringify(env));
    }
  });

  it('o mestre desligado vence tudo (voz também fica local)', () => {
    assert.deepEqual(effectivePrivacy({ RODRIGO_CLOUD: '0', RODRIGO_CLOUD_TTS: '1' }).tts, { cloud: false, reason: 'master-off', dictatedViaCloud: false });
  });

  it('valor inválido das novas flags aborta o startup (falha alto)', () => {
    assert.throws(() => parsePrivacyConfig({ RODRIGO_CLOUD_TTS: 'sim' }), /RODRIGO_CLOUD_TTS/);
    assert.throws(() => parsePrivacyConfig({ RODRIGO_TTS_DICTATED: '2' }), /RODRIGO_TTS_DICTATED/);
  });

  it('o worker recebe o estado EFETIVO do canal (não a flag crua)', () => {
    assert.equal(workerPrivacyEnv(parsePrivacyConfig({})).RODRIGO_CLOUD_TTS, '1');
    assert.equal(workerPrivacyEnv(parsePrivacyConfig({ RODRIGO_CLOUD_TTS: '0' })).RODRIGO_CLOUD_TTS, '0');
    assert.equal(workerPrivacyEnv(parsePrivacyConfig({ RODRIGO_SEND_HISTORY: '0' })).RODRIGO_CLOUD_TTS, '0');
    assert.equal(workerPrivacyEnv(parsePrivacyConfig({ RODRIGO_CLOUD: '0' })).RODRIGO_CLOUD_TTS, '0');
  });

  it('o cartão diz o que vai e o que fica, sem prometer localidade', () => {
    const on = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x' }));
    assert.ok(on.goes.some((l) => /vai ao Gemini para virar voz/.test(l)));
    assert.ok(on.goes.some((l) => /interromper antes de ouvir/.test(l)));
    const hist = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_SEND_HISTORY: '0' }));
    assert.ok(hist.stays.some((l) => /voz do sistema/.test(l) && /RODRIGO_SEND_HISTORY=0/.test(l)));
    assert.ok(!hist.goes.some((l) => /virar voz/.test(l)));
    const dictLocal = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_TTS_DICTATED: '0' }));
    assert.ok(dictLocal.goes.some((l) => /faladas com a voz do sistema/.test(l)));
  });
});

describe('Linha de estado da voz (Fase 13a)', () => {
  const g = (budget: Partial<NonNullable<TtsStatus['budget']>> = {}): TtsStatus => ({
    engine: 'gemini',
    name: 'Gemini TTS',
    budget: { used: 12, limit: 90, minuteUsed: 2, rpm: 8, exhausted: false, blockedForMs: 0, ...budget },
    counters: { gemini: 12, fallback: 0, failures: 0 }
  });

  it('mostra quantos pedidos do dia foram usados', () => {
    assert.equal(describeTtsStatus(g()), 'Voz natural (Gemini): 12 de 90 pedidos usados hoje.');
  });

  it('esgotada: diz que a voz do sistema assume até a cota renovar', () => {
    const t = describeTtsStatus(g({ used: 90, exhausted: true }));
    assert.match(t ?? '', /esgotada por hoje \(90 de 90 pedidos\)/);
    assert.match(t ?? '', /voz do sistema/);
  });

  it('em pausa (429/disjuntor): mostra os segundos arredondados para cima', () => {
    assert.match(describeTtsStatus(g({ blockedForMs: 11_200 })) ?? '', /em pausa por cerca de 12 s/);
  });

  it('voz do sistema (ou motor sem orçamento): mensagem simples; sem estado: nada', () => {
    assert.equal(describeTtsStatus({ engine: 'say', name: 'macOS say', budget: null, counters: null }), 'Voz do sistema (macOS) falando as respostas.');
    assert.equal(describeTtsStatus(null), null);
  });

  it('o texto nunca promete localidade nem ausência de custo (regras da Fase 12)', () => {
    for (const t of [describeTtsStatus(g()), describeTtsStatus(g({ exhausted: true })), describeTtsStatus(g({ blockedForMs: 5000 }))]) {
      assert.deepEqual(findViolations(t ?? ''), []);
    }
  });
});

describe('effectivePrivacy (Fase 12)', () => {
  it('com tudo ligado reflete exatamente o gabarito escrito à mão (não circular)', () => {
    const st = effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_SEND_KNOWLEDGE: '1', RODRIGO_CLOUD_VISION: '1' });
    const gabarito: PrivacyStatus = {
      mode: 'cloud',
      intent: 'gemini',
      keyPresent: true,
      sends: { utteranceForIntent: true, history: true, historyTurns: VOICE_LIMITS.MAX_CONTEXT_TURNS, memories: true, knowledgeSnippet: true, ttsText: true, visionImage: true, webSearch: false },
      models: { generation: 'gemini-flash-latest', intent: 'gemini-3.5-flash-lite', tts: 'gemini-3.8-flash-lite-tts' },
      tts: { cloud: true, reason: null, dictatedViaCloud: true },
      webSearch: { enabled: false, reason: 'channel-off' },
      neverSends: ['audio'],
      outboundGuard: 'redact'
    };
    assert.deepEqual(st, gabarito);
  });

  it('mestre desligado: nada sai, mesmo com os sub-controles ligados', () => {
    const st = effectivePrivacy({ RODRIGO_CLOUD: '0', RODRIGO_SEND_KNOWLEDGE: '1', RODRIGO_SEND_MEMORIES: '1', RODRIGO_WEB_SEARCH: '1', RODRIGO_CLOUD_VISION: '1' });
    assert.equal(st.mode, 'local-only');
    assert.equal(st.intent, 'local');
    assert.deepEqual(st.sends, { utteranceForIntent: false, history: false, historyTurns: null, memories: false, knowledgeSnippet: false, ttsText: false, visionImage: false, webSearch: false });
    assert.deepEqual(st.models, { generation: null, intent: null, tts: null });
    assert.deepEqual(st.tts, { cloud: false, reason: 'master-off', dictatedViaCloud: false });
    assert.deepEqual(st.webSearch, { enabled: false, reason: 'master-off' });
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

describe('describePrivacy — o texto do cartão acompanha cada controle (Fase 12)', () => {
  const base = effectivePrivacy({ GEMINI_API_KEY: 'x' });
  const flat = (t: ReturnType<typeof describePrivacy>): string => [t.headline, ...t.stays, ...t.goes, ...t.warnings, t.footnote].join('\n');

  it('nuvem ligada: o histórico, a intenção, as memórias e o trecho aparecem com o estado certo', () => {
    const on = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_SEND_KNOWLEDGE: '1' }));
    assert.match(on.headline, /usa a nuvem \(Gemini\)/);
    assert.ok(on.goes.some((l) => /últimas 8 trocas/.test(l) && /nota ou memória/.test(l)), 'declara que conteúdo de nota/memória repetido na conversa vai junto');
    assert.ok(on.goes.some((l) => /memórias que você salvou são enviadas/.test(l)));
    assert.ok(on.goes.some((l) => /Trechos dos seus textos de pesquisa .* são enviados/.test(l)));
    assert.ok(on.goes.some((l) => /hora, data, lembretes e notas também vai ao Gemini/.test(l)));
    assert.deepEqual(on.warnings, [FREE_TIER_NOTICE], 'com a nuvem ligada e a chave presente, o único aviso é o do nível gratuito');
  });

  it('cada controle desligado troca a frase correspondente (controle positivo da frase oposta acima)', () => {
    const off = describePrivacy(
      effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_SEND_HISTORY: '0', RODRIGO_SEND_MEMORIES: '0', RODRIGO_CLOUD_INTENT: '0' })
    );
    assert.ok(off.goes.some((l) => /Só a sua fala atual/.test(l)));
    assert.ok(off.goes.some((l) => /memórias que você salvou não são enviadas/.test(l)));
    assert.ok(off.goes.some((l) => /entendidos neste computador/.test(l)));
    assert.ok(off.goes.some((l) => /não são enviados ao Gemini/.test(l)), 'trecho de pesquisa não enviado por padrão (D1)');
    assert.ok(!flat(off).includes('últimas'));
  });

  it('imagem da tela (Fase V): o cartão diz que NÃO sai por padrão e muda de frase quando o canal é ligado', () => {
    const off = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x' }));
    assert.ok(off.stays.some((l) => /imagem da tela não é enviada ao Gemini/.test(l)), 'padrão: declarada como não enviada');
    assert.ok(!off.goes.some((l) => /imagem da tela/.test(l)));
    const on = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', RODRIGO_CLOUD_VISION: '1' }));
    assert.ok(on.goes.some((l) => /imagem da tela só vai ao Gemini quando você autoriza na própria fala/.test(l)));
    assert.ok(!on.stays.some((l) => /imagem da tela/.test(l)));
    for (const t of [off, on]) assert.deepEqual(findViolations(flat(t)), []);
  });

  it('divulgação do nível gratuito: aparece sempre que algo vai ao Gemini e NUNCA no modo sem nuvem', () => {
    for (const env of [{}, { RODRIGO_SEND_HISTORY: '0' }, { RODRIGO_SEND_MEMORIES: '0', RODRIGO_CLOUD_INTENT: '0' }]) {
      const t = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', ...env }));
      assert.ok(t.warnings.includes(FREE_TIER_NOTICE), JSON.stringify(env));
    }
    assert.match(FREE_TIER_NOTICE, /nível gratuito/);
    assert.match(FREE_TIER_NOTICE, /revis/);
    assert.match(FREE_TIER_NOTICE, /ai\.google\.dev\/gemini-api\/terms/);
    assert.deepEqual(describePrivacy(effectivePrivacy({ RODRIGO_CLOUD: '0' })).warnings, []);
  });

  it('modo sem nuvem: nada vai ao Gemini e a tela diz isso', () => {
    const t = describePrivacy(effectivePrivacy({ RODRIGO_CLOUD: '0' }));
    assert.match(t.headline, /Modo sem nuvem/);
    assert.deepEqual(t.goes, []);
    assert.ok(t.stays.some((l) => /geração está desligada/.test(l)));
  });

  it('sem chave: avisa que a geração não vai funcionar', () => {
    assert.ok(!describePrivacy(base).warnings.some((w) => /GEMINI_API_KEY/.test(w)));
    assert.ok(describePrivacy(effectivePrivacy({})).warnings.some((w) => /GEMINI_API_KEY/.test(w)));
  });

  it('o próprio texto do cartão não contém nenhuma frase proibida, em nenhum modo', () => {
    for (const env of [{}, { RODRIGO_CLOUD: '0' }, { RODRIGO_SEND_HISTORY: '0' }, { RODRIGO_SEND_KNOWLEDGE: '1' }]) {
      const t = describePrivacy(effectivePrivacy({ GEMINI_API_KEY: 'x', ...env }));
      assert.deepEqual(findViolations(flat(t)), [], JSON.stringify(env));
    }
    assert.deepEqual(findViolations(PRIVACY_UNAVAILABLE_TEXT), []);
  });
});

describe('módulo de conhecimento sob a privacidade (Fase 12, D1)', () => {
  it('desligado por privacidade não se declara ativo; ligado e carregado, avisa que o trecho vai ao Gemini', () => {
    const reg = ExtensionRegistry.getInstance();
    reg.resetForTesting();
    try {
      reg.registerKnowledge(0);
      reg.registerKnowledgeDisabledByPrivacy(true);
      const off = reg.getModuleStatuses().find((m) => m.id === 'knowledge')!;
      assert.equal(off.available, false);
      assert.match(off.description, /Desligado por privacidade/);

      reg.registerKnowledge(12);
      reg.registerKnowledgeDisabledByPrivacy(false);
      const on = reg.getModuleStatuses().find((m) => m.id === 'knowledge')!;
      assert.equal(on.available, true);
      assert.match(on.description, /enviado ao Gemini/);
    } finally {
      reg.resetForTesting();
    }
  });
});
