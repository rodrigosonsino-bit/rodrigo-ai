import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SubAgentCoordinator,
  type ISubAgent,
  type SubAgentTaskRequest,
  type SubAgentTaskResult
} from '../agents/subAgent.js';
import { SpecialistSubAgent, ToolSubAgent } from '../agents/adapters.js';
import { OpenClawSubAgent } from '../agents/openClawSubAgent.js';

test('Fase 15: SubAgentCoordinator registra e gera ExecutionTrace', () => {
  const coordinator = new SubAgentCoordinator();
  const agent: ISubAgent = {
    id: 'agent_revisor',
    name: 'Revisor de Texto',
    capabilities: ['revisao'],
    async runTask(req, signal) {
      return { success: true, output: 'Texto revisado sem erros ortográficos.' };
    }
  };

  coordinator.register(agent);
  assert.equal(coordinator.list().length, 1);

  const trace = coordinator.createTrace('turn_1', 'revisar meu texto');
  assert.equal(trace.turnId, 'turn_1');

  trace.tasks.push({
    subAgentId: 'agent_revisor',
    prompt: 'revisar meu texto',
    isMutation: false,
    status: 'completed',
    result: 'Texto revisado sem erros'
  });

  const summary = coordinator.formatTraceSummary('turn_1');
  assert.ok(summary.includes('Executei 1 passo'));
  assert.ok(summary.includes('Texto revisado sem erros'));
});

test('Fase 15: OpenClawSubAgent cancela imediatamente com AbortSignal', async () => {
  const agent = new OpenClawSubAgent('revisor', 'Revisor OpenClaw', ['revisao']);
  const controller = new AbortController();
  controller.abort(); // já cancelado antes

  const req: SubAgentTaskRequest = {
    taskId: 'task_1',
    turnId: 'turn_1',
    prompt: 'revisar artigo',
    isMutation: false
  };

  const res = await agent.runTask(req, controller.signal);
  assert.equal(res.success, false);
  assert.ok(res.error?.includes('cancelada'));
});

test('Fase 15: Limite de orçamento (máximo 6 chamadas por turno, §6)', () => {
  const coordinator = new SubAgentCoordinator();
  const now = 1_000;

  for (let i = 0; i < 6; i++) {
    const r = coordinator.beginDelegation('turn_1', 'multi-passo', now);
    assert.equal(r.ok, true, `chamada ${i + 1}`);
  }

  const seventh = coordinator.beginDelegation('turn_1', 'multi-passo', now);
  assert.equal(seventh.ok, false);
  if (!seventh.ok) assert.equal(seventh.reason, 'max_calls');
  assert.equal(coordinator.getTrace('turn_1')?.budgetExceeded, 'max_calls');
});
