import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  LembreteTool,
  NotaTool,
  mightBeMutation,
  selectMutatingToolByAction,
  createMutatingTools
} from '../tools/mutatingTools.js';
import { keywordConfirmation } from '../voice/sessionManager.js';
import type { IMutatingTool } from '../../shared/extensions/tools.js';

describe('Ferramentas Mutantes (Fase 5c) — Lembrete, Nota e Gates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-ai-mutating-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('mightBeMutation (MUTATION_GATE)', () => {
    it('detecta intenções de criar ou apagar lembrete ou nota', () => {
      const positivos = [
        'Lembrete: comprar pão',
        'Anota aí que eu preciso de leite',
        'Não esquece de ligar pro médico amanhã',
        'Guarda essa ideia pra mim',
        'Salva essa observação',
        'Registra que amanhã tem reunião',
        'Escreve isso no bloco de notas',
        'Apaga o lembrete',
        'Cancela a nota',
        'Remove o último lembrete',
        'Deleta a nota',
        'Descarta o lembrete',
        'Limpa os lembretes',
        'Tira essa nota',
        'Bota um lembrete pra amanhã',
        'Cria uma nota sobre o projeto',
        'Marca um lembrete às cinco',
        'Fixa uma nota importante',
        'Põe um lembrete pra não esquecer'
      ];

      for (const frase of positivos) {
        assert.equal(
          mightBeMutation(frase),
          true,
          `Esperava que mightBeMutation fosse true para "${frase}"`
        );
      }
    });

    it('não dispara em perguntas de domínio e conversas gerais', () => {
      const negativos = [
        'Explique a Aceitação dentro da Virtologia',
        'Faça uma análise exegética de Hebreus cinco',
        'Quem foi Agostinho de Hipona?',
        'Que horas são?',
        'Qual a data de hoje?',
        'Quanto é dezessete por cento de duzentos?',
        'Boa tarde, tudo bem com você?',
        'Qual o significado do perdão no método?'
      ];

      for (const frase of negativos) {
        assert.equal(
          mightBeMutation(frase),
          false,
          `Esperava que mightBeMutation fosse false para "${frase}"`
        );
      }
    });
  });

  describe('selectMutatingToolByAction', () => {
    it('retorna a ferramenta adequada pelo tipo de ação', () => {
      const tools = createMutatingTools(tmpDir);

      const lembreteCriar = selectMutatingToolByAction('LEMBRETE_CRIAR', tools);
      assert.equal(lembreteCriar?.name, 'LEMBRETE');

      const lembreteApagar = selectMutatingToolByAction('LEMBRETE_APAGAR', tools);
      assert.equal(lembreteApagar?.name, 'LEMBRETE');

      const notaCriar = selectMutatingToolByAction('NOTA_CRIAR', tools);
      assert.equal(notaCriar?.name, 'NOTA');

      const notaApagar = selectMutatingToolByAction('NOTA_APAGAR', tools);
      assert.equal(notaApagar?.name, 'NOTA');

      assert.equal(selectMutatingToolByAction('NENHUMA', tools), null);
      assert.equal(selectMutatingToolByAction('DESCONHECIDO', tools), null);
    });

    it('retorna null se a ferramenta estiver indisponível', () => {
      const mockTool: IMutatingTool = {
        name: 'LEMBRETE',
        description: 'Mock indisponível',
        isAvailable: () => false,
        preview: () => '',
        execute: () => ''
      };
      assert.equal(selectMutatingToolByAction('LEMBRETE_CRIAR', [mockTool]), null);
    });
  });

  describe('LembreteTool', () => {
    it('preview() e execute() com criação, prevenção de duplicata e apagamento', () => {
      const tools = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      assert.ok(tool);
      assert.equal(tool.isAvailable(), true);

      // Preview
      assert.equal(
        tool.preview('LEMBRETE_CRIAR', 'Comprar café'),
        'Posso criar o lembrete: Comprar café?'
      );
      assert.equal(
        tool.preview('LEMBRETE_APAGAR', null),
        'Posso apagar o lembrete mais recente?'
      );

      // Execute criar
      assert.equal(tool.execute('LEMBRETE_CRIAR', 'Comprar café'), 'Lembrete criado.');

      // Achado 6 / v5 §4.4: Prevenção de duplicata idêntica consecutiva
      assert.equal(tool.execute('LEMBRETE_CRIAR', 'Comprar café'), 'Isso já estava salvo.');

      // Criar segundo lembrete
      assert.equal(tool.execute('LEMBRETE_CRIAR', 'Lavar o carro'), 'Lembrete criado.');

      // Apagar o mais recente
      assert.equal(tool.execute('LEMBRETE_APAGAR', null), 'Lembrete apagado.');

      // Apagar o primeiro
      assert.equal(tool.execute('LEMBRETE_APAGAR', null), 'Lembrete apagado.');

      // Apagar quando não há nada
      assert.equal(tool.execute('LEMBRETE_APAGAR', null), 'Não há nenhum lembrete para apagar.');
    });
  });

  describe('NotaTool', () => {
    it('preview() e execute() com criação, prevenção de duplicata e apagamento', () => {
      const tools = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'NOTA')!;
      assert.ok(tool);
      assert.equal(tool.isAvailable(), true);

      // Preview
      assert.equal(
        tool.preview('NOTA_CRIAR', 'Ideia de aplicativo'),
        'Posso guardar a nota: Ideia de aplicativo?'
      );
      assert.equal(
        tool.preview('NOTA_APAGAR', null),
        'Posso apagar a nota mais recente?'
      );

      // Execute criar
      assert.equal(tool.execute('NOTA_CRIAR', 'Ideia de aplicativo'), 'Nota criada.');

      // Prevenção de duplicata consecutiva
      assert.equal(tool.execute('NOTA_CRIAR', 'Ideia de aplicativo'), 'Isso já estava salvo.');

      // Apagar
      assert.equal(tool.execute('NOTA_APAGAR', null), 'Nota apagada.');
      assert.equal(tool.execute('NOTA_APAGAR', null), 'Não há nenhuma nota para apagar.');
    });
  });

  describe('keywordConfirmation (Camada 0 — Whitelist Exata)', () => {
    it('reconhece confirmações exatas da whitelist', () => {
      const confirmacoes = [
        'Sim',
        'Sim!',
        'sim',
        'SIM',
        'Claro',
        'Confirmo',
        'Certo',
        'Exato',
        'Exatamente',
        'Positivo',
        'Isso mesmo',
        'Pode confirmar',
        'Com certeza'
      ];
      for (const frase of confirmacoes) {
        assert.equal(keywordConfirmation(frase), 'SIM', `Esperava SIM para "${frase}"`);
      }
    });

    it('reconhece negações exatas da whitelist', () => {
      const negacoes = [
        'Não',
        'não',
        'NÃO!',
        'Cancela',
        'Jamais',
        'Nunca',
        'Negativo',
        'Deixa pra lá',
        'Esquece isso',
        'Não quero'
      ];
      for (const frase of negacoes) {
        assert.equal(keywordConfirmation(frase), 'NAO', `Esperava NAO para "${frase}"`);
      }
    });

    it('Achado 1 da rodada 2: frases compostas ou de substring NÃO casam na Camada 0 (devolvem null para o LLM)', () => {
      const delegarAoLLM = [
        'Isso tá errado',
        'Pode esquecer',
        'Para mim está bom',
        'Cancela isso por favor',
        'Sim, mas só depois das seis',
        'Não sei dizer',
        'Acho que sim',
        'Talvez não',
        'Sim por favor.',
        'Pode',
        'Pode ser',
        'Pode sim',
        'Não por favor',
        'Nem pensar',
        'Agora não',
        'Para',
        'Pare'
      ];
      for (const frase of delegarAoLLM) {
        assert.equal(
          keywordConfirmation(frase),
          null,
          `Esperava null (delegar para Camada 1) para "${frase}"`
        );
      }
    });
  });
});
