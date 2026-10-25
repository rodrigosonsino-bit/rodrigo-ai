import type { IVoiceProvider, SynthesizeOptions } from '../../shared/extensions/voice.js';
import { type PrivacyConfig, ttsCloudEffective, ttsDictatedViaCloud } from '../privacy.js';
import { guardText } from '../privacy/outboundGuard.js';
import type { SynthesizeResult, VoiceEngine } from './engine.js';
import type { BudgetStatus, Reservation, TtsBudget } from './ttsBudget.js';

/**
 * Fase 13a (docs/phase-13a-v3.md §3, §4): voz natural pelo TTS do Gemini, com a voz do sistema (`say`) como reserva.
 *
 *  - Só o TEXTO da frase vai ao Google; o áudio do usuário nunca. Frases que repetem conteúdo ditado só vão se a decisão D-b
 *    permitir (ttsDictatedViaCloud).
 *  - Reserva REAL por turno (2 pedidos); sem saldo, o TURNO INTEIRO fica no `say` (não troca de voz no meio). Se o saldo
 *    acabar depois do início, o resto do turno cai no `say` (o disjuntor reduz, não elimina, a troca dentro de turnos longos).
 *  - Falha de qualquer tipo no Gemini => essa frase sai no `say`, o resto do turno também. Erros 400/401/403 (configuração)
 *    NÃO se repetem por 5 minutos; duas falhas seguidas de serviço (5xx/timeout/transporte) esfriam o Gemini por 60 s.
 *  - Cancelamento (barge-in/preempção) aborta o pedido ao worker e NÃO cai no `say` (a frase não será mais usada).
 */
export interface GeminiVoiceConfig {
  model: string;
  voice: string;
  /** Prazo local da 1ª frase do turno (o usuário espera em silêncio). */
  firstDeadlineMs: number;
  /** Prazo local das demais (o áudio anterior já está tocando). */
  deadlineMs: number;
  /** Quantas sínteses simultâneas no máximo. */
  concurrency: number;
  /** Pedidos reservados por turno. */
  reservePerTurn: number;
}

export const DEFAULT_GEMINI_VOICE_CONFIG = (model: string, voice: string): GeminiVoiceConfig => ({
  model,
  voice,
  firstDeadlineMs: 8_000,
  deadlineMs: 12_000,
  concurrency: 2,
  reservePerTurn: 2
});

interface TurnState {
  reservation: Reservation | null;
  /** 'say' => o resto do turno inteiro fala com a voz do sistema. */
  mode: 'gemini' | 'say';
  reason?: string;
  /** T9-política (a): o aviso de troca de voz já foi disparado para este turno. */
  notified?: boolean;
}

const UNKNOWN_BACKOFF_BASE_MS = 30_000;
const UNKNOWN_BACKOFF_CAP_MS = 15 * 60_000;
const CLIENT_ERROR_BLOCK_MS = 5 * 60_000;
const SERVICE_FAILURE_COOLDOWN_MS = 60_000;

export class GeminiVoiceProvider implements IVoiceProvider {
  readonly id = 'gemini';
  readonly name: string;
  readonly prefersCoalescing = true;

  private readonly turns = new Map<string, TurnState>();
  private active = 0;
  private waiters: Array<() => void> = [];
  private unknownRateLimits = 0;
  private serviceFailures = 0;
  /** Contadores para o teste e o cartão de estado (nunca texto de frase). */
  readonly counters = { gemini: 0, fallback: 0, failures: 0, tokensOut: 0 };
  /** T9-política (a): ver IVoiceProvider.onFallback. */
  onFallback?: (info: { turnId?: string; reason: string }) => void;

  constructor(
    private readonly engine: VoiceEngine,
    private readonly fallback: IVoiceProvider,
    private readonly budget: TtsBudget,
    private readonly privacy: PrivacyConfig,
    private readonly config: GeminiVoiceConfig,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (msg: string) => void = (m) => console.warn(m)
  ) {
    this.name = `Gemini TTS (${config.model}, voz ${config.voice}), reserva: ${fallback.name}`;
  }

  isAvailable(): boolean {
    return typeof this.engine.synthesize === 'function' && this.fallback.isAvailable();
  }

  budgetStatus(): BudgetStatus {
    return this.budget.status();
  }

  endTurn(turnId: string): void {
    const st = this.turns.get(turnId);
    if (st?.reservation) st.reservation.release();
    this.turns.delete(turnId);
  }

  private turnState(turnId: string): TurnState {
    let st = this.turns.get(turnId);
    if (st) return st;
    // Primeira frase do turno: decide o modo do turno inteiro.
    if (!ttsCloudEffective(this.privacy)) {
      st = { reservation: null, mode: 'say', reason: 'privacy' };
    } else {
      const reservation = this.budget.reserve(this.config.reservePerTurn);
      st = reservation
        ? { reservation, mode: 'gemini' }
        : { reservation: null, mode: 'say', reason: 'budget' };
    }
    this.turns.set(turnId, st);
    // Turnos antigos nunca terminados (processo interrompido): não deixa crescer sem limite.
    if (this.turns.size > 16) {
      const oldest = this.turns.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== turnId) this.endTurn(oldest);
    }
    return st;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.config.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== grant);
        reject(new DOMException('aborted', 'AbortError'));
      };
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  async synthesize(text: string, outputPath: string, signal?: AbortSignal, options: SynthesizeOptions = {}): Promise<void> {
    const kind = options.kind ?? 'local';
    const turnId = options.turnId ?? `adhoc-${outputPath}`;

    // Fase 17: resposta do Claude Code (dado não confiável, pode conter código do projeto) nunca vira voz em nuvem.
    if (kind === 'untrusted') return this.useFallback(text, outputPath, signal, options);

    // D-b: conteúdo ditado só vai à nuvem se a configuração permitir; o resto da resposta segue no Gemini.
    if (kind === 'dictated' && !ttsDictatedViaCloud(this.privacy)) return this.useFallback(text, outputPath, signal, options);

    // T1: o texto de cada frase falada vai à nuvem para virar voz; ele passa pelo guarda de saída. No modo block, com achado, a
    // frase INTEIRA fica local (voz do sistema). Em redact o que vai à nuvem é o texto mascarado; o texto original só vai ao `say`.
    const guarded = guardText(text, this.privacy.outboundGuard);
    if (guarded.blocked) return this.useFallback(text, outputPath, signal, options);
    const cloudText = guarded.text;

    const st = this.turnState(turnId);
    // T9-política (a): a reserva de cota falhou ao abrir o turno => voz do sistema por indisponibilidade (avisa uma vez por turno).
    if (st.mode === 'say' && st.reason === 'budget' && !st.notified) {
      st.notified = true;
      this.onFallback?.({ turnId: options.turnId, reason: 'budget' });
    }
    if (st.mode === 'say' || !this.engine.synthesize) return this.useFallback(text, outputPath, signal, options);

    // Só desconta DEPOIS de obter a vaga (auditoria F13a, achado 2): um pedido abortado enquanto espera na fila nunca é
    // enviado ao Google e não pode consumir cota. Cada pedido ENVIADO desconta; sem reserva restante, tenta um pedido
    // avulso; sem saldo, o resto do turno vai ao `say`.
    await this.acquire(signal);
    if (!(st.reservation?.take() ?? false) && !this.budget.tryTake()) {
      this.release();
      st.mode = 'say';
      st.reason = 'budget';
      st.notified = true;
      this.onFallback?.({ turnId: options.turnId, reason: 'budget' });
      return this.useFallback(text, outputPath, signal, options);
    }
    let result: SynthesizeResult;
    try {
      result = await this.engine.synthesize(
        {
          turnId,
          text: cloudText,
          outPath: outputPath,
          model: this.config.model,
          voice: this.config.voice,
          deadlineMs: options.isFirstOfTurn ? this.config.firstDeadlineMs : this.config.deadlineMs
        },
        signal
      );
    } finally {
      this.release();
    }

    if (result.ok) {
      this.counters.gemini += 1;
      this.counters.tokensOut += result.tokensOut ?? 0;
      this.serviceFailures = 0;
      this.unknownRateLimits = 0;
      return;
    }
    if (result.kind === 'cancelled' || signal?.aborted) throw new DOMException('aborted', 'AbortError');

    this.counters.failures += 1;
    st.mode = 'say';
    st.reason = result.kind;
    this.afterFailure(result);
    st.notified = true;
    this.onFallback?.({ turnId: options.turnId, reason: result.kind });
    return this.useFallback(text, outputPath, signal, options);
  }

  private afterFailure(result: Extract<SynthesizeResult, { ok: false }>): void {
    const now = this.now();
    // O corpo bruto nunca entra no log: só campos estruturados.
    this.log(
      `[tts] Gemini falhou (${result.kind}${result.status ? ` ${result.status}` : ''}${result.scope ? ` ${result.scope}` : ''}${
        result.quotaId ? ` ${result.quotaId}` : ''
      }${result.local ? ' prazo local' : ''}) — a frase sai com a voz do sistema.`
    );
    switch (result.kind) {
      case 'rate_limited': {
        if (result.scope === 'day') {
          this.budget.markDayExhausted();
        } else if (result.scope === 'minute') {
          this.budget.block(now + Math.max((result.retryAfterMs ?? 0) + 1_000, 10_000));
        } else {
          // quotaId desconhecido/ausente: backoff exponencial 30 s, 60 s, 120 s..., teto 15 min; vale o maior com retryDelay.
          this.unknownRateLimits += 1;
          const backoff = Math.min(UNKNOWN_BACKOFF_CAP_MS, UNKNOWN_BACKOFF_BASE_MS * 2 ** (this.unknownRateLimits - 1));
          this.budget.block(now + Math.max(backoff, result.retryAfterMs ?? 0));
        }
        break;
      }
      case 'client_error':
        this.budget.block(now + CLIENT_ERROR_BLOCK_MS); // configuração (chave/permissão/pedido): repetir não ajuda
        break;
      case 'disabled':
        break;
      default:
        this.serviceFailures += 1;
        if (this.serviceFailures >= 2) {
          this.budget.block(now + SERVICE_FAILURE_COOLDOWN_MS);
          this.serviceFailures = 0;
        }
    }
  }

  private async useFallback(text: string, outputPath: string, signal?: AbortSignal, options?: SynthesizeOptions): Promise<void> {
    this.counters.fallback += 1;
    await this.fallback.synthesize(text, outputPath, signal, options);
  }
}
