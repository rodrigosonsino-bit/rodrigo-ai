import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.js';
import type { AppConfig } from '../../shared/types.js';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager, windowHistory } from '../voice/sessionManager.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { createMutatingTools } from '../tools/index.js';
import { mightBeMutation } from '../tools/mutatingTools.js';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import { mightBeScreenQuery, screenCloudAuthorized } from '../tools/screenQuery.js';
import { SCREEN_NOT_READY_TEXT, SCREEN_SHARE_NEEDED_TEXT, type ConversationMessage } from '../../shared/voiceProtocol.js';
import type { SessionTuning } from '../voice/sessionManager.js';
import { parseJpegHeader } from '../voice/image.js';

/**
 * Fase V, fatia 2 (docs/phase-vision-v3.md §3, §5.3, §10.1–10.2): reconhecer a pergunta sobre a tela, decidir a proveniência
 * ANTES do histórico, isolar o turno de tela de todo envio posterior ao Gemini e a gramática de autorização da nuvem.
 */
function wav(): Buffer {
  const samples = 1600;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

interface Call {
  text: string;
  options: SynthesizeOptions | undefined;
}

class CtlProvider implements IVoiceProvider {
  readonly id = 'ctl';
  readonly name = 'ctl';
  prefersCoalescing = false;
  calls: Call[] = [];
  endTurns: string[] = [];
  /** Atraso por texto (ms); texto desconhecido = 5 ms. Valor Infinity: nunca resolve dentro do teste. */
  delays = new Map<string, number>();
  failOn = new Set<string>();
  isAvailable(): boolean {
    return true;
  }
  async synthesize(text: string, outputPath: string, signal?: AbortSignal, options?: SynthesizeOptions): Promise<void> {
    this.calls.push({ text, options });
    const d = this.delays.get(text) ?? 5;
    await new Promise((r) => setTimeout(r, d));
    if (signal?.aborted) throw new Error('aborted');
    if (this.failOn.has(text)) throw new Error('falhou');
    await fs.promises.writeFile(outputPath, wav());
  }
  endTurn(turnId: string): void {
    this.endTurns.push(turnId);
  }
}

interface H {
  server: http.Server;
  baseUrl: string;
  engine: FakeVoiceEngine;
  tts: CtlProvider;
  sm: SessionManager;
  audioStore: AudioStore;
  tmp: string;
}

async function setup(opts: { mutating?: readonly IMutatingTool[]; tuning?: SessionTuning } = {}): Promise<H> {
  const port = 25000 + Math.floor(Math.random() * 4000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-session-'));
  const engine = new FakeVoiceEngine();
  const tts = new CtlProvider();
  const audioStore = new AudioStore(tmp);
  const sm = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), null, [], opts.mutating ?? [], null, undefined, opts.tuning);
  const server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, sm, audioStore, tmp };
}

/** Fase V §4: um JPEG mínimo e VÁLIDO (SOI + SOF0 com altura/largura reais + EOI) — o parser não decodifica pixels. */
function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
function makeJpeg(width: number, height: number): Buffer {
  const sofContent = Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0]),
    u16be(2 + sofContent.length),
    sofContent,
    Buffer.from([0xff, 0xd9])
  ]);
}

function findScreenFiles(root: string): string[] {
  const out: string[] = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, dirent.name);
    if (dirent.isDirectory()) out.push(...findScreenFiles(p));
    else if (dirent.name.startsWith('screen-')) out.push(p);
  }
  return out;
}

async function postScreenJpeg(
  h: H,
  s: { sessionId: string; token: string },
  captureId: string,
  jpeg: Buffer
): Promise<Response> {
  return fetch(`${h.baseUrl}/api/voice/session/screen?captureId=${encodeURIComponent(captureId)}`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'image/jpeg' },
    body: jpeg
  });
}

async function postScreenUnavailable(
  h: H,
  s: { sessionId: string; token: string },
  captureId: string
): Promise<Response> {
  return fetch(`${h.baseUrl}/api/voice/session/screen`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ captureId, unavailable: true })
  });
}

/**
 * Prazo longo o bastante para o pedido de captura NUNCA vencer durante um teste que precisa dele pendente: com 300 ms
 * o intervalo entre o `screen_request` e o POST (poll de 8 ms + fetch) estourava sob carga e a rota devolvia 409 no
 * lugar do 400/413 esperado. Os testes encerram o turno de forma determinística com `settlePendingCapture`.
 */
const SCREEN_HOLD_MS = 30_000;

/** Resolve o pedido real ainda pendente (e prova que ele sobreviveu intacto à rejeição anterior). */
async function settlePendingCapture(h: H, s: { sessionId: string; token: string }, captureId: string): Promise<void> {
  const res = await postScreenUnavailable(h, s, captureId);
  assert.equal(res.status, 200, 'o pedido real devia continuar pendente depois da rejeição');
}

const screenRequestCaptureId = async (s: { sse: ReturnType<typeof readSse> }): Promise<string> => {
  await waitFor(() => s.sse.events.some((e) => e.type === 'screen_request'), 'screen_request');
  const ev = s.sse.events.find((e) => e.type === 'screen_request') as { captureId?: string } | undefined;
  if (!ev?.captureId) throw new Error('screen_request sem captureId');
  return ev.captureId;
};

async function teardown(h: H): Promise<void> {
  await h.sm.shutdownAll();
  const closed = new Promise<void>((r) => h.server.close(() => r()));
  h.server.closeAllConnections();
  h.server.closeIdleConnections();
  await closed;
  fs.rmSync(h.tmp, { recursive: true, force: true });
}

function readSse(url: string): { events: Array<Record<string, unknown>>; close: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const ac = new AbortController();
  fetch(url, { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line) events.push(JSON.parse(line.slice(6)));
        }
      }
    })
    .catch(() => {});
  return { events, close: () => ac.abort() };
}

async function waitFor(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 8));
  }
  throw new Error(`timeout esperando: ${what}`);
}

async function startSession(h: H): Promise<{ sessionId: string; token: string; sse: ReturnType<typeof readSse> }> {
  const r = await fetch(`${h.baseUrl}/api/voice/session`, { method: 'POST' });
  const { sessionId, token } = (await r.json()) as { sessionId: string; token: string };
  const sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
  await waitFor(() => sse.events.length >= 1, 'estado inicial');
  return { sessionId, token, sse };
}

async function speak(h: H, s: { sessionId: string; token: string }): Promise<string> {
  const r = await fetch(`${h.baseUrl}/api/voice/session/audio`, {
    method: 'POST',
    headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'audio/wav' },
    body: wav()
  });
  assert.equal(r.status, 200);
  return ((await r.json()) as { turnId: string }).turnId;
}

const ready = (sse: { events: Array<Record<string, unknown>> }): Array<{ text: string; sentenceIndex: number }> =>
  sse.events.filter((e) => e.type === 'sentence_audio_ready') as unknown as Array<{ text: string; sentenceIndex: number }>;
const done = (sse: { events: Array<Record<string, unknown>> }): boolean => sse.events.some((e) => e.type === 'turn_done');

describe('Fase V — mightBeScreenQuery (§3.1)', () => {
  for (const t of ['o que tem na minha tela?', 'Olha minha tela', 'o que é isso no monitor', 'me ajuda com essa janela',
    'o que aparece no desktop?', 'tem um erro na área de trabalho', 'o que está aqui na frente?', 'olha as telas', 'tenho dois monitores ligados', 'nas áreas de trabalho', 'essas janelas']) {
    it(`é tela: "${t}"`, () => assert.equal(mightBeScreenQuery(t), true));
  }
  for (const t of ['o que é isso?', 'esse erro aqui', 'olha só', 'qual a capital da França?', 'telhado', 'estelar', 'telão', 'monitoramento', 'telefone']) {
    it(`não é tela: "${t}"`, () => assert.equal(mightBeScreenQuery(t), false));
  }
  for (const t of ['cria um lembrete para comprar a tela nova', 'salva uma nota sobre a tela quebrada', 'guarda na memória que a tela deu problema', 'anota que a tela do celular quebrou']) {
    it(`pedido de mutação que cita a tela é mutação (§10.2): "${t}"`, () => assert.equal(mightBeMutation(t), true));
  }
});

describe('Fase V — screenCloudAuthorized (§3.2, §10.1)', () => {
  for (const t of ['com o Gemini, olha minha tela', 'olha minha tela com o Gemini', 'o que tem na tela, manda pro Gemini',
    'usa o Gemini e olha a tela', 'pergunta pro gêmini o que tem na tela.', 'o que é esse erro na tela? usa o Gemini!']) {
    it(`autoriza: "${t}"`, () => assert.equal(screenCloudAuthorized(t), true));
  }
  for (const t of ['olha minha tela', 'olha minha tela mas não usa o Gemini', 'sem o Gemini, olha a tela', 'nunca usa o Gemini',
    "o que significa 'usa o gemini'?", 'o que significa usa o gemini', 'como assim com o Gemini', 'por que usar o Gemini na tela?',
    'o Gemini é bom?', 'o gemini apareceu na minha tela', 'olha a tela com o gemini e não com o resto', 'nem pensar, com o Gemini', 'olha minha tela "com o Gemini"', "olha minha tela 'usa o gemini'"]) {
    it(`NÃO autoriza: "${t}"`, () => assert.equal(screenCloudAuthorized(t), false));
  }
});

describe('Fase V — windowHistory nunca deixa sair turno de tela (§5.3)', () => {
  const H: ConversationMessage[] = [
    { role: 'user', content: 'pergunta normal' },
    { role: 'assistant', content: 'resposta normal' },
    { role: 'user', content: 'TELA-PERGUNTA-MARCADOR', origin: 'screen' },
    { role: 'assistant', content: 'TELA-RESPOSTA-MARCADOR', origin: 'screen' },
    { role: 'user', content: 'pergunta atual' }
  ];
  it('histórico desligado + confirmação de reprodução atrasada (resposta gravada DEPOIS da fala atual): sai a fala atual', () => {
    const late: ConversationMessage[] = [
      { role: 'user', content: 'TELA-PERGUNTA', origin: 'screen' },
      { role: 'user', content: 'pergunta atual' },
      { role: 'assistant', content: 'TELA-RESPOSTA', origin: 'screen' }
    ];
    assert.deepEqual(windowHistory(late, { sendHistory: false, historyTurns: 8 }), [{ role: 'user', content: 'pergunta atual' }]);
    const lateNormal: ConversationMessage[] = [
      { role: 'user', content: 'pergunta atual' },
      { role: 'assistant', content: 'resposta antiga atrasada' }
    ];
    assert.deepEqual(windowHistory(lateNormal, { sendHistory: false, historyTurns: 8 }), [{ role: 'user', content: 'pergunta atual' }]);
  });

  it('histórico ligado: remove as mensagens de tela e nunca envia o campo origin', () => {
    const out = windowHistory(H, { sendHistory: true, historyTurns: 8 });
    assert.deepEqual(out, [
      { role: 'user', content: 'pergunta normal' },
      { role: 'assistant', content: 'resposta normal' },
      { role: 'user', content: 'pergunta atual' }
    ]);
    assert.ok(out.every((m) => !('origin' in m)));
  });
  it('histórico desligado: a última mensagem de tela não sai; a normal sai sem origin', () => {
    // sem fala normal depois da tela: sai a última fala NORMAL do usuário, nunca a de tela
    assert.deepEqual(windowHistory(H.slice(0, 4), { sendHistory: false, historyTurns: 8 }), [{ role: 'user', content: 'pergunta normal' }]);
    assert.deepEqual(windowHistory(H, { sendHistory: false, historyTurns: 8 }), [{ role: 'user', content: 'pergunta atual' }]);
  });
});

describe('Fase V — sessão: caminho de tela (fatia 2)', () => {
  let h: H;
  afterEach(async () => {
    if (h) await teardown(h);
  });

  it('pergunta sobre a tela sem captura (ninguém compartilhou): rótulo TELA, pede para compartilhar, NENHUM detector/classificação/geração', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: 80 } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    const routing = s.sse.events.find((e) => e.type === 'routing') as { label?: string } | undefined;
    assert.equal(routing?.label, 'TELA');
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_SHARE_NEEDED_TEXT]);
    assert.equal(h.tts.calls[0].options?.kind, 'local');
    assert.equal(h.engine.classifyCalls.length, 0);
    assert.equal(h.engine.detectMutationCalls.length + h.engine.detectToolCalls.length, 0);
    assert.equal(h.engine.generateCalls.length, 0);
    s.sse.close();
  });

  it('o turno de tela (pergunta E resposta ouvida) não aparece na geração seguinte', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: 80 } });
    const s = await startSession(h);
    const playedAll = async (turnId: string, texts: string[]): Promise<void> => {
      for (const text of texts) {
        const r = await fetch(`${h.baseUrl}/api/voice/session/played`, {
          method: 'POST',
          headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId, text })
        });
        assert.equal(r.status, 200);
      }
    };
    // uma rodada NORMAL antes: assim a resposta de tela não fica no início da janela (onde seria descartada por acaso)
    h.engine.fixedTranscript = 'oi, tudo bem?';
    const t0 = await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done 0');
    await playedAll(t0, ready(s.sse).map((e) => e.text));
    h.engine.fixedTranscript = 'o que tem na minha tela? MARCADOR-TELA';
    const doneBefore = s.sse.events.filter((e) => e.type === 'turn_done').length;
    const t1 = await speak(h, s);
    await waitFor(() => s.sse.events.filter((e) => e.type === 'turn_done').length > doneBefore, 'turn_done 1');
    await playedAll(t1, [SCREEN_SHARE_NEEDED_TEXT]);
    h.engine.fixedTranscript = 'qual a capital da França?';
    const before = s.sse.events.filter((e) => e.type === 'turn_done').length;
    await speak(h, s);
    await waitFor(() => s.sse.events.filter((e) => e.type === 'turn_done').length > before, 'turn_done 2');
    assert.equal(h.engine.generateCalls.length, 2);
    const sent = JSON.stringify(h.engine.generateCalls[1].messages);
    assert.ok(sent.includes('oi, tudo bem?') && sent.includes('Olá!'), 'controle: a rodada normal anterior continua indo');
    assert.ok(!sent.includes('MARCADOR-TELA'), 'a pergunta de tela não sai');
    assert.ok(!sent.includes(SCREEN_SHARE_NEEDED_TEXT), 'a resposta de tela não sai');
    assert.ok(!sent.includes('"origin"'), 'o campo origin nunca vai ao motor');
    assert.ok(sent.includes('qual a capital da França?'));
    s.sse.close();
  });

  it('pedido de mutação que cita a tela segue como mutação, não como tela (§10.2)', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'cria um lembrete para comprar a tela nova';
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.ok(!s.sse.events.some((e) => e.type === 'routing' && e.label === 'TELA'));
    assert.equal(h.engine.classifyCalls.length, 1, 'seguiu o caminho normal (positivo, não só ausência de TELA)');
    s.sse.close();
  });

  it('com mutação ARMADA (pergunta já falada), uma fala que cita a tela NÃO vira turno de tela', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-mut-'));
    try {
      const { tools: mutating } = createMutatingTools(dataDir);
      h = await setup({ mutating });
      h.engine.fixedTranscript = 'Lembrete: comprar café';
      h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];
      const s = await startSession(h);
      await speak(h, s);
      await waitFor(() => done(s.sse), 'turn_done 1');
      h.engine.mutationToReturn = ['NENHUMA', null];
      h.engine.fixedTranscript = 'o que tem na minha tela?';
      const before = s.sse.events.filter((e) => e.type === 'turn_done').length;
      await speak(h, s);
      await waitFor(() => s.sse.events.filter((e) => e.type === 'turn_done').length > before, 'turn_done 2');
      assert.ok(!s.sse.events.some((e) => e.type === 'routing' && e.label === 'TELA'));
      s.sse.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Fase V — parseJpegHeader (fatia 3, §4)', () => {
  it('JPEG válido: lê largura e altura do SOF0', () => {
    assert.deepEqual(parseJpegHeader(makeJpeg(1280, 720)), { width: 1280, height: 720 });
  });
  it('rejeita assinatura errada (PNG)', () => {
    assert.equal(parseJpegHeader(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
  });
  it('rejeita buffer vazio ou curto demais', () => {
    assert.equal(parseJpegHeader(Buffer.alloc(0)), null);
    assert.equal(parseJpegHeader(Buffer.from([0xff, 0xd8])), null);
  });
  it('rejeita SOI seguido de EOI sem nenhum SOF (sem dimensão)', () => {
    assert.equal(parseJpegHeader(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  });
  it('rejeita SOF truncado (segLen aponta além do buffer)', () => {
    const b = makeJpeg(100, 100);
    assert.equal(parseJpegHeader(b.subarray(0, b.length - 5)), null);
  });
  it('rejeita dimensão zero (altura ou largura)', () => {
    assert.equal(parseJpegHeader(makeJpeg(0, 100)), null);
    assert.equal(parseJpegHeader(makeJpeg(100, 0)), null);
  });
  it('rejeita byte 0/1 que NÃO é a assinatura SOI, mesmo que o resto pareça um JPEG válido a partir do byte 2', () => {
    // Pega um JPEG válido e troca só os 2 primeiros bytes — se o parser não checar a assinatura e só pular
    // "offset = 2" cegamente, isto passaria (o conteúdo a partir do byte 2 é um SOF0 válido por acidente).
    const valid = makeJpeg(640, 480);
    const semAssinatura = Buffer.concat([Buffer.from([0x00, 0x00]), valid.subarray(2)]);
    assert.equal(parseJpegHeader(semAssinatura), null);
  });
});

describe('Fase V — SessionManager.receiveScreenCapture/rejectScreenCapture (chamados direto, sem a rota)', () => {
  let h: H;
  afterEach(async () => {
    if (h) await teardown(h);
  });

  it('receiveScreenCapture rejeita captureId errado — a validação é da própria API, não só da rota', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const wrong = h.sm.receiveScreenCapture(s.sessionId, s.token, 'id-errado', '/tmp/x.jpg', 10);
    assert.equal(wrong, false);
    // o pedido real continua intacto: o captureId CERTO ainda funciona depois da tentativa errada
    const right = h.sm.receiveScreenCapture(s.sessionId, s.token, captureId, '/tmp/x.jpg', 10);
    assert.equal(right, true);
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('receiveScreenCapture rejeita sessão/token errados', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    assert.equal(h.sm.receiveScreenCapture('sessao-errada', s.token, captureId, '/tmp/x.jpg', 10), false);
    assert.equal(h.sm.receiveScreenCapture(s.sessionId, 'token-errado', captureId, '/tmp/x.jpg', 10), false);
    assert.equal(h.sm.receiveScreenCapture(s.sessionId, s.token, captureId, '/tmp/x.jpg', 10), true);
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('receiveScreenCapture rejeita um captureId cujo turno já foi cancelado (revalida identidade, não só existência)', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    const turnId = await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(h.sm.receiveScreenCapture(s.sessionId, s.token, captureId, '/tmp/x.jpg', 10), false);
    s.sse.close();
  });

  it('rejectScreenCapture rejeita captureId errado sem tocar no pedido real', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    assert.equal(h.sm.rejectScreenCapture(s.sessionId, s.token, 'id-errado'), false);
    assert.equal(h.sm.rejectScreenCapture(s.sessionId, s.token, captureId), true);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_SHARE_NEEDED_TEXT]);
    s.sse.close();
  });
});

describe('Fase V — captura de tela (fatia 3, §4, HV.3/HV.4)', () => {
  let h: H;
  afterEach(async () => {
    if (h) await teardown(h);
  });

  it('captura bem-sucedida: screen_request chega, JPEG válido é aceito, resposta é a frase de "ainda não sei ver", e o arquivo é apagado depois (HV.4)', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    const turnId = await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const postRes = await postScreenJpeg(h, s, captureId, makeJpeg(640, 480));
    assert.equal(postRes.status, 200);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_NOT_READY_TEXT]);
    assert.equal(findScreenFiles(h.tmp).length, 0, 'o JPEG não pode sobrar em disco depois do turno (HV.4)');
    void turnId;
    s.sse.close();
  });

  it('auditoria Kimi K3 (achado 5): o JSON de unavailable usa SÓ o captureId do corpo, nunca cai para o da query', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: SCREEN_HOLD_MS } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    // corpo SEM captureId, mas com o captureId real na QUERY — antes do achado 5 isto consumia o pedido real.
    const res = await fetch(`${h.baseUrl}/api/voice/session/screen?captureId=${encodeURIComponent(captureId)}`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ unavailable: true })
    });
    assert.equal(res.status, 409, 'o captureId da query não deve valer para o ramo JSON');
    // o pedido real continua intacto: funciona com o captureId no CORPO, como deveria
    const ok = await postScreenUnavailable(h, s, captureId);
    assert.equal(ok.status, 200);
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('sem compartilhamento: {unavailable:true} → pede para compartilhar, nenhum arquivo é escrito', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const res = await postScreenUnavailable(h, s, captureId);
    assert.equal(res.status, 200);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_SHARE_NEEDED_TEXT]);
    assert.equal(findScreenFiles(h.tmp).length, 0);
    s.sse.close();
  });

  it('HV.3: captureId errado é rejeitado com 409 e NUNCA escreve nada em disco', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: SCREEN_HOLD_MS } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s); // garante que o pedido já existe
    const res = await postScreenJpeg(h, s, 'captureId-que-nao-existe', makeJpeg(100, 100));
    assert.equal(res.status, 409);
    assert.equal(findScreenFiles(h.tmp).length, 0, 'captureId inválido nunca aloca armazenamento (achado 7)');
    await settlePendingCapture(h, s, captureId); // o pedido real ainda está pendente: encerra o turno sem esperar prazo
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('HV.3: captureId duplicado (reenvio depois de já consumido) é rejeitado com 409', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const first = await postScreenJpeg(h, s, captureId, makeJpeg(100, 100));
    assert.equal(first.status, 200);
    const dup = await postScreenJpeg(h, s, captureId, makeJpeg(100, 100));
    assert.equal(dup.status, 409);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.equal(findScreenFiles(h.tmp).length, 0);
    s.sse.close();
  });

  it('HV.3: captureId de um pedido já superado (nova fala no meio da espera) é rejeitado com 409', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: 300 } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const staleId = await screenRequestCaptureId(s);
    // nova fala preempta o turno de tela antes da captura chegar
    h.engine.fixedTranscript = 'oi';
    await speak(h, s);
    const res = await postScreenJpeg(h, s, staleId, makeJpeg(100, 100));
    assert.equal(res.status, 409);
    assert.equal(findScreenFiles(h.tmp).length, 0, 'captureId de turno superado nunca escreve nada');
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('HV.3: assinatura inválida (não é JPEG) é rejeitada com 400, sem escrever nada', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: SCREEN_HOLD_MS } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const res = await postScreenJpeg(h, s, captureId, Buffer.from('isto não é um jpeg'));
    assert.equal(res.status, 400);
    assert.equal(findScreenFiles(h.tmp).length, 0);
    await settlePendingCapture(h, s, captureId); // o pedido segue pendente: encerra o turno sem esperar prazo
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('HV.3: dimensão acima do limite é rejeitada com 400, sem escrever nada', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: SCREEN_HOLD_MS } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const res = await postScreenJpeg(h, s, captureId, makeJpeg(1601, 900));
    assert.equal(res.status, 400);
    assert.equal(findScreenFiles(h.tmp).length, 0);
    await settlePendingCapture(h, s, captureId);
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('HV.3: corpo maior que o limite é rejeitado com 413, sem escrever nada', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: SCREEN_HOLD_MS } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const big = Buffer.concat([makeJpeg(100, 100), Buffer.alloc(3 * 1024 * 1024)]);
    const res = await postScreenJpeg(h, s, captureId, big);
    assert.equal(res.status, 413);
    assert.equal(findScreenFiles(h.tmp).length, 0);
    await settlePendingCapture(h, s, captureId);
    await waitFor(() => done(s.sse), 'turn_done');
    s.sse.close();
  });

  it('timeout sem nenhum POST: pede para compartilhar (HV.3 — o prazo é o próprio protetor contra espera infinita)', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: 60 } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    await screenRequestCaptureId(s);
    await waitFor(() => done(s.sse), 'turn_done');
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_SHARE_NEEDED_TEXT]);
    assert.equal(findScreenFiles(h.tmp).length, 0);
    s.sse.close();
  });

  it('auditoria Kimi K3 (achado 1): writeFile falha (disco/permissão) → 500 honesto, nada em disco, pedido destravado na hora (não espera o timeout)', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: 5000 } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    const captureId = await screenRequestCaptureId(s);
    const real = h.audioStore.newScreenCapturePath.bind(h.audioStore);
    h.audioStore.newScreenCapturePath = () => '/caminho/que-nao-existe-de-verdade/x.jpg'; // força ENOENT no writeFile
    const t0 = Date.now();
    const res = await postScreenJpeg(h, s, captureId, makeJpeg(100, 100));
    assert.equal(res.status, 500);
    h.audioStore.newScreenCapturePath = real;
    await waitFor(() => done(s.sse), 'turn_done');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `o pedido devia ser destravado na hora do erro, não esperar os 5s do timeout (levou ${elapsed}ms)`);
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_SHARE_NEEDED_TEXT]);
    assert.equal(findScreenFiles(h.tmp).length, 0, 'nada deve sobrar em disco mesmo com o writeFile falhando');
    s.sse.close();
  });

  it('cancelar o turno (interromper) durante a espera pela captura libera rápido, sem esperar o prazo inteiro', async () => {
    h = await setup({ tuning: { screenCaptureTimeoutMs: 5000 } });
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    const turnId = await speak(h, s);
    await screenRequestCaptureId(s);
    const t0 = Date.now();
    const cancelRes = await fetch(`${h.baseUrl}/api/voice/session/cancel`, {
      method: 'POST',
      headers: { 'X-Rodrigo-Session': s.sessionId, 'X-Rodrigo-Token': s.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId })
    });
    assert.equal(cancelRes.status, 200);
    await waitFor(() => findScreenFiles(h.tmp).length === 0, 'sem resíduo', 2000); // nunca houve captura: nada a apagar
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `cancelamento não pode esperar o prazo de 5s da captura (levou ${elapsed}ms)`);
    s.sse.close();
  });
});
