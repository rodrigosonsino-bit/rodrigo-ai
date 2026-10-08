import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import { parsePrivacyConfig } from '../privacy.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import type { SynthesizeRequest, SynthesizeResult } from '../voice/engine.js';
import { DEFAULT_GEMINI_VOICE_CONFIG, GeminiVoiceProvider } from '../voice/geminiVoiceProvider.js';
import { createVoiceProvider, parseTtsEnv } from '../voice/ttsProviders.js';
import { TtsBudget } from '../voice/ttsBudget.js';

/**
 * Fase 13a (docs/phase-13a-v3.md §4, H13a.8/.14): provedor Gemini com a voz do sistema de reserva. Tudo contra um motor
 * fake (nenhuma rede, nenhum Python) e um orçamento real com relógio falso.
 */
class FakeSay implements IVoiceProvider {
  readonly id = 'say';
  readonly name = 'say fake';
  calls: Array<{ text: string; options?: SynthesizeOptions }> = [];
  isAvailable(): boolean {
    return true;
  }
  async synthesize(text: string, outputPath: string, _s?: AbortSignal, options?: SynthesizeOptions): Promise<void> {
    this.calls.push({ text, options });
    await fs.promises.writeFile(outputPath, 'WAV-do-say');
  }
}

const fail = (kind: string, extra: Record<string, unknown> = {}): SynthesizeResult => ({ ok: false, kind, ...extra }) as SynthesizeResult;

describe('GeminiVoiceProvider (Fase 13a)', () => {
  let dir: string;
  let t: number;
  let engine: FakeVoiceEngine;
  let say: FakeSay;
  let budget: TtsBudget;
  const logs: string[] = [];

  const make = (env: Record<string, string> = {}, rpm = 8, rpd = 90): GeminiVoiceProvider => {
    budget = new TtsBudget({ filePath: path.join(dir, 'b.json'), rpm, rpd, now: () => t, log: () => {} });
    return new GeminiVoiceProvider(
      engine,
      say,
      budget,
      parsePrivacyConfig(env),
      DEFAULT_GEMINI_VOICE_CONFIG('gemini-3.8-flash-lite-tts', 'Charon'),
      () => t,
      (m) => logs.push(m)
    );
  };
  const out = (n: string): string => path.join(dir, `${n}.wav`);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-provider-'));
    t = Date.UTC(2026, 9, 8, 18, 0, 0);
    engine = new FakeVoiceEngine();
    say = new FakeSay();
    logs.length = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('caminho feliz: pede ao motor o modelo, a voz e o prazo certos; o `say` não é usado', async () => {
    const p = make();
    await p.synthesize('Olá, tudo bem?', out('a'), undefined, { turnId: 't1', kind: 'generated', isFirstOfTurn: true });
    await p.synthesize('Segunda frase.', out('b'), undefined, { turnId: 't1', kind: 'generated', isFirstOfTurn: false });
    assert.equal(engine.synthCalls.length, 2);
    const [first, second] = engine.synthCalls as SynthesizeRequest[];
    assert.deepEqual(
      { text: first.text, model: first.model, voice: first.voice, deadlineMs: first.deadlineMs, outPath: first.outPath },
      { text: 'Olá, tudo bem?', model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 8000, outPath: out('a') }
    );
    assert.equal(second.deadlineMs, 12000, 'prazo local de 12 s para as frases depois da primeira');
    assert.equal(say.calls.length, 0);
    assert.deepEqual({ g: p.counters.gemini, f: p.counters.fallback }, { g: 2, f: 0 });
    assert.ok(fs.existsSync(out('a')));
  });

  it('só o TEXTO vai ao motor: o pedido não carrega áudio, histórico nem instrução de estilo', async () => {
    const p = make();
    await p.synthesize('Frase.', out('a'), undefined, { turnId: 't1', kind: 'generated' });
    assert.deepEqual(Object.keys(engine.synthCalls[0]).sort(), ['deadlineMs', 'model', 'outPath', 'text', 'turnId', 'voice']);
  });

  it('privacidade: com RODRIGO_SEND_HISTORY=0 (ou canal/mestre desligados) NENHUM pedido ao motor; tudo no `say`', async () => {
    for (const env of [{ RODRIGO_SEND_HISTORY: '0' }, { RODRIGO_CLOUD_TTS: '0' }, { RODRIGO_CLOUD: '0' }] as Array<Record<string, string>>) {
      engine.synthCalls.length = 0;
      say.calls.length = 0;
      const p = make(env);
      await p.synthesize('Frase.', out('x'), undefined, { turnId: `t-${JSON.stringify(env)}`, kind: 'generated' });
      assert.equal(engine.synthCalls.length, 0, JSON.stringify(env));
      assert.equal(say.calls.length, 1, JSON.stringify(env));
      assert.equal(budget.status().used, 0, 'sem pedido enviado, sem desconto');
    }
  });

  it('D-b: conteúdo ditado vai ao `say` com RODRIGO_SEND_MEMORIES=0 ou RODRIGO_TTS_DICTATED=0; o texto gerado segue no Gemini; padrão: tudo no Gemini', async () => {
    for (const env of [{ RODRIGO_SEND_MEMORIES: '0' }, { RODRIGO_TTS_DICTATED: '0' }] as Array<Record<string, string>>) {
      engine.synthCalls.length = 0;
      say.calls.length = 0;
      const p = make(env);
      await p.synthesize('Anotar: o código da mala é 1234. Confirma?', out('d'), undefined, { turnId: 'td', kind: 'dictated' });
      await p.synthesize('Uma resposta gerada.', out('g'), undefined, { turnId: 'td', kind: 'generated' });
      assert.deepEqual(say.calls.map((c) => c.text), ['Anotar: o código da mala é 1234. Confirma?'], JSON.stringify(env));
      assert.deepEqual(engine.synthCalls.map((c) => c.text), ['Uma resposta gerada.'], JSON.stringify(env));
    }
    engine.synthCalls.length = 0;
    say.calls.length = 0;
    const p = make({});
    await p.synthesize('Anotar: tal coisa. Confirma?', out('d2'), undefined, { turnId: 'td2', kind: 'dictated' });
    assert.equal(engine.synthCalls.length, 1);
    assert.equal(say.calls.length, 0);
  });

  it('reserva real por turno: 2 pedidos seguram a capacidade; o fim do turno estorna o não usado', async () => {
    const p = make({}, 8, 90);
    await p.synthesize('Primeira.', out('a'), undefined, { turnId: 'turno1', kind: 'generated' });
    assert.equal(budget.status().held, 1, 'a reserva de 2 gastou 1; sobra 1 segurado');
    assert.equal(budget.status().used, 1);
    p.endTurn('turno1');
    assert.equal(budget.status().held, 0, 'estornado ao fim do turno');
    assert.equal(budget.status().used, 1);
  });

  it('sem saldo para a reserva de 2: o TURNO INTEIRO fica no `say` (não mistura vozes dentro do turno)', async () => {
    const p = make({}, 8, 90);
    for (let i = 0; i < 7; i += 1) budget.tryTake(); // sobra 1 no minuto: não cabe reserva de 2
    await p.synthesize('A.', out('a'), undefined, { turnId: 'sem-saldo', kind: 'generated' });
    await p.synthesize('B.', out('b'), undefined, { turnId: 'sem-saldo', kind: 'generated' });
    assert.equal(engine.synthCalls.length, 0);
    assert.deepEqual(say.calls.map((c) => c.text), ['A.', 'B.']);
  });

  it('turno mais longo que a reserva: pede pedidos avulsos; quando o saldo acaba, o RESTO do turno vai ao `say` (troca declarada)', async () => {
    const p = make({}, 4, 90); // 4 por minuto
    for (const [i, txt] of ['1.', '2.', '3.', '4.', '5.', '6.'].entries()) {
      await p.synthesize(txt, out(`s${i}`), undefined, { turnId: 'longo', kind: 'generated' });
    }
    assert.deepEqual(engine.synthCalls.map((c) => c.text), ['1.', '2.', '3.', '4.']);
    assert.deepEqual(say.calls.map((c) => c.text), ['5.', '6.']);
    assert.equal(budget.status().used, 4);
  });

  const failure = async (result: SynthesizeResult): Promise<GeminiVoiceProvider> => {
    const p = make();
    engine.synthBehavior = async () => result;
    await p.synthesize('Falha.', out('f'), undefined, { turnId: 'tf', kind: 'generated' });
    return p;
  };

  it('H13a.8: 503, timeout, 404, transporte, vazio: a frase cai no `say` e o resto do turno também', async () => {
    for (const kind of ['server', 'timeout', 'not_found', 'transport', 'empty', 'error']) {
      engine.synthCalls.length = 0;
      say.calls.length = 0;
      const p = make();
      engine.synthBehavior = async () => fail(kind);
      await p.synthesize('Primeira.', out(`${kind}1`), undefined, { turnId: `t-${kind}`, kind: 'generated' });
      await p.synthesize('Segunda.', out(`${kind}2`), undefined, { turnId: `t-${kind}`, kind: 'generated' });
      assert.equal(engine.synthCalls.length, 1, `${kind}: depois da falha o turno não insiste`);
      assert.equal(say.calls.length, 2, `${kind}: as duas frases saíram no say`);
      assert.ok(fs.existsSync(out(`${kind}1`)));
    }
  });

  it('H13a.8: 400/401/403 (configuração) também usam o `say`, mas bloqueiam o Gemini por 5 minutos (não adianta repetir)', async () => {
    await failure(fail('client_error', { status: 401 }));
    assert.equal(budget.status().blockedForMs, 5 * 60_000);
    assert.ok(logs.some((l) => /client_error 401/.test(l)));
  });

  it('429 por minuto: bloqueia pelo retryDelay + 1 s (mínimo 10 s); 429 por dia: esgotado até a virada', async () => {
    await failure(fail('rate_limited', { status: 429, scope: 'minute', retryAfterMs: 21_000 }));
    assert.equal(budget.status().blockedForMs, 22_000);
    await failure(fail('rate_limited', { status: 429, scope: 'minute', retryAfterMs: 2_000 }));
    assert.ok(budget.status().blockedForMs >= 10_000 - 1);
    await failure(fail('rate_limited', { status: 429, scope: 'day', quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }));
    assert.equal(budget.status().exhausted, true);
  });

  it('429 com escopo desconhecido: backoff exponencial 30 s, 60 s, 120 s... teto 15 min; o maior com retryDelay vale', async () => {
    const p = make();
    engine.synthBehavior = async () => fail('rate_limited', { status: 429, scope: 'unknown' });
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      t += 20 * 60_000; // deixa o bloqueio anterior vencer
      await p.synthesize('x.', out(`u${i}`), undefined, { turnId: `tu${i}`, kind: 'generated' });
      waits.push(budget.status().blockedForMs);
    }
    assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000, 900_000]);
    engine.synthBehavior = async () => fail('rate_limited', { status: 429, scope: 'unknown', retryAfterMs: 1_800_000 });
    t += 20 * 60_000;
    await p.synthesize('x.', out('u-retry'), undefined, { turnId: 'tuR', kind: 'generated' });
    assert.equal(budget.status().blockedForMs, 1_800_000, 'o retryDelay maior que o backoff vence');
  });

  it('duas falhas de serviço seguidas esfriam o Gemini por 60 s; uma falha isolada não', async () => {
    const p = make();
    engine.synthBehavior = async () => fail('server', { status: 503 });
    await p.synthesize('a.', out('c1'), undefined, { turnId: 'c1', kind: 'generated' });
    assert.equal(budget.status().blockedForMs, 0);
    await p.synthesize('b.', out('c2'), undefined, { turnId: 'c2', kind: 'generated' });
    assert.equal(budget.status().blockedForMs, 60_000);
    // sucesso zera a contagem
    t += 61_000;
    engine.synthBehavior = null;
    await p.synthesize('ok.', out('c3'), undefined, { turnId: 'c3', kind: 'generated' });
    engine.synthBehavior = async () => fail('server', { status: 503 });
    await p.synthesize('d.', out('c4'), undefined, { turnId: 'c4', kind: 'generated' });
    assert.equal(budget.status().blockedForMs, 0);
  });

  it('o log de falha tem só campos estruturados: nunca o texto da frase', async () => {
    await failure(fail('server', { status: 503 }));
    assert.ok(logs.length >= 1);
    assert.ok(!logs.some((l) => l.includes('Falha.')), 'o texto falado não pode aparecer no log');
  });

  it('cancelamento (barge-in): aborta, NÃO cai no `say` e não cria arquivo', async () => {
    const p = make();
    const ac = new AbortController();
    engine.synthBehavior = async (_req, signal) =>
      new Promise<SynthesizeResult>((resolve) => {
        signal?.addEventListener('abort', () => resolve(fail('cancelled')), { once: true });
      });
    const pending = p.synthesize('Longa frase.', out('ab'), ac.signal, { turnId: 'tab', kind: 'generated' });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending, (e: Error) => e.name === 'AbortError');
    assert.equal(say.calls.length, 0);
    assert.ok(!fs.existsSync(out('ab')));
  });

  it('já abortado antes de começar: rejeita sem chamar o motor', async () => {
    const p = make();
    const ac = new AbortController();
    ac.abort();
    engine.synthBehavior = async (_r, signal) => (signal?.aborted ? fail('cancelled') : { ok: true, seconds: 1, tokensIn: 1, tokensOut: 1 });
    await assert.rejects(p.synthesize('x.', out('pre'), ac.signal, { turnId: 'tpre', kind: 'generated' }), (e: Error) => e.name === 'AbortError');
    assert.equal(say.calls.length, 0);
  });

  it('no máximo 2 sínteses simultâneas; as demais esperam a vez (e a ordem de entrada é mantida)', async () => {
    const p = make({}, 100, 900);
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    engine.synthBehavior = async (req) => {
      started.push(req.text);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      return { ok: true, seconds: 1, tokensIn: 1, tokensOut: 1 };
    };
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((x, i) => p.synthesize(x, out(`k${i}`), undefined, { turnId: `k${i}`, kind: 'generated' }))
    );
    assert.equal(peak, 2);
    assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  });

  it('aborto na fila de espera: libera a vaga e rejeita, sem chamar o motor', async () => {
    const p = make({}, 100, 900);
    const gates: Array<() => void> = [];
    engine.synthBehavior = () => new Promise((resolve) => gates.push(() => resolve({ ok: true, seconds: 1, tokensIn: 1, tokensOut: 1 })));
    const a = p.synthesize('a', out('qa'), undefined, { turnId: 'qa', kind: 'generated' });
    const b = p.synthesize('b', out('qb'), undefined, { turnId: 'qb', kind: 'generated' });
    const ac = new AbortController();
    const c = p.synthesize('c', out('qc'), ac.signal, { turnId: 'qc', kind: 'generated' });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await assert.rejects(c, (e: Error) => e.name === 'AbortError');
    gates.forEach((g) => g());
    await Promise.all([a, b]);
    assert.deepEqual(engine.synthCalls.map((r) => r.text), ['a', 'b']);
    // auditoria F13a, achado 2: o pedido abortado na fila nunca foi enviado, então não pode ter descontado cota
    assert.equal(budget.status().used, 2, 'só os 2 pedidos enviados descontam do dia');
  });

  it('endTurn desconhecido é inofensivo; o mapa de turnos não cresce sem limite', async () => {
    const p = make({}, 1000, 9000);
    p.endTurn('nunca-existiu');
    for (let i = 0; i < 40; i += 1) await p.synthesize('x.', out(`m${i}`), undefined, { turnId: `m${i}`, kind: 'generated' });
    assert.ok(budget.status().held <= 16 * 2, `reservas seguradas devem ser limitadas, held=${budget.status().held}`);
  });

  it('sem `turnId` (uso avulso): trata como turno próprio e funciona', async () => {
    const p = make();
    await p.synthesize('Solta.', out('solta'));
    assert.equal(engine.synthCalls.length, 1);
  });

  it('isAvailable: exige motor com síntese e a voz de reserva disponível', () => {
    assert.equal(make().isAvailable(), true);
    const semMotor = new GeminiVoiceProvider({ ...engine, synthesize: undefined } as never, say, budget, parsePrivacyConfig({}), DEFAULT_GEMINI_VOICE_CONFIG('m', 'v'));
    assert.equal(semMotor.isAvailable(), false);
  });
});

describe('Escolha da voz do app (Fase 13a)', () => {
  const engine = new FakeVoiceEngine();
  const base = { engine, rootDir: os.tmpdir(), log: () => {} };

  it('padrão (TTS_ENGINE ausente) com chave e canal efetivo: Gemini com reserva', () => {
    const p = createVoiceProvider({ ...base, privacy: parsePrivacyConfig({}), env: { GEMINI_API_KEY: 'k' } });
    assert.equal(p.id, 'gemini');
    assert.equal(p.prefersCoalescing, true);
  });

  it('TTS_ENGINE=say força a voz do sistema', () => {
    const p = createVoiceProvider({ ...base, privacy: parsePrivacyConfig({}), env: { GEMINI_API_KEY: 'k', TTS_ENGINE: 'say' } });
    assert.equal(p.id, 'say');
  });

  it('sem chave, com o canal desligado ou com RODRIGO_SEND_HISTORY=0: voz do sistema, com aviso', () => {
    const logs: string[] = [];
    const log = (m: string): void => void logs.push(m);
    assert.equal(createVoiceProvider({ ...base, log, privacy: parsePrivacyConfig({}), env: {} }).id, 'say');
    assert.equal(createVoiceProvider({ ...base, log, privacy: parsePrivacyConfig({ RODRIGO_CLOUD_TTS: '0' }), env: { GEMINI_API_KEY: 'k' } }).id, 'say');
    assert.equal(createVoiceProvider({ ...base, log, privacy: parsePrivacyConfig({ RODRIGO_SEND_HISTORY: '0' }), env: { GEMINI_API_KEY: 'k' } }).id, 'say');
    assert.equal(logs.length, 3);
  });

  it('motor sem síntese em nuvem: voz do sistema', () => {
    const semSintese = { ...engine, synthesize: undefined } as never;
    assert.equal(createVoiceProvider({ ...base, engine: semSintese, privacy: parsePrivacyConfig({}), env: { GEMINI_API_KEY: 'k' } }).id, 'say');
  });

  it('parseTtsEnv: padrões e validação estrita (valor inválido LANÇA)', () => {
    assert.deepEqual(parseTtsEnv({}), { model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', rpm: 8, rpd: 90 });
    assert.deepEqual(parseTtsEnv({ RODRIGO_TTS_MODEL: 'gemini-3.1-flash-tts-preview', RODRIGO_TTS_VOICE: 'Kore', RODRIGO_TTS_RPM: '5', RODRIGO_TTS_RPD: '40' }), {
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Kore',
      rpm: 5,
      rpd: 40
    });
    for (const bad of [{ RODRIGO_TTS_RPM: '0' }, { RODRIGO_TTS_RPM: '8.5' }, { RODRIGO_TTS_RPM: 'oito' }, { RODRIGO_TTS_RPD: '99999' }, { RODRIGO_TTS_MODEL: 'a b' }, { RODRIGO_TTS_VOICE: '../x' }]) {
      assert.throws(() => parseTtsEnv(bad), /Configuração inválida/, JSON.stringify(bad));
    }
  });
});
