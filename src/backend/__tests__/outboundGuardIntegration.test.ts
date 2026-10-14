import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOUND_BLOCKED_TEXT } from '../privacy.js';
import { resetOutboundCounts, getOutboundCounts, maskFor } from '../privacy/outboundGuard.js';
import { setup, teardown, oneTurn, type H } from './helpers/sessionHarness.js';

/**
 * T1: o guarda de saída no fluxo REAL do SessionManager (motor falso). Marcadores sintéticos plantados na fala e nas
 * memórias não aparecem no prompt de geração nem no texto da intenção em nuvem nos modos redact e block; com o guarda
 * em off eles SAEM (controle positivo). Prova de mutação: ver o commit (remover guardMessages/guardText reprova).
 */
const CPF = '529.982.247-25';
const KEY = 'AIzaSyD' + 'q'.repeat(32);

const FALA = `que horas são? meu cpf é ${CPF} e a chave ${KEY}`;
function everythingSentToCloud(h: H): string {
  return JSON.stringify({
    generate: h.engine.generateCalls.map((c) => c.messages),
    intent: h.engine.detectIntentCalls.map((c) => c.text)
  });
}

describe('guarda de saída no fluxo real do SessionManager (T1)', () => {
  it('redact (padrão): nem a fala nem a memória chegam em claro ao prompt de geração nem à intenção em nuvem', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'redact' }, true);
    t.after(() => teardown(h));
    await oneTurn(h, FALA);
    const sent = everythingSentToCloud(h);
    assert.ok(h.engine.generateCalls.length > 0, 'precondição: houve geração (senão o teste não prova nada)');
    for (const secret of [CPF, KEY, 'Cofre2026Azul']) assert.equal(sent.includes(secret), false, `vazou: ${secret.slice(0, 6)}…`);
    assert.ok(sent.includes(maskFor('cpf')), 'o marcador de tipo aparece no lugar do CPF');
    const c = getOutboundCounts();
    assert.ok((c['cpf'] ?? 0) >= 1 && (c['api-key'] ?? 0) >= 1 && (c['spoken-password'] ?? 0) >= 1, `contadores: ${JSON.stringify(c)}`);
    assert.equal(JSON.stringify(c).includes(CPF), false, 'contador nunca guarda conteúdo');
  });

  it('controle positivo: com o guarda em off os mesmos marcadores SAEM (o teste enxerga a diferença)', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'off' }, true);
    t.after(() => teardown(h));
    await oneTurn(h, FALA);
    const sent = everythingSentToCloud(h);
    assert.ok(h.engine.generateCalls.length > 0);
    assert.equal(sent.includes(CPF), true);
    assert.equal(sent.includes(KEY), true);
    assert.equal(sent.includes('Cofre2026Azul'), true);
    assert.deepEqual(getOutboundCounts(), {});
  });

  it('block: nada é enviado (nenhuma geração, nenhuma intenção em nuvem) e o app fala o aviso fixo, sem eco do conteúdo', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'block' }, true);
    t.after(() => teardown(h));
    await oneTurn(h, FALA);
    assert.equal(h.engine.generateCalls.length, 0, 'nada foi enviado à geração');
    assert.equal(h.engine.detectIntentCalls.length, 0, 'nada foi enviado à intenção em nuvem');
    assert.ok(h.tts.synthesizeCalls.includes(OUTBOUND_BLOCKED_TEXT), 'o aviso fixo foi falado');
    for (const spoken of h.tts.synthesizeCalls) {
      for (const secret of [CPF, KEY, 'Cofre2026Azul']) assert.equal(spoken.includes(secret), false);
    }
  });

  it('texto sem segredo passa idêntico em redact: o guarda não altera fala comum nem memória comum', async (t) => {
    resetOutboundCounts();
    const h = await setup({ RODRIGO_OUTBOUND_GUARD: 'redact' }, true, 'gosto de café sem açúcar'); // COM memória comum
    t.after(() => teardown(h));
    await oneTurn(h, 'que horas são? marque dentista dia 20');
    const sent = everythingSentToCloud(h);
    assert.ok(sent.includes('marque dentista dia 20'));
    assert.ok(sent.includes('gosto de café sem açúcar'), 'a memória comum chega intacta ao prompt (o guarda não a corrompe)');
    assert.deepEqual(getOutboundCounts(), {});
  });
});
