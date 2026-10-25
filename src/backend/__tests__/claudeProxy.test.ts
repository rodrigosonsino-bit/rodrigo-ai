import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import {
  ClaudeAuthProxy, CLAUDE_OAUTH_BETA, CLAUDE_PROXY_MAX_BODY, CLAUDE_PROXY_UPSTREAM, bodyDecision, filterBetas, proxyDecision, tlsEnvProblem,
  upstreamHeaders, type UpstreamFn
} from '../agents/claudeProxy.js';

const TOKEN = 'sk-ant-oat01-' + 'z'.repeat(40);
const NONCE = 'a'.repeat(64);

type Call = { opts: Record<string, unknown>; body: string };
function fakeUpstream(calls: Call[]): UpstreamFn {
  return (opts, cb) => {
    const req = new PassThrough() as unknown as http.ClientRequest;
    let body = '';
    (req as unknown as PassThrough).on('data', (d) => (body += d));
    (req as unknown as PassThrough).on('end', () => {
      calls.push({ opts: opts as Record<string, unknown>, body });
      const res = new PassThrough() as unknown as http.IncomingMessage;
      Object.assign(res, { statusCode: 200, headers: { 'content-type': 'application/json' } });
      cb(res);
      (res as unknown as PassThrough).end('{"ok":true}');
    });
    return req;
  };
}

function send(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; host?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(o.headers ?? {}) };
    if (o.host) headers.host = o.host;
    const r = http.request({ host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/v1/messages', headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' || (e as NodeJS.ErrnoException).code === 'EPIPE' ? resolve({ status: 413, body: 'reset' }) : reject(e)));
    r.end(o.body ?? '{"model":"m","messages":[]}');
  });
}

async function withProxy(fn: (p: ClaudeAuthProxy, calls: Call[], logs: string[]) => Promise<void>) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const proxy = new ClaudeAuthProxy({ token: TOKEN, upstream: fakeUpstream(calls), env: {}, log: (m) => logs.push(m) });
  assert.equal(await proxy.start(), true);
  try {
    await fn(proxy, calls, logs);
  } finally {
    await proxy.close();
  }
  assert.ok(logs.every((l) => !l.includes(TOKEN) && !l.includes(NONCE)), 'logs sem token/nonce');
}

describe('A3/A4: proxy local que injeta o token dedicado', () => {
  it('decisão: só 127.0.0.1, só POST, só /v1/messages(+count_tokens), Host certo e nonce vivo', () => {
    const ok = { method: 'POST', url: '/v1/messages?beta=true', headers: { authorization: `Bearer ${NONCE}`, host: '127.0.0.1:5000' } as http.IncomingHttpHeaders, remoteAddress: '127.0.0.1' };
    assert.deepEqual(proxyDecision(ok, NONCE, 5000), { ok: true });
    assert.equal(proxyDecision({ ...ok, url: '/v1/messages/count_tokens?beta=true' }, NONCE, 5000).ok, true);
    assert.equal(proxyDecision({ ...ok, headers: { 'x-api-key': NONCE, host: 'localhost:5000' } }, NONCE, 5000).ok, true);
    const no = (o: Partial<typeof ok>) => proxyDecision({ ...ok, ...o }, NONCE, 5000);
    assert.equal(no({ remoteAddress: '10.0.0.2' }).ok, false);
    assert.deepEqual(no({ method: 'CONNECT' }), { ok: false, status: 405, why: 'connect' });
    assert.deepEqual(no({ method: 'GET' }), { ok: false, status: 405, why: 'método' });
    assert.equal(no({ method: 'PUT' }).ok, false);
    for (const u of ['https://evil.com/v1/messages', '/api/oauth/token', '/v1/../admin', '/v1/files', '/v1/models', '/v1/messages/batches', '/v1/skills', '/v1/messages?x=1', '/v1/messages/'])
      assert.deepEqual(no({ url: u }), { ok: false, status: 403, why: 'caminho' }, u);
    assert.deepEqual(no({ headers: { authorization: `Bearer ${NONCE}`, host: 'evil.com' } }), { ok: false, status: 403, why: 'host' });
    assert.deepEqual(no({ headers: { authorization: `Bearer ${NONCE}`, host: '127.0.0.1:5001' } }), { ok: false, status: 403, why: 'host' });
    assert.equal(no({ headers: { host: '127.0.0.1:5000' } }).ok, false);
    assert.equal(no({ headers: { authorization: `Bearer ${NONCE}x`, host: '127.0.0.1:5000' } }).ok, false);
    assert.equal(no({ headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:5000' } }).ok, false, 'nem o próprio token serve: só o nonce');
    assert.equal(proxyDecision(ok, ['b'.repeat(64), NONCE], 5000).ok, true, 'qualquer nonce vivo');
    assert.equal(proxyDecision(ok, [], 5000).ok, false, 'sem nonce vivo => nada passa');
  });

  it('P1: corpo — recusa mcp_servers, container, betas e ferramentas de servidor; aceita ferramentas do cliente', () => {
    const b = (o: unknown) => bodyDecision(Buffer.from(JSON.stringify(o)));
    const good = { model: 'm', messages: [], tools: [{ name: 'Read', input_schema: {} }, { type: 'custom', name: 'x', input_schema: {} }] };
    const g = b(good);
    assert.equal(g.ok, true);
    assert.equal(g.ok && g.body.toString('utf8'), JSON.stringify(good), 'F3: sai o JSON validado re-serializado');
    assert.equal(b({ model: 'm', mcp_servers: [{ type: 'url', url: 'https://evil' }] }).ok, false);
    assert.equal(b({ model: 'm', container: 'c' }).ok, false);
    assert.equal(b({ model: 'm', betas: ['mcp-client-2025-04-04'] }).ok, false);
    for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250522', 'bash_20250124', 'text_editor_20250728', 'computer_20250124', 'memory_20250818', 'tool_search_tool_regex_20251119'])
      assert.deepEqual(b({ model: 'm', tools: [{ name: 'Read', input_schema: {} }, { type, name: 'x' }] }), { ok: false, status: 403, why: 'ferramenta de servidor' }, type);
    assert.equal(bodyDecision(Buffer.from('não é json')).ok, false);
    assert.equal(b([1, 2]).ok, false);
    assert.equal(b({ tools: 'x' }).ok, false);
  });

  it('F1: blocos de conteúdo — só tipos do Claude Code e fontes base64/text; URL/arquivo recusados em messages, system e tool_result', () => {
    const b = (o: unknown) => bodyDecision(Buffer.from(JSON.stringify(o)));
    const msg = (content: unknown) => ({ model: 'm', messages: [{ role: 'user', content }] });
    const img64 = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const docTxt = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'oi' } };
    // aceitos (o que o Claude Code manda)
    for (const c of ['oi', [{ type: 'text', text: 'oi', cache_control: { type: 'ephemeral' } }], [img64], [docTxt],
      [{ type: 'tool_use', id: 't1', name: 'Read', input: { source: { type: 'url', url: 'x' } } }],
      [{ type: 'tool_result', tool_use_id: 't1', content: 'saída' }],
      [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, img64] }],
      [{ type: 'thinking', thinking: 'h', signature: 's' }, { type: 'redacted_thinking', data: 'x' }]])
      assert.equal(b(msg(c)).ok, true, JSON.stringify(c));
    assert.equal(b({ model: 'm', system: [{ type: 'text', text: 's' }], messages: [] }).ok, true);
    assert.equal(b({ model: 'm', system: 'texto', messages: [] }).ok, true);
    // recusados: fontes buscadas pela Anthropic
    const evil = 'https://atacante.example/?d=segredo';
    for (const c of [
      [{ type: 'image', source: { type: 'url', url: evil } }],
      [{ type: 'document', source: { type: 'url', url: evil } }],
      [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }],
      [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }],
      [{ type: 'document', source: { type: 'content', content: [{ type: 'text', text: 'x' }] } }],
      [{ type: 'image', source: { type: 'base64', url: evil, media_type: 'image/png', data: 'AAAA' } }],
      [{ type: 'image' }],
      [{ type: 'text', text: 'x', source: { type: 'url', url: evil } }],
      [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'url', url: evil } }] }],
      [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'document', source: { type: 'url', url: evil } }] }],
      [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_result', tool_use_id: 'u', content: 'x' }] }],
      [{ type: 'tool_result', tool_use_id: 't', content: { type: 'image' } }],
      [{ type: 'server_tool_use', id: 's', name: 'web_fetch', input: { url: evil } }],
      [{ type: 'web_fetch_tool_result', tool_use_id: 's', content: {} }],
      [{ type: 'mcp_tool_use', id: 'm', name: 'x', server_name: 's', input: {} }],
      [{ type: 'mcp_tool_result', tool_use_id: 'm', content: [] }],
      [{ type: 'container_upload', file_id: 'f' }],
      [{ type: 'search_result', source: evil, title: 't', content: [] }],
      [{ text: 'sem tipo' }],
      ['texto solto'],
      { type: 'text', text: 'objeto em vez de lista' }
    ]) assert.equal(b(msg(c)).ok, false, JSON.stringify(c));
    assert.equal(b({ model: 'm', system: [{ type: 'image', source: { type: 'url', url: evil } }], messages: [] }).ok, false, 'system');
    assert.equal(b({ model: 'm', system: [{ type: 'document', source: { type: 'base64', data: 'x' } }], messages: [] }).ok, false, 'system só text');
    assert.equal(b({ model: 'm', messages: 'x' }).ok, false);
    assert.equal(b({ model: 'm', messages: ['x'] }).ok, false);
    // F3: chaves proibidas com outra caixa
    assert.equal(b({ model: 'm', MCP_SERVERS: [] }).ok, false);
    assert.equal(b({ model: 'm', Container: 'x' }).ok, false);
  });

  it('F3: chave duplicada (em qualquer nível, inclusive via escape unicode) é recusada; o que sai é re-serializado', () => {
    const raw = (s: string) => bodyDecision(Buffer.from(s));
    assert.deepEqual(raw('{"model":"m","tools":[{"type":"web_fetch_20250910","name":"w"}],"tools":[]}'), { ok: false, status: 400, why: 'chave duplicada' });
    assert.equal(raw('{"model":"m","messages":[{"role":"user","role":"assistant","content":"x"}]}').ok, false, 'aninhada');
    assert.equal(raw('{"model":"m","m\\\\u006fdel":"n"}').ok, true, 'barra escapada não é escape: chave diferente');
    assert.equal(raw('{"model":"m","mod\\u0065l":"n"}').ok, false, 'escape unicode decodificado');
    assert.equal(raw('{"a":{"x":1},"b":{"x":1}}').ok, true, 'mesma chave em objetos diferentes é normal');
    assert.equal(raw('{"a":"{\\"a\\":1,\\"a\\":2}"}').ok, true, 'chaves dentro de string não contam');
    const r = raw('{ "model" : "m",\n "messages" : [ ] }');
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.body.toString(), '{"model":"m","messages":[]}');
  });

  it('P1: anthropic-beta — proibidos derrubam o pedido; desconhecidos caem; oauth sempre presente', () => {
    assert.equal(filterBetas('mcp-client-2025-04-04'), null);
    assert.equal(filterBetas(['claude-code-20250219', 'web-fetch-2025-09-10']), null);
    assert.equal(filterBetas('code-execution-2025-05-22'), null);
    assert.equal(filterBetas('files-api-2025-04-14'), null);
    assert.deepEqual(filterBetas('claude-code-20250219,interleaved-thinking-2025-05-14,inventado-2099'), ['claude-code-20250219', 'interleaved-thinking-2025-05-14', CLAUDE_OAUTH_BETA]);
    assert.deepEqual(filterBetas(undefined), [CLAUDE_OAUTH_BETA]);
  });

  it('cabeçalhos: troca a autenticação do filho pelo token, fixa o host e usa só os betas filtrados', () => {
    const h = upstreamHeaders({ authorization: `Bearer ${NONCE}`, 'x-api-key': NONCE, host: '127.0.0.1:47817', 'anthropic-beta': 'foo', 'content-type': 'application/json', 'proxy-authorization': 'x', 'content-length': '9' }, TOKEN);
    assert.equal(h['authorization'], `Bearer ${TOKEN}`);
    assert.equal(h['host'], CLAUDE_PROXY_UPSTREAM);
    assert.equal(h['x-api-key'], undefined);
    assert.equal(h['proxy-authorization'], undefined);
    assert.equal(h['content-length'], undefined);
    assert.equal(h['anthropic-beta'], CLAUDE_OAUTH_BETA, 'beta desconhecido não atravessa');
    assert.equal(h['content-type'], 'application/json');
    assert.ok(!JSON.stringify(h).includes(NONCE), 'nonce não sai para a Anthropic');
  });

  it('F4: só cabeçalhos da lista de permissão vão para a Anthropic', () => {
    const inbound = {
      'content-type': 'application/json', accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': 'claude-cli/2',
      'anthropic-version': '2023-06-01', 'x-app': 'cli', 'x-claude-code-session-id': 's1', 'x-stainless-lang': 'js', 'X-Stainless-OS': 'MacOS',
      'x-http-method-override': 'DELETE', 'x-method-override': 'GET', 'anthropic-dangerous-direct-browser-access': 'true', cookie: 'a=b',
      forwarded: 'for=1.2.3.4', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil', origin: 'https://evil', referer: 'https://evil', 'x-anthropic-additional-protection': '1'
    };
    const h = upstreamHeaders(inbound, TOKEN, [CLAUDE_OAUTH_BETA]);
    assert.deepEqual(Object.keys(h).sort(), ['accept', 'accept-encoding', 'anthropic-beta', 'anthropic-version', 'authorization', 'content-type', 'host', 'user-agent', 'x-app', 'x-claude-code-session-id', 'x-stainless-lang', 'x-stainless-os'].sort());
    assert.equal(h['x-stainless-os'], 'MacOS');
  });

  it('TLS: NODE_TLS_REJECT_UNAUTHORIZED=0 impede o proxy de subir', async () => {
    assert.equal(tlsEnvProblem({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), 'NODE_TLS_REJECT_UNAUTHORIZED=0');
    assert.equal(tlsEnvProblem({}), null);
    const logs: string[] = [];
    const p = new ClaudeAuthProxy({ token: TOKEN, env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, log: (m) => logs.push(m) });
    assert.equal(await p.start(), false);
    assert.equal(p.issue('leitura'), null);
    assert.ok(logs.some((l) => /TLS/.test(l)));
  });

  it('P2: nonce por job — novo a cada issue, diferente entre modos, revogado vira 401; porta efêmera', async () => {
    await withProxy(async (proxy, calls) => {
      assert.ok(proxy.port >= 1024 && proxy.port !== 47817, 'porta efêmera do SO');
      const a = proxy.issue('leitura')!;
      const b = proxy.issue('leitura')!;
      const c = proxy.issue('escrita')!;
      assert.ok(a && b && c);
      assert.equal(new Set([a.nonce, b.nonce, c.nonce]).size, 3, 'sem reuso entre jobs/modos');
      assert.match(a.nonce, /^[0-9a-f]{64}$/);
      assert.equal(a.port, proxy.port);
      assert.equal(a.baseUrl, `http://127.0.0.1:${proxy.port}`);
      assert.equal(proxy.liveCount, 3);
      const h = (n: string) => ({ authorization: `Bearer ${n}` });
      assert.equal((await send(proxy.port, { headers: h(a.nonce) })).status, 200);
      a.revoke();
      a.revoke();
      assert.equal(proxy.liveCount, 2);
      assert.equal((await send(proxy.port, { headers: h(a.nonce) })).status, 401, 'nonce revogado não serve mais');
      assert.equal((await send(proxy.port, { headers: h(c.nonce) })).status, 200);
      b.revoke();
      c.revoke();
      assert.equal(proxy.liveCount, 0);
      assert.equal((await send(proxy.port, { headers: h(c.nonce) })).status, 401);
      assert.equal(calls.length, 2);
    });
  });

  it('ponta a ponta: só POST /v1/messages com corpo limpo chega ao upstream (TLS explícito, token, corpo intacto)', async () => {
    await withProxy(async (proxy, calls, logs) => {
      const auth = proxy.issue('leitura')!;
      const H = { authorization: `Bearer ${auth.nonce}` };
      const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'oi' }], tools: [{ name: 'Read', input_schema: {} }] });
      const ok = await send(proxy.port, { path: '/v1/messages?beta=true', headers: { ...H, 'anthropic-beta': 'claude-code-20250219,inventado-1' }, body });
      assert.equal(ok.status, 200);
      assert.equal(ok.body, '{"ok":true}');
      assert.equal(calls.length, 1);
      const o = calls[0].opts;
      assert.equal(o.host, 'api.anthropic.com');
      assert.equal(o.port, 443);
      assert.equal(o.method, 'POST');
      assert.equal(o.rejectUnauthorized, true);
      assert.ok(o.agent instanceof https.Agent);
      assert.equal((o.agent as https.Agent).options.rejectUnauthorized, true);
      assert.ok(Array.isArray((o.agent as https.Agent).options.ca), 'CAs explícitos');
      assert.ok(typeof o.timeout === 'number' && (o.timeout as number) > 0);
      const hh = o.headers as Record<string, string>;
      assert.equal(hh.authorization, `Bearer ${TOKEN}`);
      assert.equal(hh['anthropic-beta'], `claude-code-20250219,${CLAUDE_OAUTH_BETA}`);
      assert.equal(hh['content-length'], String(Buffer.byteLength(body)));
      assert.equal(calls[0].body, body);
      assert.equal((await send(proxy.port, { path: '/v1/messages/count_tokens', headers: H })).status, 200);
      // recusas, nenhuma chega ao upstream
      assert.equal((await send(proxy.port, { headers: {} })).status, 401);
      assert.equal((await send(proxy.port, { headers: { authorization: 'Bearer errado' } })).status, 401);
      assert.equal((await send(proxy.port, { method: 'GET', path: '/v1/models', headers: H })).status, 405);
      for (const p of ['/v1/files', '/v1/models', '/api/hello', '/v1/messages/batches']) assert.equal((await send(proxy.port, { path: p, headers: H })).status, 403, p);
      assert.equal((await send(proxy.port, { headers: H, host: 'evil.com' })).status, 403, 'Host errado (DNS rebinding)');
      assert.equal((await send(proxy.port, { headers: H, body: JSON.stringify({ model: 'm', mcp_servers: [{ url: 'https://evil' }] }) })).status, 403);
      for (const type of ['web_search_20250305', 'web_fetch_20250910', 'code_execution_20250825'])
        assert.equal((await send(proxy.port, { headers: H, body: JSON.stringify({ model: 'm', tools: [{ type, name: 'w' }] }) })).status, 403, type);
      assert.equal((await send(proxy.port, { headers: H, body: JSON.stringify({ model: 'm', container: 'x' }) })).status, 403);
      assert.equal((await send(proxy.port, { headers: { ...H, 'anthropic-beta': 'mcp-client-2025-04-04' } })).status, 403);
      assert.equal((await send(proxy.port, { headers: H, body: 'lixo' })).status, 400);
      assert.equal(calls.length, 2, 'pedidos recusados não chegam ao upstream');
      assert.ok(!ok.body.includes(TOKEN));
      assert.ok(logs.some((l) => /recusado 403 POST \/v1\/files: caminho/.test(l)), 'log diz método, caminho e motivo');
      auth.revoke();
    });
  });

  it('F3/F4 ponta a ponta: duplicata não sai; o upstream recebe o JSON re-serializado e só cabeçalhos permitidos', async () => {
    await withProxy(async (proxy, calls) => {
      const auth = proxy.issue('leitura')!;
      const H = { authorization: `Bearer ${auth.nonce}` };
      assert.equal((await send(proxy.port, { headers: H, body: '{"model":"m","tools":[{"type":"web_fetch_20250910","name":"w"}],"tools":[]}' })).status, 400);
      assert.equal((await send(proxy.port, { headers: H, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://evil' } }] }] }) })).status, 403);
      assert.equal(calls.length, 0);
      const r = await send(proxy.port, { headers: { ...H, 'x-http-method-override': 'DELETE', 'x-stainless-lang': 'js' }, body: '{ "model" : "m", "messages" : [] }' });
      assert.equal(r.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body, '{"model":"m","messages":[]}');
      const hh = calls[0].opts.headers as Record<string, string>;
      assert.equal(hh['content-length'], String(Buffer.byteLength('{"model":"m","messages":[]}')));
      assert.equal(hh['x-http-method-override'], undefined);
      assert.equal(hh['x-stainless-lang'], 'js');
      auth.revoke();
    });
  });

  it('F5: revogar o nonce corta na hora um stream em andamento (upstream e resposta ao filho)', async () => {
    let upReq: PassThrough | null = null;
    let upRes: PassThrough | null = null;
    const upstream: UpstreamFn = (_opts, cb) => {
      const req = new PassThrough();
      upReq = req;
      req.on('end', () => {
        const res = new PassThrough();
        upRes = res;
        Object.assign(res, { statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
        cb(res as unknown as http.IncomingMessage);
        res.write('event: message_start\n\n');
      });
      req.resume();
      return req as unknown as http.ClientRequest;
    };
    const proxy = new ClaudeAuthProxy({ token: TOKEN, upstream, env: {}, log: () => {} });
    assert.equal(await proxy.start(), true);
    try {
      const auth = proxy.issue('escrita')!;
      const other = proxy.issue('leitura')!;
      const outcome = await new Promise<{ got: string; cut: boolean }>((resolve, reject) => {
        let got = '';
        const r = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.nonce}` } }, (res) => {
          res.on('data', (d) => {
            got += d;
            auth.revoke();
          });
          res.on('end', () => resolve({ got, cut: false }));
          res.on('aborted', () => resolve({ got, cut: true }));
          res.on('error', () => resolve({ got, cut: true }));
          res.on('close', () => resolve({ got, cut: !res.complete }));
        });
        r.on('error', (e) => reject(e));
        r.end('{"model":"m","messages":[]}');
        setTimeout(() => reject(new Error('o stream não foi cortado')), 3000).unref();
      });
      assert.match(outcome.got, /message_start/, 'o stream chegou a começar');
      assert.equal(outcome.cut, true, 'resposta cortada');
      assert.equal(upReq!.destroyed, true, 'pedido ao upstream destruído');
      assert.ok(upRes, 'resposta do upstream existia');
      assert.equal(proxy.liveCount, 1, 'só o nonce revogado saiu');
      other.revoke();
    } finally {
      await proxy.close();
    }
  });

  it('limite de corpo: acima do máximo => 413 e nada sai', async () => {
    await withProxy(async (proxy, calls) => {
      const auth = proxy.issue('escrita')!;
      const big = Buffer.alloc(CLAUDE_PROXY_MAX_BODY + 1024, 0x20);
      const r = await send(proxy.port, { headers: { authorization: `Bearer ${auth.nonce}` }, body: big });
      assert.equal(r.status, 413);
      assert.equal(calls.length, 0);
      auth.revoke();
    });
  });

  it('close() revoga todos os nonces e issue() passa a dar null', async () => {
    const proxy = new ClaudeAuthProxy({ token: TOKEN, upstream: fakeUpstream([]), env: {}, log: () => {} });
    assert.equal(await proxy.start(), true);
    proxy.issue('leitura');
    await proxy.close();
    assert.equal(proxy.liveCount, 0);
    assert.equal(proxy.issue('leitura'), null, 'fechado => sem auth (falha fechada)');
  });

  it('porta ocupada => start() falso e issue() nulo (o filho não roda)', async () => {
    const busy = http.createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as { port: number }).port;
    const logs: string[] = [];
    const proxy = new ClaudeAuthProxy({ token: TOKEN, port, env: {}, log: (m) => logs.push(m) });
    try {
      assert.equal(await proxy.start(), false);
      assert.equal(proxy.issue('leitura'), null);
      assert.ok(logs.every((l) => !l.includes(TOKEN)), 'o aviso não contém o token');
    } finally {
      busy.close();
    }
  });
});
