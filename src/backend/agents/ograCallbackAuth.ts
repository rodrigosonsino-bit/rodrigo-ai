import crypto from 'node:crypto';

/**
 * Token local do callback da Ogra (`RODRIGO_OGRA_CALLBACK_TOKEN`).
 * Não é a chave do webhook de saída. Ausente ou vazio => nenhum callback é aceito.
 */
export function readOgraCallbackToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.RODRIGO_OGRA_CALLBACK_TOKEN;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

/** Comparação em tempo constante. Tamanhos diferentes nunca aceitam. */
export function timingSafeEqualString(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Authorization: Bearer <RODRIGO_OGRA_CALLBACK_TOKEN>.
 * Sem token configurado, cabeçalho ausente, múltiplo ou diferente => false.
 */
export function ograCallbackAuthorized(
  authorization: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const expected = readOgraCallbackToken(env);
  if (!expected) return false;
  if (Array.isArray(authorization)) return false;
  const provided = bearerToken(authorization);
  if (provided === null) return false;
  return timingSafeEqualString(expected, provided);
}
