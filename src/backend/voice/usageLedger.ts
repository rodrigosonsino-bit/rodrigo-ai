import fs from 'node:fs';
import path from 'node:path';
import { laDay } from './ttsBudget.js';
import type { UsageModelRow, UsageSourceName, UsageStatus } from '../../shared/types.js';

/**
 * Livro-caixa do gasto próprio com o Gemini (GET /api/usage, seção "Uso hoje").
 * Acumula UMA linha por chamada (geração, intenção, visão, TTS) — SÓ NÚMEROS
 * (modelo, tokens de entrada/saída, caracteres no TTS), nunca texto da conversa.
 * Caminhos locais (visão local, `say`, detectores locais) não geram linha:
 * sem chamada, sem custo.
 *
 * Janela: dia em America/Los_Angeles (mesma suposição NÃO verificada do TtsBudget
 * para a virada da cota). Limites: teto de pedidos/dia por fonte, configurável
 * (RODRIGO_USAGE_RPD, RODRIGO_USAGE_RPD_TTS); o app NÃO conhece a cota restante
 * da chave no Google (sem API para isso) — isto é "o que o app consumiu", não a conta toda.
 */

export type UsageSource = UsageSourceName;

export interface UsageRecord {
  ts: number;
  source: UsageSource;
  model: string;
  /** Pedidos contam mesmo sem usage_metadata (o Google conta o pedido também). */
  req: number;
  in: number | null;
  out: number | null;
  reasoning?: number | null;
  chars?: number | null;
  image?: number | null;
}

export interface UsageSummary extends UsageStatus {}

export interface UsageLedgerOptions {
  filePath: string;
  /** Teto de pedidos/dia para geracao/intencao/visao (padrão: RPD do Nível 1). */
  rpd?: number;
  /** Teto de pedidos/dia para o TTS (padrão: margem do TtsBudget). */
  rpdTts?: number;
  now?: () => number;
}

const SOURCES: readonly UsageSource[] = ['geracao', 'intencao', 'visao', 'tts'];

function isSource(v: unknown): v is UsageSource {
  return typeof v === 'string' && (SOURCES as readonly string[]).includes(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Próxima meia-noite em America/Los_Angeles, em ms desde `nowMs` (sempre > 0). */
export function msUntilLaMidnight(nowMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date(nowMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  // Meia-noite seguinte em LA: soma 1 dia na data local e subtrai o deslocamento.
  const laAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = laAsUtc - nowMs;
  const dayMs = 24 * 60 * 60 * 1000;
  const sinceMidnight = ((nowMs + offsetMs) % dayMs + dayMs) % dayMs;
  return dayMs - sinceMidnight;
}

export function parseUsageCaps(env: NodeJS.ProcessEnv): {
  rpd: number;
  rpdTts: number;
} {
  const parse = (name: 'RODRIGO_USAGE_RPD' | 'RODRIGO_USAGE_RPD_TTS', fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    if (!/^[1-9][0-9]{0,5}$/.test(raw.trim())) {
      throw new Error(`Configuração inválida: ${name} deve ser um inteiro positivo. Valor recebido: "${raw}"`);
    }
    return parseInt(raw.trim(), 10);
  };
  return { rpd: parse('RODRIGO_USAGE_RPD', 100), rpdTts: parse('RODRIGO_USAGE_RPD_TTS', 90) };
}

export class UsageLedger {
  private readonly filePath: string;
  private readonly rpd: number;
  private readonly rpdTts: number;
  private readonly now: () => number;
  private records: UsageRecord[] = [];

  constructor(opts: UsageLedgerOptions) {
    this.filePath = opts.filePath;
    this.rpd = opts.rpd ?? 100;
    this.rpdTts = opts.rpdTts ?? 90;
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return; // ausente: começa vazio
    }
    const today = laDay(this.now());
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = UsageLedger.parseLine(t);
        if (r && laDay(r.ts) === today) this.records.push(r);
      } catch {
        continue; // linha corrompida: ignora (contadores, não auditoria)
      }
    }
  }

  private static parseLine(t: string): UsageRecord | null {
    const v = JSON.parse(t) as Record<string, unknown>;
    if (!isSource(v.source) || typeof v.model !== 'string' || typeof v.ts !== 'number') return null;
    const req = num(v.req);
    if (req === null) return null;
    return {
      ts: v.ts,
      source: v.source,
      model: v.model.slice(0, 120),
      req,
      in: num(v.in),
      out: num(v.out),
      reasoning: num(v.reasoning) ?? undefined,
      chars: num(v.chars) ?? undefined,
      image: num(v.image) ?? undefined
    };
  }

  record(entry: Omit<UsageRecord, 'ts'>): void {
    const r: UsageRecord = { ...entry, ts: this.now() };
    // Rolagem de dia: descarta o dia antigo em memória (o arquivo acumula; a leitura filtra).
    const today = laDay(r.ts);
    if (this.records.length > 0 && laDay(this.records[this.records.length - 1].ts) !== today) {
      this.records = [];
    }
    this.records.push(r);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(r) + '\n', 'utf-8');
    } catch {
      // ledger é observabilidade, não guarda de segurança: falha de I/O não bloqueia a voz
    }
  }

  summary(): UsageSummary {
    const nowMs = this.now();
    const today = laDay(nowMs);
    const dayRecords = this.records.filter((r) => laDay(r.ts) === today);
    const byKey = new Map<string, UsageModelRow>();
    for (const r of dayRecords) {
      const key = `${r.source}\n${r.model}`;
      let row = byKey.get(key);
      if (!row) {
        const cap = r.source === 'tts' ? this.rpdTts : this.rpd;
        row = { source: r.source, model: r.model, req: 0, inTokens: 0, outTokens: 0, cap, pct: 0 };
        byKey.set(key, row);
      }
      row.req += r.req;
      row.inTokens += r.in ?? 0;
      row.outTokens += r.out ?? 0;
    }
    for (const row of byKey.values()) {
      row.pct = row.cap > 0 ? Math.min(1, row.req / row.cap) : 0;
    }
    return {
      day: today,
      resetInMs: msUntilLaMidnight(nowMs),
      models: [...byKey.values()].sort((a, b) => b.req - a.req || a.model.localeCompare(b.model))
    };
  }
}
