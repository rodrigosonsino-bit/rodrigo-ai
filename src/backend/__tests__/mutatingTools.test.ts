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
import { keywordConfirmation, hasAffirmativeMarker, normalizeConfirmation } from '../voice/sessionManager.js';
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

  describe('hasAffirmativeMarker (Camada 2 — Gate de Marcador Afirmativo)', () => {
    it('reconhece cada marcador afirmativo isoladamente', () => {
      const affirmativeMarkers = [
        'sim',
        'claro',
        'confirmo',
        'confirma',
        'certo',
        'certeza',
        'exato',
        'exatamente',
        'positivo',
        'isso mesmo',
        'bora',
        'beleza',
        'fechou',
        'fechado',
        'manda',
        'pode sim',
        'pode criar',
        'pode marcar',
        'pode fazer',
        'pode apagar',
        'pode guardar',
        'pode salvar',
        'pode anotar',
        'ta valendo',
        'esta valendo',
        'perfeito',
        'combinado',
        'ta bom',
        'esta bom',
        'blz',
        'ok'
      ];

      for (const marker of affirmativeMarkers) {
        assert.equal(
          hasAffirmativeMarker(marker),
          true,
          `Esperava que hasAffirmativeMarker fosse true para o marcador isolado "${marker}"`
        );
      }
    });

    it('cada marcador de negação veta um marcador afirmativo presente na mesma frase', () => {
      const negationMarkers = [
        'nao',
        'nem',
        'nunca',
        'jamais',
        'cancela',
        'cancelar',
        'esquece',
        'esquecer',
        'tira',
        'tirar',
        'nada'
      ];

      // Cada marcador de negação veta um marcador afirmativo ("sim")
      for (const neg of negationMarkers) {
        assert.equal(
          hasAffirmativeMarker(`sim ${neg}`),
          false,
          `Esperava false para "sim ${neg}" (veto por "${neg}")`
        );
        assert.equal(
          hasAffirmativeMarker(`${neg}, sim`),
          false,
          `Esperava false para "${neg}, sim" (veto por "${neg}")`
        );
      }

      // Casos reais e frases de colisão adversarial (incluindo "claro que não" e "nada tá certo")
      const casosColisao = [
        'claro que não',
        'nada tá certo',
        'jamais confirma',
        'nunca com certeza',
        'nem, pode fazer isso',
        'cancela, pode sim',
        'pode apagar não, cancelar',
        'esquece, tá bom',
        'esquecer, fechado',
        'tira, beleza',
        'tirar, ok'
      ];

      for (const frase of casosColisao) {
        assert.equal(
          hasAffirmativeMarker(frase),
          false,
          `Esperava false para a colisão com negação "${frase}"`
        );
      }
    });

    it('respeita fronteira de palavra: "embora" não casa "bora" e "incerto" não casa "certo"', () => {
      assert.equal(hasAffirmativeMarker('embora'), false);
      assert.equal(hasAffirmativeMarker('Eu vou embora agora'), false);
      assert.equal(hasAffirmativeMarker('incerto'), false);
      assert.equal(hasAffirmativeMarker('O resultado ainda é incerto'), false);
    });

    it('teste de regressão direto do caso #18 real: "E, depois eu faço." deve ser false', () => {
      assert.equal(hasAffirmativeMarker('E, depois eu faço.'), false);
      assert.equal(hasAffirmativeMarker('e, depois eu faco'), false);
    });

    it('retorna true para as 9 frases da tabela de verificação item-a-item da v8', () => {
      const frasesV8 = [
        { frase: 'sim, pode criar', marcador: 'sim / pode criar' },
        { frase: 'manda ver', marcador: 'manda' },
        { frase: 'pode sim, vai fundo', marcador: 'pode sim / sim' },
        { frase: 'é isso mesmo, bora', marcador: 'isso mesmo / bora' },
        { frase: 'confirma aí que tá certo', marcador: 'confirma / certo' },
        { frase: 'isso, pode fazer', marcador: 'pode fazer' },
        { frase: 'Beleza? Deixe a registrado.', marcador: 'beleza' },
        { frase: 'fechou, pode marcar', marcador: 'fechou / pode marcar' },
        { frase: 'anota sim, tá valendo', marcador: 'sim' }
      ];

      for (const { frase, marcador } of frasesV8) {
        assert.equal(
          hasAffirmativeMarker(frase),
          true,
          `Esperava true para "${frase}" (marcador esperado: ${marcador})`
        );
      }
    });

    it('colapsa espaços internos repetidos em normalizeConfirmation', () => {
      assert.equal(normalizeConfirmation('sim   pode   criar'), 'sim pode criar');
      assert.equal(normalizeConfirmation('  pode    apagar   '), 'pode apagar');
      assert.equal(hasAffirmativeMarker('pode    apagar'), true);
      assert.equal(hasAffirmativeMarker('esta    valendo'), true);
    });

    it('achado 1 da auditoria de código (Hermes, 2026-09-23): "está bom" reconhecido, mesmo par tá/está de "ta valendo"/"esta valendo"', () => {
      // O Whisper costuma expandir a contração "tá" para a forma gramatical "está" — o par
      // precisa existir pra cada marcador contraído, não só pra "valendo". Faltava o espelho
      // de "ta bom" até este achado.
      assert.equal(hasAffirmativeMarker('tá bom'), true);
      assert.equal(hasAffirmativeMarker('está bom'), true);
      assert.equal(hasAffirmativeMarker('Está bom, pode criar.'), true);
    });

    it('achado 3 da auditoria de código (Hermes, 2026-09-23): limite estrutural — negação perdida pelo STT cujo resíduo contém marcador não é vetada', () => {
      // Documentando o limite, não "corrigindo" — não há correção possível numa camada que só
      // vê texto: se o STT engolir a negação e o resíduo coincidir com um marcador afirmativo,
      // o gate não tem como recuperar a informação perdida. Ver comentário em AFFIRMATIVE_MARKERS
      // (sessionManager.ts) para o raciocínio completo.
      assert.equal(
        hasAffirmativeMarker('pode fazer'), // residual real de "não, pode fazer" após o STT engolir "não,"
        true,
        'limite estrutural conhecido e documentado — o texto residual não carrega mais a negação'
      );
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
});
