import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import type { AppConfig } from '../../shared/types.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { ClaudeCodeRunner, ClaudeDelegateTool, CLAUDE_STARTED_TEXT, type ClaudeJob } from '../agents/claudeCode.js';
import { CLAUDE_CODE_DISABLED_TEXT } from '../privacy.js';
import { JsonStore } from '../storage/jsonStore.js';
import { startServer } from '../server.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager } from '../voice/sessionManager.js';

/** Fase 17 ponta a ponta: fala "pede pro Claude ..." -> pergunta falada -> "sim" -> processo -> aviso. Tudo com processo FALSO. */
function wav(): Buffer {
  const pcm = Buffer.alloc(3200);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
class Voice implements IVoiceProvider {
  readonly id = 'v'; readonly name = 'v';
  kinds: Array<string | undefined> = [];
  isAvailable(): boolean { return true; }
  async synthesize(_t: string, out: string, _s?: AbortSignal, o?: SynthesizeOptions): Promise<void> { this.kinds.push(o?.kind); await fs.promises.writeFile(out, wav()); }
}
class FakeChild extends EventEmitter {
  pid: number | undefined = undefined;
  stdout = new PassThrough(); stderr = new PassThrough(); stdinText = ''; killed = false;
  stdin = new Writable({ write: (c: Buffer, _e, cb) => { this.stdinText += c.toString(); cb(); } });
  kill(): boolean { this.killed = true; return true; }
}

describe('Fase 17: fluxo de voz ponta a ponta', () => {
  let server: http.Server; let sm: SessionManager; let tmp: string; let base: string; let engine: FakeVoiceEngine; let voice: Voice;
  const children: FakeChild[] = [];
  afterEach(async () => {
    await sm.shutdownAll();
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections(); server.closeIdleConnections(); await closed;
    fs.rmSync(tmp, { recursive: true, force: true });
    children.length = 0;
  });

  async function boot(channelOn: boolean): Promise<{ runner: ClaudeCodeRunner; finished: ClaudeJob[] }> {
    const port = 29600 + Math.floor(Math.random() * 90);
    const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f17-flow-'));
    engine = new FakeVoiceEngine(); voice = new Voice();
    const finished: ClaudeJob[] = [];
    let announce: (j: ClaudeJob) => void = () => {};
    const runner = new ClaudeCodeRunner({
      resolveRoot: () => ({ ok: true, root: '/work/ro' }),
      store: new JsonStore<ClaudeJob>(tmp, 'claude-jobs.json'),
      claudeBin: () => '/fake/claude',
      spawnFn: () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildProcess; },
      onFinished: (j) => { finished.push(j); announce(j); }
    });
    const tool = new ClaudeDelegateTool(runner, () => channelOn);
    const audioStore = new AudioStore(path.join(tmp, 'audio'));
    sm = new SessionManager(engine, voice, audioStore, createSpecialistAgents(), null, [], [tool], null);
    sm.claudeRunner = runner;
    announce = (j) => { void sm.announce(`O Claude terminou. ${j.result ?? ''}`, true); };
    server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
    base = `http://127.0.0.1:${port}`;
    return { runner, finished };
  }

  async function session() {
    const r = await fetch(`${base}/api/voice/session`, { method: 'POST' });
    const { sessionId, token } = (await r.json()) as { sessionId: string; token: string };
    const events: Array<Record<string, unknown>> = [];
    fetch(`${base}/api/voice/session/events?sessionId=${sessionId}&token=${token}`).then(async (res) => {
      const rd = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n'); buf = parts.pop() ?? '';
        for (const p of parts) { const l = p.split('\n').find((x) => x.startsWith('data: ')); if (l) events.push(JSON.parse(l.slice(6))); } }
    }).catch(() => {});
    const wait = async (c: () => boolean): Promise<void> => { for (let i = 0; i < 500 && !c(); i++) await new Promise((x) => setTimeout(x, 10)); assert.ok(c(), 'timeout'); };
    await wait(() => events.length >= 1);
    const headers = { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token };
    const speak = async (): Promise<string> => {
      const rr = await fetch(`${base}/api/voice/session/audio`, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: wav() });
      return ((await rr.json()) as { turnId: string }).turnId;
    };
    const played = async (turnId: string, text: string) => fetch(`${base}/api/voice/session/played`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId, text }) });
    const spoken = () => events.filter((e) => e.type === 'sentence_audio_ready').map((e) => (e as { text: string }).text);
    const turnsDone = () => events.filter((e) => e.type === 'turn_done').length;
    return { events, wait, speak, played, spoken, turnsDone, headers };
  }

  const FALA = 'pede pro Claude listar os arquivos de configuração do projeto';
  const ORDEM = 'listar os arquivos de configuração do projeto';

  it('caminho feliz: a pergunta repete a ordem; só depois do "sim" nasce o processo; ordem vai por stdin; o aviso final usa voz local e fica fora do histórico', async () => {
    const { finished } = await boot(true);
    const s = await session();
    engine.fixedTranscript = FALA;
    const t1 = await s.speak();
    await s.wait(() => s.turnsDone() >= 1);
    const question = s.spoken()[0];
    assert.ok(question.includes(ORDEM), `a pergunta precisa repetir a ordem literal: ${question}`);
    assert.equal(children.length, 0, 'antes do "sim" nenhum processo pode existir');

    await s.played(t1, question);
    engine.fixedTranscript = 'sim';
    engine.confirmationToReturn = 'SIM';
    await s.speak();
    await s.wait(() => s.turnsDone() >= 2);
    assert.ok(s.spoken().some((t) => t.includes(CLAUDE_STARTED_TEXT)), `esperava o aviso de início: ${JSON.stringify(s.spoken())}`);
    assert.equal(children.length, 1);
    assert.equal(children[0].stdinText, ORDEM);

    // o Claude termina: aviso fora de turno, com voz local e marcado como não confiável
    const before = s.spoken().length;
    children[0].stdout.write(JSON.stringify({ is_error: false, result: 'Há três arquivos.' }));
    children[0].emit('close', 0);
    await s.wait(() => s.spoken().length > before);
    assert.equal(finished[0].status, 'done');
    assert.equal(voice.kinds[voice.kinds.length - 1], 'untrusted', 'resposta do Claude nunca vai à voz em nuvem');
  });

  it('H17.1/H17.4: "não" (ou qualquer coisa que não seja SIM) => nenhum processo', async () => {
    await boot(true);
    const s = await session();
    engine.fixedTranscript = FALA;
    const t1 = await s.speak();
    await s.wait(() => s.turnsDone() >= 1);
    await s.played(t1, s.spoken()[0]);
    engine.fixedTranscript = 'nem, depois eu peço';
    engine.confirmationToReturn = 'NAO';
    await s.speak();
    await s.wait(() => s.turnsDone() >= 2);
    assert.equal(children.length, 0);
  });

  it('pergunta nunca ouvida (sem /played) => o "sim" seguinte não executa', async () => {
    await boot(true);
    const s = await session();
    engine.fixedTranscript = FALA;
    await s.speak();
    await s.wait(() => s.turnsDone() >= 1);
    engine.fixedTranscript = 'sim';
    engine.confirmationToReturn = 'SIM';
    await s.speak();
    await s.wait(() => s.turnsDone() >= 2);
    assert.equal(children.length, 0, 'sem markPlayed a confirmação não vale');
  });

  it('canal desligado: fala honesta, nenhum processo e nenhuma pergunta de confirmação', async () => {
    await boot(false);
    const s = await session();
    engine.fixedTranscript = FALA;
    await s.speak();
    await s.wait(() => s.turnsDone() >= 1);
    assert.deepEqual(s.spoken(), [CLAUDE_CODE_DISABLED_TEXT]);
    assert.equal(children.length, 0);
  });

  it('API da tela: lista as tarefas e exige a sessão', async () => {
    await boot(true);
    const s = await session();
    const sem = await fetch(`${base}/api/voice/claude/jobs`);
    assert.equal(sem.status, 401);
    const ok = await fetch(`${base}/api/voice/claude/jobs`, { headers: s.headers });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { enabled: boolean; jobs: unknown[]; ready: boolean };
    assert.equal(body.enabled, true);
    assert.deepEqual(body.jobs, []);
  });
});
