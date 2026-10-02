import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConfirmation } from '../voice/confirmationClassifier.js';

const v = (t: string) => classifyConfirmation(t).verdict;

describe('classifyConfirmation (F11 — mundo fechado)', () => {
  it('SIM: afirmações curtas e naturais em vocabulário conhecido', () => {
    for (const f of [
      'sim', 'Sim.', 'claro', 'com certeza', 'pode ser', 'pode sim', 'isso mesmo', 'fechou', 'beleza',
      'pode criar', 'pode apagar', 'sim, pode editar', 'Pode trocar, por favor.', 'tá bom', 'está bom',
      'manda ver', 'perfeito', 'combinado', 'ok', 'blz', 'sem dúvida', 'claro que sim', 'pode mudar isso',
      'sim sim', 'aham', 'uhum', 'confirmo'
    ]) assert.equal(v(f), 'SIM', `esperava SIM para "${f}"`);
  });

  it('NAO: negação em qualquer posição vence a afirmação', () => {
    for (const f of [
      'não', 'Não.', 'nem pensar', 'cancela', 'deixa pra lá', 'deixa quieto', 'deixa pra depois',
      'nem, depois eu faço', 'sim, mas não', 'não, pode trocar', 'pode editar não', 'nunca, pode mudar',
      'cancela, pode ser', 'esquece isso', 'mudei de ideia', 'isso aí tá errado', 'de jeito nenhum',
      'sim, sim, não', 'nada disso', 'melhor não', 'pare'
    ]) assert.equal(v(f), 'NAO', `esperava NAO para "${f}"`);
  });

  it('AMBIGUO: hesitação, pergunta, assunto novo, token desconhecido — nunca SIM', () => {
    for (const f of [
      '', '   ', 'hum', 'não sei' /* tem negação -> NAO, ver abaixo */, 'pera aí', 'depende', 'como assim?',
      'repete', 'que horas são', 'sim?', 'pode ser?', 'E, depois eu faço.', 'acho uma boa ideia sim',
      'sim mas espera', 'sim talvez', 'depois', 'tudo bem', 'bom dia', 'sim, e me diz as horas'
    ]) {
      const r = v(f);
      assert.notEqual(r, 'SIM', `"${f}" não pode virar SIM (veio ${r})`);
    }
    assert.equal(v('hum'), 'AMBIGUO');
    assert.equal(v('E, depois eu faço.'), 'AMBIGUO');
    assert.equal(v('pode ser?'), 'AMBIGUO');
  });

  it('"sem dúvida" não é negação; "sem" solto em fala maior é', () => {
    assert.equal(v('sem dúvida'), 'SIM');
    assert.equal(v('sem'), 'NAO');
    assert.notEqual(v('pode fazer sem avisar'), 'SIM');
  });

  it('fala longa nunca é SIM', () => {
    assert.notEqual(v('sim pode criar esse lembrete pra mim por favor agora mesmo ok'), 'SIM');
  });

  it('robusto a acento, caixa e pontuação', () => {
    assert.equal(v('  SIM!!! '), 'SIM');
    assert.equal(v('NÃO...'), 'NAO');
    assert.equal(v('Não, tá bom?'), 'NAO');
  });
});
