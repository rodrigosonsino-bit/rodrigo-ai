import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonStore, type StoredItem } from '../../storage/jsonStore.js';
import {
  LembreteTool,
  NotaTool,
  MemoriaTool,
  findBestMatchingItemIndex
} from '../mutatingTools.js';
import { ReminderScheduler } from '../reminderScheduler.js';

test('Fase 14: findBestMatchingItemIndex - seleciona item por similaridade de texto', () => {
  const items: StoredItem[] = [
    { id: '1', text: 'comprar remédio para pressão', createdAt: new Date().toISOString() },
    { id: '2', text: 'comprar leite no mercado', createdAt: new Date().toISOString() },
    { id: '3', text: 'reunião de projeto às 15h', createdAt: new Date().toISOString() }
  ];

  const match1 = findBestMatchingItemIndex(items, 'remédio');
  assert.equal(match1.index, 0);
  assert.equal(match1.ambiguous, false);

  const match2 = findBestMatchingItemIndex(items, 'mercado');
  assert.equal(match2.index, 1);
  assert.equal(match2.ambiguous, false);

  const match3 = findBestMatchingItemIndex(items, 'reunião');
  assert.equal(match3.index, 2);
  assert.equal(match3.ambiguous, false);
});

test('Fase 14: findBestMatchingItemIndex - sinaliza ambiguidade em itens parecidos', () => {
  const items: StoredItem[] = [
    { id: '1', text: 'tomar remédio da manhã', createdAt: new Date().toISOString() },
    { id: '2', text: 'tomar remédio da noite', createdAt: new Date().toISOString() }
  ];

  const match = findBestMatchingItemIndex(items, 'tomar remédio');
  assert.equal(match.ambiguous, true);
  assert.ok(match.matches);
  assert.equal(match.matches.length, 2);
});

test('Fase 14: LEMBRETE_CONSULTAR, NOTA_CONSULTAR e MEMORIA_CONSULTAR', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f14-test-'));
  try {
    const lembretesStore = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
    const notasStore = new JsonStore<StoredItem>(tmpDir, 'notas.json');
    const memoriasStore = new JsonStore<StoredItem>(tmpDir, 'memorias.json');

    const scheduler = new ReminderScheduler(lembretesStore, (() => {}) as any);
    const lembreteTool = new LembreteTool(lembretesStore, scheduler);
    const notaTool = new NotaTool(notasStore);
    const memoriaTool = new MemoriaTool(memoriasStore);

    // Salva itens
    notaTool.execute('NOTA_CRIAR', 'Ideia de projeto de voz');
    memoriaTool.execute('MEMORIA_GUARDAR', 'Gosto de café sem açúcar');
    lembreteTool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã às 08:00');

    // Consultas
    const resNota = notaTool.execute('NOTA_CONSULTAR', 'voz');
    assert.ok(resNota.includes('Ideia de projeto de voz'));

    const resMem = memoriaTool.execute('MEMORIA_CONSULTAR', 'café');
    assert.ok(resMem.includes('Gosto de café sem açúcar'));

    const resLembrete = lembreteTool.execute('LEMBRETE_CONSULTAR', 'pão');
    assert.ok(resLembrete.includes('comprar pão'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
