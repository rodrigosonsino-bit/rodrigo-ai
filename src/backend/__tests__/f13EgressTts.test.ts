import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import { parsePrivacyConfig, workerPrivacyEnv } from '../privacy.js';
import { MlxWorkerEngine } from '../voice/mlxWorkerEngine.js';
import { GeminiVoiceProvider, type GeminiVoiceConfig } from '../voice/geminiVoiceProvider.js';
import { TtsBudget } from '../voice/ttsBudget.js';
import { workerGeminiEnv } from '../geminiTestEndpoint.js';
import { FakeGemini, HAVE_VENV, REAL_LOOKING_KEY, RecordingProxy, VENV_PY, WORKER, tonePcm } from './helpers/egress.js';

/**
 * Fase 13a (docs/phase-13a-v3.md §6, H13a.2/.7/.8/.13/.16): o TTS contra o worker Python REAL (sem modelos) e um Gemini FALSO em
 * loopback. Aqui os erros vêm das classes reais do SDK do Google (os testes do worker usam classes imitadas), e a medição é do
 * que de fato chegou ao servidor falso.
 */
class FakeSay implements IVoiceProvider {
  readonly id = 'say';
  readonly name = 'say fake';
  spoken: string[] = [];
  isAvailable(): boolean {
    return true;
  }
  async synthesize(text: string, outputPath: string, _s?: AbortSignal, _o?: SynthesizeOptions): Promise<void> {
    this.spoken.push(text);
    await fs.promises.writeFile(outputPath, 'WAV-do-say');
  }
}

interface WavInfo {
  channels: number;
  rate: number;
  bits: number;
  frames: number;
  rmsDb: number | null;
}

function readWav(file: string): WavInfo {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  const channels = b.readUInt16LE(22);
  const rate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  const dataStart = 44;
  const samples = (b.length - dataStart) / 2;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < samples; i += 1) {
    const v = b.readInt16LE(dataStart + i * 2) / 32768;
    if (Math.abs(v) > 10 ** (-50 / 20)) {
      sum += v * v;
      n += 1;
    }
  }
  return { channels, rate, bits, frames: samples, rmsDb: n > 240 ? 20 * Math.log10(Math.sqrt(sum / n)) : null };
}

const SKIP = !HAVE_VENV;

describe('TTS Gemini contra o worker real e um Gemini falso (Fase 13a)', { skip: SKIP ? 'sem .runtime/.venv (npm run setup:voice)' : false }, () => {
  let gemini: FakeGemini;
  let tmp: string;
  let engine: MlxWorkerEngine;
  let say: FakeSay;
  let budget: TtsBudget;
  let provider: GeminiVoiceProvider;
  const logs: string[] = [];

  const config = (over: Partial<GeminiVoiceConfig> = {}): GeminiVoiceConfig => ({
    model: 'gemini-3.8-flash-lite-tts',
    voice: 'Charon',
    firstDeadlineMs: 8000,
    deadlineMs: 12000,
    concurrency: 2,
    reservePerTurn: 2,
    ...over
  });

  const boot = async (env: Record<string, string> = {}, cfg: Partial<GeminiVoiceConfig> = {}, workerEnv: Record<string, string> = {}): Promise<void> => {
    const privacy = parsePrivacyConfig(env);
    const wenv: Record<string, string> = {
      RODRIGO_TEST: '1',
      RODRIGO_WORKER_NO_MODELS: '1',
      RODRIGO_GEMINI_BASE_URL: gemini.url,
      GEMINI_API_KEY: REAL_LOOKING_KEY,
      ...workerEnv
    };
    engine = new MlxWorkerEngine({
      pythonBin: VENV_PY,
      workerScript: WORKER,
      hfCacheDir: path.join(tmp, 'hf'),
      env: { ...wenv, ...workerPrivacyEnv(privacy), ...workerGeminiEnv(wenv) }
    });
    await engine.waitUntilReady(20000);
    say = new FakeSay();
    budget = new TtsBudget({ filePath: path.join(tmp, 'budget.json'), rpm: 100, rpd: 900, log: () => {} });
    provider = new GeminiVoiceProvider(engine, say, budget, privacy, config(cfg), () => Date.now(), (m) => logs.push(m));
  };
  const out = (n: string): string => path.join(tmp, `${n}.wav`);

  before(() => {
    // o worker usa a chave sintética de teste; nada aqui toca a rede real
  });
  beforeEach(async () => {
    gemini = new FakeGemini();
    await gemini.start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-egress-tts-'));
    logs.length = 0;
  });
  afterEach(async () => {
    await engine?.shutdown().catch(() => {});
    await gemini.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  after(() => {});

  it('H13a.7: cada frase vira UM pedido ao modelo de TTS com SÓ o texto — sem áudio do usuário, sem histórico, sem instrução de estilo', async () => {
    await boot();
    const frases = ['Olá, tudo bem?', 'Certo, vou criar um lembrete para amanhã.', 'Quer que eu continue?'];
    for (const [i, f] of frases.entries()) await provider.synthesize(f, out(`f${i}`), undefined, { turnId: 'turno', kind: 'generated' });
    const reqs = gemini.ttsRequests();
    assert.equal(reqs.length, frases.length);
    assert.equal(gemini.streamRequests().length, 0, 'nenhum pedido de GERAÇÃO foi feito');
    for (const [i, r] of reqs.entries()) {
      assert.match(r.url, /\/models\/gemini-3\.8-flash-lite-tts:streamGenerateContent/);
      const body = JSON.parse(r.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ['contents', 'generationConfig'], 'só conteúdo e configuração de áudio; nada de systemInstruction nem outros campos');
      const contents = body.contents as Array<{ role?: string; parts: Array<Record<string, unknown>> }>;
      assert.equal(contents.length, 1, 'nenhum histórico de conversa');
      assert.deepEqual(contents[0].parts, [{ text: frases[i] }], 'a única parte é o texto da frase, exatamente');
      assert.ok(!r.body.includes('inlineData') && !r.body.includes('inline_data'), 'nenhum áudio enviado');
      // o SDK serializa speechConfig em snake_case (formato aceito pelo Google; verificado com chamadas reais em 2026-10-07)
      const gc = body.generationConfig as { responseModalities: string[]; speechConfig: { voice_config: { prebuilt_voice_config: { voice_name: string } } } };
      assert.deepEqual(gc.responseModalities, ['AUDIO']);
      assert.equal(gc.speechConfig.voice_config.prebuilt_voice_config.voice_name, 'Charon');
      assert.ok(!r.body.includes(REAL_LOOKING_KEY), 'a chave nunca vai no corpo');
    }
    assert.equal(say.spoken.length, 0);
  });

  it('o WAV gravado é válido (mono, 16 bits, 24 kHz), sem .part, e normalizado para -17 dBFS (H13a.5)', async () => {
    gemini.ttsPcm = tonePcm(-24, 0.5);
    await boot();
    await provider.synthesize('Frase de teste.', out('w'), undefined, { turnId: 't', kind: 'generated' });
    const info = readWav(out('w'));
    assert.deepEqual({ ch: info.channels, rate: info.rate, bits: info.bits }, { ch: 1, rate: 24000, bits: 16 });
    assert.ok(Math.abs(info.frames - 12000) < 50, `duração ~0,5 s, frames=${info.frames}`);
    assert.ok(info.rmsDb !== null && Math.abs(info.rmsDb + 17) <= 0.3, `RMS ${info.rmsDb} deveria ser -17 ±0,3`);
    assert.ok(!fs.existsSync(`${out('w')}.part`));
  });

  it('H13a.5: frases em volumes diferentes saem todas a ≤ 1,5 dB do alvo (as que não saturam o teto de ganho)', async () => {
    await boot();
    const out_: number[] = [];
    for (const [i, db] of [-27, -22, -19, -15, -12].entries()) {
      gemini.ttsPcm = tonePcm(db, 0.4);
      await provider.synthesize(`Frase ${i}.`, out(`v${i}`), undefined, { turnId: `tv${i}`, kind: 'generated' });
      out_.push(readWav(out(`v${i}`)).rmsDb ?? NaN);
    }
    for (const r of out_) assert.ok(Math.abs(r + 17) <= 1.5, `RMS ${r}`);
  });

  it('H13a.2: com RODRIGO_CLOUD_TTS=0 NENHUMA conexão chega ao Gemini; tudo sai no `say`', async () => {
    await boot({ RODRIGO_CLOUD_TTS: '0' });
    for (let i = 0; i < 10; i += 1) await provider.synthesize(`Frase ${i}.`, out(`c${i}`), undefined, { turnId: `tc${i}`, kind: 'generated' });
    assert.equal(gemini.requests.length, 0);
    assert.equal(say.spoken.length, 10);
  });

  it('H13a.2: mesmo que o Node peça, o WORKER recusa quando o canal está desligado (defesa em profundidade)', async () => {
    await boot({ RODRIGO_CLOUD_TTS: '0' });
    const r = await engine.synthesize({ turnId: 'x', text: 'Oi.', outPath: out('d'), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 4000 });
    assert.deepEqual(r, { ok: false, kind: 'disabled' });
    assert.equal(gemini.requests.length, 0);
    assert.ok(!fs.existsSync(out('d')));
  });

  it('H13a.2: RODRIGO_SEND_HISTORY=0 também desliga o canal no worker (estado EFETIVO, não a flag crua)', async () => {
    await boot({ RODRIGO_SEND_HISTORY: '0' });
    const r = await engine.synthesize({ turnId: 'x', text: 'Oi.', outPath: out('h'), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 4000 });
    assert.equal(r.ok, false);
    assert.equal(gemini.requests.length, 0);
  });

  it('H13a.8 com erros REAIS do SDK: 429 por minuto (quotaId e retryDelay lidos do corpo estruturado)', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'quota', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel', retryDelay: '11s' };
    await boot();
    const r = await engine.synthesize({ turnId: 'q', text: 'Oi.', outPath: out('q'), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 6000 });
    assert.deepEqual(r, { ok: false, kind: 'rate_limited', status: 429, scope: 'minute', retryAfterMs: 11000, quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' });
    assert.ok(!fs.existsSync(out('q')) && !fs.existsSync(`${out('q')}.part`));
  });

  it('H13a.8: 429 por DIA vira esgotado até a virada; a frase sai no `say`', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'quota', quotaId: 'GenerateRequestsPerDayPerProjectPerModel', retryDelay: '3600s' };
    await boot();
    await provider.synthesize('Oi.', out('day'), undefined, { turnId: 'td', kind: 'generated' });
    assert.deepEqual(say.spoken, ['Oi.']);
    assert.equal(budget.status().exhausted, true);
    // o dia esgotado impede novos pedidos ao Google
    const before = gemini.ttsRequests().length;
    await provider.synthesize('De novo.', out('day2'), undefined, { turnId: 'td2', kind: 'generated' });
    assert.equal(gemini.ttsRequests().length, before);
  });

  it('H13a.8: 429 SEM quotaId reconhecível = escopo desconhecido (backoff), nunca desliga o dia', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'quota', quotaId: 'CotaQueNaoExistiaAntes', retryDelay: '5s' };
    await boot();
    const r = await engine.synthesize({ turnId: 'u', text: 'Oi.', outPath: out('u'), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 6000 });
    assert.equal(r.ok === false && r.scope, 'unknown');
  });

  it('H13a.8: 503 e 404 -> falha estruturada; o provedor cai no `say`', async () => {
    for (const status of [503, 404]) {
      gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'status', status, echo: 'x' };
      await boot({}, {}, {});
      const r = await engine.synthesize({ turnId: `s${status}`, text: 'Oi.', outPath: out(`s${status}`), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 6000 });
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.kind, status === 503 ? 'server' : 'not_found');
      await engine.shutdown();
    }
  });

  it('H13a.8: 400 não é erro de serviço (client_error) e o provedor bloqueia o Gemini por 5 min, mas fala no `say`', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'status', status: 400, echo: 'x' };
    await boot();
    await provider.synthesize('Oi.', out('b400'), undefined, { turnId: 't400', kind: 'generated' });
    assert.deepEqual(say.spoken, ['Oi.']);
    assert.ok(budget.status().blockedForMs > 4 * 60_000);
  });

  it('nunca segue redirecionamento (a chave iria a outro host): um 307 vira falha e NENHUM segundo pedido é feito', async () => {
    const other = new FakeGemini();
    await other.start();
    try {
      gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'redirect', to: `${other.url}/v1beta/models/gemini-3.8-flash-lite-tts:streamGenerateContent` };
      await boot();
      const r = await engine.synthesize({ turnId: 'r', text: 'Oi.', outPath: out('r'), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 6000 });
      assert.equal(r.ok, false);
      assert.equal(other.requests.length, 0, 'o outro host não recebeu nada');
      assert.equal(gemini.ttsRequests().length, 1, 'só o pedido original foi feito ao host original');
    } finally {
      await other.stop();
    }
  });

  it('prazo local: o servidor não responde; a 1ª frase do turno falha em ~deadline (não espera o HTTP) e cai no `say`', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'hang' };
    await boot({}, { firstDeadlineMs: 1500, deadlineMs: 2500 });
    const t0 = Date.now();
    await provider.synthesize('Oi.', out('hang'), undefined, { turnId: 'th', kind: 'generated', isFirstOfTurn: true });
    const el = Date.now() - t0;
    assert.ok(el >= 1400 && el < 4500, `caiu no say em ${el} ms`);
    assert.deepEqual(say.spoken, ['Oi.']);
    assert.ok(!fs.existsSync(`${out('hang')}.part`) && !fs.existsSync(out('hang')) || fs.readFileSync(out('hang'), 'utf-8') === 'WAV-do-say');
  });

  it('H13a.13: com a geração PRESA no worker, uma síntese conclui em < 3 s (não espera a geração)', async () => {
    gemini.modelModes['gemini-flash-latest'] = { kind: 'hang' }; // a geração trava o laço de trabalho do worker
    await boot();
    const sentences: string[] = [];
    const gen = engine.generate('turno-gen', Date.now(), [{ role: 'system', content: 's' }, { role: 'user', content: 'oi' }], { onSentence: (t) => sentences.push(t) });
    await new Promise((r) => setTimeout(r, 400)); // a geração já está dentro do worker, bloqueada
    assert.equal(gemini.streamRequests().length >= 1, true, 'a geração chegou ao Gemini falso e ficou presa');
    const t0 = Date.now();
    await provider.synthesize('A frase zero.', out('g0'), undefined, { turnId: 'turno-gen', kind: 'generated', isFirstOfTurn: true });
    const el = Date.now() - t0;
    assert.ok(el < 3000, `a síntese esperou a geração: ${el} ms`);
    assert.equal(say.spoken.length, 0, 'sintetizou pelo Gemini, não caiu no say');
    assert.ok(fs.existsSync(out('g0')));
    engine.cancel('turno-gen');
    await gen.catch(() => {});
  });

  it('H13a.16: encerrar o worker com 2 sínteses em curso termina em < 2 s e não deixa .part', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'hang' };
    await boot();
    const reqs = [0, 1].map((i) =>
      engine.synthesize({ turnId: 'tx', text: `Frase ${i}.`, outPath: out(`x${i}`), model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', deadlineMs: 20000 })
    );
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    await engine.shutdown();
    const el = Date.now() - t0;
    assert.ok(el < 2000, `encerramento levou ${el} ms`);
    await Promise.all(reqs);
    assert.ok(!fs.existsSync(`${out('x0')}.part`) && !fs.existsSync(`${out('x1')}.part`));
  });

  it('cancelamento (barge-in) aborta o pedido em curso sem cair no `say` e sem arquivo', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'hang' };
    await boot();
    const ac = new AbortController();
    const p = provider.synthesize('Longa.', out('abt'), ac.signal, { turnId: 'tabt', kind: 'generated' });
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(p, (e: Error) => e.name === 'AbortError');
    assert.equal(say.spoken.length, 0);
    assert.ok(!fs.existsSync(out('abt')));
  });

  it('o corpo bruto do erro e a chave nunca aparecem nos logs do provedor', async () => {
    gemini.modelModes['gemini-3.8-flash-lite-tts'] = { kind: 'status', status: 503, echo: 'SEGREDO-NO-CORPO-DO-ERRO' };
    await boot();
    await provider.synthesize('Texto falado sensivel.', out('lg'), undefined, { turnId: 'tl', kind: 'generated' });
    const all = logs.join('\n');
    assert.ok(!all.includes('SEGREDO-NO-CORPO-DO-ERRO') && !all.includes(REAL_LOOKING_KEY) && !all.includes('Texto falado sensivel.'));
  });

  it('o worker só fala com o Gemini falso em loopback: nenhum pedido a outro destino (proxy de rede recusa e conta)', async () => {
    const proxy = new RecordingProxy();
    await proxy.start();
    try {
      await boot({}, {}, { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' });
      await provider.synthesize('Oi.', out('px'), undefined, { turnId: 'tpx', kind: 'generated' });
      assert.deepEqual(proxy.seen, [], 'nenhuma tentativa de conexão externa');
      assert.equal(gemini.ttsRequests().length, 1);
    } finally {
      await proxy.stop();
    }
  });
});
