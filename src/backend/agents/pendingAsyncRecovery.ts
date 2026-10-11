import type { OpenClawHttpClient } from './openClawHttpClient.js';
import type { ExecutionTrace, SubAgentCoordinator } from './subAgent.js';
import {
  isPendingAsyncTaskAgedOut,
  type PendingAsyncTask,
  type PendingAsyncTaskStore
} from './pendingAsyncStore.js';

export const ASYNC_TASK_LOST_ON_RESTART_TEXT =
  'Uma tarefa que você pediu antes se perdeu num reinício — não consegui recuperar o resultado.';

export interface AsyncRecoverySpeech {
  taskId: string;
  text: string;
  /** 'completed' | 'failed' | 'lost' — nunca 'aged' (descarte silencioso). */
  outcome: 'completed' | 'failed' | 'lost';
}

export interface RecoverPendingAsyncTasksResult {
  discardedByAge: number;
  speeches: AsyncRecoverySpeech[];
  traces: ExecutionTrace[];
}

/**
 * Comportamento exato na subida (docs/phase-15-v3.md §4.3):
 * 1. Descartar em silêncio tarefas com idade > TTL.
 * 2. Para as demais, pollStatus — nunca re-entregar o prompt original ao LLM.
 * 3. Concluída → resumo datado marcado como tarefa anterior.
 * 4. taskId inexistente → fala honesta de perda no reinício.
 * 5. Remover o registro assim que conclui / falha / descarta por idade.
 */
export async function recoverPendingAsyncTasks(opts: {
  store: PendingAsyncTaskStore;
  client: OpenClawHttpClient | null;
  ttlHours: number;
  coordinator?: SubAgentCoordinator;
  now?: Date;
}): Promise<RecoverPendingAsyncTasksResult> {
  const now = opts.now ?? new Date();
  const speeches: AsyncRecoverySpeech[] = [];
  const traces: ExecutionTrace[] = [];
  let discardedByAge = 0;

  const pending = opts.store.readAll();
  for (const task of pending) {
    if (isPendingAsyncTaskAgedOut(task, opts.ttlHours, now)) {
      opts.store.remove(task.taskId);
      discardedByAge += 1;
      continue;
    }

    if (!opts.client) {
      opts.store.remove(task.taskId);
      const text = ASYNC_TASK_LOST_ON_RESTART_TEXT;
      speeches.push({ taskId: task.taskId, text, outcome: 'lost' });
      traces.push(recordRecoveryTrace(opts.coordinator, task, 'failed', text));
      continue;
    }

    try {
      const status = await opts.client.pollStatus(task.taskId);
      const normalized = status.status.trim().toLowerCase();

      if (normalized === 'completed') {
        opts.store.remove(task.taskId);
        const summary = status.result?.trim() || 'a tarefa terminou sem resultado textual';
        const text = formatPriorAsyncResultSpeech(task.startedAt, summary, now);
        speeches.push({ taskId: task.taskId, text, outcome: 'completed' });
        traces.push(recordRecoveryTrace(opts.coordinator, task, 'completed', text));
        continue;
      }

      if (normalized === 'failed') {
        opts.store.remove(task.taskId);
        const detail = status.result?.trim() || 'falhou sem detalhe';
        const text = formatPriorAsyncFailureSpeech(task.startedAt, detail, now);
        speeches.push({ taskId: task.taskId, text, outcome: 'failed' });
        traces.push(recordRecoveryTrace(opts.coordinator, task, 'failed', text));
        continue;
      }

      if (normalized === 'not_found' || normalized === 'unknown' || normalized === 'missing') {
        opts.store.remove(task.taskId);
        speeches.push({
          taskId: task.taskId,
          text: ASYNC_TASK_LOST_ON_RESTART_TEXT,
          outcome: 'lost'
        });
        traces.push(
          recordRecoveryTrace(opts.coordinator, task, 'failed', ASYNC_TASK_LOST_ON_RESTART_TEXT)
        );
        continue;
      }

      // Ainda pending/running no OpenClaw após restart: mitigação mínima da F15 é só
      // verificar na subida — retomar o poller automaticamente fica fora de escopo (§9).
      // Mantém o registro para a próxima subida / para um poller futuro.
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      const looksMissing = /não exist|not found|unknown task|inexistente|404/i.test(msg);
      opts.store.remove(task.taskId);
      if (looksMissing) {
        speeches.push({
          taskId: task.taskId,
          text: ASYNC_TASK_LOST_ON_RESTART_TEXT,
          outcome: 'lost'
        });
        traces.push(
          recordRecoveryTrace(opts.coordinator, task, 'failed', ASYNC_TASK_LOST_ON_RESTART_TEXT)
        );
      } else {
        const text = `Não consegui verificar uma tarefa anterior no OpenClaw (${msg || 'erro desconhecido'}).`;
        speeches.push({ taskId: task.taskId, text, outcome: 'failed' });
        traces.push(recordRecoveryTrace(opts.coordinator, task, 'failed', text));
      }
    }
  }

  return { discardedByAge, speeches, traces };
}

export function formatPriorAsyncResultSpeech(
  startedAtIso: string,
  summary: string,
  now: Date = new Date()
): string {
  const when = formatRelativeWhen(startedAtIso, now);
  return `Resultado de uma tarefa que você pediu ${when}: ${summary}`;
}

function formatPriorAsyncFailureSpeech(startedAtIso: string, detail: string, now: Date): string {
  const when = formatRelativeWhen(startedAtIso, now);
  return `Uma tarefa que você pediu ${when} falhou: ${detail}`;
}

function formatRelativeWhen(startedAtIso: string, now: Date): string {
  const started = Date.parse(startedAtIso);
  if (Number.isNaN(started)) return 'mais cedo';
  const hours = (now.getTime() - started) / (60 * 60 * 1000);
  if (hours < 1) return 'há pouco';
  if (hours < 2) return 'há cerca de uma hora';
  if (hours < 24) return `há cerca de ${Math.floor(hours)} horas`;
  return 'mais cedo';
}

function recordRecoveryTrace(
  coordinator: SubAgentCoordinator | undefined,
  task: PendingAsyncTask,
  status: 'completed' | 'failed',
  result: string
): ExecutionTrace {
  const turnId = `recovery:${task.taskId}`;
  if (!coordinator) {
    return {
      turnId,
      query: '(tarefa assíncrona anterior — prompt original não reentregue)',
      tasks: [
        {
          subAgentId: task.capability,
          prompt: '(omitido na recuperação — nunca re-entregue ao LLM)',
          isMutation: Boolean(task.confirmationToken),
          status,
          result
        }
      ]
    };
  }
  const trace = coordinator.createTrace(
    turnId,
    '(tarefa assíncrona anterior — prompt original não reentregue)'
  );
  trace.tasks.push({
    subAgentId: task.capability,
    prompt: '(omitido na recuperação — nunca re-entregue ao LLM)',
    isMutation: Boolean(task.confirmationToken),
    status,
    result
  });
  return trace;
}
