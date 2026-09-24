import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRelativeTime,
  parseNumberOrWord,
  formatHumanRelative,
  CARDINAL_WORDS
} from '../tools/relativeTimeParser.js';

describe('relativeTimeParser (Fase 6 — H1 & H2)', () => {
  const fixedNow = new Date('2026-09-24T10:00:00.000Z');

  describe('H1 — parseNumberOrWord', () => {
    it('converte dígitos decimais válidos', () => {
      assert.equal(parseNumberOrWord('0'), 0);
      assert.equal(parseNumberOrWord('1'), 1);
      assert.equal(parseNumberOrWord('20'), 20);
      assert.equal(parseNumberOrWord('59'), 59);
    });

    it('converte palavras cardinais simples e variações de gênero', () => {
      assert.equal(parseNumberOrWord('zero'), 0);
      assert.equal(parseNumberOrWord('um'), 1);
      assert.equal(parseNumberOrWord('uma'), 1);
      assert.equal(parseNumberOrWord('dois'), 2);
      assert.equal(parseNumberOrWord('duas'), 2);
      assert.equal(parseNumberOrWord('três'), 3);
      assert.equal(parseNumberOrWord('tres'), 3);
      assert.equal(parseNumberOrWord('quatro'), 4);
      assert.equal(parseNumberOrWord('cinco'), 5);
      assert.equal(parseNumberOrWord('dez'), 10);
      assert.equal(parseNumberOrWord('quinze'), 15);
      assert.equal(parseNumberOrWord('vinte'), 20);
      assert.equal(parseNumberOrWord('trinta'), 30);
      assert.equal(parseNumberOrWord('quarenta'), 40);
      assert.equal(parseNumberOrWord('cinquenta'), 50);
    });

    it('converte números compostos ("dezenas e unidades")', () => {
      assert.equal(parseNumberOrWord('vinte e um'), 21);
      assert.equal(parseNumberOrWord('vinte e uma'), 21);
      assert.equal(parseNumberOrWord('vinte e dois'), 22);
      assert.equal(parseNumberOrWord('vinte e duas'), 22);
      assert.equal(parseNumberOrWord('trinta e cinco'), 35);
      assert.equal(parseNumberOrWord('quarenta e oito'), 48);
      assert.equal(parseNumberOrWord('cinquenta e nove'), 59);
    });

    it('retorna null para entradas inválidas ou não mapeadas', () => {
      assert.equal(parseNumberOrWord('cem'), null);
      assert.equal(parseNumberOrWord('muitos'), null);
      assert.equal(parseNumberOrWord(''), null);
      assert.equal(parseNumberOrWord('abc'), null);
    });
  });

  describe('H1 — parseRelativeTime', () => {
    it('1. Meia hora ("daqui a meia hora", "em meia hora") -> now + 30 min', () => {
      const res1 = parseRelativeTime('comprar pão daqui a meia hora', fixedNow);
      assert.ok(res1.dueAt);
      const expectedDue1 = new Date(fixedNow.getTime() + 30 * 60_000).toISOString();
      assert.equal(res1.dueAt, expectedDue1);
      assert.equal(res1.residualText, 'comprar pão');

      const res2 = parseRelativeTime('em meia hora levar o cachorro', fixedNow);
      assert.ok(res2.dueAt);
      assert.equal(res2.dueAt, expectedDue1);
      assert.equal(res2.residualText, 'levar o cachorro');
    });

    it('2. Minutos com dígitos e palavras cardinais', () => {
      // Dígitos
      const resDigits = parseRelativeTime('ligar pro dentista daqui a 20 minutos', fixedNow);
      assert.ok(resDigits.dueAt);
      assert.equal(
        resDigits.dueAt,
        new Date(fixedNow.getTime() + 20 * 60_000).toISOString()
      );
      assert.equal(resDigits.residualText, 'ligar pro dentista');

      const res5 = parseRelativeTime('em 5 minutos tomar remédio', fixedNow);
      assert.ok(res5.dueAt);
      assert.equal(res5.dueAt, new Date(fixedNow.getTime() + 5 * 60_000).toISOString());
      assert.equal(res5.residualText, 'tomar remédio');

      // Por extenso
      const resVinte = parseRelativeTime('ligar pro dentista daqui a vinte minutos', fixedNow);
      assert.ok(resVinte.dueAt);
      assert.equal(
        resVinte.dueAt,
        new Date(fixedNow.getTime() + 20 * 60_000).toISOString()
      );
      assert.equal(resVinte.residualText, 'ligar pro dentista');

      const resCinco = parseRelativeTime('em cinco minutos tomar café', fixedNow);
      assert.ok(resCinco.dueAt);
      assert.equal(resCinco.dueAt, new Date(fixedNow.getTime() + 5 * 60_000).toISOString());
      assert.equal(resCinco.residualText, 'tomar café');

      // 1 e 2 minutos (singular / variações de gênero)
      const resUm = parseRelativeTime('daqui a um minuto responder email', fixedNow);
      assert.ok(resUm.dueAt);
      assert.equal(resUm.dueAt, new Date(fixedNow.getTime() + 1 * 60_000).toISOString());
      assert.equal(resUm.residualText, 'responder email');

      const resDois = parseRelativeTime('daqui a dois minutos desligar forno', fixedNow);
      assert.ok(resDois.dueAt);
      assert.equal(resDois.dueAt, new Date(fixedNow.getTime() + 2 * 60_000).toISOString());
      assert.equal(resDois.residualText, 'desligar forno');
    });

    it('3. Horas com dígitos e palavras cardinais', () => {
      const res2h = parseRelativeTime('reunião em 2 horas', fixedNow);
      assert.ok(res2h.dueAt);
      assert.equal(res2h.dueAt, new Date(fixedNow.getTime() + 2 * 3600_000).toISOString());
      assert.equal(res2h.residualText, 'reunião');

      const resDuasH = parseRelativeTime('reunião em duas horas', fixedNow);
      assert.ok(resDuasH.dueAt);
      assert.equal(resDuasH.dueAt, new Date(fixedNow.getTime() + 2 * 3600_000).toISOString());
      assert.equal(resDuasH.residualText, 'reunião');

      const res1h = parseRelativeTime('daqui a 1 hora sair de casa', fixedNow);
      assert.ok(res1h.dueAt);
      assert.equal(res1h.dueAt, new Date(fixedNow.getTime() + 1 * 3600_000).toISOString());
      assert.equal(res1h.residualText, 'sair de casa');

      const resUmaH = parseRelativeTime('daqui a uma hora sair de casa', fixedNow);
      assert.ok(resUmaH.dueAt);
      assert.equal(resUmaH.dueAt, new Date(fixedNow.getTime() + 1 * 3600_000).toISOString());
      assert.equal(resUmaH.residualText, 'sair de casa');
    });

    it('4. Amanhã de tarde e amanhã à tarde -> 14:00 do dia seguinte', () => {
      const expected = new Date(fixedNow);
      expected.setDate(expected.getDate() + 1);
      expected.setHours(14, 0, 0, 0);

      const res1 = parseRelativeTime('pagar a conta amanhã de tarde', fixedNow);
      assert.equal(res1.dueAt, expected.toISOString());
      assert.equal(res1.residualText, 'pagar a conta');

      const res2 = parseRelativeTime('pagar a conta amanhã à tarde', fixedNow);
      assert.equal(res2.dueAt, expected.toISOString());
      assert.equal(res2.residualText, 'pagar a conta');

      const res3 = parseRelativeTime('amanhã a tarde pagar a conta', fixedNow);
      assert.equal(res3.dueAt, expected.toISOString());
      assert.equal(res3.residualText, 'pagar a conta');
    });

    it('5. Amanhã de noite e amanhã à noite -> 19:00 do dia seguinte', () => {
      const expected = new Date(fixedNow);
      expected.setDate(expected.getDate() + 1);
      expected.setHours(19, 0, 0, 0);

      const res1 = parseRelativeTime('jantar com amigos amanhã de noite', fixedNow);
      assert.equal(res1.dueAt, expected.toISOString());
      assert.equal(res1.residualText, 'jantar com amigos');

      const res2 = parseRelativeTime('jantar com amigos amanhã à noite', fixedNow);
      assert.equal(res2.dueAt, expected.toISOString());
      assert.equal(res2.residualText, 'jantar com amigos');
    });

    it('6. Amanhã de manhã e amanhã pela manhã -> 09:00 do dia seguinte', () => {
      const expected = new Date(fixedNow);
      expected.setDate(expected.getDate() + 1);
      expected.setHours(9, 0, 0, 0);

      const res1 = parseRelativeTime('fazer caminhada amanhã de manhã', fixedNow);
      assert.equal(res1.dueAt, expected.toISOString());
      assert.equal(res1.residualText, 'fazer caminhada');

      const res2 = parseRelativeTime('fazer caminhada amanhã pela manhã', fixedNow);
      assert.equal(res2.dueAt, expected.toISOString());
      assert.equal(res2.residualText, 'fazer caminhada');
    });

    it('7. Amanhã isolado -> 09:00 do dia seguinte', () => {
      const expected = new Date(fixedNow);
      expected.setDate(expected.getDate() + 1);
      expected.setHours(9, 0, 0, 0);

      const res1 = parseRelativeTime('comprar pão amanhã', fixedNow);
      assert.equal(res1.dueAt, expected.toISOString());
      assert.equal(res1.residualText, 'comprar pão');

      const res2 = parseRelativeTime('amanhã comprar pão', fixedNow);
      assert.equal(res2.dueAt, expected.toISOString());
      assert.equal(res2.residualText, 'comprar pão');
    });

    it('Casos negativos: sem indicação de tempo', () => {
      const semTempo1 = parseRelativeTime('comprar café', fixedNow);
      assert.equal(semTempo1.dueAt, null);
      assert.equal(semTempo1.residualText, 'comprar café');

      const semTempo2 = parseRelativeTime('ler o capítulo três de virtologia', fixedNow);
      assert.equal(semTempo2.dueAt, null);
      assert.equal(semTempo2.residualText, 'ler o capítulo três de virtologia');

      const semTempo3 = parseRelativeTime('', fixedNow);
      assert.equal(semTempo3.dueAt, null);
      assert.equal(semTempo3.residualText, '');
    });

    it('Remoção limpa de preposições e pontuação nas bordas do residualText', () => {
      const c1 = parseRelativeTime('comprar leite para amanhã de tarde', fixedNow);
      assert.equal(c1.residualText, 'comprar leite');

      const c2 = parseRelativeTime('comprar café, daqui a 20 minutos', fixedNow);
      assert.equal(c2.residualText, 'comprar café');

      const c3 = parseRelativeTime('daqui a 2 horas: estudar grego', fixedNow);
      assert.equal(c3.residualText, 'estudar grego');

      const c4 = parseRelativeTime('amanhã de manhã de pagar o boleto', fixedNow);
      assert.equal(c4.residualText, 'pagar o boleto');

      const c5 = parseRelativeTime('comprar flores pra amanhã', fixedNow);
      assert.equal(c5.residualText, 'comprar flores');
    });
  });

  describe('H2 — formatHumanRelative', () => {
    it('retorna "agora" para horários passados ou imediatos', () => {
      assert.equal(formatHumanRelative(fixedNow.toISOString(), fixedNow), 'agora');
      const past = new Date(fixedNow.getTime() - 10_000).toISOString();
      assert.equal(formatHumanRelative(past, fixedNow), 'agora');
    });

    it('deltas de minutos (< 60 min)', () => {
      const d1 = new Date(fixedNow.getTime() + 1 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d1, fixedNow), 'daqui a um minuto');

      const d2 = new Date(fixedNow.getTime() + 2 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d2, fixedNow), 'daqui a dois minutos');

      const d20 = new Date(fixedNow.getTime() + 20 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d20, fixedNow), 'daqui a 20 minutos');

      const d30 = new Date(fixedNow.getTime() + 30 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d30, fixedNow), 'daqui a meia hora');
    });

    it('deltas de horas (>= 60 min)', () => {
      const d60 = new Date(fixedNow.getTime() + 60 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d60, fixedNow), 'daqui a uma hora');

      const d90 = new Date(fixedNow.getTime() + 90 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d90, fixedNow), 'daqui a uma hora e meia');

      const d120 = new Date(fixedNow.getTime() + 120 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d120, fixedNow), 'daqui a 2 horas');

      const d150 = new Date(fixedNow.getTime() + 150 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d150, fixedNow), 'daqui a 2 horas e meia');

      const d61 = new Date(fixedNow.getTime() + 61 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d61, fixedNow), 'daqui a uma hora e um minuto');

      const d75 = new Date(fixedNow.getTime() + 75 * 60_000).toISOString();
      assert.equal(formatHumanRelative(d75, fixedNow), 'daqui a uma hora e 15 minutos');
    });

    it('períodos de amanhã', () => {
      const tomorrow = new Date(fixedNow);
      tomorrow.setDate(tomorrow.getDate() + 1);

      tomorrow.setHours(9, 0, 0, 0);
      assert.equal(formatHumanRelative(tomorrow.toISOString(), fixedNow), 'amanhã de manhã');

      tomorrow.setHours(14, 0, 0, 0);
      assert.equal(formatHumanRelative(tomorrow.toISOString(), fixedNow), 'amanhã de tarde');

      tomorrow.setHours(19, 0, 0, 0);
      assert.equal(formatHumanRelative(tomorrow.toISOString(), fixedNow), 'amanhã de noite');

      tomorrow.setHours(16, 0, 0, 0);
      assert.equal(formatHumanRelative(tomorrow.toISOString(), fixedNow), 'amanhã às 16 horas');
    });

    it('não gera markdown, abreviações ou pontuação indevida', () => {
      const formatted = formatHumanRelative(
        new Date(fixedNow.getTime() + 20 * 60_000).toISOString(),
        fixedNow
      );
      assert.equal(/[*_`#]/.test(formatted), false);
      assert.equal(/\bmin\b/i.test(formatted), false);
    });
  });
});
