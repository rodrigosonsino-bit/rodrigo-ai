import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import type { AppConfig } from '../../shared/types.js';
import { AUDIT_CONCLUSION_LOST_TEXT, AUDIT_REFUSED_TEXT } from '../../shared/voiceProtocol.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { DecisionLog, realAuditFs, type AuditFs } from '../audit/decisionLog.js';
import { startServer } from '../server.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager } from '../voice/sessionManager.js';
import { freePort } from './helpers/freePort.js';

/** T4 ponta a ponta: uma mutação confirmada por voz passa pelas duas fases; registro quebrado => a ação NÃO é executada. */
function wav(): Buffer {
  const pcm = Buffer.alloc(3200);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
class Voice implements IVoiceProvider {
  readonly id = 'v'; readonly name = 'v'; isAvailable(): boolean { return true; }
  async synthesize(_t: string, out: string): Promise<void> { await fs.promises.writeFile(out, wav()); }
}
class FakeReminder implements IMutatingTool {
  readonly name = 'LEMBRETE'; readonly description = 'fake';
  executed: Array<string | null> = [];
  isAvailable(): boolean { return true; }
  preview(_k: string, c: string | null): string { return `Posso criar o lembrete: ${c}?`; }
  execute(_k: string, c: string | null): string { this.executed.push(c); return 'Lembrete criado.'; }
}

describe('T4: auditoria das mutações no fluxo real', () => {
  let server: http.Server; let sm: SessionManager; let tmp: string; let base: string; let engine: FakeVoiceEngine; let tool: FakeReminder;
  afterEach(async () => {
    await sm.shutdownAll();
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections(); server.closeIdleConnections(); await closed;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  async function boot(io: AuditFs = realAuditFs): Promise<DecisionLog> {
    const port = await freePort();
    const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't4-int-'));
    engine = new FakeVoiceEngine(); tool = new FakeReminder();
    const audioStore = new AudioStore(path.join(tmp, 'audio'));
    sm = new SessionManager(engine, new Voice(), audioStore, createSpecialistAgents(), null, [], [tool], null);
    const log = new DecisionLog(path.join(tmp, 'audit', 'decisions.jsonl'), io);
    sm.decisionLog = log;
    server = await startServer(config, undefined, { config, sessionManager: sm, audioStore });
    base = `http://127.0.0.1:${port}`;
    return log;
  }
  async function confirmedMutation(): Promise<string[]> {
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
    const speak = async (): Promise<string> => {
      const rr = await fetch(`${base}/api/voice/session/audio`, { method: 'POST',
        headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'audio/wav' }, body: wav() });
      return ((await rr.json()) as { turnId: string }).turnId;
    };
    engine.fixedTranscript = 'Lembrete: comprar café';
    engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];
    const t1 = await speak();
    await wait(() => events.some((e) => e.type === 'turn_done'));
    const q = (events.find((e) => e.type === 'sentence_audio_ready') as { text: string }).text;
    await fetch(`${base}/api/voice/session/played`, { method: 'POST',
      headers: { 'X-Rodrigo-Session': sessionId, 'X-Rodrigo-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: t1, text: q }) });
    const doneBefore = events.filter((e) => e.type === 'turn_done').length;
    engine.fixedTranscript = 'sim';
    engine.confirmationToReturn = 'SIM';
    await speak();
    await wait(() => events.filter((e) => e.type === 'turn_done').length > doneBefore);
    return events.filter((e) => e.type === 'sentence_audio_ready').map((e) => (e as { text: string }).text);
  }

  it('caminho feliz: a ferramenta executa e o arquivo ganha INTENÇÃO e CONCLUSÃO encadeadas, sem o conteúdo da fala', async () => {
    const log = await boot();
    const spoken = await confirmedMutation();
    assert.deepEqual(tool.executed, ['comprar café']);
    assert.ok(spoken.some((s) => s.includes('Lembrete criado')));
    assert.deepEqual(log.verify(), { ok: true, count: 2 });
    const txt = fs.readFileSync(log.filePath, 'utf-8');
    assert.doesNotMatch(txt, /café|comprar|Lembrete criado/);
    assert.match(txt, /"kind":"intent"/); assert.match(txt, /"kind":"completion"/); assert.match(txt, /"outcome":"ok"/);
  });

  it('fase 1 falha (disco): a ferramenta NÃO é executada e o usuário ouve a recusa', async () => {
    const failing: AuditFs = { ...realAuditFs, append: () => { throw new Error('ENOSPC'); } };
    await boot(failing);
    const spoken = await confirmedMutation();
    assert.deepEqual(tool.executed, [], 'a mutação não pode ter acontecido');
    assert.ok(spoken.includes(AUDIT_REFUSED_TEXT), `esperava a recusa falada; ouviu: ${JSON.stringify(spoken)}`);
  });

  it('fase 2 falha: a ação JÁ ocorreu, não é desfeita, e o usuário é avisado', async () => {
    let n = 0;
    const second: AuditFs = { ...realAuditFs, append: (f, l) => { n += 1; if (n === 2) throw new Error('EIO'); realAuditFs.append(f, l); } };
    const log = await boot(second);
    const spoken = await confirmedMutation();
    assert.deepEqual(tool.executed, ['comprar café']);
    assert.ok(spoken.some((s) => s.includes(AUDIT_CONCLUSION_LOST_TEXT)), `aviso ausente: ${JSON.stringify(spoken)}`);
    assert.equal(log.pending().length, 1, 'intenção sem conclusão ficou registrada');
  });
});
