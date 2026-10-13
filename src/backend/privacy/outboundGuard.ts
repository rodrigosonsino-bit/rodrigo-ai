/**
 * T1 (docs/plans/openjarvis-voz-desktop-v2.md §3.1): guarda de saída para a nuvem.
 *
 * Módulo ÚNICO que varre o texto no ponto onde ele é montado para sair (prompt de geração, texto da intenção,
 * texto da voz em nuvem) em busca de segredos e dados pessoais, e aplica o modo escolhido em
 * RODRIGO_OUTBOUND_GUARD (off | warn | redact | block). Padrão: redact (decisão 4 do plano).
 *
 * Primeira rodada de padrões (e-mail e telefone ficam para a segunda, para não dar falso positivo em fala comum):
 * chaves e tokens de API, bloco de chave privada, `Bearer <token>`, senha ditada, CPF, CNPJ e cartão (com Luhn).
 *
 * Limites declarados (a seção 3.1 do plano os repete):
 *  - o guarda varre TEXTO; imagem (canal de visão) não é varrida, só controlada pelo seu interruptor;
 *  - mascarar muda o sentido da frase (aceito e declarado);
 *  - esta é a camada do Node; a camada em profundidade no worker Python ainda não existe.
 * Nunca registra, imprime nem devolve o conteúdo casado em contadores ou logs: só o TIPO e a contagem.
 */

export type OutboundGuardMode = 'off' | 'warn' | 'redact' | 'block';
export const OUTBOUND_GUARD_MODES: readonly OutboundGuardMode[] = ['off', 'warn', 'redact', 'block'];

export type FindingKind =
  | 'api-key'
  | 'private-key'
  | 'bearer-token'
  | 'spoken-password'
  | 'cpf'
  | 'cnpj'
  | 'credit-card';

export interface Finding {
  readonly kind: FindingKind;
  /** Posição no texto original; nunca o conteúdo. */
  readonly start: number;
  readonly end: number;
}

export interface GuardResult {
  readonly text: string;
  readonly findings: readonly Finding[];
  /** true só no modo block, quando há achado: o chamador NÃO deve enviar. */
  readonly blocked: boolean;
}

/** Erro lançado no modo block; a mensagem cita só os TIPOS, nunca o conteúdo. */
export class OutboundBlockedError extends Error {
  constructor(public readonly kinds: readonly FindingKind[]) {
    super(`Envio à nuvem bloqueado pelo guarda de saída (RODRIGO_OUTBOUND_GUARD=block): ${kinds.join(', ')}.`);
    this.name = 'OutboundBlockedError';
  }
}

export function isOutboundGuardMode(value: string): value is OutboundGuardMode {
  return (OUTBOUND_GUARD_MODES as readonly string[]).includes(value);
}

/** Dígitos de uma string, sem separadores. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function cpfValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

export function cnpjValid(digits: string): boolean {
  if (!/^\d{14}$/.test(digits) || /^(\d)\1{13}$/.test(digits)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(digits[12]) && calc(13) === Number(digits[13]);
}

/** Heurística para o valor depois de "senha é": tem dígito, símbolo ou maiúscula depois da primeira letra. */
export function looksLikeCredential(value: string): boolean {
  if (/\d/.test(value)) return true;
  if (/[^\p{L}]/u.test(value)) return true;
  return /\p{Ll}\p{Lu}/u.test(value) || /^\p{Lu}.*\p{Lu}/u.test(value);
}

interface Detector {
  readonly kind: FindingKind;
  readonly regex: RegExp;
  /** Extrai o trecho a mascarar de um casamento (padrão: o casamento inteiro). */
  readonly accept?: (m: RegExpExecArray) => { start: number; end: number } | null;
}

const DETECTORS: readonly Detector[] = [
  // Bloco de chave privada inteiro (cabeçalho até o rodapé, ou só o cabeçalho se truncado).
  {
    kind: 'private-key',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g
  },
  // Chaves e tokens de API conhecidos pelo prefixo.
  {
    kind: 'api-key',
    regex:
      /\b(?:AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g
  },
  // Authorization: Bearer <token> (mascara só o token).
  {
    kind: 'bearer-token',
    regex: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/g,
    accept: (m) => ({ start: m.index + m[0].length - m[1].length, end: m.index + m[0].length })
  },
  // Senha ditada: "minha senha é X", "a senha do wifi é X", "password: X". Mascara só o valor.
  {
    kind: 'spoken-password',
    regex: /\b(?:senha|password|passwd)(?:\s+d[aoe]s?\s+[\p{L}0-9_-]+)?\s*(?:é|eh|e|:|=|is)\s*["']?([^\s"',;]{3,})/giu,
    // Só vale se o valor PARECE credencial (dígito, símbolo ou maiúscula no meio): "a senha é importante" não é senha.
    // Limite declarado: uma senha ditada toda em minúsculas e só com letras ("jacaranda") não é pega.
    accept: (m) =>
      looksLikeCredential(m[1]) ? { start: m.index + m[0].length - m[1].length, end: m.index + m[0].length } : null
  },
  // CNPJ antes de CPF (14 dígitos contêm 11).
  {
    kind: 'cnpj',
    regex: /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g,
    accept: (m) => (cnpjValid(digitsOnly(m[0])) ? { start: m.index, end: m.index + m[0].length } : null)
  },
  {
    kind: 'cpf',
    regex: /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g,
    accept: (m) => (cpfValid(digitsOnly(m[0])) ? { start: m.index, end: m.index + m[0].length } : null)
  },
  // Cartão: 13 a 19 dígitos, com espaços ou hifens, validado por Luhn.
  {
    kind: 'credit-card',
    regex: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    accept: (m) => (luhnValid(digitsOnly(m[0])) ? { start: m.index, end: m.index + m[0].length } : null)
  }
];

/** Varre o texto e devolve os achados (sem sobreposição; vence o detector que veio antes). */
export function scanText(text: string): Finding[] {
  const found: Finding[] = [];
  for (const d of DETECTORS) {
    d.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = d.regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        d.regex.lastIndex++;
        continue;
      }
      const span = d.accept ? d.accept(m) : { start: m.index, end: m.index + m[0].length };
      if (!span) continue;
      const overlaps = found.some((f) => span.start < f.end && span.end > f.start);
      if (!overlaps) found.push({ kind: d.kind, start: span.start, end: span.end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Marcador de máscara: nome do tipo, nunca o conteúdo. */
export function maskFor(kind: FindingKind): string {
  return `[${kind} omitido]`;
}

// Contadores por tipo (nunca o conteúdo), lidos por GET /api/privacy.
const counts = new Map<FindingKind, number>();
export function getOutboundCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}
export function resetOutboundCounts(): void {
  counts.clear();
}
function bump(findings: readonly Finding[]): void {
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
}

/** Aplica o guarda a um texto no modo dado. Nos modos warn/redact/block os achados entram nos contadores. */
export function guardText(text: string, mode: OutboundGuardMode): GuardResult {
  if (mode === 'off' || text.length === 0) return { text, findings: [], blocked: false };
  const findings = scanText(text);
  if (findings.length === 0) return { text, findings, blocked: false };
  bump(findings);
  if (mode === 'warn') return { text, findings, blocked: false };
  if (mode === 'block') return { text, findings, blocked: true };
  // redact: troca de trás para frente para preservar as posições.
  let out = text;
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i];
    out = out.slice(0, f.start) + maskFor(f.kind) + out.slice(f.end);
  }
  return { text: out, findings, blocked: false };
}

/** Mensagem no formato do motor de geração (papel + conteúdo). */
export interface GuardableMessage {
  readonly role: string;
  readonly content: string;
}

/**
 * Aplica o guarda a todas as mensagens de um prompt. No modo block, LANÇA OutboundBlockedError se qualquer
 * mensagem tiver achado (nada é enviado). Nos outros modos devolve cópias, sem alterar as originais.
 */
export function guardMessages<T extends GuardableMessage>(messages: readonly T[], mode: OutboundGuardMode): T[] {
  if (mode === 'off') return messages.slice();
  const out: T[] = [];
  const blockedKinds = new Set<FindingKind>();
  for (const m of messages) {
    const r = guardText(m.content, mode);
    if (r.blocked) for (const f of r.findings) blockedKinds.add(f.kind);
    out.push({ ...m, content: r.text });
  }
  if (blockedKinds.size > 0) throw new OutboundBlockedError([...blockedKinds]);
  return out;
}
