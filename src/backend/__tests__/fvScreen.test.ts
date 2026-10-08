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
import { SCREEN_NOT_READY_TEXT, type ConversationMessage } from '../../shared/voiceProtocol.js';

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
  tmp: string;
}

async function setup(opts: { mutating?: readonly IMutatingTool[] } = {}): Promise<H> {
  const port = 25000 + Math.floor(Math.random() * 4000);
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-session-'));
  const engine = new FakeVoiceEngine();
  const tts = new CtlProvider();
  const audioStore = new AudioStore(tmp);
  const sm = new SessionManager(engine, tts, audioStore, createSpecialistAgents(), null, [], opts.mutating ?? [], null);
  const server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
  return { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, sm, tmp };
}

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

  it('pergunta sobre a tela: rótulo TELA, frase fixa local, e NENHUM detector, classificação ou geração', async () => {
    h = await setup();
    h.engine.fixedTranscript = 'o que tem na minha tela?';
    const s = await startSession(h);
    await speak(h, s);
    await waitFor(() => done(s.sse), 'turn_done');
    const routing = s.sse.events.find((e) => e.type === 'routing') as { label?: string } | undefined;
    assert.equal(routing?.label, 'TELA');
    assert.deepEqual(ready(s.sse).map((e) => e.text), [SCREEN_NOT_READY_TEXT]);
    assert.equal(h.tts.calls[0].options?.kind, 'local');
    assert.equal(h.engine.classifyCalls.length, 0);
    assert.equal(h.engine.detectMutationCalls.length + h.engine.detectToolCalls.length, 0);
    assert.equal(h.engine.generateCalls.length, 0);
    s.sse.close();
  });

  it('o turno de tela (pergunta E resposta ouvida) não aparece na geração seguinte', async () => {
    h = await setup();
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
    await playedAll(t1, [SCREEN_NOT_READY_TEXT]);
    h.engine.fixedTranscript = 'qual a capital da França?';
    const before = s.sse.events.filter((e) => e.type === 'turn_done').length;
    await speak(h, s);
    await waitFor(() => s.sse.events.filter((e) => e.type === 'turn_done').length > before, 'turn_done 2');
    assert.equal(h.engine.generateCalls.length, 2);
    const sent = JSON.stringify(h.engine.generateCalls[1].messages);
    assert.ok(sent.includes('oi, tudo bem?') && sent.includes('Olá!'), 'controle: a rodada normal anterior continua indo');
    assert.ok(!sent.includes('MARCADOR-TELA'), 'a pergunta de tela não sai');
    assert.ok(!sent.includes(SCREEN_NOT_READY_TEXT), 'a resposta de tela não sai');
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
