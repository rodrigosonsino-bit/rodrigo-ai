import path from 'node:path';
import { JsonStore } from '../storage/jsonStore.js';

/**
 * Schema mínimo de persistência de tarefa OpenClaw assíncrona (docs/phase-15-v3.md §4.3,
 * achados r2 N1 / r3 N2). Escrita atômica via JsonStore (temp + rename).
 */
export interface PendingAsyncTask {
  taskId: string;
  prompt: string;
  /** Domínio declarado do OpenClawSubAgent que originou a tarefa (§4.4). */
  capability: string;
  /** ISO 8601 — usado pelo descarte por TTL na subida. */
  startedAt: string;
  turnId: string;
  /** Presente só se a tarefa original era uma mutação. */
  confirmationToken?: string;
}

const FILE_NAME = 'pendingAsyncTasks.json';

/** Padrão 6h (achado r3 N3); configurável via RODRIGO_ASYNC_TASK_TTL_HOURS. */
export const DEFAULT_ASYNC_TASK_TTL_HOURS = 6;

export function parseAsyncTaskTtlHours(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env.RODRIGO_ASYNC_TASK_TTL_HOURS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ASYNC_TASK_TTL_HOURS;
  const v = raw.trim();
  if (!/^[1-9][0-9]{0,2}$/.test(v)) {
    throw new Error(
      `Configuração inválida: RODRIGO_ASYNC_TASK_TTL_HOURS deve ser um inteiro entre 1 e 168. Valor recebido: "${raw}"`
    );
  }
  const n = parseInt(v, 10);
  if (n > 168) {
    throw new Error(
      `Configuração inválida: RODRIGO_ASYNC_TASK_TTL_HOURS deve ser um inteiro entre 1 e 168. Valor recebido: "${raw}"`
    );
  }
  return n;
}

/**
 * Persistência em data/pendingAsyncTasks.json. Reutiliza JsonStore (temp + rename)
 * — o mesmo padrão dos lembretes em storage/jsonStore.ts.
 */
export class PendingAsyncTaskStore {
  private readonly store: JsonStore<PendingAsyncTask>;

  /** Caminho absoluto do arquivo final (útil em testes de atomicidade). */
  readonly filePath: string;

  constructor(baseDir: string) {
    this.store = new JsonStore<PendingAsyncTask>(baseDir, FILE_NAME);
    this.filePath = path.join(baseDir, FILE_NAME);
  }

  readAll(): PendingAsyncTask[] {
    return this.store.read().items;
  }

  upsert(task: PendingAsyncTask): void {
    const items = this.store.read().items.filter((t) => t.taskId !== task.taskId);
    items.push(task);
    this.store.write({ items });
  }

  remove(taskId: string): void {
    const items = this.store.read().items.filter((t) => t.taskId !== taskId);
    this.store.write({ items });
  }

  clear(): void {
    this.store.write({ items: [] });
  }
}

export function isPendingAsyncTaskAgedOut(
  task: PendingAsyncTask,
  ttlHours: number,
  now: Date = new Date()
): boolean {
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started)) return true;
  return now.getTime() - started > ttlHours * 60 * 60 * 1000;
}
