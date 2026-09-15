import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentNotRegisteredError,
  GeneralAgent,
  TeologiaAgent,
  VirtologiaAgent,
  createSpecialistAgents,
  selectAgentForLabel
} from '../agents/specialistAgents.js';
import { ExtensionRegistry } from '../../shared/extensions/registry.js';

describe('Agentes especialistas (Fase 4)', () => {
  it('createSpecialistAgents() retorna exatamente os 3 agentes, todos disponíveis', () => {
    const agents = createSpecialistAgents();
    assert.equal(agents.length, 3);
    assert.deepEqual(
      agents.map((a) => a.id).sort(),
      ['geral', 'teologia', 'virtologia']
    );
    for (const agent of agents) {
      assert.equal(agent.isAvailable(), true);
      assert.ok(agent.getSystemPrompt().length > 0);
    }
  });

  it('selectAgentForLabel resolve GERAL/TEOLOGIA/VIRTOLOGIA para o agente correspondente', () => {
    const agents = createSpecialistAgents();
    assert.ok(selectAgentForLabel('GERAL', agents) instanceof GeneralAgent);
    assert.ok(selectAgentForLabel('TEOLOGIA', agents) instanceof TeologiaAgent);
    assert.ok(selectAgentForLabel('VIRTOLOGIA', agents) instanceof VirtologiaAgent);
  });

  it('selectAgentForLabel resolve AMBIGUO para a mesma instância que GERAL resolveria', () => {
    const agents = createSpecialistAgents();
    const geral = selectAgentForLabel('GERAL', agents);
    const ambiguo = selectAgentForLabel('AMBIGUO', agents);
    assert.equal(ambiguo, geral);
  });

  it('selectAgentForLabel lança AgentNotRegisteredError se o agente não estiver na lista', () => {
    assert.throws(() => selectAgentForLabel('TEOLOGIA', []), AgentNotRegisteredError);
  });

  it('registerAgent no ExtensionRegistry é idempotente por id', () => {
    const registry = ExtensionRegistry.getInstance();
    const before = registry.getAgents().length;

    const agent = new GeneralAgent();
    registry.registerAgent(agent);
    const afterFirst = registry.getAgents().length;
    registry.registerAgent(agent);
    const afterSecond = registry.getAgents().length;

    assert.equal(afterFirst, before + 1);
    assert.equal(afterSecond, afterFirst);
  });
});
