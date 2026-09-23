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

  it('Fase 5b (H9): registra ferramentas, reflete no status de forma idempotente e responde a reset', () => {
    const registry = ExtensionRegistry.getInstance();
    registry.resetForTesting();

    const horaTool = {
      name: 'HORA',
      description: 'Hora atual do relógio do sistema.',
      isAvailable: () => true,
      execute: () => 'São 10 horas em ponto.'
    };
    const dataTool = {
      name: 'DATA',
      description: 'Data atual do sistema.',
      isAvailable: () => true,
      execute: () => 'Hoje é segunda-feira.'
    };

    registry.registerTool(horaTool);
    registry.registerTool(dataTool);
    // Idempotência por name:
    registry.registerTool({ ...horaTool, description: 'Duplicata ignorada' });

    assert.equal(registry.getTools().length, 2);
    assert.deepEqual(
      registry.getTools().map((t) => t.name),
      ['HORA', 'DATA']
    );

    const statuses = registry.getModuleStatuses();
    const tools = statuses.find((s) => s.id === 'tools');
    assert.equal(tools?.available, true);
    assert.equal(tools?.phase, 5);
    assert.equal(
      tools?.description,
      '2 ferramentas ativas: HORA, DATA.'
    );

    // resetForTesting zera ferramentas e volta available para false
    registry.resetForTesting();
    assert.equal(registry.getTools().length, 0);

    const statusesAfterReset = registry.getModuleStatuses();
    const toolsAfterReset = statusesAfterReset.find((s) => s.id === 'tools');
    assert.equal(toolsAfterReset?.available, false);
    assert.equal(
      toolsAfterReset?.description,
      'Nenhuma ferramenta conectada — depende do runtime de voz (rode "npm run setup:voice").'
    );
  });

  it('Fase 5c: registra ferramentas mutantes de forma idempotente e responde a reset', () => {
    const registry = ExtensionRegistry.getInstance();
    registry.resetForTesting();

    assert.deepEqual(registry.getMutatingTools(), []);

    const lembreteTool = {
      name: 'lembrete',
      description: 'Lembretes do usuário.',
      isAvailable: () => true,
      preview: () => 'Posso criar?',
      execute: () => 'Criado.'
    };
    const notaTool = {
      name: 'nota',
      description: 'Notas do usuário.',
      isAvailable: () => true,
      preview: () => 'Posso salvar?',
      execute: () => 'Salvo.'
    };

    registry.registerMutatingTool(lembreteTool);
    registry.registerMutatingTool(notaTool);
    // Idempotência por name:
    registry.registerMutatingTool({ ...lembreteTool, description: 'Duplicata ignorada' });

    assert.equal(registry.getMutatingTools().length, 2);
    assert.deepEqual(
      registry.getMutatingTools().map((t) => t.name),
      ['lembrete', 'nota']
    );

    registry.resetForTesting();
    assert.equal(registry.getMutatingTools().length, 0);
  });
});
