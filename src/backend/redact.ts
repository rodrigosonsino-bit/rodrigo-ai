/**
 * Fase 12 (docs/phase-12-v2.md §2.6): máscara de segredos para logs e erros. Espelho EXATO de `redact()` em
 * scripts/worker/worker.py — os dois passam pelos mesmos casos (src/backend/__tests__/fixtures/redact-cases.json).
 *
 * Ordem importa: (1) segredos exatos conhecidos, (2) formato de chave Gemini, (3) pares nome=valor
 * (cabeçalhos, JSON, variáveis de ambiente), (4) ?key= em URL — e SÓ ENTÃO truncar. Mascarar antes de
 * truncar impede que um corte no meio de uma chave deixe um fragmento legível.
 */
export const REDACTED = '[REDACTED]';

/** Chave Gemini ("AIza" + ≥8 caracteres), inclusive com `-`/`_` codificados em URL. Pega fragmentos. */
const KEY_RE = /AIza(?:[0-9A-Za-z_-]|%2[Dd]|%5[Ff]){8,}/g;
/** nome(:|=)valor para api key / x-goog-api-key / authorization, com aspas e barras de JSON escapado. */
const NAMED_RE = /((?:[A-Za-z_-]*(?:api[_-]?key)|x-goog-api-key|authorization)\\?["']?\s*[:=]\s*\\?["']?(?:(?:bearer|basic)\s+)?)[^\s,;&"'}\\<>]+/gi;
/** `?key=…` / `&key=…` em URL (o valor pode estar codificado). */
const QUERY_KEY_RE = /([?&]key=)[^\s&"'<>]+/gi;

const MIN_SECRET_LEN = 8;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex de um segredo exato tolerando espaços/quebras de linha entre QUAISQUER caracteres (chave partida). */
function secretRe(secret: string): RegExp {
  return new RegExp([...secret].map(escapeRe).join('\\s*'), 'g');
}

export function redact(text: string, extraSecrets: readonly string[] = [], maxLen?: number): string {
  let out = text;
  const secrets = [process.env.GEMINI_API_KEY ?? '', ...extraSecrets].filter((s) => s.trim().length >= MIN_SECRET_LEN);
  for (const secret of secrets) {
    out = out.replace(secretRe(secret), REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  out = out.replace(KEY_RE, REDACTED);
  out = out.replace(NAMED_RE, `$1${REDACTED}`);
  out = out.replace(QUERY_KEY_RE, `$1${REDACTED}`);
  if (maxLen !== undefined && out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}
