import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenClawSubAgent } from '../agents/openClawSubAgent.js';
import type { SubAgentTaskRequest } from '../agents/subAgent.js';
import {
  DEFAULT_PRIVACY,
  WEB_SEARCH_DISABLED_TEXT,
  webSearchEffective,
  type PrivacyConfig
} from '../privacy.js';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18789';

function buildRequest(prompt: string): SubAgentTaskRequest {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    prompt,
    isMutation: false
  };
}

test('F15 §5 (a): cloud=0 → webSearchEffective false mesmo com webSearch=1', () => {
  const cfg: PrivacyConfig = { ...DEFAULT_PRIVACY, cloud: false, webSearch: true };
  assert.equal(webSearchEffective(cfg), false);
  assert.equal(webSearchEffective({ ...DEFAULT_PRIVACY, cloud: true, webSearch: true }), true);
  assert.equal(webSearchEffective({ ...DEFAULT_PRIVACY, cloud: true, webSearch: false }), false);
});

test('F15 §5 (b): cloud=1+webSearch=0 → frase padrão sem chamar o client', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  let fetchCalls = 0;
  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient(
      'openclaw_web',
      'OpenClaw Web',
      ['openclaw_web'],
      { ...DEFAULT_PRIVACY, cloud: true, webSearch: false }
    );
    assert.ok(agent);
    const result = await agent!.runTask(buildRequest('pesquise algo'), new AbortController().signal);
    assert.equal(result.success, true);
    assert.equal(result.output, WEB_SEARCH_DISABLED_TEXT);
    assert.equal(result.output, 'A busca na web está desligada; quer que eu ligue?');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 §5 (a-agent): cloud=0+webSearch=1 → mesma frase padrão sem chamar o client', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  let fetchCalls = 0;
  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient(
      'openclaw_web',
      'OpenClaw Web',
      ['openclaw_web'],
      { ...DEFAULT_PRIVACY, cloud: false, webSearch: true }
    );
    assert.ok(agent);
    const result = await agent!.runTask(buildRequest('pesquise algo'), new AbortController().signal);
    assert.equal(result.success, true);
    assert.equal(result.output, WEB_SEARCH_DISABLED_TEXT);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 §5 (c): cloud=1+webSearch=1 → delegação acontece (mock fetch)', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  let fetchCalls = 0;
  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'achado na web' } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient(
      'openclaw_web',
      'OpenClaw Web',
      ['openclaw_web'],
      { ...DEFAULT_PRIVACY, cloud: true, webSearch: true }
    );
    assert.ok(agent);
    const result = await agent!.runTask(buildRequest('pesquise isso'), new AbortController().signal);
    assert.equal(result.success, true);
    assert.equal(result.kind, 'final');
    assert.equal(result.output, 'achado na web');
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});
