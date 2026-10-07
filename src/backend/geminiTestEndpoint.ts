/**
 * Fase 12 (docs/phase-12-v2.md §2.5): RODRIGO_GEMINI_BASE_URL existe só para o teste de egresso (Gemini FALSO em
 * loopback). A regra é única e inequívoca: `fullmatch` de http://127.0.0.1:<porta> ou http://[::1]:<porta>, dígitos
 * ASCII, porta 1024..65535 — sem `localhost`, sem userinfo, sem barra invertida, sem formas hex/decimal/octal, sem
 * caminho. O worker repete a MESMA regra (parse_gemini_base_url em worker.py) sobre a string que recebe daqui.
 */
const BASE_URL_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;

export function parseGeminiBaseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = BASE_URL_RE.exec(raw);
  if (!m) return null;
  const port = Number(m[2]);
  return port >= 1024 && port <= 65535 ? raw : null;
}

/**
 * Variável que o worker recebe. SEMPRE definida (vazia quando não vale): o spawn mescla process.env, então um valor
 * herdado do ambiente do usuário precisa ser sobrescrito, não apenas omitido.
 * Só vale com RODRIGO_TEST=1 e URL válida; qualquer outro caso => '' + aviso (nunca usa).
 */
export function workerGeminiEnv(
  env: Readonly<Record<string, string | undefined>>,
  warn: (msg: string) => void = () => {}
): Record<string, string> {
  const raw = env['RODRIGO_GEMINI_BASE_URL'];
  if (!raw) return { RODRIGO_GEMINI_BASE_URL: '' };
  if (env['RODRIGO_TEST'] !== '1') {
    warn('[Rodrigo AI] RODRIGO_GEMINI_BASE_URL ignorada: só vale com RODRIGO_TEST=1.');
    return { RODRIGO_GEMINI_BASE_URL: '' };
  }
  const url = parseGeminiBaseUrl(raw);
  if (url === null) {
    warn('[Rodrigo AI] RODRIGO_GEMINI_BASE_URL inválida (só http://127.0.0.1:<porta> ou http://[::1]:<porta>, 1024..65535): ignorada.');
    return { RODRIGO_GEMINI_BASE_URL: '' };
  }
  return { RODRIGO_GEMINI_BASE_URL: url };
}
