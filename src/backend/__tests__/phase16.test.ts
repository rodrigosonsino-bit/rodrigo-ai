import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, KnowledgeRetriever } from '../knowledge/index.js';
import { NeurocienciaAgent } from '../agents/specialistAgents.js';

/**
 * Corpus sintético — os testes NUNCA dependem de docs/research/ (ver mesma regra em
 * knowledge.test.ts): uma revisão do material pessoal do usuário não pode quebrar a suíte.
 */
const NEUROCIENCIA_FIXTURE = `# Neurociência (fonte de teste)

## Neuroplasticidade

O cérebro reorganiza suas conexões sinápticas em resposta à experiência e ao aprendizado,
processo conhecido como neuroplasticidade, com relevância clínica e educacional reconhecida.
`;

test('Fase 16: chunkMarkdown segmenta a fonte de Neurociência com headingPath correto', () => {
  const chunks = chunkMarkdown('neurociencia', NEUROCIENCIA_FIXTURE);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.some((c) => c.headingPath.includes('Neuroplasticidade')));
});

test('Fase 16: KnowledgeRetriever encontra o trecho coberto e não inventa cobertura ausente', () => {
  const chunks = chunkMarkdown('neurociencia', NEUROCIENCIA_FIXTURE);
  const retriever = new KnowledgeRetriever(chunks);

  const covered = retriever.retrieve('neurociencia', 'neuroplasticidade');
  assert.ok(covered.length > 0);
  assert.ok(covered[0].headingPath.includes('Neuroplasticidade'));

  const uncovered = retriever.retrieve('neurociencia', 'física quântica');
  assert.equal(uncovered.length, 0);
});

test('Fase 16: NeurocienciaAgent implementa IAgent (id bate com o agentId do corpus) e instrui o limite padronizado', () => {
  const agent = new NeurocienciaAgent();
  assert.equal(agent.id, 'neurociencia');
  assert.equal(agent.isAvailable(), true);
  assert.ok(
    agent.getSystemPrompt().includes('Não encontrei no seu material uma posição registrada sobre este tópico.')
  );
});
