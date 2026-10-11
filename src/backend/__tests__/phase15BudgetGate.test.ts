import assert from 'node:assert/strict';
import test from 'node:test';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import { ToolSubAgent } from '../agents/adapters.js';
import {
  SUBAGENT_BUDGET,
  SubAgentCoordinator,
  type ISubAgent,
  type SubAgentTaskRequest,
  type SubAgentTaskResult
} from '../agents/subAgent.js';
import {
  mintMutationConfirmationToken,
  SessionManager
} from '../voice/sessionManager.js';
import { FakeVoiceEngine } from '../voice/fakeEngine.js';
import { AudioStore } from '../voice/audioStore.js';
import type { IVoiceProvider } from '../../shared/extensions/voice.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class SilentTts implements IVoiceProvider {
  readonly id = 'silent';
  readonly name = 'Silent';
  readonly spoken: string[] = [];
  isAvailable(): boolean {
    return true;
  }
  async synthesize(text: string, outputPath: string): Promise<void> {
    this.spoken.push(text);
    await fs.promises.writeFile(outputPath, Buffer.alloc(44));
  }
}

function makeSessionManager(opts: {
  coordinator?: SubAgentCoordinator;
  nowMs?: () => number;
} = {}): { sm: SessionManager; tts: SilentTts; tmpDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f15-budget-'));
  const tts = new SilentTts();
  const sm = new SessionManager(
    new FakeVoiceEngine(),
    tts,
    new AudioStore(tmpDir),
    [],
    null,
    [],
    [],
    null,
    undefined,
    { nowMs: opts.nowMs },
    null,
    opts.coordinator ?? new SubAgentCoordinator()
  );
  return { sm, tts, tmpDir };
}

function fakeAgent(
  id: string,
  run: (req: SubAgentTaskRequest) => Promise<SubAgentTaskResult> | SubAgentTaskResult
): ISubAgent {
  return {
    id,
    name: id,
    capabilities: ['test'],
    async runTask(req) {
      return await run(req);
    }
  };
}

test('F15 Fatia 4 (a): 7ª chamada no turno → recusa + fala honesta + ExecutionTrace', async () => {
  const coordinator = new SubAgentCoordinator();
  let calls = 0;
  coordinator.register(
    fakeAgent('worker', () => {
      calls += 1;
      return { success: true, output: `ok-${calls}`, kind: 'final' };
    })
  );
  const speeches: string[] = [];
  const { sm, tmpDir } = makeSessionManager({ coordinator });

  try {
    for (let i = 0; i < SUBAGENT_BUDGET.MAX_CALLS_PER_TURN; i += 1) {
      const r = await sm.runSubAgentDelegation({
        turnId: 'turn-a',
        query: 'cadeia longa',
        subAgentId: 'worker',
        prompt: `passo ${i}`,
        isMutation: false,
        signal: new AbortController().signal,
        onSpeech: (t) => speeches.push(t)
      });
      assert.equal(r.ok, true, `chamada ${i + 1} deveria passar`);
    }

    const seventh = await sm.runSubAgentDelegation({
      turnId: 'turn-a',
      query: 'cadeia longa',
      subAgentId: 'worker',
      prompt: 'passo 6',
      isMutation: false,
      signal: new AbortController().signal,
      onSpeech: (t) => speeches.push(t)
    });

    assert.equal(seventh.ok, false);
    assert.equal(seventh.budgetExceeded, 'max_calls');
    assert.ok(seventh.speech);
    assert.match(seventh.speech!, /não consegui terminar/i);
    assert.equal(speeches.length, 1);
    assert.equal(calls, SUBAGENT_BUDGET.MAX_CALLS_PER_TURN, 'a 7ª não deve invocar o subagente');
    const trace = coordinator.getTrace('turn-a');
    assert.equal(trace?.budgetExceeded, 'max_calls');
    assert.equal(trace?.callCount, SUBAGENT_BUDGET.MAX_CALLS_PER_TURN);
  } finally {
    await sm.shutdownAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F15 Fatia 4 (b): orçamento 60s estourado → recusa + fala + trace', async () => {
  let now = 1_000_000;
  const coordinator = new SubAgentCoordinator();
  coordinator.register(
    fakeAgent('worker', () => ({ success: true, output: 'feito', kind: 'final' }))
  );
  const speeches: string[] = [];
  const { sm, tmpDir } = makeSessionManager({ coordinator, nowMs: () => now });

  try {
    const first = await sm.runSubAgentDelegation({
      turnId: 'turn-b',
      query: 'demorado',
      subAgentId: 'worker',
      prompt: 'passo 1',
      isMutation: false,
      signal: new AbortController().signal,
      onSpeech: (t) => speeches.push(t)
    });
    assert.equal(first.ok, true);

    now += SUBAGENT_BUDGET.MAX_ORCHESTRATION_MS + 1;

    const late = await sm.runSubAgentDelegation({
      turnId: 'turn-b',
      query: 'demorado',
      subAgentId: 'worker',
      prompt: 'passo 2',
      isMutation: false,
      signal: new AbortController().signal,
      onSpeech: (t) => speeches.push(t)
    });

    assert.equal(late.ok, false);
    assert.equal(late.budgetExceeded, 'time');
    assert.ok(late.speech);
    assert.match(late.speech!, /tempo\/dos passos previstos/i);
    assert.equal(speeches.length, 1);
    assert.equal(coordinator.getTrace('turn-b')?.budgetExceeded, 'time');
  } finally {
    await sm.shutdownAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F15 Fatia 4 (c): 3ª task async simultânea → recusa com fala', async () => {
  const coordinator = new SubAgentCoordinator();
  let asyncSeq = 0;
  coordinator.register(
    fakeAgent('async-worker', () => {
      asyncSeq += 1;
      return {
        success: true,
        output: '',
        kind: 'async_deferred',
        asyncTaskId: `async-${asyncSeq}`
      };
    })
  );
  const speeches: string[] = [];
  const { sm, tmpDir } = makeSessionManager({ coordinator });

  try {
    for (let i = 0; i < SUBAGENT_BUDGET.MAX_CONCURRENT_ASYNC; i += 1) {
      const r = await sm.runSubAgentDelegation({
        turnId: `turn-c-${i}`,
        query: 'async',
        subAgentId: 'async-worker',
        prompt: `a${i}`,
        isMutation: false,
        signal: new AbortController().signal,
        onSpeech: (t) => speeches.push(t)
      });
      assert.equal(r.ok, true);
      assert.equal(r.result?.kind, 'async_deferred');
    }
    assert.equal(coordinator.activeAsyncCount(), 2);

    const third = await sm.runSubAgentDelegation({
      turnId: 'turn-c-2',
      query: 'async',
      subAgentId: 'async-worker',
      prompt: 'a2',
      isMutation: false,
      signal: new AbortController().signal,
      onSpeech: (t) => speeches.push(t)
    });

    assert.equal(third.ok, false);
    assert.equal(third.budgetExceeded, 'max_async');
    assert.ok(third.speech);
    assert.match(third.speech!, /não consegui terminar/i);
    assert.equal(speeches.length, 1);
    assert.equal(coordinator.activeAsyncCount(), 2, 'não adquire o 3º slot');
    assert.equal(coordinator.getTrace('turn-c-2')?.budgetExceeded, 'max_async');
  } finally {
    await sm.shutdownAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F15 Fatia 4 (d): mutação com token válido passa; token de outro turnId expira', async () => {
  const tool: IMutatingTool = {
    name: 'LEMBRETE',
    description: 'test',
    isAvailable: () => true,
    preview: () => 'Confirma?',
    execute: () => 'Lembrete criado.'
  };
  const sub = new ToolSubAgent(tool);
  const coordinator = new SubAgentCoordinator();
  coordinator.register(sub);
  const { sm, tmpDir } = makeSessionManager({ coordinator });

  try {
    const turnId = 'turn-d';
    const token = sm.recordMutationConfirmation(turnId);
    assert.ok(token.startsWith(`${turnId}:`));
    assert.equal(sm.peekMutationConfirmationToken(turnId), token);

    const ok = await sm.runSubAgentDelegation({
      turnId,
      query: 'cria lembrete',
      subAgentId: sub.id,
      prompt: 'comprar pão',
      isMutation: true,
      signal: new AbortController().signal,
      context: { action: 'LEMBRETE_CRIAR' }
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.result?.success, true);
    assert.equal(ok.result?.output, 'Lembrete criado.');

    // Token de outro turnId: SessionManager não anexa o token do turn-d ao turn-e.
    const other = await sm.runSubAgentDelegation({
      turnId: 'turn-e',
      query: 'cria outro',
      subAgentId: sub.id,
      prompt: 'comprar leite',
      isMutation: true,
      signal: new AbortController().signal,
      context: { action: 'LEMBRETE_CRIAR' }
    });
    assert.equal(other.ok, true);
    assert.equal(other.result?.success, false);
    assert.match(other.result?.error ?? '', /Mutação bloqueada: nenhum confirmationToken/);

    // Token stale passado direto ao ToolSubAgent (frescor r2 N4).
    const staleReq: SubAgentTaskRequest = {
      taskId: 't1',
      turnId: 'turn-f',
      prompt: 'x',
      isMutation: true,
      confirmationToken: token, // era do turn-d
      context: { action: 'LEMBRETE_CRIAR' }
    };
    const stale = await sub.runTask(staleReq, new AbortController().signal);
    assert.equal(stale.success, false);
    assert.match(stale.error ?? '', /não corresponde ao turno atual/);
  } finally {
    await sm.shutdownAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F15 Fatia 4 (e): mutação sem confirmationToken bloqueada pelo ToolSubAgent', async () => {
  const tool: IMutatingTool = {
    name: 'NOTA',
    description: 'test',
    isAvailable: () => true,
    preview: () => 'Confirma?',
    execute: () => {
      throw new Error('execute() não deveria rodar sem token');
    }
  };
  const sub = new ToolSubAgent(tool);
  const res = await sub.runTask(
    {
      taskId: 't1',
      turnId: 'turn-e',
      prompt: 'anota isso',
      isMutation: true
    },
    new AbortController().signal
  );
  assert.equal(res.success, false);
  assert.match(res.error ?? '', /Mutação bloqueada: nenhum confirmationToken/);
});

test('F15 Fatia 4: mintMutationConfirmationToken embute turnId e nonce não vazio', () => {
  const a = mintMutationConfirmationToken('turn-x', 123);
  const b = mintMutationConfirmationToken('turn-x', 123);
  assert.ok(a.startsWith('turn-x:123:'));
  assert.ok(b.startsWith('turn-x:123:'));
  assert.notEqual(a, b, 'nonce deve variar entre emissões');
  assert.equal(a.split(':').length, 3);
});
