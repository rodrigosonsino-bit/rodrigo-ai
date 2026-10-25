/**
 * A3/A4 (reauditorias 3 e 4 do Code): proxy local que injeta o token dedicado.
 *
 * O filho (Claude Code no sandbox) NÃO recebe o token: recebe ANTHROPIC_BASE_URL=http://127.0.0.1:<porta> e um
 * NONCE aleatório POR JOB em ANTHROPIC_AUTH_TOKEN (P2: revogado no fim do job; nunca reaproveitado entre jobs ou modos).
 * Este proxy roda no processo PAI (fora do sandbox) e:
 *  - escuta só em 127.0.0.1, numa porta efêmera escolhida pelo SO (P3), com Host conferido (anti-rebinding);
 *  - só aceita POST /v1/messages e /v1/messages/count_tokens (P1), com o nonce de um job vivo (tempo constante);
 *  - lê o corpo (limite de tamanho, P4) e RECUSA ferramentas executadas no servidor da Anthropic (web_fetch, web_search,
 *    code_execution, computer, bash/text_editor/memory de servidor, mcp_toolset...), `mcp_servers` e `container` (P1);
 *  - filtra `anthropic-beta` por lista de permissão e recusa betas de MCP, arquivos, skills e ferramentas de servidor (P1);
 *  - só encaminha para https://api.anthropic.com:443 com TLS verificado EXPLICITAMENTE (CAs embutidos do Node, sem
 *    NODE_EXTRA_CA_CERTS; recusa subir com NODE_TLS_REJECT_UNAUTHORIZED=0);
 *  - troca a autenticação pelo token dedicado e nunca loga cabeçalhos nem corpo (só método, caminho e motivo da recusa).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** Porta só de referência para a impressão digital do perfil (a porta real é efêmera; ver profileFingerprint). */
export const CLAUDE_PROXY_PORT = 47817;
export const CLAUDE_PROXY_HOST = '127.0.0.1';
export const CLAUDE_PROXY_UPSTREAM = 'api.anthropic.com';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** P1: os únicos caminhos (sem query ou com `?beta=true`). */
export const CLAUDE_PROXY_PATHS = ['/v1/messages', '/v1/messages/count_tokens'] as const;
/** P4: limites. */
export const CLAUDE_PROXY_MAX_BODY = 32 * 1024 * 1024;
export const CLAUDE_PROXY_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
export const CLAUDE_PROXY_HEADERS_TIMEOUT_MS = 30_000;
export const CLAUDE_PROXY_MAX_CONNECTIONS = 32;
/** P1: betas aceitos (por prefixo); os demais são descartados. */
export const CLAUDE_BETA_ALLOWED_PREFIXES = [
  'oauth-', 'claude-code-', 'interleaved-thinking-', 'fine-grained-tool-streaming-', 'context-1m-', 'context-management-',
  'prompt-caching-', 'token-efficient-tools-', 'effort-', 'output-128k-', 'extended-cache-ttl-', 'redact-thinking-'
] as const;
/** P1: betas que, se pedidos, derrubam o pedido inteiro (sinal de tentativa de usar algo de servidor). */
export const CLAUDE_BETA_FORBIDDEN = /^(mcp-|web-fetch|web-search|code-execution|computer-use|files-api|skills-|container|agent-|memory-|search-results|tool-search)/;
/** P1: chaves de topo proibidas no corpo. */
export const CLAUDE_BODY_FORBIDDEN_KEYS = ['mcp_servers', 'container', 'betas'] as const;

/** F4: cabeçalhos do filho que podem seguir para a Anthropic (o resto é descartado). */
export const CLAUDE_UPSTREAM_HEADER_ALLOW = ['accept', 'accept-encoding', 'content-type', 'user-agent', 'anthropic-version', 'x-app', 'x-claude-code-session-id'] as const;
export const CLAUDE_UPSTREAM_HEADER_ALLOW_PREFIX = 'x-stainless-';
/** F1: tipos de bloco de conteúdo aceitos (os que o Claude Code usa) e as fontes aceitas (nada buscado pelo servidor). */
export const CLAUDE_BLOCK_TYPES = ['text', 'image', 'document', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'] as const;
export const CLAUDE_TOOL_RESULT_BLOCK_TYPES = ['text', 'image', 'document'] as const;
export const CLAUDE_SOURCE_TYPES = ['base64', 'text'] as const;

export type ProxyMode = 'leitura' | 'escrita';

/** O que o job recebe: URL, nonce DO JOB, porta (para o perfil) e a revogação (chamada no fim do job). */
export interface ProxyAuth {
  baseUrl: string;
  nonce: string;
  port: number;
  revoke: () => void;
}

export type UpstreamFn = (opts: https.RequestOptions, cb: (res: http.IncomingMessage) => void) => http.ClientRequest;

export interface ClaudeProxyOptions {
  token: string;
  /** Padrão 0 (efêmera). */
  port?: number;
  upstream?: UpstreamFn;
  env?: Readonly<Record<string, string | undefined>>;
  log?: (m: string) => void;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function presentedNonce(headers: http.IncomingHttpHeaders): string {
  const auth = headers['authorization'];
  if (typeof auth === 'string' && /^Bearer /i.test(auth)) return auth.slice(7).trim();
  const key = headers['x-api-key'];
  return typeof key === 'string' ? key.trim() : '';
}

/** P2: confere contra TODOS os nonces vivos em tempo constante (sem curto-circuito). */
function nonceAlive(presented: string, alive: Iterable<string>): boolean {
  let ok = false;
  for (const n of alive) ok = sameSecret(presented, n) || ok;
  return ok && presented.length > 0;
}

export type Decision = { ok: true } | { ok: false; status: number; why: string };
/** F3: decisão do corpo; quando aceito, `body` é o JSON validado RE-SERIALIZADO (é ele que sai, nunca os bytes do filho). */
export type BodyDecision = { ok: true; body: Buffer } | { ok: false; status: number; why: string };

/** Decide (sem efeitos) se um pedido pode sair, só pelo método, caminho, origem, Host e nonce. Exportado para teste. */
export function proxyDecision(
  req: { method?: string; url?: string; headers: http.IncomingHttpHeaders; remoteAddress?: string },
  nonces: string | Iterable<string>,
  port?: number
): Decision {
  if (req.remoteAddress !== '127.0.0.1' && req.remoteAddress !== '::ffff:127.0.0.1') return { ok: false, status: 403, why: 'origem' };
  if (req.method === 'CONNECT') return { ok: false, status: 405, why: 'connect' };
  if (req.method !== 'POST') return { ok: false, status: 405, why: 'método' };
  const url = req.url ?? '';
  const [p, q] = url.split('?', 2);
  if (!(CLAUDE_PROXY_PATHS as readonly string[]).includes(p) || (q !== undefined && q !== 'beta=true')) return { ok: false, status: 403, why: 'caminho' };
  if (port !== undefined) {
    const host = String(req.headers['host'] ?? '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, status: 403, why: 'host' };
  }
  const alive = typeof nonces === 'string' ? [nonces] : nonces;
  if (!nonceAlive(presentedNonce(req.headers), alive)) return { ok: false, status: 401, why: 'nonce' };
  return { ok: true };
}

/** P1: betas pedidos => os que saem. Proibido => null (recusa o pedido). */
export function filterBetas(raw: string | string[] | undefined): string[] | null {
  const asked = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (asked.some((b) => CLAUDE_BETA_FORBIDDEN.test(b))) return null;
  const out = asked.filter((b) => CLAUDE_BETA_ALLOWED_PREFIXES.some((p) => b.startsWith(p)));
  if (!out.includes(CLAUDE_OAUTH_BETA)) out.push(CLAUDE_OAUTH_BETA);
  return [...new Set(out)];
}

/** F3: true se algum objeto do JSON (já validado por JSON.parse) repete uma chave (após decodificar escapes). */
export function hasDuplicateKey(text: string): boolean {
  const stack: Array<{ obj: boolean; keys: Set<string>; expectKey: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.obj && top.expectKey) {
        const k = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(k)) return true;
        top.keys.add(k);
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') stack.push({ obj: true, keys: new Set(), expectKey: true });
    else if (c === '[') stack.push({ obj: false, keys: new Set(), expectKey: false });
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top && top.obj) top.expectKey = true;
    }
    i++;
  }
  return false;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const NO = (why: string, status = 403): { ok: false; status: number; why: string } => ({ ok: false, status, why });

/** F1: um bloco de conteúdo. image/document só com fonte base64/text; tool_result só com text/image/document dentro. */
function blockProblem(b: unknown, allowed: readonly string[]): string | null {
  if (!isObj(b)) return 'bloco';
  const type = b.type;
  if (typeof type !== 'string' || !allowed.includes(type)) return `bloco ${String(type).slice(0, 40)}`;
  if ('source' in b || type === 'image' || type === 'document') {
    const src = b.source;
    if (!isObj(src) || typeof src.type !== 'string' || !(CLAUDE_SOURCE_TYPES as readonly string[]).includes(src.type)) return 'fonte';
    if ('url' in src || 'file_id' in src) return 'fonte';
  }
  if (type === 'tool_result' && b.content !== undefined && typeof b.content !== 'string') {
    if (!Array.isArray(b.content)) return 'tool_result';
    for (const x of b.content) {
      const p = blockProblem(x, CLAUDE_TOOL_RESULT_BLOCK_TYPES);
      if (p) return p;
    }
  }
  return null;
}

function contentProblem(content: unknown, allowed: readonly string[]): string | null {
  if (typeof content === 'string') return null;
  if (!Array.isArray(content)) return 'content';
  for (const b of content) {
    const p = blockProblem(b, allowed);
    if (p) return p;
  }
  return null;
}

/**
 * P1/F1/F3: corpo aceito só se for JSON-objeto SEM chaves duplicadas, sem `mcp_servers`/`container`/`betas` (qualquer caixa),
 * com ferramentas só do CLIENTE (sem `type`, ou `type: "custom"`), e com blocos de conteúdo (messages e system, inclusive
 * dentro de tool_result) só dos tipos permitidos e fontes base64/text (nada de URL ou arquivo buscado pela Anthropic).
 */
export function bodyDecision(raw: Buffer): BodyDecision {
  const text = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NO('json', 400);
  }
  if (!isObj(body)) return NO('json', 400);
  if (hasDuplicateKey(text)) return NO('chave duplicada', 400);
  const b = body;
  const lower = Object.keys(b).map((k) => k.toLowerCase());
  for (const k of CLAUDE_BODY_FORBIDDEN_KEYS) if (lower.includes(k)) return NO(`campo ${k}`);
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools)) return NO('tools', 400);
    for (const t of b.tools) {
      if (!isObj(t)) return NO('tools', 400);
      if (t.type !== undefined && t.type !== 'custom') return NO('ferramenta de servidor');
    }
  }
  if (b.system !== undefined) {
    const p = contentProblem(b.system, ['text']);
    if (p) return NO(`system: ${p}`);
  }
  if (b.messages !== undefined) {
    if (!Array.isArray(b.messages)) return NO('messages', 400);
    for (const m of b.messages) {
      if (!isObj(m)) return NO('messages', 400);
      const p = contentProblem(m.content, CLAUDE_BLOCK_TYPES);
      if (p) return NO(`messages: ${p}`);
    }
  }
  return { ok: true, body: Buffer.from(JSON.stringify(b), 'utf8') };
}

/** Cabeçalhos que vão para a Anthropic: sem os do filho que autenticam/roteiam; com o token dedicado e betas filtrados. */
export function upstreamHeaders(inbound: http.IncomingHttpHeaders, token: string, betas: string[] = filterBetas(inbound['anthropic-beta']) ?? [CLAUDE_OAUTH_BETA]): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(inbound)) {
    const n = k.toLowerCase();
    if (v !== undefined && ((CLAUDE_UPSTREAM_HEADER_ALLOW as readonly string[]).includes(n) || n.startsWith(CLAUDE_UPSTREAM_HEADER_ALLOW_PREFIX))) out[n] = v;
  }
  out['host'] = CLAUDE_PROXY_UPSTREAM;
  out['authorization'] = `Bearer ${token}`;
  out['anthropic-beta'] = betas.join(',');
  return out;
}

/** Ambiente que enfraquece a verificação TLS do Node => o proxy não sobe. */
export function tlsEnvProblem(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return 'NODE_TLS_REJECT_UNAUTHORIZED=0';
  return null;
}

export class ClaudeAuthProxy {
  private _port: number;
  private server: http.Server | null = null;
  private state: 'idle' | 'starting' | 'listening' | 'failed' = 'idle';
  private readonly upstream: UpstreamFn;
  private readonly agent: https.Agent;
  /** Nonce vivo => modo e os pedidos em andamento (F5: destruídos na revogação). */
  private readonly live = new Map<string, { mode: ProxyMode; conns: Set<() => void> }>();
  private readonly log: (m: string) => void;

  constructor(private readonly opts: ClaudeProxyOptions) {
    this._port = opts.port ?? 0;
    // TLS explícito: verificação ligada e só os CAs embutidos do Node (ignora NODE_EXTRA_CA_CERTS).
    this.agent = new https.Agent({ rejectUnauthorized: true, ca: [...tls.rootCertificates], keepAlive: true, maxSockets: 8 });
    this.upstream = opts.upstream ?? ((o, cb) => https.request(o, cb));
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  get port(): number {
    return this._port;
  }

  get failed(): boolean {
    return this.state === 'failed';
  }

  get listening(): boolean {
    return this.state === 'listening';
  }

  /** Nonces vivos (só para teste/diagnóstico: quantidade, nunca os valores). */
  get liveCount(): number {
    return this.live.size;
  }

  /** P2: um nonce NOVO por job; `revoke` o invalida na hora (idempotente). null se o proxy não estiver escutando. */
  issue(mode: ProxyMode): ProxyAuth | null {
    if (!this.listening) return null;
    const nonce = crypto.randomBytes(32).toString('hex');
    this.live.set(nonce, { mode, conns: new Set() });
    return { baseUrl: `http://${CLAUDE_PROXY_HOST}:${this._port}`, nonce, port: this._port, revoke: () => this.revoke(nonce) };
  }

  /** P2/F5: tira o nonce da lista e corta na hora os pedidos/streams dele que ainda estão em andamento. */
  private revoke(nonce: string): void {
    const e = this.live.get(nonce);
    this.live.delete(nonce);
    if (e) for (const cut of [...e.conns]) cut();
  }

  start(): Promise<boolean> {
    if (this.state === 'listening') return Promise.resolve(true);
    const bad = tlsEnvProblem(this.opts.env ?? process.env);
    if (bad) {
      this.state = 'failed';
      this.log(`[claude-proxy] recusado: ${bad} enfraquece o TLS; delegação indisponível`);
      return Promise.resolve(false);
    }
    this.state = 'starting';
    return new Promise((resolve) => {
      const srv = http.createServer({ headersTimeout: CLAUDE_PROXY_HEADERS_TIMEOUT_MS, requestTimeout: CLAUDE_PROXY_UPSTREAM_TIMEOUT_MS }, (req, res) => this.handle(req, res));
      srv.maxConnections = CLAUDE_PROXY_MAX_CONNECTIONS;
      srv.on('connect', (_req, sock) => sock.destroy());
      srv.on('upgrade', (_req, sock) => sock.destroy());
      srv.on('clientError', (_e, sock) => sock.destroy());
      srv.once('error', (e) => {
        this.state = 'failed';
        this.log(`[claude-proxy] não subiu (${(e as NodeJS.ErrnoException).code ?? 'erro'}); delegação indisponível`);
        resolve(false);
      });
      // Porta efêmera do SO, só no loopback IPv4, exclusiva (sem compartilhar com cluster).
      srv.listen({ port: this._port, host: CLAUDE_PROXY_HOST, exclusive: true }, () => {
        const a = srv.address();
        if (!a || typeof a !== 'object' || a.address !== CLAUDE_PROXY_HOST) {
          srv.close();
          this.state = 'failed';
          resolve(false);
          return;
        }
        this._port = a.port;
        this.server = srv;
        this.state = 'listening';
        srv.unref();
        resolve(true);
      });
    });
  }

  close(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.state = 'idle';
    for (const n of [...this.live.keys()]) this.revoke(n);
    this.agent.destroy();
    return new Promise((r) => (s ? s.close(() => r()) : r()));
  }

  private refuse(req: http.IncomingMessage, res: http.ServerResponse, d: { status: number; why: string }): void {
    // Só método, caminho (sem query) e motivo: nada de cabeçalhos ou corpo.
    this.log(`[claude-proxy] recusado ${d.status} ${req.method ?? '?'} ${(req.url ?? '').split('?')[0].slice(0, 80)}: ${d.why}`);
    if (!res.headersSent) res.writeHead(d.status, { 'content-type': 'text/plain', connection: 'close' });
    res.end(`recusado: ${d.why}`);
    req.resume();
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const d = proxyDecision({ method: req.method, url: req.url, headers: req.headers, remoteAddress: req.socket.remoteAddress }, this.live.keys(), this._port);
    if (!d.ok) return this.refuse(req, res, d);
    const betas = filterBetas(req.headers['anthropic-beta']);
    if (!betas) return this.refuse(req, res, { status: 403, why: 'beta proibido' });
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > CLAUDE_PROXY_MAX_BODY) return this.refuse(req, res, { status: 413, why: 'corpo grande demais' });
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.setTimeout(CLAUDE_PROXY_HEADERS_TIMEOUT_MS * 4, () => req.destroy());
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > CLAUDE_PROXY_MAX_BODY) {
        aborted = true;
        this.refuse(req, res, { status: 413, why: 'corpo grande demais' });
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (aborted) return;
      const bd = bodyDecision(Buffer.concat(chunks));
      if (!bd.ok) return this.refuse(req, res, bd);
      // F3: o que sai é o JSON validado e re-serializado, não os bytes do filho.
      const body = bd.body;
      // O nonce pode ter sido revogado enquanto o corpo chegava.
      const presented = presentedNonce(req.headers);
      if (!nonceAlive(presented, this.live.keys())) return this.refuse(req, res, { status: 401, why: 'nonce' });
      const entry = this.live.get(presented);
      if (!entry) return this.refuse(req, res, { status: 401, why: 'nonce' });
      const headers = upstreamHeaders(req.headers, this.opts.token, betas);
      headers['content-length'] = String(body.length);
      const up = this.upstream(
        { host: CLAUDE_PROXY_UPSTREAM, port: 443, method: 'POST', path: req.url, headers, servername: CLAUDE_PROXY_UPSTREAM, agent: this.agent, rejectUnauthorized: true, timeout: CLAUDE_PROXY_UPSTREAM_TIMEOUT_MS },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        }
      );
      // F5: revogar o nonce corta este pedido (e o stream da resposta) na hora.
      const cut = (): void => {
        up.destroy(new Error('revogado'));
        res.destroy();
      };
      entry.conns.add(cut);
      res.on('close', () => entry.conns.delete(cut));
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('falha no upstream');
      });
      up.end(body);
    });
  }
}

let shared: ClaudeAuthProxy | null = null;

/** Um proxy por processo pai (porta efêmera); nonces por job. `token` ausente => null (falha fechada). */
export function sharedClaudeProxy(loadToken: () => string | null): ClaudeAuthProxy | null {
  if (shared) {
    if (shared.failed) void shared.start();
    return shared;
  }
  const token = loadToken();
  if (!token) return null;
  shared = new ClaudeAuthProxy({ token });
  void shared.start();
  return shared;
}
