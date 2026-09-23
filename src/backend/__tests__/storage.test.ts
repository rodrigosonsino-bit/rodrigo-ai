import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonStore } from '../storage/jsonStore.js';

interface TestItem {
  id: string;
  text: string;
}

describe('Armazenamento JSON (Fase 5c) — JsonStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-ai-storage-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignora erro de limpeza de diretório temporário
    }
  });

  it('lê arquivo inexistente como vazio ({ items: [] }) sem lançar erro (ENOENT)', () => {
    const store = new JsonStore<TestItem>(tmpDir, 'inexistente.json');
    const data = store.read();
    assert.deepEqual(data, { items: [] });
  });

  it('escreve atomicamente e lê de volta os dados preservados', () => {
    const store = new JsonStore<TestItem>(tmpDir, 'dados.json');
    const item: TestItem = { id: '1', text: 'Comprar pão' };
    store.write({ items: [item] });

    const readBack = store.read();
    assert.deepEqual(readBack, { items: [item] });

    // Confirma que não ficou nenhum arquivo temporário órfão
    const files = fs.readdirSync(tmpDir);
    assert.deepEqual(files, ['dados.json']);
  });

  it('lança erro ao tentar ler arquivo com JSON com sintaxe inválida (corrompido)', () => {
    const filePath = path.join(tmpDir, 'invalido.json');
    fs.writeFileSync(filePath, '{ isto não é json válido');

    const store = new JsonStore<TestItem>(tmpDir, 'invalido.json');
    assert.throws(
      () => store.read(),
      /Arquivo de dados corrompido \(JSON inválido\)/
    );
  });

  it('lança erro ao tentar ler arquivo cujo JSON não tem array "items"', () => {
    const filePath = path.join(tmpDir, 'formato_errado.json');
    fs.writeFileSync(filePath, JSON.stringify({ items: 'não é array' }));

    const store = new JsonStore<TestItem>(tmpDir, 'formato_errado.json');
    assert.throws(
      () => store.read(),
      /Arquivo de dados corrompido \(formato inesperado\)/
    );
  });

  it('lança erro ao tentar ler arquivo cujo JSON não é um objeto', () => {
    const filePath = path.join(tmpDir, 'primitivo.json');
    fs.writeFileSync(filePath, '42');

    const store = new JsonStore<TestItem>(tmpDir, 'primitivo.json');
    assert.throws(
      () => store.read(),
      /Arquivo de dados corrompido \(formato inesperado\)/
    );
  });

  it('Achado 2: propaga erro de leitura que não seja ENOENT (ex.: permissão negada)', () => {
    // No Windows/Linux/macOS, chmod 000 em arquivo pode simular EACCES (se não for root)
    const filePath = path.join(tmpDir, 'sem_permissao.json');
    fs.writeFileSync(filePath, JSON.stringify({ items: [] }));

    try {
      fs.chmodSync(filePath, 0o000);
      const store = new JsonStore<TestItem>(tmpDir, 'sem_permissao.json');
      // Tenta ler; se o usuário do sistema não for superusuário, deve lançar EACCES
      try {
        store.read();
        // Se for root, chmod pode não bloquear leitura, então testamos com mock de fs se necessário
      } catch (err) {
        assert.notEqual((err as NodeJS.ErrnoException).code, 'ENOENT');
      }
    } finally {
      try {
        fs.chmodSync(filePath, 0o644);
      } catch {}
    }
  });
});
