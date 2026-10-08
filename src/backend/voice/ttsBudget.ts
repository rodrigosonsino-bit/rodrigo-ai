import fs from 'node:fs';
import path from 'node:path';

/**
 * Fase 13a (docs/phase-13a-v3.md §4.4): orçamento de pedidos ao TTS em nuvem. Cota do Google no Nível 1: 10 pedidos por
 * minuto e 100 por dia, POR MODELO. O app fica com margem (8/min, 90/dia) e, esgotado, a voz do sistema assume NA HORA, sem
 * esperar. Regras:
 *  - todo pedido ENVIADO ao Google desconta (o Google conta, inclusive 429 e cancelados); pedido bloqueado aqui não desconta;
 *  - a reserva é REAL: decrementa na concessão e estorna o que não foi usado (nada de checagem seguida de uso);
 *  - o dia é indexado em America/Los_Angeles (suposição documentada do fuso de virada da cota, NÃO verificada);
 *  - arquivo ausente = dia novo; arquivo corrompido ou erro de I/O = ESGOTADO (falha fechada), com log e contador;
 *  - escrita com lockfile (O_EXCL) + .tmp + rename; duas instâncias do app compartilham a cota do Google e o contador local
 *    é uma estimativa conservadora (maior valor entre memória e disco).
 */
export interface TtsBudgetOptions {
  filePath: string;
  rpm?: number;
  rpd?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface BudgetStatus {
  day: string;
  used: number;
  limit: number;
  minuteUsed: number;
  rpm: number;
  held: number;
  blockedForMs: number;
  exhausted: boolean;
  /** Quantas vezes o arquivo de orçamento estava corrompido/ilegível/impossível de gravar. */
  ioProblems: number;
}

export interface Reservation {
  /** Consome UM pedido da reserva (conta no minuto e no dia). false se a reserva acabou. */
  take(): boolean;
  /** Devolve o que não foi usado. Idempotente. */
  release(): void;
}

const WINDOW_MS = 60_000;

export function laDay(ms: number): string {
  // en-CA formata como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class TtsBudget {
  readonly rpm: number;
  readonly rpd: number;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  private day: string;
  private dayCount = 0;
  private dayExhausted = false;
  private sent: number[] = [];
  private held = 0;
  private blockedUntil = 0;
  private ioProblems = 0;
  private ioBroken = false;
  /** Dia em que o arquivo já foi declarado problemático (evita repetir log e contagem a cada consulta). */
  private problemDay: string | null = null;

  constructor(opts: TtsBudgetOptions) {
    this.filePath = opts.filePath;
    this.rpm = opts.rpm ?? 8;
    this.rpd = opts.rpd ?? 90;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.warn(m));
    this.day = laDay(this.now());
    this.loadDisk();
  }

  // --- persistência -------------------------------------------------------------------------------------------

  private problem(msg: string): void {
    this.problemDay = this.day;
    this.ioProblems += 1;
    this.log(`[tts-budget] ${msg} — orçamento do dia tratado como ESGOTADO (falha fechada) até a virada do dia.`);
    this.dayExhausted = true;
  }

  /** Reconcilia com o disco: ausente => zero; corrompido/ilegível => esgotado; dia diferente => dia novo. */
  private loadDisk(): void {
    const today = laDay(this.now());
    const rolled = today !== this.day;
    if (rolled) {
      this.day = today;
      this.dayCount = 0;
      this.dayExhausted = false;
      this.ioBroken = false;
      this.problemDay = null;
    }
    if (this.problemDay === this.day) return; // já declarado hoje: falha fechada até a virada
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // dia novo / primeira execução
      this.problem(`não consegui ler ${path.basename(this.filePath)} (${(err as NodeJS.ErrnoException).code ?? 'erro'})`);
      return;
    }
    try {
      const data = JSON.parse(raw) as { day?: unknown; count?: unknown };
      if (typeof data.day !== 'string' || typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count < 0) {
        throw new Error('formato inválido');
      }
      if (data.day === today) this.dayCount = Math.max(this.dayCount, data.count);
      // dia diferente no arquivo: é de ontem — o contador de hoje já está em zero
    } catch {
      // Na virada do dia, um arquivo corrompido é de ONTEM (não dá para saber o dia de um arquivo ilegível): recomeça do
      // zero e o próximo pedido o sobrescreve. Fora da virada, é do dia corrente: falha fechada até a virada.
      if (rolled) {
        this.log(`[tts-budget] ${path.basename(this.filePath)} corrompido, mas é de um dia anterior — recomeçando o dia.`);
        this.writeDisk(); // sobrescreve já: senão a próxima leitura (agora "do dia corrente") o trataria como problema de hoje
      } else {
        this.problem(`${path.basename(this.filePath)} corrompido`);
      }
    }
  }

  private writeDisk(): void {
    const lock = `${this.filePath}.lock`;
    const tmp = `${this.filePath}.tmp`;
    let fd: number | null = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      for (let i = 0; i < 20; i += 1) {
        try {
          fd = fs.openSync(lock, 'wx');
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          try {
            if (this.now() - fs.statSync(lock).mtimeMs > 5_000) fs.unlinkSync(lock); // lock órfão
          } catch {
            /* outro processo removeu */
          }
          sleepSync(5);
        }
      }
      if (fd === null) throw new Error('lock ocupado');
      fs.writeFileSync(tmp, JSON.stringify({ day: this.day, count: this.dayCount }));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.ioBroken = true;
      this.problem(`não consegui gravar o orçamento (${(err as Error).message})`);
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
          fs.unlinkSync(lock);
        } catch {
          /* melhor esforço */
        }
      }
    }
  }

  // --- contas -------------------------------------------------------------------------------------------------

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0] <= cutoff) this.sent.shift();
  }

  private usable(): boolean {
    this.loadDisk();
    return !this.dayExhausted && !this.ioBroken && this.now() >= this.blockedUntil;
  }

  private commitOne(): void {
    this.sent.push(this.now());
    this.dayCount += 1;
    this.writeDisk();
  }

  /** Concede N pedidos AGORA (decrementa a capacidade) ou devolve null; o resto do turno vai à voz do sistema. */
  reserve(n: number): Reservation | null {
    if (n <= 0 || !this.usable()) return null;
    this.prune();
    if (this.sent.length + this.held + n > this.rpm) return null;
    if (this.dayCount + this.held + n > this.rpd) return null;
    this.held += n;
    let remaining = n;
    return {
      take: () => {
        if (remaining <= 0) return false;
        remaining -= 1;
        this.held -= 1;
        this.commitOne();
        return true;
      },
      release: () => {
        if (remaining > 0) {
          this.held -= remaining;
          remaining = 0;
        }
      }
    };
  }

  /** Um pedido avulso (turno que passou da reserva, ou frase sem reserva). */
  tryTake(): boolean {
    const r = this.reserve(1);
    return r !== null && r.take();
  }

  /** Bloqueia o Gemini até `untilMs` (429 por minuto/desconhecido, disjuntor). Nunca encurta um bloqueio maior. */
  block(untilMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, untilMs);
  }

  /** 429 de cota DIÁRIA: esgotado até a virada do dia (fuso acima). */
  markDayExhausted(): void {
    this.dayExhausted = true;
  }

  status(): BudgetStatus {
    this.loadDisk();
    this.prune();
    return {
      day: this.day,
      used: this.dayCount,
      limit: this.rpd,
      minuteUsed: this.sent.length,
      rpm: this.rpm,
      held: this.held,
      blockedForMs: Math.max(0, this.blockedUntil - this.now()),
      exhausted: this.dayExhausted || this.ioBroken || this.dayCount >= this.rpd,
      ioProblems: this.ioProblems
    };
  }
}
