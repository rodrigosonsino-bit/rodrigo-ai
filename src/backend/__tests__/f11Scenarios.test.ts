process.env.RODRIGO_VOICE_DISABLE = '1';

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from '../../shared/types.js';
import { startServer } from '../server.js';
import { AudioStore } from '../voice/audioStore.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { SessionManager } from '../voice/sessionManager.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import type { ITool, IMutatingTool } from '../../shared/extensions/tools.js';
import { createSpecialistAgents } from '../agents/specialistAgents.js';
import { createMutatingTools, LembreteTool } from '../tools/mutatingTools.js';
import { ReminderScheduler } from '../tools/reminderScheduler.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import {
  MUTATION_FAILURE_TEXT,
  MUTATION_CANCELLED_TEXT,
  MUTATION_REPROMPT_TEXT,
  NO_ACTION_CLAIM_TEXT,
  type MutationName
} from '../../shared/voiceProtocol.js';
import { freePort } from './helpers/freePort.js';

function buildTestWav(durationSeconds = 0.1, sampleRate = 16000): Buffer {
  const totalSamples = Math.round(durationSeconds * sampleRate);
  const dataSize = totalSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

class FakeVoiceProvider implements IVoiceProvider {
  readonly id = 'fake';
  readonly name = 'Fake TTS';
  public synthesizeCalls: string[] = [];

  isAvailable(): boolean {
    return true;
  }

  async synthesize(text: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    this.synthesizeCalls.push(text);
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    await fs.promises.writeFile(outputPath, buildTestWav(0.05));
  }
}

interface Harness {
  server: http.Server;
  baseUrl: string;
  engine: FakeVoiceEngine;
  tts: FakeVoiceProvider;
  audioStore: AudioStore;
  sessionManager: SessionManager;
  tmpDir: string;
}

async function getNextPort(): Promise<number> {
  return freePort();
}

const allHarnesses: Harness[] = [];

async function setupHarness(
  mutatingTools: readonly IMutatingTool[] = [],
  tools: readonly ITool[] = []
): Promise<Harness> {
  const port = await getNextPort();
  const config: AppConfig = { port, host: '127.0.0.1', clientPort: port + 1 };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-harness-'));
  const engine = new FakeVoiceEngine();
  const tts = new FakeVoiceProvider();
  const audioStore = new AudioStore(tmpDir);
  const sessionManager = new SessionManager(
    engine,
    tts,
    audioStore,
    createSpecialistAgents(),
    null,
    tools,
    mutatingTools,
    null
  );

  const server = await startServer(config, undefined, { config, sessionManager, audioStore });
  const h: Harness = { server, baseUrl: `http://127.0.0.1:${port}`, engine, tts, audioStore, sessionManager, tmpDir };
  allHarnesses.push(h);
  return h;
}

async function teardownHarness(h: Harness): Promise<void> {
  if ((h as any)._tornDown) return;
  (h as any)._tornDown = true;
  try {
    await h.sessionManager.shutdownAll();
  } catch {}
  try {
    const closePromise = new Promise<void>((resolve) => h.server.close(() => resolve()));
    h.server.closeAllConnections();
    h.server.closeIdleConnections();
    await closePromise;
  } catch {}
  try {
    await fs.promises.rm(h.tmpDir, { recursive: true, force: true }).catch(() => {});
  } catch {}
}

after(async () => {
  for (const h of allHarnesses) {
    await teardownHarness(h);
  }
});

function readSse(url: string): {
  events: unknown[];
  close: () => void;
  waitFor: (n: number, timeoutMs?: number) => Promise<void>;
} {
  const events: unknown[] = [];
  const controller = new AbortController();
  let resolveWait: (() => void) | null = null;
  let waitCount = 0;

  fetch(url, { signal: controller.signal })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            events.push(JSON.parse(line.slice(6)));
            if (resolveWait && events.length >= waitCount) {
              resolveWait();
              resolveWait = null;
            }
          }
        }
      }
    })
    .catch(() => {});

  return {
    events,
    close: () => controller.abort(),
    waitFor: (n: number, timeoutMs = 4000) =>
      new Promise<void>((resolve, reject) => {
        if (events.length >= n) {
          resolve();
          return;
        }
        waitCount = n;
        resolveWait = resolve;
        setTimeout(
          () => reject(new Error(`Timeout esperando ${n} eventos SSE (recebidos: ${events.length})`)),
          timeoutMs
        );
      })
  };
}

async function createVoiceSession(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/voice/session`, { method: 'POST' });
  assert.equal(res.status, 200);
  return (await res.json()) as { sessionId: string; token: string };
}

async function sendAudio(baseUrl: string, sessionId: string, token: string, wavBuffer = buildTestWav(0.1)) {
  return fetch(`${baseUrl}/api/voice/session/audio`, {
    method: 'POST',
    headers: {
      'X-Rodrigo-Session': sessionId,
      'X-Rodrigo-Token': token,
      'Content-Type': 'audio/wav'
    },
    body: wavBuffer
  });
}

async function sendPlayed(baseUrl: string, sessionId: string, token: string, turnId: string, text: string) {
  return fetch(`${baseUrl}/api/voice/session/played`, {
    method: 'POST',
    headers: {
      'X-Rodrigo-Session': sessionId,
      'X-Rodrigo-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ turnId, text })
  });
}

async function sendCancel(baseUrl: string, sessionId: string, token: string, turnId: string) {
  return fetch(`${baseUrl}/api/voice/session/cancel`, {
    method: 'POST',
    headers: {
      'X-Rodrigo-Session': sessionId,
      'X-Rodrigo-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ turnId })
  });
}

// ============================================================================
// GRUPO A: Controle positivo (~25 respostas afirmativas -> 1 item gravado)
// ============================================================================
describe('Grupo A: Controle positivo (respostas afirmativas executam e gravam exatamente 1 item)', () => {
  const AFFIRMATIVE_CASES = [
    'sim',
    'pode sim',
    'claro que sim',
    'fechou',
    'manda ver',
    'com certeza',
    'pode criar',
    'sim por favor',
    'claro',
    'pode sim',
    'com certeza pode',
    'pode fazer',
    'manda bala',
    'bora',
    'bora que sim',
    'pode mandar',
    'isso mesmo',
    'esta combinado',
    'esta valendo',
    'positivo',
    'confirmo',
    'autorizado',
    'perfeito',
    'cria pra mim',
    'salva por favor',
    'pode crer'
  ];

  AFFIRMATIVE_CASES.forEach((phrase, idx) => {
    it(`A.${idx + 1}: afirmação "${phrase}" executa mutação, fala 'Lembrete criado' e grava 1 item`, async (t) => {
      const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpA-'));
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(mutatingTools);
      let sse: ReturnType<typeof readSse> | null = null;

      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar café';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

        const { sessionId, token } = await createVoiceSession(h.baseUrl);
        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        await sse.waitFor(1); // ouvindo

        // Turno 1: pedido de mutação
        const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
        assert.equal(audioRes1.status, 200);
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8);

        const questionEvent = sse.events.find(
          (e: any) => e.type === 'sentence_audio_ready'
        ) as { text: string };
        assert.ok(questionEvent, 'Servidor deve emitir pergunta de confirmação');
        assert.equal(questionEvent.text, 'Posso criar o lembrete: comprar café?');

        // Cliente confirma reprodução da pergunta
        const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
        assert.equal(playedRes.status, 200);

        // Turno 2: resposta afirmativa do usuário
        h.engine.fixedTranscript = phrase;
        const audioRes2 = await sendAudio(h.baseUrl, sessionId, token);
        assert.equal(audioRes2.status, 200);
        await sse.waitFor(15);

        const executedEvent = sse.events
          .filter((e: any) => e.type === 'sentence_audio_ready')
          .pop() as { text: string };
        assert.ok(
          executedEvent.text.includes('Lembrete criado'),
          `Fala final deve conter 'Lembrete criado', obtido: "${executedEvent.text}"`
        );

        // Verifica que exatamente 1 item foi persistido
        const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
        const data = store.read();
        assert.equal(data.items.length, 1, 'Deve persistir EXATAMENTE 1 lembrete');
        assert.equal(data.items[0].text, 'comprar café');
      } finally {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});

// ============================================================================
// GRUPO B: Zero execução (~30 respostas negação/ambíguo/ruído)
// ============================================================================
describe('Grupo B: Zero execução (negações, ruídos, reprompt com ambiguidade)', () => {
  const DIRECT_NEGATIONS = [
    'não',
    'nem pensar',
    'cancela',
    'deixa pra depois',
    'de jeito nenhum',
    'não quero',
    'esquece',
    'desisto',
    'pare',
    'deixa quieto',
    'sai fora',
    'para tudo',
    'errado',
    'negativo',
    'nunca'
  ];

  DIRECT_NEGATIONS.forEach((negPhrase, idx) => {
    it(`B.neg.${idx + 1}: negação "${negPhrase}" cancela e resulta em 0 itens gravados`, async (t) => {
      const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpB-neg-'));
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(mutatingTools);
      let sse: ReturnType<typeof readSse> | null = null;

      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: lavar o carro';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'lavar o carro'];

        const { sessionId, token } = await createVoiceSession(h.baseUrl);
        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        await sse.waitFor(1);

        const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8);

        const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
        await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);

        // Turno 2: resposta de negação
        h.engine.fixedTranscript = negPhrase;
        await sendAudio(h.baseUrl, sessionId, token);
        await sse.waitFor(15);

        const cancelEvent = sse.events
          .filter((e: any) => e.type === 'sentence_audio_ready')
          .pop() as { text: string };
        assert.equal(cancelEvent.text, MUTATION_CANCELLED_TEXT);

        const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
        const data = store.read();
        assert.equal(data.items.length, 0, 'Zero itens devem ser gravados em negação');
      } finally {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  const AMBIGUOUS_PHRASES = [
    'hum',
    'pera aí',
    'que horas são',
    'E, depois eu faço.',
    'depende',
    'talvez amanhã',
    'o que você acha?',
    'como assim',
    'espera um pouco',
    'pode apagar' // verbo apagar não casa com LEMBRETE_CRIAR -> ambíguo
  ];

  AMBIGUOUS_PHRASES.forEach((ambPhrase, idx) => {
    it(`B.amb.${idx + 1}: ambiguidade "${ambPhrase}" -> reprompt -> ambíguo de novo cancela com 0 itens`, async (t) => {
      const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpB-amb-'));
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(mutatingTools);
      let sse: ReturnType<typeof readSse> | null = null;

      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: pagar boleto';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'pagar boleto'];

        const { sessionId, token } = await createVoiceSession(h.baseUrl);
        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        await sse.waitFor(1);

        const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8);

        const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
        await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);

        // Turno 2: resposta ambígua -> servidor emite reprompt
        h.engine.fixedTranscript = ambPhrase;
        const audioRes2 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId2 } = (await audioRes2.json()) as { turnId: string };
        await sse.waitFor(15);

        const repromptEvent = sse.events
          .filter((e: any) => e.type === 'sentence_audio_ready')
          .pop() as { text: string };
        assert.equal(repromptEvent.text, MUTATION_REPROMPT_TEXT);

        // Cliente reproduz reprompt e chama /played
        const playedReprompt = await sendPlayed(h.baseUrl, sessionId, token, turnId2, repromptEvent.text);
        assert.equal(playedReprompt.status, 200);

        // Turno 3: ambíguo de novo ('sei lá') -> na 2ª vez cancela
        h.engine.fixedTranscript = 'sei lá';
        await sendAudio(h.baseUrl, sessionId, token);
        await sse.waitFor(22);

        const finalEvent = sse.events
          .filter((e: any) => e.type === 'sentence_audio_ready')
          .pop() as { text: string };
        assert.equal(finalEvent.text, MUTATION_CANCELLED_TEXT);

        const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
        const data = store.read();
        assert.equal(data.items.length, 0, 'Zero itens devem ser gravados após cancelamento por ambiguidade dupla');
      } finally {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // Reprompt seguido de 'não' cancela com 0 itens
  ['não', 'cancela', 'deixa pra lá'].forEach((neg, idx) => {
    it(`B.reprompt_neg.${idx + 1}: ambíguo -> reprompt -> negação "${neg}" cancela com 0 itens`, async (t) => {
      const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpB-repneg-'));
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(mutatingTools);
      let sse: ReturnType<typeof readSse> | null = null;

      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar pão';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar pão'];

        const { sessionId, token } = await createVoiceSession(h.baseUrl);
        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        await sse.waitFor(1);

        const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8);

        const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
        await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);

        // Turno 2: ambíguo
        h.engine.fixedTranscript = 'hum';
        const audioRes2 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId2 } = (await audioRes2.json()) as { turnId: string };
        await sse.waitFor(15);

        await sendPlayed(h.baseUrl, sessionId, token, turnId2, MUTATION_REPROMPT_TEXT);

        // Turno 3: negação explícita
        h.engine.fixedTranscript = neg;
        await sendAudio(h.baseUrl, sessionId, token);
        await sse.waitFor(22);

        const finalEvent = sse.events
          .filter((e: any) => e.type === 'sentence_audio_ready')
          .pop() as { text: string };
        assert.equal(finalEvent.text, MUTATION_CANCELLED_TEXT);

        const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
        assert.equal(store.read().items.length, 0);
      } finally {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // Reprompt seguido de 'sim' executa exatamente 1 vez
  ['sim', 'pode sim', 'com certeza'].forEach((aff, idx) => {
    it(`B.reprompt_pos.${idx + 1}: ambíguo -> reprompt -> afirmação "${aff}" executa exatamente 1 vez`, async (t) => {
      const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpB-reppos-'));
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(mutatingTools);
      let sse: ReturnType<typeof readSse> | null = null;

      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: comprar pão';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar pão'];

        const { sessionId, token } = await createVoiceSession(h.baseUrl);
        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        await sse.waitFor(1);

        const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8);

        const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
        await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);

        // Turno 2: ambíguo
        h.engine.fixedTranscript = 'pera aí';
        const audioRes2 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId2 } = (await audioRes2.json()) as { turnId: string };
        await sse.waitFor(15);

        await sendPlayed(h.baseUrl, sessionId, token, turnId2, MUTATION_REPROMPT_TEXT);

        // Turno 3: afirmação
        h.engine.fixedTranscript = aff;
        await sendAudio(h.baseUrl, sessionId, token);
        await sse.waitFor(22);

        const finalEvent = sse.events
          .filter((e: any) => e.type === 'sentence_audio_ready')
          .pop() as { text: string };
        assert.ok(finalEvent.text.includes('Lembrete criado'));

        const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
        const items = store.read().items;
        assert.equal(items.length, 1, 'Deve executar exatamente 1 vez');
        assert.equal(items[0].text, 'comprar pão');
      } finally {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  // Ruídos compostos e perguntas adicionais
  ['sim mas não', 'não sei', 'quem é você', 'qual o sentido disso'].forEach((noise, idx) => {
    it(`B.noise.${idx + 1}: enunciado de ruído "${noise}" não executa mutação`, async (t) => {
      const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpB-noise-'));
      const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
      const h = await setupHarness(mutatingTools);
      let sse: ReturnType<typeof readSse> | null = null;

      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      });

      try {
        h.engine.fixedTranscript = 'Lembrete: regar plantas';
        h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'regar plantas'];

        const { sessionId, token } = await createVoiceSession(h.baseUrl);
        sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
        await sse.waitFor(1);

        const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
        const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
        await sse.waitFor(8);

        const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
        await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);

        // Turno 2: ruído
        h.engine.fixedTranscript = noise;
        await sendAudio(h.baseUrl, sessionId, token);
        await sse.waitFor(15);

        // Nenhum item gravado até aqui
        const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
        assert.equal(store.read().items.length, 0);
      } finally {
        sse?.close();
        await teardownHarness(h);
        try {
          fs.rmSync(tmpDataDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });
});

// ============================================================================
// GRUPO C: Ataques de reprodução/cancelamento (~25 casos)
// ============================================================================
describe('Grupo C: Ataques de reprodução, cancelamento e integridade do histórico', () => {
  it('C.1: /played antes de existir qualquer turno é rejeitado (401)', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    t.after(async () => {
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    const res = await sendPlayed(h.baseUrl, sessionId, token, '00000000-0000-0000-0000-000000000000', 'Texto qualquer');
    assert.equal(res.status, 401);
    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.2: /played com turnId arbitrário inexistente é rejeitado (401)', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    t.after(async () => {
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    const res = await sendPlayed(h.baseUrl, sessionId, token, 'non-existent-id', 'Posso criar o lembrete?');
    assert.equal(res.status, 401);
  });

  it('C.3: /played com texto arbitrário após emissão da pergunta é rejeitado e não promove mutação', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    // Texto inventado pelo cliente
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Texto completamente inventado');
    assert.equal(playedRes.status, 401);

    const session = (h.sessionManager as any).current;
    assert.equal(session.pendingMutation, null, 'pendingMutation não deve ser promovida');

    // Turno seguinte 'Sim' não executa nada
    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.4: /played com texto parcial da pergunta é rejeitado', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    // Falta o ponto de interrogação
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete: comprar café');
    assert.equal(playedRes.status, 401);
  });

  it('C.5: /played com espaço extra no texto é rejeitado', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete: comprar café? ');
    assert.equal(playedRes.status, 401);
  });

  it('C.6: /played com texto vazio é rejeitado', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, '');
    assert.equal(playedRes.status, 401);
  });

  it('C.7: /played duplicado é rejeitado na 2ª vez e não duplica histórico', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };

    const played1 = await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
    assert.equal(played1.status, 200);

    const played2 = await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
    assert.equal(played2.status, 401, '2ª chamada de /played deve ser rejeitada');

    const session = (h.sessionManager as any).current;
    const assistantMessages = session.history.filter((m: any) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 1, 'Histórico não deve conter mensagem duplicada');
  });

  it('C.8: /played triplicado é rejeitado também na 3ª vez', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
    const played3 = await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
    assert.equal(played3.status, 401);
  });

  it('C.9: /played de turno anterior após barge-in é rejeitado', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    // Barge-in: Turno 2 inicia
    h.engine.mutationToReturn = ['NENHUMA', null];
    h.engine.fixedTranscript = 'Que horas são?';
    await sendAudio(h.baseUrl, sessionId, token);

    // Cliente tenta chamar /played do Turno 1
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete: comprar café?');
    assert.equal(playedRes.status, 401);

    const session = (h.sessionManager as any).current;
    assert.equal(session.pendingMutation, null);
  });

  it('C.10: /played do Turno 1 após Turno 2 já finalizado é rejeitado', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    // Turno 2 roda e conclui
    h.engine.mutationToReturn = ['NENHUMA', null];
    h.engine.fixedTranscript = 'Qual o sentido da vida?';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete: comprar café?');
    assert.equal(playedRes.status, 401);
  });

  it('C.11: /cancel antes do /played rejeita /played e subsequente "Sim" resulta em 0 execuções', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const questionEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };

    // Cliente cancela o turno antes de chamar /played
    const cancelRes = await sendCancel(h.baseUrl, sessionId, token, turnId1);
    assert.equal(cancelRes.status, 200);

    // Cliente tenta /played após /cancel
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, questionEvent.text);
    assert.equal(playedRes.status, 401);

    // Usuário diz 'Sim' no turno seguinte
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0, 'Zero execuções após cancel');
  });

  it('C.12: /cancel antes do /played sem /played posterior: "Sim" seguinte resulta em 0 execuções', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendCancel(h.baseUrl, sessionId, token, turnId1);

    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.13: pergunta original nunca confirmada por /played: "Sim" seguinte resulta em 0 execuções', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(8);

    // Cliente NUNCA chama /played
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.14: pergunta original nunca confirmada: "Com certeza" resulta em 0 execuções', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(8);

    h.engine.fixedTranscript = 'Com certeza';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.15: pergunta original nunca confirmada: "Pode criar" resulta em 0 execuções', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(8);

    h.engine.fixedTranscript = 'Pode criar';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.16: reprompt interrompido por /cancel antes do /played: "Sim" seguinte NÃO executa', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    // Turno 2: ambíguo -> reprompt
    h.engine.fixedTranscript = 'hum';
    const audioRes2 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId2 } = (await audioRes2.json()) as { turnId: string };
    await sse.waitFor(15);

    // Cancel antes de chamar /played do reprompt
    await sendCancel(h.baseUrl, sessionId, token, turnId2);

    // Tentativa de /played do reprompt é rejeitada
    const playedReprompt = await sendPlayed(h.baseUrl, sessionId, token, turnId2, MUTATION_REPROMPT_TEXT);
    assert.equal(playedReprompt.status, 401);

    // Turno 3: 'Sim'
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(22);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.17: /played do reprompt faltando: "Sim" seguinte NÃO executa', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    // Turno 2: ambíguo -> reprompt
    h.engine.fixedTranscript = 'pera aí';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    // Cliente NÃO chama /played do reprompt
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(22);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.18: /played do reprompt com texto incorreto é rejeitado e subsequente "Sim" não executa', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    // Turno 2: ambíguo
    h.engine.fixedTranscript = 'depende';
    const audioRes2 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId2 } = (await audioRes2.json()) as { turnId: string };
    await sse.waitFor(15);

    // Texto errado para o reprompt
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId2, 'Posso confirmar?');
    assert.equal(playedRes.status, 401);

    // Turno 3: 'Sim'
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(22);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.19: /played do reprompt usando turnId do Turno 1 é rejeitado', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    // Turno 2: ambíguo
    h.engine.fixedTranscript = 'hum';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    // Tenta usar turnId1 em vez de turnId2
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, MUTATION_REPROMPT_TEXT);
    assert.equal(playedRes.status, 401);
  });

  it('C.20: headers de sessão inválidos em /played retornam 401', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    t.after(async () => {
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    const res = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: {
        'X-Rodrigo-Session': 'bad-session',
        'X-Rodrigo-Token': 'bad-token',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ turnId: 'any-id', text: 'any-text' })
    });
    assert.equal(res.status, 401);
  });

  it('C.21: TTL expirado (>60s) descarta pendingMutation e "Sim" seguinte não executa', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    const session = (h.sessionManager as any).current;
    assert.ok(session.pendingMutation);
    // Simula passagem de tempo acima de 60s
    session.pendingMutation.askedAt = performance.now() - 60_005;

    // Próximo turno 'Sim'
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0, 'Mutação expirada não deve executar');
  });

  it('C.22: MUTATION_MAX_AGE_MS (120s) expirado antes de /played não promove mutação', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const session = (h.sessionManager as any).current;
    assert.ok(session.armedMutation);
    // Simula 121s decorridos desde o pedido original
    session.armedMutation.requestedAt = performance.now() - 121_000;

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);
    assert.equal(playedRes.status, 200); // played em si aceita para o histórico
    assert.equal(session.pendingMutation, null, 'pendingMutation NÃO deve ser promovida se requestedAt > 120s');

    // Turno 2: 'Sim'
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.23: tentativa de 2ª execução com "Sim" no Turno 3 não duplica item (permanece 1)', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    // Turno 2: 'Sim' executa
    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 1);

    // Turno 3: 'Sim' novamente não deve criar novo lembrete
    h.engine.fixedTranscript = 'Sim';
    h.engine.mutationToReturn = ['NENHUMA', null];
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(22);

    assert.equal(store.read().items.length, 1, 'Não deve criar item duplicado');
  });

  it('C.24: preempção de sessão invalida sessão anterior e impede execução', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId: s1, token: t1 } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${s1}&token=${t1}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, s1, t1);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    // Nova sessão preempta a sessão 1
    const { sessionId: s2, token: t2 } = await createVoiceSession(h.baseUrl);
    assert.ok(s2);

    // Sessão 1 tenta chamar /played
    const playedRes = await sendPlayed(h.baseUrl, s1, t1, turnId1, 'Posso criar o lembrete: comprar café?');
    assert.equal(playedRes.status, 401);

    const store = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');
    assert.equal(store.read().items.length, 0);
  });

  it('C.25: /played com JSON malformado retorna 400', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    t.after(async () => {
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    const res = await fetch(`${h.baseUrl}/api/voice/session/played`, {
      method: 'POST',
      headers: {
        'X-Rodrigo-Session': sessionId,
        'X-Rodrigo-Token': token,
        'Content-Type': 'application/json'
      },
      body: '{ json invalido'
    });
    assert.equal(res.status, 400);
  });

  it('C.26: /played com texto de frase que não é a pergunta não promove armedMutation', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpC-'));
    const { tools: mutatingTools } = createMutatingTools(tmpDataDir);
    const h = await setupHarness(mutatingTools);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    // Cliente tenta /played com texto diferente da pergunta
    const playedRes = await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Lembrete criado.');
    assert.equal(playedRes.status, 401);

    const session = (h.sessionManager as any).current;
    assert.equal(session.pendingMutation, null);
  });
});

// ============================================================================
// GRUPO D: Resultado verdadeiro (H11.4, ~25 casos)
// ============================================================================
describe('Grupo D: Resultado verdadeiro (H11.4 — falhas reais e guarda de alucinação)', () => {
  const FORBIDDEN_WORDS = ['criado', 'salvei', 'apaguei', 'agendei', 'guardado', 'atualizado', 'apagado'];

  function assertNoFalseClaims(text: string) {
    const lower = text.toLowerCase();
    for (const word of FORBIDDEN_WORDS) {
      assert.ok(!lower.includes(word), `Fala "${text}" não deve conter palavra proibida: "${word}"`);
    }
  }

  it('D.1: IMutatingTool stub cujo execute() lança Error -> fala MUTATION_FAILURE_TEXT sem falsas afirmações', async (t) => {
    const brokenTool: IMutatingTool = {
      name: 'LEMBRETE',
      description: 'Tool com erro',
      isAvailable: () => true,
      preview: () => 'Posso criar o lembrete de teste?',
      execute: () => {
        throw new Error('Falha de banco de dados');
      }
    };
    const h = await setupHarness([brokenTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete de teste?');

    // Turno 2: 'Sim' -> execute() lança
    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };
    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assertNoFalseClaims(finalEvent.text);
  });

  it('D.2: IMutatingTool stub cujo execute() lança TypeError -> fala MUTATION_FAILURE_TEXT', async (t) => {
    const brokenTool: IMutatingTool = {
      name: 'LEMBRETE',
      description: 'Tool com TypeError',
      isAvailable: () => true,
      preview: () => 'Posso criar o lembrete de teste?',
      execute: () => {
        throw new TypeError('Cannot read properties of undefined');
      }
    };
    const h = await setupHarness([brokenTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete de teste?');

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };
    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assertNoFalseClaims(finalEvent.text);
  });

  it('D.3: IMutatingTool stub cujo execute() lança string -> fala MUTATION_FAILURE_TEXT', async (t) => {
    const brokenTool: IMutatingTool = {
      name: 'LEMBRETE',
      description: 'Tool com throw string',
      isAvailable: () => true,
      preview: () => 'Posso criar o lembrete de teste?',
      execute: () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'Erro genérico';
      }
    };
    const h = await setupHarness([brokenTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete de teste?');

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };
    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assertNoFalseClaims(finalEvent.text);
  });

  it('D.4: IMutatingTool para NOTA cujo execute() lança -> fala MUTATION_FAILURE_TEXT', async (t) => {
    const brokenNotaTool: IMutatingTool = {
      name: 'NOTA',
      description: 'Nota com erro',
      isAvailable: () => true,
      preview: () => 'Posso guardar a nota?',
      execute: () => {
        throw new Error('Falha no disco');
      }
    };
    const h = await setupHarness([brokenNotaTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Anota: comprar leite';
    h.engine.mutationToReturn = ['NOTA_CRIAR', 'comprar leite'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso guardar a nota?');

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };
    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assertNoFalseClaims(finalEvent.text);
  });

  it('D.5: IMutatingTool para MEMORIA cujo execute() lança -> fala MUTATION_FAILURE_TEXT', async (t) => {
    const brokenMemoriaTool: IMutatingTool = {
      name: 'MEMORIA',
      description: 'Memória com erro',
      isAvailable: () => true,
      preview: () => 'Posso guardar isso sobre você?',
      execute: () => {
        throw new Error('Falha em memória');
      }
    };
    const h = await setupHarness([brokenMemoriaTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Guarda que sou vegetariano';
    h.engine.mutationToReturn = ['MEMORIA_GUARDAR', 'sou vegetariano'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso guardar isso sobre você?');

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };
    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assertNoFalseClaims(finalEvent.text);
  });

  it('D.6: ferramenta indisponível (isAvailable false) no início não gera pergunta nem arma mutação', async (t) => {
    const unavailTool: IMutatingTool = {
      name: 'LEMBRETE',
      description: 'Indisponível',
      isAvailable: () => false,
      preview: () => 'Posso criar o lembrete?',
      execute: () => 'Lembrete criado.'
    };
    const h = await setupHarness([unavailTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(8);

    const session = (h.sessionManager as any).current;
    assert.equal(session.armedMutation, null, 'Não deve armar mutação de ferramenta indisponível');
    assert.equal(session.pendingMutation, null);
  });

  it('D.7: ferramenta indisponível no momento da confirmação sintetiza MUTATION_FAILURE_TEXT', async (t) => {
    let available = true;
    const dynamicTool: IMutatingTool = {
      name: 'LEMBRETE',
      description: 'Fica indisponível',
      isAvailable: () => available,
      preview: () => 'Posso criar o lembrete?',
      execute: () => 'Lembrete criado.'
    };
    const h = await setupHarness([dynamicTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    await sendPlayed(h.baseUrl, sessionId, token, turnId1, 'Posso criar o lembrete?');

    // Ferramenta fica indisponível antes da execução
    available = false;

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };
    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assertNoFalseClaims(finalEvent.text);
  });

  it('D.8: LembreteTool real com scheduler cujo schedule() lança fala verdade e preserva item no store', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpD-sched-'));
    const lembreteStore = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');

    // Scheduler cujo schedule() lança erro
    class BrokenScheduler extends ReminderScheduler {
      schedule(): void {
        throw new Error('Falha no agendador de lembretes');
      }
    }
    const scheduler = new BrokenScheduler(lembreteStore);
    const lembreteTool = new LembreteTool(lembreteStore, scheduler);

    const h = await setupHarness([lembreteTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    // Lembrete recorrente diário: aciona o ramo de agendamento com try/catch que relata a verdade
    h.engine.fixedTranscript = 'Lembrete: regar plantas todo dia de manhã';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'regar plantas todo dia de manhã'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };

    // Deve falar a verdade: salvou, mas não conseguiu agendar o aviso
    assert.equal(finalEvent.text, 'Guardei o lembrete, mas não consegui agendar o aviso.');
    assert.ok(!finalEvent.text.includes(MUTATION_FAILURE_TEXT), 'Não deve dizer que não conseguiu salvar');

    // O item ESTÁ gravado no store!
    const data = lembreteStore.read();
    assert.equal(data.items.length, 1);
    assert.ok(data.items[0].text.includes('regar plantas'));
  });

  it('D.9: LembreteTool real com scheduler que lança para lembrete semanal fala verdade e grava item', async (t) => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-grpD-sched2-'));
    const lembreteStore = new JsonStore<StoredItem>(tmpDataDir, 'lembretes.json');

    class BrokenScheduler extends ReminderScheduler {
      schedule(): void {
        throw new Error('Serviço de cron indisponível');
      }
    }
    const scheduler = new BrokenScheduler(lembreteStore);
    const lembreteTool = new LembreteTool(lembreteStore, scheduler);

    const h = await setupHarness([lembreteTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch {}
    });

    h.engine.fixedTranscript = 'Lembrete: pagar academia toda segunda de manhã';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'pagar academia toda segunda de manhã'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };

    assert.equal(finalEvent.text, 'Guardei o lembrete, mas não consegui agendar o aviso.');
    assert.equal(lembreteStore.read().items.length, 1);
  });

  it('D.10: Store que lança erro de escrita (permissão negada) sintetiza falha e não fala "Lembrete criado"', async (t) => {
    const brokenStore = {
      read: () => ({ items: [] as StoredItem[] }),
      write: () => {
        throw new Error('EACCES: permission denied, open /lembretes.json');
      }
    } as unknown as JsonStore<StoredItem>;

    const scheduler = new ReminderScheduler(brokenStore);
    const lembreteTool = new LembreteTool(brokenStore, scheduler);

    const h = await setupHarness([lembreteTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };

    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assert.ok(!finalEvent.text.includes('Lembrete criado'));
  });

  it('D.11: Store que lança erro de leitura na execução sintetiza falha e não fala "Lembrete criado"', async (t) => {
    let shouldThrow = false;
    const brokenStore = {
      read: () => {
        if (shouldThrow) {
          throw new Error('Falha de leitura no disco');
        }
        return { items: [] as StoredItem[] };
      },
      write: () => {}
    } as unknown as JsonStore<StoredItem>;

    const scheduler = new ReminderScheduler(brokenStore);
    const lembreteTool = new LembreteTool(brokenStore, scheduler);

    const h = await setupHarness([lembreteTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    // Ativa a falha no store antes da execução da mutação
    shouldThrow = true;

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };

    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assert.ok(!finalEvent.text.includes('Lembrete criado'));
  });

  it('D.12: Store com erro de I/O em diretório protegido sintetiza falha', async (t) => {
    const ioErrorStore = {
      read: () => ({ items: [] as StoredItem[] }),
      write: () => {
        throw new Error('ENOSPC: no space left on device');
      }
    } as unknown as JsonStore<StoredItem>;

    const scheduler = new ReminderScheduler(ioErrorStore);
    const lembreteTool = new LembreteTool(ioErrorStore, scheduler);

    const h = await setupHarness([lembreteTool]);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Lembrete: comprar café';
    h.engine.mutationToReturn = ['LEMBRETE_CRIAR', 'comprar café'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    const audioRes1 = await sendAudio(h.baseUrl, sessionId, token);
    const { turnId: turnId1 } = (await audioRes1.json()) as { turnId: string };
    await sse.waitFor(8);

    const qEvent = sse.events.find((e: any) => e.type === 'sentence_audio_ready') as { text: string };
    await sendPlayed(h.baseUrl, sessionId, token, turnId1, qEvent.text);

    h.engine.fixedTranscript = 'Sim';
    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(15);

    const finalEvent = sse.events
      .filter((e: any) => e.type === 'sentence_audio_ready')
      .pop() as { text: string };

    assert.equal(finalEvent.text, MUTATION_FAILURE_TEXT);
    assert.ok(!finalEvent.text.includes('Lembrete criado'));
  });

  // Geração livre (sem ferramenta) em que o FakeVoiceEngine emite frases com afirmações falsas
  const HALLUCINATED_CLAIM_PHRASES = [
    'Anotei o lembrete para você.',
    'Salvei sua nota.',
    'Agendei para amanhã.',
    'Apaguei a memória.',
    'Criei o lembrete.',
    'Guardei a anotação.',
    'Atualizei a nota.',
    'Removi o compromisso.',
    'Deletei o lembrete.',
    'Anotei.',
    'Salvei.'
  ];

  HALLUCINATED_CLAIM_PHRASES.forEach((claimPhrase, idx) => {
    it(`D.claim.${idx + 1}: frase alucinada "${claimPhrase}" é substituída por NO_ACTION_CLAIM_TEXT`, async (t) => {
      const h = await setupHarness([], []);
      let sse: ReturnType<typeof readSse> | null = null;
      t.after(async () => {
        sse?.close();
        await teardownHarness(h);
      });

      h.engine.fixedTranscript = 'Olá, o que você fez?';
      h.engine.mutationToReturn = ['NENHUMA', null];
      h.engine.sentencesToEmit = [claimPhrase];

      const { sessionId, token } = await createVoiceSession(h.baseUrl);
      sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
      await sse.waitFor(1);

      await sendAudio(h.baseUrl, sessionId, token);
      await sse.waitFor(8);

      const readyEvents = sse.events.filter(
        (e: any) => e.type === 'sentence_audio_ready'
      ) as Array<{ text: string }>;
      assert.equal(readyEvents.length, 1);
      assert.equal(readyEvents[0].text, NO_ACTION_CLAIM_TEXT);
      assert.ok(!readyEvents[0].text.includes(claimPhrase));
    });
  });

  it('D.24: múltiplas afirmações alucinadas no mesmo turno emitem NO_ACTION_CLAIM_TEXT uma única vez', async (t) => {
    const h = await setupHarness([], []);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'O que você fez agora?';
    h.engine.mutationToReturn = ['NENHUMA', null];
    h.engine.sentencesToEmit = ['Anotei o lembrete para você.', 'Salvei sua nota.'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(8);

    const readyEvents = sse.events.filter(
      (e: any) => e.type === 'sentence_audio_ready'
    ) as Array<{ text: string }>;
    assert.equal(readyEvents.length, 1, 'Deve emitir NO_ACTION_CLAIM_TEXT exatamente uma vez por turno');
    assert.equal(readyEvents[0].text, NO_ACTION_CLAIM_TEXT);
  });

  it('D.25: frases normais sem falsa alegação passam intactas', async (t) => {
    const h = await setupHarness([], []);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'Qual a cor do céu?';
    h.engine.mutationToReturn = ['NENHUMA', null];
    h.engine.sentencesToEmit = ['Claro, o céu é azul.'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    await sse.waitFor(8);

    const readyEvents = sse.events.filter(
      (e: any) => e.type === 'sentence_audio_ready'
    ) as Array<{ text: string }>;
    assert.equal(readyEvents.length, 1);
    assert.equal(readyEvents[0].text, 'Claro, o céu é azul.');
    assert.notEqual(readyEvents[0].text, NO_ACTION_CLAIM_TEXT);
  });

  it('D.26: turno misto com frase normal e frase alucinada: 1ª passa intacta e 2ª vira NO_ACTION_CLAIM_TEXT', async (t) => {
    const h = await setupHarness([], []);
    let sse: ReturnType<typeof readSse> | null = null;
    t.after(async () => {
      sse?.close();
      await teardownHarness(h);
    });

    h.engine.fixedTranscript = 'O que você achou?';
    h.engine.mutationToReturn = ['NENHUMA', null];
    h.engine.sentencesToEmit = ['Entendi sua pergunta com clareza.', 'Salvei sua nota.'];

    const { sessionId, token } = await createVoiceSession(h.baseUrl);
    sse = readSse(`${h.baseUrl}/api/voice/session/events?sessionId=${sessionId}&token=${token}`);
    await sse.waitFor(1);

    await sendAudio(h.baseUrl, sessionId, token);
    // Espera as DUAS frases (a síntese é concorrente: a ordem de chegada não é garantida; o cliente
    // ordena por sentenceIndex) em vez de contar eventos genéricos, o que era uma corrida.
    const deadline = Date.now() + 5000;
    while (
      sse.events.filter((e: any) => e.type === 'sentence_audio_ready').length < 2 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const readyEvents = (sse.events.filter(
      (e: any) => e.type === 'sentence_audio_ready'
    ) as Array<{ text: string; sentenceIndex: number }>).sort((a, b) => a.sentenceIndex - b.sentenceIndex);
    assert.equal(readyEvents.length, 2);
    assert.equal(readyEvents[0].text, 'Entendi sua pergunta com clareza.');
    assert.equal(readyEvents[1].text, NO_ACTION_CLAIM_TEXT);
  });
});
