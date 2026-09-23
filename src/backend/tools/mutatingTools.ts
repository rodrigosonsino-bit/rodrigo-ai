import crypto from 'node:crypto';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import type { MutationName } from '../../shared/voiceProtocol.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';

export { type IMutatingTool };

export class LembreteTool implements IMutatingTool {
  readonly name = 'LEMBRETE';
  readonly description = 'Gerencia lembretes locais.';

  constructor(private readonly store: JsonStore<StoredItem>) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: MutationName, content: string | null): string {
    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }
      return `Posso criar o lembrete: ${content}?`;
    }
    if (kind === 'LEMBRETE_APAGAR') {
      return 'Posso apagar o lembrete mais recente?';
    }
    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }
      const store = this.store.read();
      const last = store.items[store.items.length - 1];
      if (last && last.text === content) {
        return 'Isso já estava salvo.';
      }
      store.items.push({
        id: crypto.randomUUID(),
        text: content,
        createdAt: new Date().toISOString()
      });
      this.store.write(store);
      return 'Lembrete criado.';
    }

    if (kind === 'LEMBRETE_APAGAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para apagar.';
      }
      store.items.pop();
      this.store.write(store);
      return 'Lembrete apagado.';
    }

    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }
}

export class NotaTool implements IMutatingTool {
  readonly name = 'NOTA';
  readonly description = 'Gerencia notas locais.';

  constructor(private readonly store: JsonStore<StoredItem>) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: MutationName, content: string | null): string {
    if (kind === 'NOTA_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de nota.');
      }
      return `Posso guardar a nota: ${content}?`;
    }
    if (kind === 'NOTA_APAGAR') {
      return 'Posso apagar a nota mais recente?';
    }
    throw new Error(`Ação inválida para NotaTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    if (kind === 'NOTA_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de nota.');
      }
      const store = this.store.read();
      const last = store.items[store.items.length - 1];
      if (last && last.text === content) {
        return 'Isso já estava salvo.';
      }
      store.items.push({
        id: crypto.randomUUID(),
        text: content,
        createdAt: new Date().toISOString()
      });
      this.store.write(store);
      return 'Nota criada.';
    }

    if (kind === 'NOTA_APAGAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhuma nota para apagar.';
      }
      store.items.pop();
      this.store.write(store);
      return 'Nota apagada.';
    }

    throw new Error(`Ação inválida para NotaTool: ${kind}`);
  }
}

/** Filtro permissivo especificado em docs/phase-5c-v3.md §4.2. */
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr)\w*\b/;

export function mightBeMutation(transcript: string): boolean {
  const n = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return MUTATION_GATE.test(n);
}

/**
 * Deriva o prefixo da ação (LEMBRETE_/NOTA_) e encontra a MESMA instância que trata as duas
 * ações desse prefixo — especificado em docs/phase-5c-v2.md §6.4.
 */
export function selectMutatingToolByAction(
  kind: string,
  tools: readonly IMutatingTool[]
): IMutatingTool | null {
  const prefix = kind.split('_')[0].toUpperCase();
  return tools.find((t) => t.name.toUpperCase() === prefix && t.isAvailable()) ?? null;
}

export function createMutatingTools(baseDir: string): IMutatingTool[] {
  const lembreteStore = new JsonStore<StoredItem>(baseDir, 'lembretes.json');
  const notaStore = new JsonStore<StoredItem>(baseDir, 'notas.json');
  return [new LembreteTool(lembreteStore), new NotaTool(notaStore)];
}
