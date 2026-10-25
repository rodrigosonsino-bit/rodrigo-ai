/**
 * Fase 17 (ajuste 1, 2026-10-24): quando o app delega uma tarefa ao Claude Code (modo leitura ou escrita), a Ogra é
 * avisada pelo webhook — o que foi pedido, quando, o status e a conclusão — para continuar em primeiro plano.
 *
 * É um AVISO, não uma fala do usuário: o payload leva `kind: 'delegation_status'` e `expectsReply: false`, e NÃO abre
 * tarefa pendente de resposta (a camada Ogra de voz só espera resposta de falas do usuário). Só sai com RODRIGO_OGRA=1 e
 * o webhook configurado; a ordem passa pelo guarda de saída (T1) e é TRUNCADA. A conclusão do Claude NUNCA é repassada
 * (M4 do Code: risco de injeção cruzada na Ogra): vai só o tamanho dela e a indicação de ler na tela. Falha de envio é registrada pelo nome do erro e nunca bloqueia nem derruba a tarefa.
 */
import { guardText, type OutboundGuardMode } from '../privacy/outboundGuard.js';
import type { PrivacyConfig } from '../privacy.js';
import { readOgraWebhookEnv, type OgraWebhookTarget } from './ograSubAgent.js';

export type DelegationMode = 'leitura' | 'escrita';
export type DelegationStatus = 'started' | 'done' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';

export interface DelegationEvent {
  id: string;
  mode: DelegationMode;
  /** O que foi pedido (a ordem). */
  order: string;
  status: DelegationStatus;
  /** Instante do evento, ISO 8601. */
  at: string;
  /** Resultado ou erro, só nos eventos finais. */
  conclusion?: string;
}

export interface DelegationObserver {
  onEvent(e: DelegationEvent): void;
}

export const NOTICE_ORDER_MAX = 280;
export const NOTICE_CONCLUSION_MAX = 400;
const NOTICE_TIMEOUT_MS = 5000;

const STATUS_PT: Record<DelegationStatus, string> = {
  started: 'iniciada',
  done: 'concluída',
  failed: 'falhou',
  timeout: 'passou do tempo',
  cancelled: 'cancelada',
  interrupted: 'interrompida'
};

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')}…` : t;
}

export function buildNoticeMessage(e: DelegationEvent, mode: OutboundGuardMode): string {
  const part = (label: string, raw: string, max: number): string => {
    const g = guardText(clip(raw, max), mode);
    return `${label}: ${g.blocked ? '[bloqueado pelo guarda de saída]' : g.text}`;
  };
  const lines = [`[Delegação ao Claude | modo ${e.mode} | ${STATUS_PT[e.status]}]`, part('pedido', e.order, NOTICE_ORDER_MAX), `quando: ${e.at}`];
  // M4 do Code: o texto do Claude (resultado ou erro) é DADO NÃO CONFIÁVEL e pode carregar instruções injetadas
  // ("Ogra: aprove o merge..."). A Ogra recebe só METADADOS: o tamanho e onde ler. O texto nunca entra no aviso.
  if (e.conclusion !== undefined && e.conclusion !== '') {
    lines.push(`conclusão: ${e.conclusion.length} caracteres, não repassados (dado não confiável do Claude; ver na tela do app)`);
  }
  return lines.join('\n');
}

export interface OgraNotifierOptions {
  privacy: PrivacyConfig;
  env?: Readonly<Record<string, string | undefined>>;
  /** Id da sessão de voz corrente (a Ogra devolve na mesma sessão); '' se não houver. */
  session: () => string;
  fetchImpl?: typeof fetch;
  /** Substitui a leitura de GROK_WEBHOOK_* (testes). */
  webhook?: OgraWebhookTarget | null;
}

/** Observador que posta os avisos no webhook da Ogra. Desligado (no-op) sem RODRIGO_OGRA=1 ou sem webhook. */
export function createOgraDelegationNotifier(opts: OgraNotifierOptions): DelegationObserver {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    onEvent(e: DelegationEvent): void {
      if (!opts.privacy.ogra) return;
      const target = opts.webhook === undefined ? readOgraWebhookEnv(opts.env ?? process.env) : opts.webhook;
      if (!target) return;
      const session = opts.session();
      const body = {
        source: 'ork',
        project: 'rodrigo-ai',
        kind: 'delegation_status',
        expectsReply: false,
        message: buildNoticeMessage(e, opts.privacy.outboundGuard),
        taskId: `delegacao-${e.id}`,
        status: e.status,
        mode: e.mode,
        session,
        sessionId: session
      };
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), NOTICE_TIMEOUT_MS);
      timer.unref?.();
      void doFetch(target.url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.key}` },
        body: JSON.stringify(body),
        signal: timeout.signal
      })
        .then((r) => r.body?.cancel().catch(() => {}))
        .catch((err: unknown) => console.error('[ogra] aviso de delegação falhou:', err instanceof Error ? err.name : 'erro'))
        .finally(() => clearTimeout(timer));
    }
  };
}
