import type {
  ISubAgent,
  SubAgentTaskRequest,
  SubAgentTaskResult
} from './subAgent.js';
import {
  makeOpenClawHttpClient,
  type OpenClawHttpClient
} from './openClawHttpClient.js';

const SHORT_TIMEOUT_MS = 15_000;

export class OpenClawSubAgent implements ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];

  constructor(
    id: string,
    name: string,
    capabilities: string[],
    private readonly openClawClient?: OpenClawHttpClient
  ) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
  }

  static withHttpClient(
    id: string,
    name: string,
    capabilities: string[]
  ): OpenClawSubAgent | null {
    const client = makeOpenClawHttpClient();
    if (!client) return null;
    return new OpenClawSubAgent(id, name, capabilities, client);
  }

  async runTask(
    req: SubAgentTaskRequest,
    signal: AbortSignal
  ): Promise<SubAgentTaskResult> {
    if (signal.aborted) {
      return {
        success: false,
        output: '',
        error: 'Tarefa cancelada pelo usuário.',
        kind: 'final'
      };
    }

    if (!this.openClawClient) {
      return {
        success: false,
        output: '',
        error: 'Gateway OpenClaw não conectado.',
        kind: 'final'
      };
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), SHORT_TIMEOUT_MS);
    const combinedSignal = combineSignals(signal, timeoutController.signal);

    try {
      const output = await this.openClawClient.invokeShort(req.prompt, combinedSignal);
      return { success: true, output, kind: 'final' };
    } catch (err) {
      if (signal.aborted) {
        return {
          success: false,
          output: '',
          error: 'Tarefa cancelada pelo usuário.',
          kind: 'final'
        };
      }

      if (timeoutController.signal.aborted) {
        try {
          const asyncHandle = await this.openClawClient.invokeLongAsync(req.prompt);
          return {
            success: true,
            output: '',
            kind: 'async_deferred',
            asyncTaskId: asyncHandle.taskId
          };
        } catch (deferredErr) {
          return {
            success: false,
            output: '',
            error: this.describeFailure(deferredErr),
            kind: 'final'
          };
        }
      }

      return {
        success: false,
        output: '',
        error: this.describeFailure(err),
        kind: 'final'
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private describeFailure(err: unknown): string {
    return `Não consegui falar com o OpenClaw agora (${err instanceof Error ? err.message : 'erro desconhecido'}).`;
  }
}

function combineSignals(primary: AbortSignal, timeoutSignal: AbortSignal): AbortSignal {
  const withAny = AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };
  if (withAny.any) return withAny.any([primary, timeoutSignal]);

  const ctrl = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (ctrl.signal.aborted) return;
    ctrl.abort((source as AbortSignal & { reason?: unknown }).reason);
  };

  if (primary.aborted) {
    abortFrom(primary);
    return ctrl.signal;
  }
  if (timeoutSignal.aborted) {
    abortFrom(timeoutSignal);
    return ctrl.signal;
  }

  const onPrimaryAbort = (): void => abortFrom(primary);
  const onTimeoutAbort = (): void => abortFrom(timeoutSignal);
  primary.addEventListener('abort', onPrimaryAbort, { once: true });
  timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });

  ctrl.signal.addEventListener(
    'abort',
    () => {
      primary.removeEventListener('abort', onPrimaryAbort);
      timeoutSignal.removeEventListener('abort', onTimeoutAbort);
    },
    { once: true }
  );

  return ctrl.signal;
}
