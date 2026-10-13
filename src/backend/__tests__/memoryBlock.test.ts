import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryBlock,
  MAX_MEMORIES_INJECTED,
  MAX_MEMORY_BLOCK_CHARS
} from '../memory/index.js';
import type { StoredItem } from '../storage/jsonStore.js';
import { UNTRUSTED_NOTICE, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../memory/untrustedData.js';

describe('buildMemoryBlock (Fase 7 — H2)', () => {
  it('retorna string vazia quando não há itens', () => {
    assert.equal(buildMemoryBlock([]), '');
  });

  it('formata itens dentro dos limites (mais recente primeiro)', () => {
    const items: StoredItem[] = [
      { id: '1', text: 'seu nome é Rodrigo', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: '2', text: 'prefere café sem açúcar', createdAt: '2026-09-02T00:00:00.000Z' }
    ];

    const block = buildMemoryBlock(items);
    assert.ok(block.startsWith('[Fatos que o usuário pediu para você lembrar entre sessões'));
    // Mais recente primeiro: item 2 antes de item 1
    const expected =
      `[Fatos que o usuário pediu para você lembrar entre sessões — use-os naturalmente na conversa, nunca liste-os como uma lista para o usuário a menos que ele peça explicitamente. ${UNTRUSTED_NOTICE}]\n` +
      `${UNTRUSTED_OPEN}\n` +
      '- prefere café sem açúcar\n' +
      '- seu nome é Rodrigo\n' +
      UNTRUSTED_CLOSE;
    assert.equal(block, expected);
  });

  it('respeita o teto de quantidade (MAX_MEMORIES_INJECTED = 10), descartando as mais antigas', () => {
    const items: StoredItem[] = [];
    for (let i = 1; i <= 15; i++) {
      items.push({
        id: String(i),
        text: `fato ${i}`,
        createdAt: new Date(2026, 0, i).toISOString()
      });
    }

    const block = buildMemoryBlock(items);
    const lines = block.split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines.length, MAX_MEMORIES_INJECTED);
    // Mais recente é fato 15, até fato 6 (10 itens). Fato 1 a 5 foram descartados.
    assert.equal(lines[0], '- fato 15');
    assert.equal(lines[lines.length - 1], '- fato 6');
  });

  it('respeita o teto de caracteres (MAX_MEMORY_BLOCK_CHARS = 1200) sem cortar itens pela metade', () => {
    // Cada item com 300 caracteres -> 4 itens = 1200 chars sem contar prefixos e newline.
    // Com "- " (2) e "\n" (1), cada linha tem 303 chars.
    // 3 linhas = ~909 chars. 4 linhas = ~1212 chars (> 1200) -> deve parar em 3 linhas!
    const items: StoredItem[] = [];
    for (let i = 1; i <= 5; i++) {
      items.push({
        id: String(i),
        text: `memoria_${i}_` + 'x'.repeat(290),
        createdAt: new Date(2026, 0, i).toISOString()
      });
    }

    const block = buildMemoryBlock(items);
    const lines = block.split('\n').filter((l) => l.startsWith('- '));

    // Não deve conter 5 nem 4 itens (1212 chars > 1200), deve conter 3 itens
    assert.equal(lines.length, 3);
    // Mais recentes primeiro: 5, 4, 3
    assert.ok(lines[0].startsWith('- memoria_5_'));
    assert.ok(lines[1].startsWith('- memoria_4_'));
    assert.ok(lines[2].startsWith('- memoria_3_'));

    // Verifica que nenhum item ficou cortado pela metade — compara contra o próprio texto
    // original do item, não contra um número mágico (achado BAIXA, auditoria Hermes, 2026-09-26).
    for (let i = 0; i < lines.length; i++) {
      const originalItem = items[items.length - 1 - i]; // lines está em ordem mais recente primeiro
      assert.equal(lines[i].length, '- '.length + originalItem.text.length);
    }
  });

  it('retorna string vazia se até o item mais recente exceder MAX_MEMORY_BLOCK_CHARS', () => {
    const items: StoredItem[] = [
      {
        id: '1',
        text: 'x'.repeat(MAX_MEMORY_BLOCK_CHARS + 10),
        createdAt: '2026-09-01T00:00:00.000Z'
      }
    ];

    assert.equal(buildMemoryBlock(items), '');
  });
});
