import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HoraAtualTool,
  DataAtualTool,
  createSystemTools,
  selectToolByName,
  mightBeTemporal,
  TOOL_FAILURE_TEXT
} from '../tools/index.js';
import type { ITool } from '../../shared/extensions/tools.js';

describe('Ferramentas do Sistema (Fase 5b) — Unitários e Contratos H1-H4', () => {
  describe('H1: Filtro permissivo mightBeTemporal', () => {
    it('detecta coloquiais temporais (incluindo "século")', () => {
      const coloquiais = [
        'São que horas?',
        'Que hora que é?',
        'Tá que horas?',
        'Hoje é que dia?',
        'Hoje é dia quanto?',
        'Cê sabe que horas são?',
        'Tá tarde?',
        'Já passou do meio-dia?',
        'Em que século estamos?',
        'Que horas são agora?',
        'Qual a data de hoje?',
        'Estamos em que mês mesmo?',
        'Quantos dias faltam?',
        'Em que ano nós estamos?',
        'Como está o calendário?',
        'Olhe no relógio',
        'Quando vai acontecer?',
        'Boa tarde',
        'Boa noite',
        'Amanhã de manhã',
        'Ontem à noite',
        'Espere um minuto'
      ];

      for (const frase of coloquiais) {
        assert.equal(
          mightBeTemporal(frase),
          true,
          `Esperava que mightBeTemporal fosse true para "${frase}"`
        );
      }
    });

    it('não dispara em perguntas de domínio e assuntos não-temporais', () => {
      const negativos = [
        'Explique a Aceitação dentro da Virtologia',
        'Faça uma análise exegética de Hebreus cinco',
        'Quanto é dezessete por cento de oitocentos e cinquenta',
        'Quem foi Policarpo de Esmirna?',
        'Fale sobre o significado da graça na vida cristã.',
        'Qual o conceito de perdão no método?',
        'Defina santificação e justificação.',
        'Resuma a teologia paulina.'
      ];

      for (const frase of negativos) {
        assert.equal(
          mightBeTemporal(frase),
          false,
          `Esperava que mightBeTemporal fosse false para "${frase}"`
        );
      }
    });
  });

  describe('H3: execute() com Clock fixo', () => {
    it('HoraAtualTool: formata com concordância correta para singular, plural e minutos zerados', () => {
      // 01:01 -> "É 1 hora e 1 minuto."
      const t1 = new HoraAtualTool(() => new Date('2026-09-21T01:01:00'));
      assert.equal(t1.execute(), 'É 1 hora e 1 minuto.');

      // 11:00 -> "São 11 horas em ponto."
      const t2 = new HoraAtualTool(() => new Date('2026-09-21T11:00:00'));
      assert.equal(t2.execute(), 'São 11 horas em ponto.');

      // 12:00 -> "São 12 horas em ponto."
      const t3 = new HoraAtualTool(() => new Date('2026-09-21T12:00:00'));
      assert.equal(t3.execute(), 'São 12 horas em ponto.');

      // 11:06 -> "São 11 horas e 6 minutos."
      const t4 = new HoraAtualTool(() => new Date('2026-09-21T11:06:00'));
      assert.equal(t4.execute(), 'São 11 horas e 6 minutos.');
    });

    it('DataAtualTool: formata a data completa em português', () => {
      const t = new DataAtualTool(() => new Date('2026-09-21T12:00:00'));
      assert.equal(t.execute(), 'Hoje é segunda-feira, 21 de setembro de 2026.');
    });
  });

  describe('H4: selectToolByName', () => {
    it('retorna null para NENHUMA', () => {
      const tools = createSystemTools();
      assert.equal(selectToolByName('NENHUMA', tools), null);
    });

    it('retorna null para ferramenta desconhecida', () => {
      const tools = createSystemTools();
      assert.equal(selectToolByName('DESCONHECIDA', tools), null);
      assert.equal(selectToolByName('BANANA', tools), null);
    });

    it('retorna a instância correta para HORA e DATA', () => {
      const tools = createSystemTools();
      const hora = selectToolByName('HORA', tools);
      assert.ok(hora);
      assert.equal(hora.name, 'HORA');
      assert.equal(hora.isAvailable(), true);

      const data = selectToolByName('DATA', tools);
      assert.ok(data);
      assert.equal(data.name, 'DATA');
      assert.equal(data.isAvailable(), true);
    });

    it('retorna null se a ferramenta existir mas não estiver disponível', () => {
      const mockTool: ITool = {
        name: 'HORA',
        description: 'Mock',
        isAvailable: () => false,
        execute: () => '...'
      };
      assert.equal(selectToolByName('HORA', [mockTool]), null);
    });
  });

  describe('Constante de falha de execução', () => {
    it('TOOL_FAILURE_TEXT tem o texto determinístico fixo', () => {
      assert.equal(
        TOOL_FAILURE_TEXT,
        'Não consegui consultar o relógio do sistema agora.'
      );
    });
  });
});
