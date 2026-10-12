import type {
  ISubAgent,
  SubAgentCoordinator,
  SubAgentTaskRequest,
  SubAgentTaskResult
} from './subAgent.js';
import {
  makeOpenClawHttpClient,
  type OpenClawHttpClient
} from './openClawHttpClient.js';
import {
  OPENCLAW_CAPABILITIES,
  getOpenClawCapability,
  type OpenClawCapabilitySpec
} from './openClawCapabilities.js';
import {
  DEFAULT_PRIVACY,
  WEB_SEARCH_DISABLED_TEXT,
  webSearchEffective,
  type PrivacyConfig
} from '../privacy.js';

const DEFAULT_SHORT_TIMEOUT_MS = 15_000;

export class OpenClawSubAgent implements ISubAgent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly shortTimeoutMs: number;
  readonly requiresConfirmation: boolean;

  constructor(
    id: string,
    name: string,
    capabilities: string[],
    private readonly openClawClient?: OpenClawHttpClient,
    opts: {
      shortTimeoutMs?: number;
      requiresConfirmation?: boolean;
      privacy?: PrivacyConfig;
      /** Fatia 4 (C2/B1): gatekeeper que confirma e consome o token emitido; sem ele, fail-closed. */
      verifyMutationToken?: (turnId: string, token: string) => boolean;
    } = {}
  ) {
    this.id = id;
    this.name = name;
    this.capabilities = capabilities;
    this.shortTimeoutMs = opts.shortTimeoutMs ?? DEFAULT_SHORT_TIMEOUT_MS;
    this.requiresConfirmation = opts.requiresConfirmation ?? false;
    this.privacy = opts.privacy ?? DEFAULT_PRIVACY;
    this.verifyMutationToken = opts.verifyMutationToken;
  }

  private readonly privacy: PrivacyConfig;
  private readonly verifyMutationToken?: (turnId: string, token: string) => boolean;

  static fromCapability(
    spec: OpenClawCapabilitySpec,
    client?: OpenClawHttpClient | null,
    privacy: PrivacyConfig = DEFAULT_PRIVACY
  ): OpenClawSubAgent | null {
    if (!spec.wired) {
      // Declarável, sem wiring — o registro pode listar o id, mas não há agente executável.
      return null;
    }
    if (!client) return null;
    return new OpenClawSubAgent(spec.id, spec.name, [spec.id], client, {
      shortTimeoutMs: spec.shortTimeoutMs,
      requiresConfirmation: spec.requiresConfirmation,
      privacy
    });
  }

  static withHttpClient(
    id: string,
    name: string,
    capabilities: string[],
    privacy: PrivacyConfig = DEFAULT_PRIVACY
  ): OpenClawSubAgent | null {
    const client = makeOpenClawHttpClient();
    if (!client) return null;
    const spec = getOpenClawCapability(id);
    return new OpenClawSubAgent(id, name, capabilities, client, {
      shortTimeoutMs: spec?.shortTimeoutMs ?? DEFAULT_SHORT_TIMEOUT_MS,
      requiresConfirmation: spec?.requiresConfirmation ?? false,
      privacy
    });
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

    // Fase 15 §5 / H15.6: openclaw_web só lê na web com o canal efetivo ligado.
    if (this.capabilities.includes('openclaw_web') && !webSearchEffective(this.privacy)) {
      return {
        success: true,
        output: WEB_SEARCH_DISABLED_TEXT,
        kind: 'final'
      };
    }

    if (this.requiresConfirmation || req.isMutation) {
      if (!req.confirmationToken) {
        return {
          success: false,
          output: '',
          error: 'Mutação bloqueada: nenhum confirmationToken presente (achado 3 da auditoria r1 da F15).',
          kind: 'final'
        };
      }
      if (!req.confirmationToken.startsWith(`${req.turnId}:`)) {
        return {
          success: false,
          output: '',
          error: 'Mutação bloqueada: confirmationToken não corresponde ao turno atual (achado r2 N4).',
          kind: 'final'
        };
      }
      if (this.verifyMutationToken?.(req.turnId, req.confirmationToken) !== true) {
        return {
          success: false,
          output: '',
          error: 'Mutação bloqueada: confirmationToken não emitido pelo gatekeeper',
          kind: 'final'
        };
      }
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
    const timeout = setTimeout(() => timeoutController.abort(), this.shortTimeoutMs);
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

/**
 * Registra no coordenador uma instância por capacidade wired (§4.4).
 * Capacidades não-wired ficam só na tabela OPENCLAW_CAPABILITIES — declaráveis,
 * sem agente executável. O limite real das ações no OpenClaw é compartilhado com
 * a config do gateway; ver comentário em openClawCapabilities.ts.
 */
export function registerWiredOpenClawAgents(
  coordinator: SubAgentCoordinator,
  client?: OpenClawHttpClient | null,
  privacy: PrivacyConfig = DEFAULT_PRIVACY
): OpenClawSubAgent[] {
  const resolved = client === undefined ? makeOpenClawHttpClient() : client;
  const registered: OpenClawSubAgent[] = [];
  for (const spec of OPENCLAW_CAPABILITIES) {
    const agent = OpenClawSubAgent.fromCapability(spec, resolved, privacy);
    if (!agent) continue;
    coordinator.register(agent);
    registered.push(agent);
  }
  return registered;
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
