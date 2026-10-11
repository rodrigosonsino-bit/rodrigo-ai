import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveConflicts,
  deriveTopicKey,
  setSuppressionLogger
} from '../memory/conflictResolver.js';
import { buildMemoryBlock } from '../memory/memoryBlock.js';
import type { StoredItem } from '../storage/jsonStore.js';

const fixturesPath = path.join(process.cwd(), 'src', 'backend', '__tests__', 'fixtures', 'phase16-memory-scenarios.json');
interface MemoryFixtureCase {
  id: string;
  kind?: 'preference' | 'cumulative';
  items: Array<{ text: string; createdAt: string }>;
  expectedSurvivorText: string;
}

const scenarios = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8')) as MemoryFixtureCase[];

describe('conflictResolver (Fase 16 — H16.3)', () => {
  beforeEach(() => {
    // Reset logger para o padrão (console.warn) antes de cada teste
    setSuppressionLogger((entry) => {
      console.warn('[memory] supressão por conflito:', entry);
    });
  });

  describe('deriveTopicKey', () => {
    it('normaliza acentos e minúsculas', () => {
      assert.equal(deriveTopicKey('Gosto de Café'), 'cafe');
      assert.equal(deriveTopicKey('café COM açúcar'), 'acucar_cafe');
      assert.equal(deriveTopicKey('Ação e Reação'), 'acao_reacao');
    });

    it('remove stopwords e mantém apenas palavras de conteúdo', () => {
      // "gosto de" e "prefiro" são stopwords; devem colidir no mesmo tópico
      const key1 = deriveTopicKey('gosto de café com açúcar');
      const key2 = deriveTopicKey('prefiro café com açúcar');
      assert.equal(key1, key2);
    });

    it('usa fallback normalizado quando só há stopwords', () => {
      const key = deriveTopicKey('eu não');
      assert.equal(key, 'eu nao');
    });

    it('limita a no máximo 4 palavras ordenadas', () => {
      const key = deriveTopicKey('comprei bicicleta vermelha nova ontem tarde');
      assert.equal(key.split('_').length, 4);
    });
  });

  describe('resolveConflicts', () => {
    it('retorna lista vazia para input vazio', () => {
      assert.deepEqual(resolveConflicts([]), []);
    });

    it('mantém entrada única inalterada', () => {
      const item: StoredItem = {
        id: '1',
        text: 'prefiro café sem açúcar',
        createdAt: '2026-10-11T10:00:00.000Z'
      };
      const result = resolveConflicts([item]);
      assert.equal(result.length, 1);
      assert.equal(result[0].text, item.text);
    });

    it('remove duplicata exata, mantendo a mais recente', () => {
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café com açúcar', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: '2', text: 'gosto de café com açúcar', createdAt: '2026-10-01T10:00:00.000Z' }
      ];
      const result = resolveConflicts(items);
      assert.equal(result.length, 1);
      assert.equal(result[0].createdAt, '2026-10-01T10:00:00.000Z');
    });

    it('agrupa por tópico derivado, não por texto exato', () => {
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café com açúcar', createdAt: '2026-01-15T10:00:00.000Z' },
        { id: '2', text: 'prefiro café sem açúcar', createdAt: '2026-10-05T10:00:00.000Z' }
      ];
      const result = resolveConflicts(items);
      assert.equal(result.length, 1);
      assert.equal(result[0].text, 'prefiro café sem açúcar');
    });

    it('preserva entradas de tópicos diferentes', () => {
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: '2', text: 'prefiro chá', createdAt: '2026-01-02T10:00:00.000Z' }
      ];
      const result = resolveConflicts(items);
      assert.equal(result.length, 2);
    });

    it('ordena saída por createdAt crescente', () => {
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café', createdAt: '2026-10-01T10:00:00.000Z' },
        { id: '2', text: 'prefiro chá', createdAt: '2026-01-01T10:00:00.000Z' }
      ];
      const result = resolveConflicts(items);
      assert.equal(result[0].text, 'prefiro chá');
      assert.equal(result[1].text, 'gosto de café');
    });

    it('registra supressão via logger injetado', () => {
      const logs: unknown[] = [];
      setSuppressionLogger((entry) => logs.push(entry));
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café com açúcar', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: '2', text: 'prefiro café sem açúcar', createdAt: '2026-10-01T10:00:00.000Z' }
      ];
      resolveConflicts(items);
      assert.equal(logs.length, 1);
      const entry = logs[0] as { suppressed: { text: string }; kept: { text: string } };
      assert.equal(entry.suppressed.text, 'gosto de café com açúcar');
      assert.equal(entry.kept.text, 'prefiro café sem açúcar');
    });

    it('não falha quando o logger lança exceção', () => {
      setSuppressionLogger(() => {
        throw new Error('falha simulada');
      });
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café com açúcar', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: '2', text: 'prefiro café sem açúcar', createdAt: '2026-10-01T10:00:00.000Z' }
      ];
      const result = resolveConflicts(items);
      assert.equal(result.length, 1);
    });
  });

  describe('H16.3 — cenários de fixture', () => {
    for (const scenario of scenarios) {
      it(`${scenario.id} (${scenario.kind}): sobrevivente correto`, () => {
        const items: StoredItem[] = scenario.items.map((it: { text: string; createdAt: string }, idx: number) => ({
          id: `${scenario.id}-${idx}`,
          text: it.text,
          createdAt: it.createdAt
        }));
        const result = resolveConflicts(items);
        const survivor = result.find(
          (r) => r.text === scenario.expectedSurvivorText
        );
        assert.ok(
          survivor,
          `esperava "${scenario.expectedSurvivorText}" entre os sobreviventes`
        );
      });
    }
  });

  describe('integração com buildMemoryBlock', () => {
    it('dedup antes do corte de tamanho', () => {
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café com açúcar', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: '2', text: 'prefiro café sem açúcar', createdAt: '2026-10-01T10:00:00.000Z' }
      ];
      const block = buildMemoryBlock(items);
      assert.ok(block.includes('prefiro café sem açúcar'));
      assert.ok(!block.includes('gosto de café com açúcar'));
    });

    it('preserva múltiplos fatos de tópicos diferentes', () => {
      const items: StoredItem[] = [
        { id: '1', text: 'gosto de café', createdAt: '2026-01-01T10:00:00.000Z' },
        { id: '2', text: 'prefiro chá', createdAt: '2026-01-02T10:00:00.000Z' }
      ];
      const block = buildMemoryBlock(items);
      assert.ok(block.includes('gosto de café'));
      assert.ok(block.includes('prefiro chá'));
    });
  });
});
