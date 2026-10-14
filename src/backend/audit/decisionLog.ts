import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guardText } from '../privacy/outboundGuard.js';

/**
 * T4 (docs/plans/openjarvis-voz-desktop-v2.md §3.4): registro de decisões SEM CONTEÚDO, com cadeia de hashes.
 *
 * - LISTA FECHADA de campos (allow-list): uma propriedade extra é REJEITADA, nunca gravada. Nada de fala, resposta, texto de
 *   nota/memória, argumentos de ferramenta nem mensagem de erro em texto livre.
 * - Todo campo de texto passa pelo guarda da T1 em modo `block`: se algo sensível aparece, o campo é DESCARTADO e contado.
 * - Cadeia de hashes: cada linha guarda o hash da anterior; adulteração ou remoção no meio é detectada por `verify()`.
 * - Protocolo em duas fases (`withAudit`): a INTENÇÃO é gravada antes da mutação (se falhar, a mutação é recusada); a
 *   CONCLUSÃO depois (se falhar, a mutação já ocorreu e não é desfeita: devolve `conclusionLost`).
 *
 * LIMITE DE PROJETO (achado da auditoria do Codex, aceito e declarado): a cadeia é EVIDÊNCIA de adulteração contra erro e
 * edição ingênua, NÃO prova contra quem tem escrita na pasta de dados: essa pessoa pode recalcular todos os hashes ou cortar o
 * fim do arquivo e `verify()` aceita. Fechar isso exige uma âncora externa (hash final e contagem em armazenamento
 * independente) ou chave fora do arquivo; não há esse armazenamento neste app, então não é prometido.
 *
 * Limites declarados (honestidade do plano): é um registro de auditoria com compensação tardia, NÃO uma transação atômica.
 * Não cobre queda do processo entre a gravação da intenção e a mutação. Sem o marcador `applied` nos stores (mudança de
 * esquema que aguarda a aprovação do Rodrigo), a recuperação NÃO distingue "mutação aplicada, conclusão perdida" de "não
 * aplicada": uma intenção sem conclusão é reportada como INDETERMINADA.
 */
export type DataClass = 'ordinary' | 'sensitive' | 'unknown';
export type Outcome = 'ok' | 'failed' | 'refused' | 'cancelled';

export interface AuditIntent {
  kind: 'intent';
  mid: string;
  turnId: string;
  action: string;
  tool: string;
  executor: string;
  dataClass: DataClass;
}
export interface AuditCompletion {
  kind: 'completion';
  mid: string;
  turnId: string;
  outcome: Outcome;
  ms: number;
}
export type AuditDto = AuditIntent | AuditCompletion;

const INTENT_KEYS = ['kind', 'mid', 'turnId', 'action', 'tool', 'executor', 'dataClass'] as const;
const COMPLETION_KEYS = ['kind', 'mid', 'turnId', 'outcome', 'ms'] as const;
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const DATA_CLASSES: readonly string[] = ['ordinary', 'sensitive', 'unknown'];
const OUTCOMES: readonly string[] = ['ok', 'failed', 'refused', 'cancelled'];
const GENESIS = '0'.repeat(64);

export class AuditSchemaError extends Error {}

/** Corta um nome no primeiro caractere fora do alfabeto de identificador: `Tool("compre pão")` vira `Tool` (sem argumentos). */
export function normalizeName(raw: string): string {
  const m = /^[A-Za-z0-9_.:-]+/.exec(raw.trim());
  return m ? m[0].slice(0, 64) : 'desconhecido';
}

export interface Sanitized {
  dto: AuditDto;
  dropped: number;
}

/** Valida contra a lista fechada: propriedade extra, tipo errado ou valor fora do enumerado => AuditSchemaError. */
export function sanitize(input: unknown): Sanitized {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new AuditSchemaError('registro inválido');
  const obj = input as Record<string, unknown>;
  const kind = obj.kind;
  const allowed: readonly string[] = kind === 'intent' ? INTENT_KEYS : kind === 'completion' ? COMPLETION_KEYS : [];
  if (allowed.length === 0) throw new AuditSchemaError('kind desconhecido');
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new AuditSchemaError(`propriedade não permitida: ${k}`);
  for (const k of allowed) if (!(k in obj)) throw new AuditSchemaError(`propriedade ausente: ${k}`);

  let dropped = 0;
  const text = (k: string): string => {
    const v = obj[k];
    if (typeof v !== 'string' || !TOKEN.test(v)) throw new AuditSchemaError(`valor inválido em ${k}`);
    // Guarda residual da T1 em `block`: um marcador sensível dentro do campo faz o campo ser DESCARTADO (e contado).
    if (guardText(v, 'block').blocked) {
      dropped += 1;
      return '[descartado]';
    }
    return v;
  };
  if (kind === 'intent') {
    const dataClass = obj.dataClass;
    if (typeof dataClass !== 'string' || !DATA_CLASSES.includes(dataClass)) throw new AuditSchemaError('dataClass inválida');
    return { dto: { kind: 'intent', mid: text('mid'), turnId: text('turnId'), action: text('action'), tool: text('tool'), executor: text('executor'), dataClass: dataClass as DataClass }, dropped };
  }
  const outcome = obj.outcome;
  const ms = obj.ms;
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) throw new AuditSchemaError('outcome inválido');
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new AuditSchemaError('ms inválido');
  return { dto: { kind: 'completion', mid: text('mid'), turnId: text('turnId'), outcome: outcome as Outcome, ms: Math.round(ms) }, dropped };
}

export interface AuditRecord {
  seq: number;
  ts: string;
  prev: string;
  hash: string;
  [k: string]: unknown;
}

function canonical(o: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])));
}
function hashOf(prev: string, body: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(prev).update('\n').update(canonical(body)).digest('hex');
}

/** Operações de arquivo injetáveis: os testes injetam a falha de escrita sem encher o disco. */
export interface AuditFs {
  mkdir(dir: string): void;
  append(file: string, line: string): void;
  read(file: string): string | null;
  rename(from: string, to: string): void;
}
export const realAuditFs: AuditFs = {
  mkdir: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  rename: (from, to) => fs.renameSync(from, to),
  append: (file, line) => fs.appendFileSync(file, line, { mode: 0o600 }),
  read: (file) => {
    try { return fs.readFileSync(file, 'utf-8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
};

/** Registro INDISPONÍVEL (disco/permissão): toda gravação lança, então as mutações são recusadas — falha fechada. */
export function unavailableAuditFs(): AuditFs {
  return { mkdir: () => undefined, read: () => null, rename: () => undefined, append: () => { throw new Error('registro de auditoria indisponível'); } };
}

/** Registro em MEMÓRIA (padrão dos testes e de qualquer SessionManager sem arquivo): toda mutação continua auditada. */
export function memoryAuditFs(): AuditFs {
  let text = '';
  return {
    mkdir: () => undefined,
    read: () => (text === '' ? null : text),
    rename: () => { text = ''; },
    append: (_f, line) => { text += line; }
  };
}

export type VerifyResult = { ok: true; count: number } | { ok: false; line: number; reason: string };

export class DecisionLog {
  private seq = 0;
  private prev = GENESIS;
  droppedFields = 0;

  constructor(
    readonly filePath: string,
    private readonly io: AuditFs = realAuditFs,
    private readonly now: () => Date = () => new Date()
  ) {
    this.io.mkdir(path.dirname(filePath));
    const text = this.io.read(filePath);
    if (text) {
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const r = JSON.parse(lines[i]) as AuditRecord;
          if (typeof r.seq === 'number' && typeof r.hash === 'string') { this.seq = r.seq; this.prev = r.hash; break; }
        } catch { /* linha corrompida: continua a partir da última válida; verify() acusa */ }
      }
    }
  }

  static inMemory(): DecisionLog {
    return new DecisionLog('memoria://decisions.jsonl', memoryAuditFs());
  }

  /**
   * Se a cadeia NÃO verifica (adulteração, ou linha cortada por uma queda no meio da gravação), move o arquivo para
   * `<arquivo>.quarentena-<ms>` (a evidência fica) e começa uma cadeia NOVA: nada novo é anexado a uma cadeia inválida e o
   * app não fica sem poder mutar por causa de uma linha cortada. Devolve o novo nome do arquivo, ou null se estava íntegro.
   */
  quarantineIfBroken(): string | null {
    if (this.verify().ok) return null;
    const dest = `${this.filePath}.quarentena-${this.now().getTime()}`;
    this.io.rename(this.filePath, dest);
    this.seq = 0;
    this.prev = GENESIS;
    return dest;
  }

  /** Grava um registro. LANÇA se a validação ou a escrita falhar (quem chama decide: na fase 1 a mutação é recusada). */
  append(input: unknown): AuditRecord {
    const { dto, dropped } = sanitize(input);
    const body: Record<string, unknown> = { seq: this.seq + 1, ts: this.now().toISOString(), prev: this.prev, ...dto };
    const hash = hashOf(this.prev, body);
    const record = { ...body, hash } as AuditRecord;
    this.io.append(this.filePath, JSON.stringify(record) + '\n'); // se lançar, o estado da cadeia NÃO avança
    this.seq = record.seq;
    this.prev = hash;
    this.droppedFields += dropped;
    return record;
  }

  verify(): VerifyResult {
    const text = this.io.read(this.filePath);
    if (!text) return { ok: true, count: 0 };
    let prev = GENESIS;
    let n = 0;
    for (const [i, line] of text.split('\n').filter(Boolean).entries()) {
      let r: AuditRecord;
      try { r = JSON.parse(line) as AuditRecord; } catch { return { ok: false, line: i + 1, reason: 'linha ilegível' }; }
      const { hash, ...body } = r;
      if (r.prev !== prev) return { ok: false, line: i + 1, reason: 'encadeamento quebrado (registro removido ou reordenado)' };
      if (r.seq !== n + 1) return { ok: false, line: i + 1, reason: 'sequência quebrada' };
      if (hashOf(prev, body) !== hash) return { ok: false, line: i + 1, reason: 'hash não confere (registro adulterado)' };
      prev = hash; n += 1;
    }
    return { ok: true, count: n };
  }

  /** Intenções sem conclusão: INDETERMINADAS (a mutação pode ou não ter sido aplicada; ver o limite declarado acima). */
  pending(): string[] {
    const text = this.io.read(this.filePath);
    if (!text) return [];
    const open = new Set<string>();
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line) as AuditRecord;
        if (r.kind === 'intent' && typeof r.mid === 'string') open.add(r.mid);
        if (r.kind === 'completion' && typeof r.mid === 'string') open.delete(r.mid);
      } catch { /* ignora */ }
    }
    return [...open];
  }
}

export type AuditedRun<T> = { refused: true } | { refused: false; result: T; conclusionLost: boolean };

/**
 * Protocolo em duas fases. Fase 1: grava a INTENÇÃO; se falhar, a mutação é RECUSADA (`run` nem é chamado). Fase 2: grava a
 * CONCLUSÃO; se falhar, a mutação JÁ ocorreu e não é desfeita (`conclusionLost: true` para o chamador avisar por voz).
 */
export async function withAudit<T>(
  log: DecisionLog,
  intent: Omit<AuditIntent, 'kind'>,
  run: () => Promise<T>,
  outcomeOf: (r: T) => Outcome,
  clock: () => number = Date.now
): Promise<AuditedRun<T>> {
  try {
    log.append({ kind: 'intent', ...intent });
  } catch (err) {
    console.error('[audit] fase 1 falhou; a mutação NÃO será executada:', err instanceof Error ? err.name : 'erro');
    return { refused: true };
  }
  const started = clock();
  let result: T;
  try {
    result = await run();
  } catch (err) {
    try { log.append({ kind: 'completion', mid: intent.mid, turnId: intent.turnId, outcome: 'failed', ms: clock() - started }); } catch { /* conclusão perdida; o erro original segue */ }
    throw err;
  }
  try {
    log.append({ kind: 'completion', mid: intent.mid, turnId: intent.turnId, outcome: outcomeOf(result), ms: clock() - started });
    return { refused: false, result, conclusionLost: false };
  } catch (err) {
    console.error('[audit] fase 2 falhou; a mutação já ocorreu e não é desfeita:', err instanceof Error ? err.name : 'erro');
    return { refused: false, result, conclusionLost: true };
  }
}
