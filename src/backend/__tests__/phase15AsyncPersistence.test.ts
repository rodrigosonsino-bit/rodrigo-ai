import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PendingAsyncTaskStore,
  parseAsyncTaskTtlHours,
  type PendingAsyncTask
} from '../agents/pendingAsyncStore.js';
import {
  formatPriorAsyncResultSpeech,
  recoverPendingAsyncTasks,
  ASYNC_TASK_LOST_ON_RESTART_TEXT
} from '../agents/pendingAsyncRecovery.js';
import { SubAgentCoordinator } from '../agents/subAgent.js';
import type { OpenClawHttpClient } from '../agents/openClawHttpClient.js';
import { JsonStore } from '../storage/jsonStore.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'f15-async-'));
}

function sampleTask(overrides: Partial<PendingAsyncTask> = {}): PendingAsyncTask {
  return {
    taskId: 'task-1',
    prompt: 'pesquise o horário do evento',
    capability: 'openclaw_web',
    startedAt: new Date().toISOString(),
    turnId: 'turn-1',
    ...overrides
  };
}

test('F15 §4.3: JsonStore usa temp + rename (padrão atômico dos lembretes)', () => {
  const dir = tmpDir();
  try {
    const store = new JsonStore<PendingAsyncTask>(dir, 'pendingAsyncTasks.json');
    const filePath = path.join(dir, 'pendingAsyncTasks.json');
    store.write({ items: [sampleTask()] });

    const realRename = fs.renameSync.bind(fs);
    const renameCalls: Array<{ from: string; to: string }> = [];
    const original = fs.readFileSync(filePath, 'utf-8');

    // Simula crash no rename: o temp é escrito, o rename falha — arquivo final intacto.
    (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from, to) => {
      renameCalls.push({ from: String(from), to: String(to) });
      throw new Error('simulated crash mid-rename');
    }) as typeof fs.renameSync;

    try {
      assert.throws(
        () => store.write({ items: [sampleTask({ taskId: 'corrupt-attempt' })] }),
        /simulated crash mid-rename/
      );
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    }

    assert.equal(renameCalls.length, 1);
    assert.match(renameCalls[0].from, /\.tmp-/);
    assert.equal(renameCalls[0].to, filePath);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), original, 'arquivo final não corrompe se rename falha');
    const still = store.read().items;
    assert.equal(still.length, 1);
    assert.equal(still[0].taskId, 'task-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15 §4.3: PendingAsyncTaskStore write/read/remove round-trip', () => {
  const dir = tmpDir();
  try {
    const store = new PendingAsyncTaskStore(dir);
    assert.deepEqual(store.readAll(), []);

    const task = sampleTask({ confirmationToken: 'turn-1:1:abcd1234' });
    store.upsert(task);
    assert.equal(store.readAll().length, 1);
    assert.deepEqual(store.readAll()[0], task);

    store.upsert({ ...task, prompt: 'atualizado' });
    assert.equal(store.readAll().length, 1);
    assert.equal(store.readAll()[0].prompt, 'atualizado');

    assert.ok(fs.existsSync(store.filePath));
    const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf-8'));
    assert.ok(Array.isArray(raw.items));
    // Após escrita bem-sucedida, nenhum temp residual.
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);

    store.remove('task-1');
    assert.deepEqual(store.readAll(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15 §4.3: descarte por TTL na subida (silencioso, remove do arquivo)', async () => {
  const dir = tmpDir();
  try {
    const store = new PendingAsyncTaskStore(dir);
    const aged = sampleTask({
      taskId: 'old',
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString()
    });
    const fresh = sampleTask({
      taskId: 'fresh',
      startedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    });
    store.upsert(aged);
    store.upsert(fresh);

    const client: OpenClawHttpClient = {
      invokeShort: async () => 'x',
      invokeLongAsync: async () => ({ taskId: 'x', status: 'pending' }),
      pollStatus: async () => ({ status: 'pending' })
    };

    const result = await recoverPendingAsyncTasks({
      store,
      client,
      ttlHours: 6,
      now: new Date()
    });

    assert.equal(result.discardedByAge, 1);
    assert.equal(store.readAll().length, 1);
    assert.equal(store.readAll()[0].taskId, 'fresh');
    assert.equal(result.speeches.length, 0, 'idade > TTL: sem fala');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15 §4.3: resumo datado de tarefa anterior + prompt nunca reentregue', async () => {
  const dir = tmpDir();
  try {
    const store = new PendingAsyncTaskStore(dir);
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    store.upsert(
      sampleTask({
        taskId: 'done-1',
        prompt: 'NUNCA_REENTREGUE_ISTO_AO_LLM',
        startedAt
      })
    );

    let polledId = '';
    const client: OpenClawHttpClient = {
      invokeShort: async (prompt) => {
        throw new Error(`invokeShort não deve ser chamado na recuperação: ${prompt}`);
      },
      invokeLongAsync: async (prompt) => {
        throw new Error(`invokeLongAsync não deve ser chamado na recuperação: ${prompt}`);
      },
      pollStatus: async (taskId) => {
        polledId = taskId;
        return { status: 'completed', result: 'O evento é às três da tarde.' };
      }
    };

    const coordinator = new SubAgentCoordinator();
    const result = await recoverPendingAsyncTasks({
      store,
      client,
      ttlHours: 6,
      coordinator,
      now: new Date()
    });

    assert.equal(polledId, 'done-1');
    assert.equal(result.speeches.length, 1);
    assert.match(result.speeches[0].text, /^Resultado de uma tarefa que você pediu/);
    assert.match(result.speeches[0].text, /O evento é às três da tarde/);
    assert.ok(!result.speeches[0].text.includes('NUNCA_REENTREGUE'));
    assert.deepEqual(store.readAll(), [], 'registro removido após conclusão');

    const speech = formatPriorAsyncResultSpeech(startedAt, 'ok', new Date());
    assert.match(speech, /Resultado de uma tarefa que você pediu/);

    const trace = coordinator.getTrace(`recovery:done-1`);
    assert.ok(trace);
    assert.match(trace!.query, /não reentregue/);
    assert.match(trace!.tasks[0].prompt, /omitido/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15 §4.3: taskId inexistente → fala honesta de perda no reinício', async () => {
  const dir = tmpDir();
  try {
    const store = new PendingAsyncTaskStore(dir);
    store.upsert(sampleTask({ taskId: 'gone' }));

    const client: OpenClawHttpClient = {
      invokeShort: async () => 'x',
      invokeLongAsync: async () => ({ taskId: 'x', status: 'pending' }),
      pollStatus: async () => {
        throw new Error('task not found');
      }
    };

    const result = await recoverPendingAsyncTasks({ store, client, ttlHours: 6 });
    assert.equal(result.speeches.length, 1);
    assert.equal(result.speeches[0].text, ASYNC_TASK_LOST_ON_RESTART_TEXT);
    assert.deepEqual(store.readAll(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15 §4.3: pollStatus not_found (sem throw) também fala perda honesta', async () => {
  const dir = tmpDir();
  try {
    const store = new PendingAsyncTaskStore(dir);
    store.upsert(sampleTask({ taskId: 'missing' }));

    const client: OpenClawHttpClient = {
      invokeShort: async () => 'x',
      invokeLongAsync: async () => ({ taskId: 'x', status: 'pending' }),
      pollStatus: async () => ({ status: 'not_found' })
    };

    const result = await recoverPendingAsyncTasks({ store, client, ttlHours: 6 });
    assert.equal(result.speeches[0].text, ASYNC_TASK_LOST_ON_RESTART_TEXT);
    assert.deepEqual(store.readAll(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F15: RODRIGO_ASYNC_TASK_TTL_HOURS padrão 6; inválido lança', () => {
  assert.equal(parseAsyncTaskTtlHours({}), 6);
  assert.equal(parseAsyncTaskTtlHours({ RODRIGO_ASYNC_TASK_TTL_HOURS: '12' }), 12);
  assert.throws(
    () => parseAsyncTaskTtlHours({ RODRIGO_ASYNC_TASK_TTL_HOURS: '0' }),
    /RODRIGO_ASYNC_TASK_TTL_HOURS/
  );
  assert.throws(
    () => parseAsyncTaskTtlHours({ RODRIGO_ASYNC_TASK_TTL_HOURS: 'abc' }),
    /RODRIGO_ASYNC_TASK_TTL_HOURS/
  );
});
