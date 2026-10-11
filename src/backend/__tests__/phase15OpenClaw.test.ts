import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenClawSubAgent } from '../agents/openClawSubAgent.js';
import type { SubAgentTaskRequest } from '../agents/subAgent.js';
import { DEFAULT_PRIVACY, WEB_SEARCH_DISABLED_TEXT, type PrivacyConfig } from '../privacy.js';

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18789';
const PRIVACY_WEB_ON: PrivacyConfig = { ...DEFAULT_PRIVACY, webSearch: true };

function buildRequest(prompt: string): SubAgentTaskRequest {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    prompt,
    isMutation: false
  };
}

function makeAbortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

test('F15 Fatia 3 (a): resposta curta concluída em <15s retorna kind final com output', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Resultado OpenClaw' } }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient('openclaw_web', 'OpenClaw Web', ['openclaw_web'], PRIVACY_WEB_ON);
    assert.ok(agent);

    const result = await agent!.runTask(buildRequest('pesquise isso'), new AbortController().signal);

    assert.equal(result.success, true);
    assert.equal(result.kind, 'final');
    assert.equal(result.output, 'Resultado OpenClaw');
    assert.equal(capturedUrl, `${DEFAULT_GATEWAY_URL}/v1/chat/completions`);
    assert.equal((capturedInit?.headers as Record<string, string>).Authorization, 'Bearer token-abc');
    assert.equal(capturedInit?.method, 'POST');
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      messages: [{ role: 'user', content: 'pesquise isso' }]
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 Fatia 3 (b): timeout no curto retorna async_deferred com asyncTaskId', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  let callCount = 0;

  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;

    globalThis.setTimeout = (((callback: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      callback(...args);
      return originalSetTimeout(() => {}, 0);
    }) as unknown) as typeof setTimeout;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      callCount += 1;
      if (callCount === 1) {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('invokeShort sem AbortSignal.'));
            return;
          }
          if (signal.aborted) {
            reject(makeAbortError());
            return;
          }
          signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
        });
      }

      return new Response(
        JSON.stringify({
          taskId: 'oc-task-42',
          status: 'pending'
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient('openclaw_web', 'OpenClaw Web', ['openclaw_web'], PRIVACY_WEB_ON);
    assert.ok(agent);

    const result = await agent!.runTask(buildRequest('tarefa longa'), new AbortController().signal);
    assert.equal(result.success, true);
    assert.equal(result.kind, 'async_deferred');
    assert.equal(result.asyncTaskId, 'oc-task-42');
    assert.equal(result.output, '');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 Fatia 3 (c): sem token withHttpClient retorna null e runTask falha sem mock de sucesso', async () => {
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  try {
    delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;

    const maybeAgent = OpenClawSubAgent.withHttpClient('openclaw_web', 'OpenClaw Web', ['openclaw_web']);
    assert.equal(maybeAgent, null);

    // webSearch ligado para passar o gate §5 e exercitar o caminho "sem cliente".
    const disconnected = new OpenClawSubAgent('openclaw_web', 'OpenClaw Web', ['openclaw_web'], undefined, {
      privacy: PRIVACY_WEB_ON
    });
    const result = await disconnected.runTask(buildRequest('qualquer coisa'), new AbortController().signal);
    assert.equal(result.success, false);
    assert.equal(result.kind, 'final');
    assert.equal(result.output, '');
    assert.equal(result.error, 'Gateway OpenClaw não conectado.');
  } finally {
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 Fatia 3 (d): AbortSignal externo retorna erro de cancelamento', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;

  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('invokeShort sem AbortSignal.'));
          return;
        }
        if (signal.aborted) {
          reject(makeAbortError());
          return;
        }
        signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
      });
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient('openclaw_web', 'OpenClaw Web', ['openclaw_web'], PRIVACY_WEB_ON);
    assert.ok(agent);

    const controller = new AbortController();
    const running = agent!.runTask(buildRequest('cancele essa'), controller.signal);
    controller.abort();

    const result = await running;
    assert.equal(result.success, false);
    assert.equal(result.kind, 'final');
    assert.equal(result.output, '');
    assert.match(result.error ?? '', /cancelada/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 Fatia 3 (e): HTTP 401 e 500 retornam erro honesto (sem sucesso falso)', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
  const statuses = [401, 500];

  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    process.env.RODRIGO_OPENCLAW_GATEWAY_URL = DEFAULT_GATEWAY_URL;

    for (const status of statuses) {
      globalThis.fetch = (async () => {
        return new Response(
          JSON.stringify({ error: { message: `falha ${status}` } }),
          { status, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const agent = OpenClawSubAgent.withHttpClient('openclaw_web', 'OpenClaw Web', ['openclaw_web'], PRIVACY_WEB_ON);
      assert.ok(agent);

      const result = await agent!.runTask(buildRequest(`teste ${status}`), new AbortController().signal);
      assert.equal(result.success, false);
      assert.equal(result.kind, 'final');
      assert.equal(result.output, '');
      assert.match(result.error ?? '', /^Não consegui falar com o OpenClaw agora \(/);
      assert.match(result.error ?? '', new RegExp(`HTTP ${status}`));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_URL;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_URL = originalUrl;
  }
});

test('F15 §5: RODRIGO_WEB_SEARCH desligado responde a frase padrão (sem chamar o gateway)', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  let fetchCalls = 0;
  try {
    process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-abc';
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const agent = OpenClawSubAgent.withHttpClient(
      'openclaw_web',
      'OpenClaw Web',
      ['openclaw_web'],
      { ...DEFAULT_PRIVACY, webSearch: false }
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
  }
});
