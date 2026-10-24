import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { VOICE_LIMITS, type ConversationMessage } from '../../shared/voiceProtocol.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager, trimHistory, windowHistory } from '../voice/sessionManager.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';

class SilentVoice implements IVoiceProvider {
  readonly id = 'silent';
  readonly name = 'silent';
  isAvailable(): boolean { return true; }
  async synthesize(): Promise<void> {}
}

function createMockSseResponse() {
  let ended = false;
  const chunks: string[] = [];
  return {
    write: (data: string) => {
      chunks.push(data);
      return true;
    },
    end: () => {
      ended = true;
    },
    get writableEnded() {
      return ended;
    },
    chunks
  } as unknown as ServerResponse;
}

describe('Expansão de Janela de Contexto e Timeout de Ociosidade', () => {
  it('trimHistory: retenção em memória limita a MAX_CONTEXT_TURNS * 2 (200 mensagens)', () => {
    const messages: ConversationMessage[] = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`
    }));

    const trimmed = trimHistory(messages);
    assert.equal(trimmed.length, VOICE_LIMITS.MAX_CONTEXT_TURNS * 2);
    assert.equal(trimmed.length, 200);
    assert.equal(trimmed[0].content, 'msg-50');
    assert.equal(trimmed[trimmed.length - 1].content, 'msg-249');

    // Menos que o limite: preserva integralmente
    const shortList = messages.slice(0, 50);
    assert.equal(trimHistory(shortList).length, 50);
  });

  it('windowHistory: seleciona cauda de até historyTurns * 2 (60 msgs no padrão 30) e descarta telas e órfãos', () => {
    const messages: ConversationMessage[] = [
      { role: 'assistant', content: 'órfã inicial' },
      ...Array.from({ length: 80 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `texto-${i}`,
        origin: (i === 10 || i === 11 ? 'screen' : undefined) as 'screen' | undefined
      }))
    ];

    const windowed = windowHistory(messages, DEFAULT_PRIVACY);
    // 30 turnos * 2 = 60 mensagens no teto
    assert.ok(windowed.length <= DEFAULT_PRIVACY.historyTurns * 2);
    assert.equal(windowed[0].role, 'user', 'sempre deve começar por mensagem do usuário');
    assert.ok(windowed.every((m) => (m as any).origin === undefined), 'metadados internos como origin não vazam');
    assert.ok(!windowed.some((m) => m.content === 'texto-10' || m.content === 'texto-11'), 'mensagens com origin:screen são filtradas');

    // Com sendHistory: false, apenas a última mensagem do usuário (não de tela) vai
    const noHistory = windowHistory(messages, { ...DEFAULT_PRIVACY, sendHistory: false });
    assert.equal(noHistory.length, 1);
    assert.equal(noHistory[0].role, 'user');
  });

  it('SessionManager: resolução do timeout via PrivacyConfig e tuning override', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-timeout-'));
    try {
      const audioStore = new AudioStore(tmp);
      const engine = new FakeVoiceEngine();
      const tts = new SilentVoice();
      const agents = createSpecialistAgents();

      // Caso 1: padrão de produção (DEFAULT_PRIVACY => 60 min = 3.600.000 ms)
      const smDefault = new SessionManager(engine, tts, audioStore, agents, null, [], [], null, DEFAULT_PRIVACY);
      assert.equal((smDefault as any).idleTimeoutMs, 60 * 60_000);

      // Caso 2: privacidade customizada (15 min = 900.000 ms)
      const privacy15: PrivacyConfig = { ...DEFAULT_PRIVACY, idleTimeoutMinutes: 15 };
      const sm15 = new SessionManager(engine, tts, audioStore, agents, null, [], [], null, privacy15);
      assert.equal((sm15 as any).idleTimeoutMs, 15 * 60_000);

      // Caso 3: tuning override (5.000 ms)
      const smTuning = new SessionManager(engine, tts, audioStore, agents, null, [], [], null, DEFAULT_PRIVACY, {
        idleTimeoutMs: 5_000
      });
      assert.equal((smTuning as any).idleTimeoutMs, 5_000);

      await smDefault.shutdownAll();
      await sm15.shutdownAll();
      await smTuning.shutdownAll();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('SessionManager: ciclo de vida do timeout de 60m, renovação por atividade e término observável', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lifecycle-'));

    try {
      const audioStore = new AudioStore(tmp);
      const engine = new FakeVoiceEngine();
      const tts = new SilentVoice();
      const agents = createSpecialistAgents();

      // Instancia com o padrão de 60 minutos
      const sm = new SessionManager(engine, tts, audioStore, agents, null, [], [], null, DEFAULT_PRIVACY);
      const { sessionId, token } = await sm.createSession();
      assert.equal(sm.isAuthorized(sessionId, token), true);

      const mockRes = createMockSseResponse();
      const attached = sm.attachEvents(sessionId, token, mockRes);
      assert.equal(attached, true);

      const M = 60_000;

      // 1. Avança 10 minutos (prazo do timeout antigo): sessão continua ativa
      mock.timers.tick(10 * M);
      assert.equal(sm.isAuthorized(sessionId, token), true);
      assert.equal(mockRes.writableEnded, false);

      // 2. Avança mais 40 minutos (total 50m desde o início): continua ativa
      mock.timers.tick(40 * M);
      assert.equal(sm.isAuthorized(sessionId, token), true);

      // 3. Atividade aos 50m (touch público via markPlayed)
      // O novo prazo de expiração deve ser 50m + 60m = 110m
      sm.markPlayed(sessionId, token, 'turn-1', 'fala ouvida');

      // 4. Avança 15 minutos (t = 65m do início, 5m APÓS o prazo original de 60m)
      // Antifalso-positivo: se clearTimeout não tivesse funcionado, a sessão teria morrido aos 60m!
      mock.timers.tick(15 * M);
      assert.equal(sm.isAuthorized(sessionId, token), true, 'deve sobreviver após o prazo de expiração original');
      assert.equal(mockRes.writableEnded, false);

      // 5. Avança até t = 109m (59 minutos após o touch)
      mock.timers.tick(44 * M);
      assert.equal(sm.isAuthorized(sessionId, token), true, 'deve continuar ativa aos 59m após atividade');
      assert.equal(mockRes.writableEnded, false);

      // 6. Avança 1 minuto até t = 110m (exatamente 60m após a atividade)
      mock.timers.tick(1 * M);

      // Encerramento observável
      assert.equal(sm.isAuthorized(sessionId, token), false, 'sessão deve estar desautorizada e expirada');
      assert.equal(mockRes.writableEnded, true, 'SSE deve ser encerrado com end()');

      // Tentativa de reutilizar sessão expirada é rejeitada
      assert.equal(sm.attachEvents(sessionId, token, createMockSseResponse()), false);

      await sm.shutdownAll();
    } finally {
      mock.timers.reset();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
