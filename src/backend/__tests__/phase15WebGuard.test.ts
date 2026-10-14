import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenClawSubAgent } from '../agents/openClawSubAgent.js';
import type { SubAgentTaskRequest } from '../agents/subAgent.js';
import { DEFAULT_PRIVACY, type PrivacyConfig } from '../privacy.js';

/** T1 (auditoria do agy, A4): a consulta do agente WEB passa pelo guarda de saída antes de sair. */
const CPF = '529.982.247-25';
const req = (prompt: string): SubAgentTaskRequest => ({ taskId: 't', turnId: 'u', prompt, isMutation: false });

async function run(mode: PrivacyConfig['outboundGuard'], capability: string, prompt: string) {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
  process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = 'token-de-teste';
  const sent: string[] = [];
  globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    sent.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const privacy: PrivacyConfig = { ...DEFAULT_PRIVACY, webSearch: true, outboundGuard: mode };
    const agent = OpenClawSubAgent.withHttpClient(capability, 'OC', [capability], privacy);
    assert.ok(agent);
    const result = await agent!.runTask(req(prompt), new AbortController().signal);
    return { result, sent };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN;
    else process.env.RODRIGO_OPENCLAW_GATEWAY_TOKEN = originalToken;
  }
}

test('A4 redact: o CPF da consulta web NÃO sai; o resto da consulta sai', async () => {
  const { sent } = await run('redact', 'openclaw_web', `busque o concurso do cpf ${CPF}`);
  assert.equal(sent.length, 1, 'precondição: houve chamada ao gateway');
  assert.equal(sent[0].includes(CPF), false);
  assert.ok(sent[0].includes('[cpf omitido]') && sent[0].includes('busque o concurso'));
});

test('A4 controle positivo: com o guarda em off o CPF SAI (prova que o teste enxerga o envio)', async () => {
  const { sent } = await run('off', 'openclaw_web', `busque o concurso do cpf ${CPF}`);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes(CPF));
});

test('A4 block: nada é enviado e a mensagem de erro não ecoa o conteúdo', async () => {
  const { result, sent } = await run('block', 'openclaw_web', `busque o concurso do cpf ${CPF}`);
  assert.equal(sent.length, 0);
  assert.equal(result.success, false);
  assert.equal(`${result.error}${result.output}`.includes(CPF), false);
});

test('A4 escopo: agente que NÃO é o web (gateway local) não é alterado pelo guarda', async () => {
  const { sent } = await run('redact', 'openclaw_local', `anote o cpf ${CPF}`);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes(CPF), 'fora do canal web o texto segue intacto (o gateway é local)');
});
