import crypto from 'node:crypto';
import type { IMutatingTool } from '../../shared/extensions/tools.js';
import type { MutationName } from '../../shared/voiceProtocol.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import { ReminderScheduler } from './reminderScheduler.js';
import {
  parseRelativeTime,
  formatHumanRelative,
  type ParsedRelativeTime
} from './relativeTimeParser.js';

export { type IMutatingTool };

export class LembreteTool implements IMutatingTool {
  readonly name = 'LEMBRETE';
  readonly description = 'Gerencia lembretes locais.';
  private lastParsed: { raw: string; parsed: ParsedRelativeTime } | null = null;

  constructor(
    private readonly store: JsonStore<StoredItem>,
    private readonly scheduler: ReminderScheduler
  ) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: MutationName, content: string | null): string {
    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }
      const parsed = parseRelativeTime(content);
      this.lastParsed = { raw: content, parsed };

      const finalText = parsed.residualText.trim() || content;
      if (parsed.dueAt) {
        return `Posso criar o lembrete de ${finalText} para ${formatHumanRelative(parsed.dueAt)}?`;
      }
      return `Posso criar o lembrete: ${finalText}?`;
    }
    if (kind === 'LEMBRETE_APAGAR') {
      return 'Posso apagar o lembrete mais recente?';
    }
    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    // Achado 8 (auditoria de código, Hermes, 2026-09-24): captura o cache e limpa
    // incondicionalmente aqui, independente do kind — um preview(LEMBRETE_CRIAR) seguido de um
    // execute(LEMBRETE_APAGAR) (usuário muda de ideia entre a pergunta e a confirmação) não pode
    // deixar `lastParsed` sobrevivendo para contaminar uma criação de lembrete não relacionada
    // mais tarde. `cachedParsed` guarda o valor capturado antes da limpeza, pro ramo CRIAR usar.
    const cachedParsed = this.lastParsed;
    this.lastParsed = null;

    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }

      // Reusa o parsing validado na pergunta ou roda fallback se chamado diretamente
      const parsed =
        cachedParsed && cachedParsed.raw === content
          ? cachedParsed.parsed
          : parseRelativeTime(content);

      const { dueAt, residualText } = parsed;
      const finalText = residualText.trim() || content;

      const store = this.store.read();
      const last = store.items[store.items.length - 1];

      // Correção do Achado 5: deduplicação temporal segura
      const isDuplicate =
        last &&
        last.text === finalText &&
        (last.dueAt ?? null) === (dueAt ?? null) &&
        last.notifiedAt === null;

      if (isDuplicate) {
        return 'Isso já estava salvo.';
      }

      const id = crypto.randomUUID();
      store.items.push({
        id,
        text: finalText,
        createdAt: new Date().toISOString(),
        dueAt,
        notifiedAt: null
      });
      this.store.write(store);

      if (dueAt) {
        this.scheduler.schedule({ id, text: finalText, dueAt });
        return `Lembrete criado para ${formatHumanRelative(dueAt)}.`;
      }
      return 'Lembrete criado.';
    }

    if (kind === 'LEMBRETE_APAGAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para apagar.';
      }
      const removed = store.items.pop()!;
      // Cancela o agendamento em memória se houver
      this.scheduler.cancel(removed.id);
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

export class MemoriaTool implements IMutatingTool {
  readonly name = 'MEMORIA';
  readonly description = 'Guarda e esquece fatos/preferências do usuário entre sessões.';

  constructor(private readonly store: JsonStore<StoredItem>) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: MutationName, content: string | null): string {
    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para guardar memória.');
      }
      return `Posso guardar isso sobre você: ${content}?`;
    }
    if (kind === 'MEMORIA_ESQUECER') {
      // Achado 2 (CRÍTICA, rodada 1): "apagar", nunca "esquecer" — a palavra "esquece" está em
      // NEGATION_MARKERS (sessionManager.ts) e vetaria a própria confirmação afirmativa.
      // Achado novo (BAIXA, rodada 2): frase curta, simétrica a LEMBRETE_APAGAR/NOTA_APAGAR —
      // uma cauda como "...que você me pediu para guardar?" reintroduziria "guardar", que é ele
      // mesmo um marcador afirmativo ('pode guardar'), abrindo espaço pra ambiguidade contrária.
      return 'Posso apagar a memória mais recente?';
    }
    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para guardar memória.');
      }
      const store = this.store.read();
      // Achado 7 (MÉDIA, rodada 1): checa o array inteiro, não só o último item — memória é
      // lista estática de fatos, não um log temporal como NotaTool.
      const normalized = content.trim().toLowerCase();
      const isDuplicate = store.items.some((it) => it.text.trim().toLowerCase() === normalized);
      if (isDuplicate) {
        return 'Isso já estava guardado.';
      }
      store.items.push({
        id: crypto.randomUUID(),
        text: content,
        createdAt: new Date().toISOString()
      });
      this.store.write(store);
      return 'Guardado.';
    }

    if (kind === 'MEMORIA_ESQUECER') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nada guardado pra apagar.';
      }
      store.items.pop();
      this.store.write(store);
      return 'Apagado.';
    }

    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }
}

/** Filtro permissivo especificado em docs/phase-5c-v3.md §4.2 e atualizado na Fase 7 §4.1. */
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr|memor|grava|grave|gravou|gravand|gravar)\w*\b/;

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

export interface MutatingToolsResult {
  tools: IMutatingTool[];
  scheduler: ReminderScheduler;
  memoriaStore: JsonStore<StoredItem>;
}

/**
 * `customScheduler`, se passado, DEVE ter sido construído com o mesmo `JsonStore` de lembretes
 * que este `baseDir` produziria (`new JsonStore(baseDir, 'lembretes.json')`) — achado 5 (auditoria
 * de código, Hermes, 2026-09-24): um scheduler apontando para um store diferente agenda o timer
 * normalmente, mas `fire()` nunca encontra o item nesse store e a notificação nunca dispara, sem
 * nenhum erro visível. Em produção `customScheduler` nunca é passado (voiceRuntime.ts usa o
 * default); o parâmetro existe só para testes injetarem um scheduler mockável.
 */
export function createMutatingTools(
  baseDir: string,
  customScheduler?: ReminderScheduler
): MutatingToolsResult {
  const lembreteStore = new JsonStore<StoredItem>(baseDir, 'lembretes.json');
  const notaStore = new JsonStore<StoredItem>(baseDir, 'notas.json');
  const memoriaStore = new JsonStore<StoredItem>(baseDir, 'memorias.json');

  const scheduler = customScheduler ?? new ReminderScheduler(lembreteStore);
  const lembreteTool = new LembreteTool(lembreteStore, scheduler);
  const notaTool = new NotaTool(notaStore);
  const memoriaTool = new MemoriaTool(memoriaStore);

  return {
    tools: [lembreteTool, notaTool, memoriaTool],
    scheduler,
    memoriaStore
  };
}
