import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeSubAgent, registerClaudeCodeAgent } from '../agents/claudeCodeSubAgent.js';
import { SubAgentCoordinator, type SubAgentTaskRequest } from '../agents/subAgent.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';
import { fakeIsolation } from './helpers/claudeIsolation.js';

function buildRequest(turnId: string, prompt: string, confirmationToken?: string): SubAgentTaskRequest {
  return {
    taskId: `task-${turnId}`,
    turnId,
    prompt,
    confirmationToken,
    isMutation: true
  };
}

function makePrivacy(claudeCode: boolean): PrivacyConfig {
  return {
    ...DEFAULT_PRIVACY,
    ...({ claudeCode } as Record<string, unknown>)
  } as PrivacyConfig;
}

test('ClaudeCodeSubAgent — propriedades e contratos de capacidade', () => {
  const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, undefined, fakeIsolation());
  assert.equal(agent.id, 'claude_code');
  assert.equal(agent.name, 'Claude Code');
  assert.equal(agent.requiresConfirmation, true);
  assert.deepEqual(agent.capabilities, ['claude_code']);
  assert.deepEqual(agent.grants, ['shell', 'read_file', 'write_file', 'network', 'browser']);
});

test('H17.1: Sem confirmationToken a execução é bloqueada e nenhum processo é criado', async () => {
  const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, undefined, fakeIsolation());
  const req = buildRequest('turn-10', 'leia o arquivo README.md');
  const result = await agent.runTask(req, new AbortController().signal);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /confirmationToken ausente/);
});

test('H17.1: confirmationToken de turno diferente é rejeitado', async () => {
  const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, undefined, fakeIsolation());
  const req = buildRequest('turn-10', 'leia o arquivo README.md', 'turn-999:valid-token');
  const result = await agent.runTask(req, new AbortController().signal);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /não corresponde ao turno atual/);
});

test('H17.1: AbortSignal já cancelado no início rejeita imediatamente', async () => {
  const agent = new ClaudeCodeSubAgent(DEFAULT_PRIVACY, undefined, fakeIsolation());
  const req = buildRequest('turn-10', 'leia o arquivo README.md', 'turn-10:token-abc');
  const ac = new AbortController();
  ac.abort();

  const result = await agent.runTask(req, ac.signal);
  assert.equal(result.success, false);
  assert.equal(result.error, 'Tarefa cancelada.');
});

test('H17.8: Prompt bloqueado pelo outboundGuard retorna erro e não cria processo', async () => {
  const privacyBlocked: PrivacyConfig = {
    ...DEFAULT_PRIVACY,
    outboundGuard: 'block'
  };
  const agent = new ClaudeCodeSubAgent(privacyBlocked, undefined, fakeIsolation());
  // Prompt contendo segredo detectável pelo outboundGuard (chave com formato de token)
  const req = buildRequest('turn-10', 'minha chave é AIzaSyD9876543210abcdefghijklmnopq', 'turn-10:token-abc');
  const result = await agent.runTask(req, new AbortController().signal);

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /bloqueado pelo guarda de saída/i);
});

test('registerClaudeCodeAgent — registra apenas quando claudeCode está ativo', () => {
  const coordinator = new SubAgentCoordinator();
  const privacyOff = makePrivacy(false);
  const resOff = registerClaudeCodeAgent(coordinator, privacyOff, fakeIsolation());

  assert.equal(resOff, null);
  assert.equal(coordinator.get('claude_code'), undefined);

  const privacyOn = makePrivacy(true);
  const resOn = registerClaudeCodeAgent(coordinator, privacyOn, fakeIsolation());

  assert.ok(resOn);
  assert.equal(resOn.id, 'claude_code');
  assert.equal(coordinator.get('claude_code'), resOn);
});
