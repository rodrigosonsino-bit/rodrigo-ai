import type { ExtensionRegistry } from '../../shared/extensions/registry.js';
import type { Capability } from './capabilityPolicy.js';
import type { ISubAgent, SubAgentCoordinator, SubAgentTaskRequest, SubAgentTaskResult } from './subAgent.js';
import { guardText } from '../privacy/outboundGuard.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';

export const OGRA_AGENT_ID = 'ogra';

/**
 * Fala curta do Ork depois do 2xx do webhook, enquanto POST /api/ogra/reply não chega.
 * O webhook só acusa o recebimento; a resposta é o callback.
 */
export const OGRA_HOLDING_TEXT = 'Pensando...';
/** Mesma frase de OGRA_HOLDING_TEXT: o 2xx não é a resposta, é a espera. */
export const OGRA_ACK_TEXT = OGRA_HOLDING_TEXT;

/** Silêncio depois do ack, com RODRIGO_OGRA_FALLBACK=0: o turno encerra com esta frase. */
export const OGRA_REPLY_TIMEOUT_TEXT = 'A Ogra não respondeu a tempo.';

export const OGRA_BLOCKED_TEXT =
  'Não enviei isso à Ogra: o texto contém um dado sensível e, pela configuração, não sai.';

export const OGRA_WEBHOOK_MISSING_TEXT = 'A Ogra está ligada, mas o webhook não está configurado.';

export const OGRA_WEBHOOK_FAILED_TEXT = 'Não consegui falar com a Ogra agora.';

/** Aviso curto antes de o mesmo turno seguir o caminho normal. Não é uma nova tentativa à Ogra. */
export const OGRA_FALLBACK_NOTICE = 'A Ogra não respondeu, vou seguir por aqui.';

const OGRA_HTTP_FAILURE = new RegExp(
  `^${OGRA_WEBHOOK_FAILED_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(HTTP (\\d+)\\)\\.$`
);

/**
 * Falha de transporte em que o turno pode seguir o caminho normal (RODRIGO_OGRA_FALLBACK=1).
 * HTTP fora de 2xx (429, 5xx e os demais), prazo, erro de rede, ou webhook ausente.
 * Cancelamento, guarda em block e estouro de orçamento não entram: não são falha do webhook.
 * A Ogra não é destino de reserva do Gemini — esta função só classifica a ida que já falhou.
 */
export function ograFailureFallsBack(error: string | undefined): boolean {
  if (!error) return false;
  if (error === OGRA_WEBHOOK_MISSING_TEXT) return true;
  if (error === OGRA_WEBHOOK_FAILED_TEXT) return true;
  const http = OGRA_HTTP_FAILURE.exec(error);
  if (!http) return false;
  const status = Number(http[1]);
  return status < 200 || status >= 300;
}

export const OGRA_REPLY_EMPTY_TEXT = 'A Ogra encerrou sem texto.';

export const OGRA_REPLY_BLOCKED_TEXT =
  'A resposta da Ogra tinha um dado sensível e eu não a falei.';

const WEBHOOK_TIMEOUT_MS = 20_000;

export interface OgraCapabilityDescriptor {
  id: string;
  name: string;
  kind: 'agent' | 'tool' | 'mutating_tool' | 'voice';
}

export interface OgraWebhookTarget {
  url: string;
  key: string;
}

/**
 * Catálogo declarado no registro de extensões. Só id/nome/tipo — sem fala, arquivo ou segredo.
 * TODO (fases seguintes): isto lista o que existe; não autoriza desktop, cursor nem WhatsApp.
 */
export function capabilitiesFromRegistry(reg: ExtensionRegistry): OgraCapabilityDescriptor[] {
  const out: OgraCapabilityDescriptor[] = [];
  for (const agent of reg.getAgents()) out.push({ id: agent.id, name: agent.name, kind: 'agent' });
  for (const tool of reg.getTools()) out.push({ id: tool.name, name: tool.name, kind: 'tool' });
  for (const tool of reg.getMutatingTools()) out.push({ id: tool.name, name: tool.name, kind: 'mutating_tool' });
  for (const voice of reg.getVoiceProviders()) out.push({ id: voice.id, name: voice.name, kind: 'voice' });
  return out;
}

export interface OgraWebhookPayload {
  source: 'ork';
  project: 'rodrigo-ai';
  message: string;
  taskId: string;
  /** Mesmo papel do campo `session` de scripts/avisar-grok.sh. */
  session: string;
  sessionId: string;
  capabilities: readonly OgraCapabilityDescriptor[];
}

type Env = Readonly<Record<string, string | undefined>>;

export function readOgraWebhookEnv(env: Env): OgraWebhookTarget | null {
  const url = env.GROK_WEBHOOK_URL?.trim() ?? '';
  const key = env.GROK_WEBHOOK_KEY?.trim() ?? '';
  if (!url || !key) return null;
  if (!isHttpUrl(url)) return null;
  return { url, key };
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export interface OgraSubAgentOptions {
  privacy?: PrivacyConfig;
  env?: Env;
  webhook?: OgraWebhookTarget | null;
  fetchImpl?: typeof fetch;
  catalog?: () => readonly OgraCapabilityDescriptor[];
  /** Gatekeeper: true só para o token emitido neste turnId, e então o consome. Sem ele, mutação fica fechada. */
  verifyMutationToken?: (turnId: string, token: string) => boolean;
  timeoutMs?: number;
}

/**
 * Subagente da Ogra. O webhook só acusa o recebimento (2xx, sem corpo de resposta).
 * `runTask` devolve `async_deferred`; quem espera `POST /api/ogra/reply` e fala o texto
 * é o turno, até RODRIGO_OGRA_REPLY_TIMEOUT_MS. Não substitui o LLM do turno e não entra
 * na reserva do Gemini.
 *
 * Mutação: o mesmo trinco do OpenClaw (token presente, prefixo do turnId, emitido pelo gatekeeper).
 * A fala do usuário NÃO é mutação. Quem propõe ferramenta mutante é o endpoint /api/ogra/tool,
 * e ele não chama este método com `isMutation` — o SIM falado é que libera o tool subagent.
 *
 * TODO: não coordenar cursor, WhatsApp nem outros apps daqui.
 */
export class OgraSubAgent implements ISubAgent {
  readonly id = OGRA_AGENT_ID;
  readonly name = 'Ogra';
  readonly capabilities: readonly string[] = ['ogra'];
  /** Webhook de saída. Mutação local não é concessão deste agente (falta `write_file` de propósito). */
  readonly grants: readonly Capability[] = ['network'];

  private readonly privacy: PrivacyConfig;
  private readonly env: Env;
  private readonly webhook: OgraWebhookTarget | null | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly catalog: () => readonly OgraCapabilityDescriptor[];
  private readonly verifyMutationToken?: (turnId: string, token: string) => boolean;
  private readonly timeoutMs: number;

  constructor(opts: OgraSubAgentOptions = {}) {
    this.privacy = opts.privacy ?? DEFAULT_PRIVACY;
    this.env = opts.env ?? process.env;
    this.webhook = opts.webhook;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.catalog = opts.catalog ?? (() => []);
    this.verifyMutationToken = opts.verifyMutationToken;
    this.timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  }

  async runTask(req: SubAgentTaskRequest, signal: AbortSignal): Promise<SubAgentTaskResult> {
    if (signal.aborted) {
      return { success: false, output: '', error: 'Tarefa cancelada pelo usuário.', kind: 'final' };
    }

    if (req.isMutation) {
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

    const guarded = guardText(req.prompt, this.privacy.outboundGuard);
    if (guarded.blocked) {
      return { success: false, output: '', error: OGRA_BLOCKED_TEXT, kind: 'final' };
    }

    const target = this.webhook === undefined ? readOgraWebhookEnv(this.env) : this.webhook;
    if (!target) {
      return { success: false, output: '', error: OGRA_WEBHOOK_MISSING_TEXT, kind: 'final' };
    }

    const sessionId = typeof req.context?.sessionId === 'string' ? req.context.sessionId : '';
    const payload: OgraWebhookPayload = {
      source: 'ork',
      project: 'rodrigo-ai',
      message: guarded.text,
      taskId: req.taskId,
      session: sessionId,
      sessionId,
      capabilities: this.catalog()
    };

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const combined = combineSignals(signal, timeout.signal);
    try {
      const response = await this.fetchImpl(target.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${target.key}`
        },
        body: JSON.stringify(payload),
        signal: combined
      });
      await response.body?.cancel().catch(() => {});
      if (response.status >= 200 && response.status < 300) {
        return { success: true, output: '', kind: 'async_deferred', asyncTaskId: req.taskId };
      }
      return {
        success: false,
        output: '',
        error: `${OGRA_WEBHOOK_FAILED_TEXT} (HTTP ${response.status}).`,
        kind: 'final'
      };
    } catch (err) {
      if (signal.aborted) {
        return { success: false, output: '', error: 'Tarefa cancelada pelo usuário.', kind: 'final' };
      }
      console.error('[ogra] webhook falhou:', err instanceof Error ? err.name : 'erro');
      return { success: false, output: '', error: OGRA_WEBHOOK_FAILED_TEXT, kind: 'final' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Só registra com a flag ligada. Fora isso o coordenador fica como está. */
export function registerOgraAgent(
  coordinator: SubAgentCoordinator,
  privacy: PrivacyConfig,
  opts: OgraSubAgentOptions = {}
): OgraSubAgent | null {
  if (!privacy.ogra) return null;
  const agent = new OgraSubAgent({ ...opts, privacy });
  coordinator.register(agent);
  return agent;
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
