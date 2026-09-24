/** Teto de sanidade para minutos/horas por extenso ou dígito — ver achado 4 (Hermes, 2026-09-24). */
const MAX_REASONABLE_UNITS = 100_000;

export interface ParsedRelativeTime {
  dueAt: string | null;      // ISO 8601, sempre no futuro relativo ao momento da chamada
  residualText: string;      // Conteúdo do lembrete sem a expressão de tempo e sem pontuações residuais
}

/** Mapa de números cardinais por extenso comuns no Whisper STT (PT-BR). */
export const CARDINAL_WORDS: Record<string, number> = {
  zero: 0,
  um: 1, uma: 1,
  dois: 2, duas: 2,
  tres: 3, três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14, catorze: 14,
  quinze: 15,
  dezesseis: 16, dezeseis: 16,
  dezessete: 17, dezesete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50
};

/**
 * Converte dígitos ("20") ou cardinais por extenso (1 a 59, "vinte e cinco", "uma", "duas") em número.
 */
export function parseNumberOrWord(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    const val = parseInt(trimmed, 10);
    return Number.isFinite(val) ? val : null;
  }
  const parts = trimmed.split(/\s+e\s+/);
  if (parts.length === 2) {
    const tens = CARDINAL_WORDS[parts[0]];
    const units = CARDINAL_WORDS[parts[1]];
    if (tens !== undefined && units !== undefined) {
      return tens + units;
    }
  }
  return CARDINAL_WORDS[trimmed] ?? null;
}

/**
 * Limpa preposições e pontuações residuais nas bordas do texto residual.
 */
function cleanResidualText(text: string): string {
  let cleaned = text.trim();
  // Remove pontuação final
  cleaned = cleaned.replace(/[\s,;:\.\-]+$/, '').trim();
  // Remove preposições finais soltas ("para", "pra", "pro", "de", "em", "a")
  cleaned = cleaned.replace(/\b(?:para|pra|pro|de|em|a)\b$/i, '').trim();
  // Remove pontuação final novamente se sobrou (ex.: vírgula antes da preposição)
  cleaned = cleaned.replace(/[\s,;:\.\-]+$/, '').trim();

  // Remove pontuação inicial
  cleaned = cleaned.replace(/^[\s,;:\.\-]+/, '').trim();
  // Remove preposições iniciais soltas ("para", "pra", "pro", "de", "em", "a")
  cleaned = cleaned.replace(/^(?:para|pra|pro|de|em|a)\b/i, '').trim();
  // Remove pontuação inicial novamente se sobrou
  cleaned = cleaned.replace(/^[\s,;:\.\-]+/, '').trim();

  // Normaliza espaços múltiplos
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Padrões de tempo relativo em ordem rigorosa de precedência (§4.1):
 * 1. "Meia hora"
 * 2. Minutos (dígitos ou por extenso)
 * 3. Horas (dígitos ou por extenso)
 * 4. "Amanhã de tarde" / "amanhã à tarde" (14:00)
 * 5. "Amanhã de noite" / "amanhã à noite" (19:00)
 * 6. "Amanhã de manhã" / "amanhã pela manhã" (09:00)
 * 7. "Amanhã" (isolado, 09:00)
 */
export function parseRelativeTime(text: string, now: Date = new Date()): ParsedRelativeTime {
  if (!text || !text.trim()) {
    return { dueAt: null, residualText: text };
  }

  // 1. "Meia hora": /(?:daqui\s+a|em)\s+meia\s+hora/i -> now + 30 min
  const meiaHoraRegex = /(?:daqui\s+a|em)\s+meia\s+hora/i;
  const meiaHoraMatch = text.match(meiaHoraRegex);
  if (meiaHoraMatch && meiaHoraMatch.index !== undefined) {
    const dueAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const residual = cleanResidualText(
      text.slice(0, meiaHoraMatch.index) + ' ' + text.slice(meiaHoraMatch.index + meiaHoraMatch[0].length)
    );
    return { dueAt, residualText: residual };
  }

  // 2. Minutos: /(?:daqui\s+a|em)\s+([a-zçãéíóú\d\s]+?)\s+minutos?/i
  const minutosRegex = /(?:daqui\s+a|em)\s+([a-zçãéíóú\d\s]+?)\s+minutos?/i;
  const minutosMatch = text.match(minutosRegex);
  if (minutosMatch && minutosMatch.index !== undefined) {
    const val = parseNumberOrWord(minutosMatch[1]);
    // Achado 4 (auditoria de código, Hermes, 2026-09-24): teto de sanidade — sem ele, um
    // dígito absurdamente grande (só alcançável via chamada direta da função, não por voz
    // real) produz Date inválida e new Date(...).toISOString() lança RangeError não tratado.
    if (val !== null && val > 0 && val < MAX_REASONABLE_UNITS) {
      const dueAt = new Date(now.getTime() + val * 60_000).toISOString();
      const residual = cleanResidualText(
        text.slice(0, minutosMatch.index) + ' ' + text.slice(minutosMatch.index + minutosMatch[0].length)
      );
      return { dueAt, residualText: residual };
    }
  }

  // 3. Horas: /(?:daqui\s+a|em)\s+([a-zçãéíóú\d\s]+?)\s+horas?/i
  const horasRegex = /(?:daqui\s+a|em)\s+([a-zçãéíóú\d\s]+?)\s+horas?/i;
  const horasMatch = text.match(horasRegex);
  if (horasMatch && horasMatch.index !== undefined) {
    const val = parseNumberOrWord(horasMatch[1]);
    if (val !== null && val > 0 && val < MAX_REASONABLE_UNITS) {
      const dueAt = new Date(now.getTime() + val * 3600_000).toISOString();
      const residual = cleanResidualText(
        text.slice(0, horasMatch.index) + ' ' + text.slice(horasMatch.index + horasMatch[0].length)
      );
      return { dueAt, residualText: residual };
    }
  }

  // 4. "Amanhã de tarde" / "amanhã à tarde": /amanh[ãa]\s+(?:(?:a|à|de)\s+)?tarde/i -> 14:00
  const amanhaTardeRegex = /amanh[ãa]\s+(?:(?:a|à|de)\s+)?tarde/i;
  const amanhaTardeMatch = text.match(amanhaTardeRegex);
  if (amanhaTardeMatch && amanhaTardeMatch.index !== undefined) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(14, 0, 0, 0);
    const residual = cleanResidualText(
      text.slice(0, amanhaTardeMatch.index) + ' ' + text.slice(amanhaTardeMatch.index + amanhaTardeMatch[0].length)
    );
    return { dueAt: target.toISOString(), residualText: residual };
  }

  // 5. "Amanhã de noite" / "amanhã à noite": /amanh[ãa]\s+(?:(?:a|à|de)\s+)?noite/i -> 19:00
  const amanhaNoiteRegex = /amanh[ãa]\s+(?:(?:a|à|de)\s+)?noite/i;
  const amanhaNoiteMatch = text.match(amanhaNoiteRegex);
  if (amanhaNoiteMatch && amanhaNoiteMatch.index !== undefined) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(19, 0, 0, 0);
    const residual = cleanResidualText(
      text.slice(0, amanhaNoiteMatch.index) + ' ' + text.slice(amanhaNoiteMatch.index + amanhaNoiteMatch[0].length)
    );
    return { dueAt: target.toISOString(), residualText: residual };
  }

  // 6. "Amanhã de manhã" / "amanhã pela manhã": /amanh[ãa]\s+(?:(?:pela|de)\s+)?manh[ãa]/i -> 09:00
  const amanhaManhaRegex = /amanh[ãa]\s+(?:(?:pela|de)\s+)?manh[ãa]/i;
  const amanhaManhaMatch = text.match(amanhaManhaRegex);
  if (amanhaManhaMatch && amanhaManhaMatch.index !== undefined) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    const residual = cleanResidualText(
      text.slice(0, amanhaManhaMatch.index) + ' ' + text.slice(amanhaManhaMatch.index + amanhaManhaMatch[0].length)
    );
    return { dueAt: target.toISOString(), residualText: residual };
  }

  // 7. "Amanhã" (isolado): /amanh[ãa]/i -> 09:00
  const amanhaIsoladoRegex = /amanh[ãa]/i;
  const amanhaIsoladoMatch = text.match(amanhaIsoladoRegex);
  if (amanhaIsoladoMatch && amanhaIsoladoMatch.index !== undefined) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    const residual = cleanResidualText(
      text.slice(0, amanhaIsoladoMatch.index) + ' ' + text.slice(amanhaIsoladoMatch.index + amanhaIsoladoMatch[0].length)
    );
    return { dueAt: target.toISOString(), residualText: residual };
  }

  return { dueAt: null, residualText: text };
}

/**
 * Converte um timestamp ISO de disparo em texto coloquial em português para síntese por voz.
 * @param dueAtIso Data e hora futura em formato ISO 8601.
 * @param now Data de referência (injeção para testes; default = new Date()).
 */
export function formatHumanRelative(dueAtIso: string, now: Date = new Date()): string {
  const target = new Date(dueAtIso);
  const diffMs = target.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);

  // Achado 3 (auditoria de código, Hermes, 2026-09-24): função pública, chamável fora do
  // caminho protegido de bootstrap()/parseRelativeTime() — ISO inválido produziria "daqui a
  // NaN horas" sem esta guarda.
  if (Number.isNaN(diffMin)) return 'agora';

  // Se o horário já passou ou é imediato
  if (diffMin <= 0) return 'agora';

  // Verifica se cai no dia seguinte (amanhã)
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate() &&
    target.getTime() > now.getTime();

  if (isTomorrow) {
    const hours = target.getHours();
    if (hours === 9) return 'amanhã de manhã';
    if (hours === 14) return 'amanhã de tarde';
    if (hours === 19) return 'amanhã de noite';
    return `amanhã às ${hours} horas`;
  }

  // Deltas em minutos (< 60 min)
  if (diffMin < 60) {
    if (diffMin === 1) return 'daqui a um minuto';
    if (diffMin === 2) return 'daqui a dois minutos';
    if (diffMin === 30) return 'daqui a meia hora';
    return `daqui a ${diffMin} minutos`;
  }

  // Deltas em horas (>= 60 min)
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  const hWord = h === 1 ? 'uma hora' : `${h} horas`;

  if (m === 0) {
    return `daqui a ${hWord}`;
  }
  if (m === 30) {
    return `daqui a ${hWord} e meia`;
  }
  const mWord = m === 1 ? 'um minuto' : `${m} minutos`;
  return `daqui a ${hWord} e ${mWord}`;
}
