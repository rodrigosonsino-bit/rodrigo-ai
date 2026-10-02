import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  LembreteTool,
  NotaTool,
  MemoriaTool,
  mightBeMutation,
  selectMutatingToolByAction,
  createMutatingTools
} from '../tools/mutatingTools.js';
import { ReminderScheduler } from '../tools/reminderScheduler.js';
import { createVoiceRuntime } from '../voice/voiceRuntime.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
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

    it('Fase 7: detecta intenções com memor e formas verbais de gravar, sem disparar em palavras não-mutantes', () => {
      const novosPositivos = [
        'Memorize que prefiro café sem açúcar',
        'Grava isso pra mim',
        'Grave essa preferência',
        'Gravou o que eu disse?',
        'Estou gravando meu nome',
        'Pode gravar que eu moro em SP'
      ];
      for (const frase of novosPositivos) {
        assert.equal(
          mightBeMutation(frase),
          true,
          `Esperava que mightBeMutation fosse true para "${frase}"`
        );
      }

      const falsosEvitados = [
        'Temos um problema de gravidade',
        'Ela está grávida de três meses',
        'A gravitação universal é uma lei da física'
      ];
      for (const frase of falsosEvitados) {
        assert.equal(
          mightBeMutation(frase),
          false,
          `Esperava que mightBeMutation fosse false para "${frase}"`
        );
      }
    });

    it('Fase 8: detecta intenções com edita/troca/corrige em formas fechadas, sem disparar em palavras como edital/trocadilho/trocado', () => {
      const novosPositivos = [
        'Troca esse lembrete pra ligar pro médico',
        'Corrige a nota sobre a reunião',
        'Estou editando o lembrete de amanhã',
        'Edite o texto da nota',
        'Edita essa memória sobre mim',
        'Troque esse lembrete',
        'Trocou a nota?',
        'Trocando o texto da nota',
        'Corrija o lembrete por favor',
        'Corrigiu o que eu pedi?',
        'Corrigindo a anotação'
      ];
      for (const frase of novosPositivos) {
        assert.equal(
          mightBeMutation(frase),
          true,
          `Esperava que mightBeMutation fosse true para "${frase}"`
        );
      }

      const falsosEvitados = [
        'Saiu o edital do concurso público',
        'Não entendi esse trocadilho',
        'Você tem trocado de dez reais?',
        'Os editais estão abertos para inscrição'
      ];
      for (const frase of falsosEvitados) {
        assert.equal(
          mightBeMutation(frase),
          false,
          `Esperava que mightBeMutation fosse false para "${frase}"`
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
      const { tools } = createMutatingTools(tmpDir);

      const lembreteCriar = selectMutatingToolByAction('LEMBRETE_CRIAR', tools);
      assert.equal(lembreteCriar?.name, 'LEMBRETE');

      const lembreteEditar = selectMutatingToolByAction('LEMBRETE_EDITAR', tools);
      assert.equal(lembreteEditar?.name, 'LEMBRETE');

      const lembreteApagar = selectMutatingToolByAction('LEMBRETE_APAGAR', tools);
      assert.equal(lembreteApagar?.name, 'LEMBRETE');

      const notaCriar = selectMutatingToolByAction('NOTA_CRIAR', tools);
      assert.equal(notaCriar?.name, 'NOTA');

      const notaEditar = selectMutatingToolByAction('NOTA_EDITAR', tools);
      assert.equal(notaEditar?.name, 'NOTA');

      const notaApagar = selectMutatingToolByAction('NOTA_APAGAR', tools);
      assert.equal(notaApagar?.name, 'NOTA');

      const memoriaGuardar = selectMutatingToolByAction('MEMORIA_GUARDAR', tools);
      assert.equal(memoriaGuardar?.name, 'MEMORIA');

      const memoriaEditar = selectMutatingToolByAction('MEMORIA_EDITAR', tools);
      assert.equal(memoriaEditar?.name, 'MEMORIA');

      const memoriaEsquecer = selectMutatingToolByAction('MEMORIA_ESQUECER', tools);
      assert.equal(memoriaEsquecer?.name, 'MEMORIA');

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
      const { tools } = createMutatingTools(tmpDir);
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
      const { tools } = createMutatingTools(tmpDir);
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

  describe('Fase 6 — Agendamento de Lembretes, Deduplicação Temporal e Ciclo de Vida (H3, H4, H5, H9, H10)', () => {
    it('H3 — preview() explicita o horário e execute() reutiliza o cache lastParsed', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;

      // preview com horário relativo
      const question = tool.preview('LEMBRETE_CRIAR', 'ligar pro dentista daqui a 20 minutos');
      assert.equal(
        question,
        'Posso criar o lembrete de ligar pro dentista para daqui a 20 minutos?'
      );

      // execute consome o cache
      const answer = tool.execute('LEMBRETE_CRIAR', 'ligar pro dentista daqui a 20 minutos');
      assert.equal(answer, 'Lembrete criado para daqui a 20 minutos.');

      // Verifica dados salvos no store
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
      const data = store.read();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].text, 'ligar pro dentista');
      assert.ok(data.items[0].dueAt);
      assert.equal(data.items[0].notifiedAt, null);

      scheduler.shutdown();
    });

    it('H3 — execute() sem preview prévio (cache miss) executa parsing via fallback', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;

      // Chamada direta a execute
      const answer = tool.execute('LEMBRETE_CRIAR', 'comprar pão em 10 minutos');
      assert.equal(answer, 'Lembrete criado para daqui a 10 minutos.');

      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
      const data = store.read();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].text, 'comprar pão');
      assert.ok(data.items[0].dueAt);

      scheduler.shutdown();
    });

    it('H4 — Deduplicação temporal em LembreteTool.execute()', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;

      // Cria lembrete com horário A (amanhã de tarde)
      const res1 = tool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã de tarde');
      assert.equal(res1, 'Lembrete criado para amanhã de tarde.');

      // Tentativa idêntica consecutiva com mesmo texto e mesmo dueAt -> bloqueado
      const resDup = tool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã de tarde');
      assert.equal(resDup, 'Isso já estava salvo.');

      // Mesma tarefa mas para horário diferente B (amanhã de noite) -> aceito
      const resDiffTime = tool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã de noite');
      assert.equal(resDiffTime, 'Lembrete criado para amanhã de noite.');

      // Marca o último item como já notificado
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
      const current = store.read();
      current.items[current.items.length - 1].notifiedAt = new Date().toISOString();
      store.write(current);

      // Agora mesma tarefa e mesmo horário de B pode ser recriado porque o anterior já foi notificado
      const resAfterNotified = tool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã de noite');
      assert.equal(resAfterNotified, 'Lembrete criado para amanhã de noite.');

      scheduler.shutdown();
    });

    it('H5 — Cancelamento de agendamento em LEMBRETE_APAGAR', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;

      tool.execute('LEMBRETE_CRIAR', 'pagar conta em 3 horas');
      assert.equal(scheduler.activeTimersCount, 1);

      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
      const saved = store.read();
      const itemId = saved.items[0].id;
      assert.equal(scheduler.hasTimer(itemId), true);

      // Apaga o lembrete
      const resApagar = tool.execute('LEMBRETE_APAGAR', null);
      assert.equal(resApagar, 'Lembrete apagado.');

      // Confirma que o timer foi cancelado no scheduler
      assert.equal(scheduler.activeTimersCount, 0);
      assert.equal(scheduler.hasTimer(itemId), false);

      scheduler.shutdown();
    });

    it('H9 — createMutatingTools desacoplado e injeção de customScheduler', () => {
      const mockStore = new JsonStore<StoredItem>(tmpDir, 'custom.json');
      const customScheduler = new ReminderScheduler(mockStore);

      const result = createMutatingTools(tmpDir, customScheduler);
      assert.equal(result.scheduler, customScheduler);
      assert.equal(result.tools.length, 3);
      assert.ok(result.memoriaStore);
      assert.equal(result.tools.some((t) => t.name === 'MEMORIA'), true);

      customScheduler.shutdown();
    });

    it('H9 — RODRIGO_VOICE_DISABLE=1 não instancia timers no voiceRuntime', async () => {
      const originalEnv = process.env.RODRIGO_VOICE_DISABLE;
      process.env.RODRIGO_VOICE_DISABLE = '1';
      try {
        const runtime = createVoiceRuntime(tmpDir);
        assert.equal(runtime.available, false);
        assert.equal(runtime.scheduler, undefined);
        await runtime.shutdown();
      } finally {
        if (originalEnv !== undefined) {
          process.env.RODRIGO_VOICE_DISABLE = originalEnv;
        } else {
          delete process.env.RODRIGO_VOICE_DISABLE;
        }
      }
    });

    it('H10 — Regressão da Fase 5c: criação de lembrete sem tempo continua atemporal e NotaTool atemporal', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const lembreteTool = tools.find((t) => t.name === 'LEMBRETE')!;
      const notaTool = tools.find((t) => t.name === 'NOTA')!;

      // Lembrete sem tempo
      assert.equal(
        lembreteTool.preview('LEMBRETE_CRIAR', 'comprar maçã'),
        'Posso criar o lembrete: comprar maçã?'
      );
      assert.equal(
        lembreteTool.execute('LEMBRETE_CRIAR', 'comprar maçã'),
        'Lembrete criado.'
      );

      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
      const data = store.read();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].text, 'comprar maçã');
      assert.equal(data.items[0].dueAt, null);
      assert.equal(data.items[0].notifiedAt, null);

      // NotaTool
      assert.equal(
        notaTool.preview('NOTA_CRIAR', 'ideia de podcast daqui a 20 minutos'),
        'Posso guardar a nota: ideia de podcast daqui a 20 minutos?'
      );
      assert.equal(
        notaTool.execute('NOTA_CRIAR', 'ideia de podcast daqui a 20 minutos'),
        'Nota criada.'
      );

      const notaStore = new JsonStore<StoredItem>(tmpDir, 'notas.json');
      const notaData = notaStore.read();
      assert.equal(notaData.items.length, 1);
      assert.equal(notaData.items[0].text, 'ideia de podcast daqui a 20 minutos');
      assert.equal(notaData.items[0].dueAt, undefined);

      scheduler.shutdown();
    });
  });

  describe('MemoriaTool (Fase 7 — H1)', () => {
    it('isAvailable() retorna sempre true', () => {
      const store = new JsonStore<StoredItem>(tmpDir, 'memorias.json');
      const tool = new MemoriaTool(store);
      assert.equal(tool.isAvailable(), true);
      assert.equal(tool.name, 'MEMORIA');
    });

    it('preview() formula a pergunta correta e valida conteúdo', () => {
      const store = new JsonStore<StoredItem>(tmpDir, 'memorias.json');
      const tool = new MemoriaTool(store);

      // MEMORIA_GUARDAR
      assert.equal(
        tool.preview('MEMORIA_GUARDAR', 'prefere respostas curtas'),
        'Posso guardar isso sobre você: prefere respostas curtas?'
      );

      // Validação de conteúdo ausente em GUARDAR
      assert.throws(
        () => tool.preview('MEMORIA_GUARDAR', null),
        /Conteúdo ausente para guardar memória\./
      );
      assert.throws(
        () => tool.preview('MEMORIA_GUARDAR', '   '),
        /Conteúdo ausente para guardar memória\./
      );

      // MEMORIA_ESQUECER: frase exata sem cauda
      assert.equal(
        tool.preview('MEMORIA_ESQUECER', null),
        'Posso apagar a memória mais recente?'
      );

      // Ação inválida
      assert.throws(
        () => tool.preview('LEMBRETE_CRIAR', 'teste'),
        /Ação inválida para MemoriaTool: LEMBRETE_CRIAR/
      );
    });

    it('execute() guarda memória e deduplica contra o array inteiro (H1)', () => {
      const store = new JsonStore<StoredItem>(tmpDir, 'memorias.json');
      const tool = new MemoriaTool(store);

      // 1. Guarda primeira memória
      const r1 = tool.execute('MEMORIA_GUARDAR', 'prefere respostas curtas');
      assert.equal(r1, 'Guardado.');
      assert.equal(store.read().items.length, 1);
      assert.equal(store.read().items[0].text, 'prefere respostas curtas');

      // 2. Guarda segunda memória (diferente)
      const r2 = tool.execute('MEMORIA_GUARDAR', 'seu nome é Rodrigo');
      assert.equal(r2, 'Guardado.');
      assert.equal(store.read().items.length, 2);

      // 3. Tenta guardar a primeira memória novamente (não é o último item do array!)
      // Achado 7 da rodada 1: deduplica contra o array inteiro, case-insensitive e trim
      const r3 = tool.execute('MEMORIA_GUARDAR', '  PREFERE RESPOSTAS CURTAS  ');
      assert.equal(r3, 'Isso já estava guardado.');
      // O array deve continuar com 2 itens
      assert.equal(store.read().items.length, 2);

      // Validação de erro em conteúdo ausente
      assert.throws(
        () => tool.execute('MEMORIA_GUARDAR', null),
        /Conteúdo ausente para guardar memória\./
      );
      assert.throws(
        () => tool.execute('MEMORIA_GUARDAR', '  '),
        /Conteúdo ausente para guardar memória\./
      );
    });

    it('execute() apaga a memória mais recente ou avisa que está vazia', () => {
      const store = new JsonStore<StoredItem>(tmpDir, 'memorias.json');
      const tool = new MemoriaTool(store);

      // Store vazia
      assert.equal(tool.execute('MEMORIA_ESQUECER', null), 'Não há nada guardado pra apagar.');

      // Guarda dois itens
      tool.execute('MEMORIA_GUARDAR', 'item 1');
      tool.execute('MEMORIA_GUARDAR', 'item 2');
      assert.equal(store.read().items.length, 2);

      // Apaga o mais recente (item 2)
      assert.equal(tool.execute('MEMORIA_ESQUECER', null), 'Apagado.');
      const dataAfterPop = store.read();
      assert.equal(dataAfterPop.items.length, 1);
      assert.equal(dataAfterPop.items[0].text, 'item 1');

      // Apaga o remanescente (item 1)
      assert.equal(tool.execute('MEMORIA_ESQUECER', null), 'Apagado.');
      assert.equal(store.read().items.length, 0);

      // Agora vazia novamente
      assert.equal(tool.execute('MEMORIA_ESQUECER', null), 'Não há nada guardado pra apagar.');

      // Ação inválida
      assert.throws(
        () => tool.execute('NOTA_APAGAR', null),
        /Ação inválida para MemoriaTool: NOTA_APAGAR/
      );
    });

    it('selectMutatingToolByAction() seleciona MemoriaTool para MEMORIA_GUARDAR e MEMORIA_ESQUECER', () => {
      const { tools } = createMutatingTools(tmpDir);
      const toolGuardar = selectMutatingToolByAction('MEMORIA_GUARDAR', tools);
      assert.ok(toolGuardar);
      assert.equal(toolGuardar.name, 'MEMORIA');

      const toolEsquecer = selectMutatingToolByAction('MEMORIA_ESQUECER', tools);
      assert.ok(toolEsquecer);
      assert.equal(toolEsquecer.name, 'MEMORIA');
      assert.equal(toolGuardar, toolEsquecer); // Mesma instância
    });
  });

  describe('Fase 8 — Edição de Lembrete, Nota e Memória (H1..H6)', () => {
    it('H1 — LEMBRETE_EDITAR substitui só o text e preserva id, createdAt, dueAt, notifiedAt', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      tool.execute('LEMBRETE_CRIAR', 'comprar café em 2 horas');
      const original = store.read().items[0];
      assert.ok(original.dueAt);
      assert.equal(original.notifiedAt, null);

      const res = tool.execute('LEMBRETE_EDITAR', 'comprar café em grãos');
      assert.equal(res, 'Lembrete atualizado.');

      const updated = store.read().items[0];
      assert.equal(updated.text, 'comprar café em grãos');
      assert.equal(updated.id, original.id);
      assert.equal(updated.createdAt, original.createdAt);
      assert.equal(updated.dueAt, original.dueAt);
      assert.equal(updated.notifiedAt, original.notifiedAt);

      scheduler.shutdown();
    });

    it('H1 — NOTA_EDITAR e MEMORIA_EDITAR substituem só o text e preservam id e createdAt', () => {
      const { tools, memoriaStore } = createMutatingTools(tmpDir);
      const notaTool = tools.find((t) => t.name === 'NOTA')!;
      const memoriaTool = tools.find((t) => t.name === 'MEMORIA')!;
      const notaStore = new JsonStore<StoredItem>(tmpDir, 'notas.json');

      // Nota
      notaTool.execute('NOTA_CRIAR', 'ideia inicial');
      const notaOriginal = notaStore.read().items[0];
      const resNota = notaTool.execute('NOTA_EDITAR', 'ideia aprimorada');
      assert.equal(resNota, 'Nota atualizada.');
      const notaUpdated = notaStore.read().items[0];
      assert.equal(notaUpdated.text, 'ideia aprimorada');
      assert.equal(notaUpdated.id, notaOriginal.id);
      assert.equal(notaUpdated.createdAt, notaOriginal.createdAt);

      // Memória
      memoriaTool.execute('MEMORIA_GUARDAR', 'gosta de chá verde');
      const memOriginal = memoriaStore.read().items[0];
      const resMem = memoriaTool.execute('MEMORIA_EDITAR', 'gosta de chá preto');
      assert.equal(resMem, 'Atualizado.');
      const memUpdated = memoriaStore.read().items[0];
      assert.equal(memUpdated.text, 'gosta de chá preto');
      assert.equal(memUpdated.id, memOriginal.id);
      assert.equal(memUpdated.createdAt, memOriginal.createdAt);
    });

    it('H2 — Store vazio retorna mensagem honesta específica por ferramenta sem lançar exceção', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const lembreteTool = tools.find((t) => t.name === 'LEMBRETE')!;
      const notaTool = tools.find((t) => t.name === 'NOTA')!;
      const memoriaTool = tools.find((t) => t.name === 'MEMORIA')!;

      assert.equal(
        lembreteTool.execute('LEMBRETE_EDITAR', 'novo texto'),
        'Não há nenhum lembrete para editar.'
      );
      assert.equal(
        notaTool.execute('NOTA_EDITAR', 'novo texto'),
        'Não há nenhuma nota para editar.'
      );
      assert.equal(
        memoriaTool.execute('MEMORIA_EDITAR', 'novo texto'),
        'Não há nada guardado para editar.'
      );

      scheduler.shutdown();
    });

    it('H3 — Integração com ReminderScheduler: timer não é duplicado nem cancelado, e fire() usa o texto atualizado', () => {
      let osascriptArgs: string[] = [];
      const fakeExecFile = ((cmd: string, args: string[], options: any, callback: any) => {
        osascriptArgs = args;
        const cb = typeof options === 'function' ? options : callback;
        cb(null, '', '');
      }) as any;

      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
      const scheduler = new ReminderScheduler(store, fakeExecFile);
      const { tools } = createMutatingTools(tmpDir, scheduler);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;

      // 1. Cria lembrete agendado
      tool.execute('LEMBRETE_CRIAR', 'reunião amanhã de tarde');
      assert.equal(scheduler.activeTimersCount, 1);
      const item = store.read().items[0];
      assert.equal(scheduler.hasTimer(item.id), true);

      // 2. Edita o lembrete
      const res = tool.execute('LEMBRETE_EDITAR', 'reunião estratégica de produto');
      assert.equal(res, 'Lembrete atualizado.');

      // 3. Timer não foi duplicado nem cancelado
      assert.equal(scheduler.activeTimersCount, 1);
      assert.equal(scheduler.hasTimer(item.id), true);

      // 4. Disparo do scheduler lê o item do store fresco e usa o texto atualizado
      (scheduler as any).fire(item.id);
      assert.ok(osascriptArgs.length > 0);
      assert.ok(
        osascriptArgs.some((arg: string) => arg.includes('reunião estratégica de produto')),
        `Script osascript deve conter o texto atualizado. Args: ${JSON.stringify(osascriptArgs)}`
      );
      assert.equal(
        osascriptArgs.some((arg: string) => arg.includes('reunião amanhã de tarde')),
        false,
        'Script osascript não deve conter o texto antigo'
      );
      assert.equal(scheduler.activeTimersCount, 0);

      scheduler.shutdown();
    });

    it('H4 — preview() formula a pergunta correta e valida conteúdo ausente em todas as ferramentas', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const lembreteTool = tools.find((t) => t.name === 'LEMBRETE')!;
      const notaTool = tools.find((t) => t.name === 'NOTA')!;
      const memoriaTool = tools.find((t) => t.name === 'MEMORIA')!;

      // Lembrete
      assert.equal(
        lembreteTool.preview('LEMBRETE_EDITAR', 'ligar para o médico'),
        'Posso trocar o lembrete mais recente para: ligar para o médico?'
      );
      assert.throws(
        () => lembreteTool.preview('LEMBRETE_EDITAR', null),
        /Conteúdo ausente para editar lembrete\./
      );
      assert.throws(
        () => lembreteTool.preview('LEMBRETE_EDITAR', '   '),
        /Conteúdo ausente para editar lembrete\./
      );
      assert.throws(
        () => lembreteTool.execute('LEMBRETE_EDITAR', null),
        /Conteúdo ausente para editar lembrete\./
      );

      // Nota
      assert.equal(
        notaTool.preview('NOTA_EDITAR', 'comprar materiais'),
        'Posso trocar a nota mais recente para: comprar materiais?'
      );
      assert.throws(
        () => notaTool.preview('NOTA_EDITAR', null),
        /Conteúdo ausente para editar nota\./
      );
      assert.throws(
        () => notaTool.preview('NOTA_EDITAR', '   '),
        /Conteúdo ausente para editar nota\./
      );
      assert.throws(
        () => notaTool.execute('NOTA_EDITAR', null),
        /Conteúdo ausente para editar nota\./
      );

      // Memória
      assert.equal(
        memoriaTool.preview('MEMORIA_EDITAR', 'seu nome é Rodrigo Sonsino'),
        'Posso trocar essa memória para: seu nome é Rodrigo Sonsino?'
      );
      assert.throws(
        () => memoriaTool.preview('MEMORIA_EDITAR', null),
        /Conteúdo ausente para editar memória\./
      );
      assert.throws(
        () => memoriaTool.preview('MEMORIA_EDITAR', '   '),
        /Conteúdo ausente para editar memória\./
      );
      assert.throws(
        () => memoriaTool.execute('MEMORIA_EDITAR', null),
        /Conteúdo ausente para editar memória\./
      );

      scheduler.shutdown();
    });

    it('H5 — LEMBRETE_EDITAR em lembrete já notificado é recusado com mensagem honesta', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      tool.execute('LEMBRETE_CRIAR', 'tomar remédio');
      const current = store.read();
      current.items[0].notifiedAt = new Date().toISOString();
      store.write(current);

      const res = tool.execute('LEMBRETE_EDITAR', 'tomar remédio depois');
      assert.equal(res, 'Esse lembrete já foi disparado, não é possível editar mais.');

      // Confirma que o texto não foi alterado
      const after = store.read();
      assert.equal(after.items[0].text, 'tomar remédio');

      scheduler.shutdown();
    });

    it('H6 — No-op em lembrete, nota e memória é tratado sem modificar dados', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const lembreteTool = tools.find((t) => t.name === 'LEMBRETE')!;
      const notaTool = tools.find((t) => t.name === 'NOTA')!;
      const memoriaTool = tools.find((t) => t.name === 'MEMORIA')!;

      // Lembrete
      lembreteTool.execute('LEMBRETE_CRIAR', 'comprar pão');
      assert.equal(
        lembreteTool.execute('LEMBRETE_EDITAR', 'comprar pão'),
        'Isso já era o texto do lembrete.'
      );

      // Nota
      notaTool.execute('NOTA_CRIAR', 'minha anotação');
      assert.equal(
        notaTool.execute('NOTA_EDITAR', 'minha anotação'),
        'Isso já era o texto da nota.'
      );

      // Memória
      memoriaTool.execute('MEMORIA_GUARDAR', 'prefere café');
      assert.equal(
        memoriaTool.execute('MEMORIA_EDITAR', '  PREFERE CAFÉ  '),
        'Isso já era o texto guardado.'
      );

      scheduler.shutdown();
    });

    it('H6 — MEMORIA_EDITAR recusa duplicata contra outros itens da lista (mas permite editar pro próprio texto caindo em no-op)', () => {
      const { tools } = createMutatingTools(tmpDir);
      const memoriaTool = tools.find((t) => t.name === 'MEMORIA')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'memorias.json');

      // Guarda dois itens
      memoriaTool.execute('MEMORIA_GUARDAR', 'item um');
      memoriaTool.execute('MEMORIA_GUARDAR', 'item dois');
      assert.equal(store.read().items.length, 2);

      // Tenta editar o mais recente (item dois) para o texto do item um -> recusado
      const resDup = memoriaTool.execute('MEMORIA_EDITAR', 'ITEM UM');
      assert.equal(resDup, 'Isso já estava guardado.');

      // Verifica que o item dois continua inalterado
      assert.equal(store.read().items[1].text, 'item dois');

      // Edita para algo inédito -> aceito
      const resOk = memoriaTool.execute('MEMORIA_EDITAR', 'item três');
      assert.equal(resOk, 'Atualizado.');
      assert.equal(store.read().items[1].text, 'item três');
    });

    it('Defesa em profundidade: LEMBRETE_EDITAR recusa pedidos de troca de horário disfarçados de edição de texto', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      tool.execute('LEMBRETE_CRIAR', 'comprar pão');

      const frasesComHorario = [
        'comprar pão amanhã de tarde',
        'comprar pão amanhã às 10',
        'comprar pão daqui a meia hora',
        'comprar pão em 20 minutos',
        'amanhã de noite comprar pão'
      ];

      for (const frase of frasesComHorario) {
        const res = tool.execute('LEMBRETE_EDITAR', frase);
        assert.equal(
          res,
          'Não dá pra mudar o horário editando o texto — apague e crie um lembrete novo com o horário certo.',
          `Esperava recusa com defesa em profundidade para: "${frase}"`
        );
      }

      // Confirma que o texto do lembrete permanece intacto
      assert.equal(store.read().items[0].text, 'comprar pão');

      scheduler.shutdown();
    });
  });

  describe('Fase 9 — Recorrência em LembreteTool (H3, H6, H7, H8)', () => {
    it('H3 — criação de lembrete recorrente persiste recurrence + dueAt, agenda timer e formata respostas', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      const previewText = tool.preview('LEMBRETE_CRIAR', 'me lembra todo dia às 8 da manhã de tomar o remédio');
      assert.equal(
        previewText,
        'Posso criar o lembrete de me lembra de tomar o remédio, todo dia às 8 horas?'
      );

      const execText = tool.execute('LEMBRETE_CRIAR', 'me lembra todo dia às 8 da manhã de tomar o remédio');
      assert.equal(
        execText,
        'Lembrete criado, vou te avisar todo dia às 8 horas.'
      );

      const items = store.read().items;
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item.text, 'me lembra de tomar o remédio');
      assert.deepEqual(item.recurrence, { type: 'daily', hour: 8, minute: 0 });
      assert.ok(item.dueAt);
      assert.equal(item.notifiedAt, null);
      assert.equal(scheduler.hasTimer(item.id), true);

      // Deduplicação considerando recurrence:
      // Tentar criar exatamente a mesma recorrência -> duplicata
      const dup = tool.execute('LEMBRETE_CRIAR', 'me lembra todo dia às 8 da manhã de tomar o remédio');
      assert.equal(dup, 'Isso já estava salvo.');
      assert.equal(store.read().items.length, 1);

      scheduler.shutdown();
    });

    it('H3 — deduplicação não bloqueia indevidamente lembrete único com mesmo texto', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      // Cria lembrete recorrente
      tool.execute('LEMBRETE_CRIAR', 'todo dia às 9h tomar café');
      assert.equal(store.read().items.length, 1);

      // Cria lembrete não-recorrente com mesmo texto
      const resNonRec = tool.execute('LEMBRETE_CRIAR', 'tomar café');
      assert.equal(resNonRec, 'Lembrete criado.');
      assert.equal(store.read().items.length, 2);
      assert.equal(store.read().items[1].recurrence, undefined);

      scheduler.shutdown();
    });

    it('H6 — LEMBRETE_APAGAR cancela recorrência e timer no scheduler', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      tool.execute('LEMBRETE_CRIAR', 'todo domingo de manhã passear');
      assert.equal(store.read().items.length, 1);
      const id = store.read().items[0].id;
      assert.equal(scheduler.hasTimer(id), true);

      const previewApagar = tool.preview('LEMBRETE_APAGAR', null);
      assert.equal(previewApagar, 'Posso apagar o lembrete mais recente?');

      const execApagar = tool.execute('LEMBRETE_APAGAR', null);
      assert.equal(execApagar, 'Lembrete apagado.');

      assert.equal(store.read().items.length, 0);
      assert.equal(scheduler.hasTimer(id), false);

      scheduler.shutdown();
    });

    it('H7 — LEMBRETE_EDITAR recusa frase de recorrência com mensagem específica de §4.8', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      tool.execute('LEMBRETE_CRIAR', 'tomar vitamina');

      const frasesRecorrentes = [
        'todo dia às 8h tomar vitamina',
        'tomar vitamina todo dia às 8 da manhã',
        'toda segunda às 9h tomar vitamina',
        'todo domingo de manhã passear',
        'tomar vitamina todo dia de tarde'
      ];

      for (const frase of frasesRecorrentes) {
        const res = tool.execute('LEMBRETE_EDITAR', frase);
        assert.equal(
          res,
          'Não dá pra mudar a recorrência editando o texto — apague e crie um lembrete novo.',
          `Esperava recusa com mensagem de recorrência para: "${frase}"`
        );
      }

      // O lembrete original não foi alterado
      assert.equal(store.read().items[0].text, 'tomar vitamina');

      // Frase com horário simples continua retornando a mensagem de horário da Fase 8
      const resHorario = tool.execute('LEMBRETE_EDITAR', 'tomar vitamina amanhã às 10');
      assert.equal(
        resHorario,
        'Não dá pra mudar o horário editando o texto — apague e crie um lembrete novo com o horário certo.'
      );

      // Edição de texto pura continua funcionando normalmente
      const resOk = tool.execute('LEMBRETE_EDITAR', 'tomar vitamina C');
      assert.equal(resOk, 'Lembrete atualizado.');
      assert.equal(store.read().items[0].text, 'tomar vitamina C');

      scheduler.shutdown();
    });

    it('H8 — Regressão: lembrete não-recorrente funciona identicamente', () => {
      const { tools, scheduler } = createMutatingTools(tmpDir);
      const tool = tools.find((t) => t.name === 'LEMBRETE')!;
      const store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');

      const previewRes = tool.preview('LEMBRETE_CRIAR', 'comprar pão amanhã de manhã');
      assert.ok(previewRes.includes('Posso criar o lembrete de comprar pão para'));

      const execRes = tool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã de manhã');
      assert.ok(execRes.includes('Lembrete criado para'));

      const items = store.read().items;
      assert.equal(items.length, 1);
      assert.equal(items[0].recurrence, undefined);
      assert.ok(items[0].dueAt);
      assert.equal(items[0].notifiedAt, null);

      // Deduplicação não-recorrente funciona
      const dup = tool.execute('LEMBRETE_CRIAR', 'comprar pão amanhã de manhã');
      assert.equal(dup, 'Isso já estava salvo.');

      scheduler.shutdown();
    });
  });
});
