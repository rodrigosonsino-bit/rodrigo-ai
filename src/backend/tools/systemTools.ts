import type { ITool } from '../../shared/extensions/tools.js';

export type Clock = () => Date;
const systemClock: Clock = () => new Date();

export class HoraAtualTool implements ITool {
  readonly name = 'HORA';
  readonly description = 'Hora atual do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean {
    return true;
  }

  execute(): string {
    const hhmm = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(this.clock());
    const [hStr, mStr] = hhmm.split(':');
    const h = Number(hStr);
    const m = Number(mStr);

    const verbo = h === 1 ? 'É' : 'São';
    const horaWord = h === 1 ? 'hora' : 'horas';
    const base = `${verbo} ${h} ${horaWord}`;

    if (m === 0) return `${base} em ponto.`;
    const minutoWord = m === 1 ? 'minuto' : 'minutos';
    return `${base} e ${m} ${minutoWord}.`;
  }
}

export class DataAtualTool implements ITool {
  readonly name = 'DATA';
  readonly description = 'Data atual e dia da semana, do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean {
    return true;
  }

  execute(): string {
    const data = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(this.clock());
    return `Hoje é ${data}.`;
  }
}

export function createSystemTools(clock: Clock = systemClock): ITool[] {
  return [new HoraAtualTool(clock), new DataAtualTool(clock)];
}

export function selectToolByName(name: string, tools: readonly ITool[]): ITool | null {
  if (name === 'NENHUMA') return null;
  return tools.find((t) => t.name === name && t.isAvailable()) ?? null;
}

/** Filtro permissivo (§4.1) — ver ali para a lista completa, com "seculo" adicionado. */
const TIME_GATE =
  /\b(hora|horas|horario|hrs|dia|dias|data|hoje|agora|semana|mes|meses|ano|anos|manha|tarde|noite|amanha|ontem|minuto|minutos|relogio|calendario|quando|seculo|seculos)\b/;

export function mightBeTemporal(transcript: string): boolean {
  const n = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return TIME_GATE.test(n);
}

export const TOOL_FAILURE_TEXT = 'Não consegui consultar o relógio do sistema agora.';
