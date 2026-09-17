import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionRegistry } from '../../shared/extensions/index.js';

describe('Pontos de Extensão e Registro Modular (Fase 1)', () => {
  it('deve manter registros de provedores, agentes e ferramentas vazios na Fase 1', () => {
    const registry = ExtensionRegistry.getInstance();

    assert.deepEqual(registry.getVoiceProviders(), []);
    assert.deepEqual(registry.getAgents(), []);
    assert.deepEqual(registry.getTools(), []);
  });

  it('deve informar honestamente a indisponibilidade de módulos futuros', () => {
    const registry = ExtensionRegistry.getInstance();
    const statuses = registry.getModuleStatuses();

    assert.equal(statuses.length, 5);

    const foundation = statuses.find((s) => s.id === 'foundation');
    assert.equal(foundation?.available, true);
    assert.equal(foundation?.phase, 1);

    const voice = statuses.find((s) => s.id === 'voice');
    assert.equal(voice?.available, false);
    assert.equal(voice?.phase, 2);

    const agents = statuses.find((s) => s.id === 'agents');
    assert.equal(agents?.available, false);
    assert.equal(agents?.phase, 4);

    const tools = statuses.find((s) => s.id === 'tools');
    assert.equal(tools?.available, false);
    assert.equal(tools?.phase, 5);

    // Fase 5a: sem corpus registrado, o módulo de conhecimento se declara indisponível.
    const knowledge = statuses.find((s) => s.id === 'knowledge');
    assert.equal(knowledge?.available, false);
    assert.equal(knowledge?.phase, 5);
  });
});
