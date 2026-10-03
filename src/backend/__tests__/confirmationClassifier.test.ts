import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConfirmation } from '../voice/confirmationClassifier.js';

const v = (t: string) => classifyConfirmation(t).verdict;

describe('classifyConfirmation (F11 — mundo fechado)', () => {
  it('SIM: afirmações curtas e naturais em vocabulário conhecido', () => {
    for (const f of [
      'sim', 'Sim.', 'claro', 'com certeza', 'pode sim', 'isso mesmo', 'fechou', 'beleza',
      'pode criar', 'pode apagar', 'sim, pode editar', 'Pode trocar, por favor.', 'tá bom', 'está bom',
      'manda ver', 'perfeito', 'combinado', 'ok', 'blz', 'sem dúvida', 'claro que sim', 'pode mudar isso',
      'sim sim', 'confirmo'
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
    // auditoria Kimi r2 (2026-10-03): hesitações comuns não são autorização
    for (const f of ['pode ser', 'pode ser então', 'vamos ver', 'vamos ver então', 'vish, manda', 'uai, fecha', 'demorou', 'ué, pode'])
      assert.notEqual(v(f), 'SIM', `"${f}" não pode virar SIM`);
    assert.equal(v('manda ver'), 'SIM');
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

  it('auditoria Kimi 2026-10-03: sarcasmo, subordinação, interjeição e murmúrio nunca viram SIM', () => {
    for (const f of [
      'claro que podia', 'claro que eu confio', 'claro que sim, cadê o jogo', 'vish, está valendo',
      'aham', 'uhum', 'aham deixa eu ver', 'com certeza meu filho pode deixar comigo', 'pode me explicar isso'
    ]) assert.notEqual(v(f), 'SIM', `"${f}" não pode virar SIM (veio ${v(f)})`);
    assert.equal(v('ah sim claro'), 'SIM');
  });

  it('verbo de ação diferente da pendente nunca confirma', () => {
    assert.equal(classifyConfirmation('pode apagar', 'LEMBRETE_CRIAR').verdict, 'AMBIGUO');
    assert.equal(classifyConfirmation('pode criar', 'LEMBRETE_APAGAR').verdict, 'AMBIGUO');
    assert.equal(classifyConfirmation('pode apagar', 'LEMBRETE_APAGAR').verdict, 'SIM');
    assert.equal(classifyConfirmation('pode sim', 'LEMBRETE_CRIAR').verdict, 'SIM');
  });

  it('ordem de parar e símbolos: "pára, por favor" é NAO; emoji e "？" não viram SIM', () => {
    assert.equal(v('pára, por favor'), 'NAO');
    assert.notEqual(v('sim 👎'), 'SIM');
    assert.notEqual(v('pode apagar？'), 'SIM');
  });
});
