import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReminderScheduler, OVERDUE_CUTOFF_MS } from '../tools/reminderScheduler.js';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';

describe('ReminderScheduler (Fase 6 — H6, H7 & H8)', () => {
  let tmpDir: string;
  let store: JsonStore<StoredItem>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodrigo-ai-scheduler-test-'));
    store = new JsonStore<StoredItem>(tmpDir, 'lembretes.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('H6 — schedule(), fire() e notificação confiável', () => {
    it('dispara timer curto, invoca execFile("osascript"), grava notifiedAt e limpa o Map', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];

      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ cmd, args });
        // Simula sucesso imediato
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      // Salva item no store
      const id = 'test-item-1';
      const dueAt = new Date(Date.now() + 50).toISOString();
      store.write({
        items: [{ id, text: 'Tomar água', createdAt: new Date().toISOString(), dueAt, notifiedAt: null }]
      });

      scheduler.schedule({ id, text: 'Tomar água', dueAt });
      assert.equal(scheduler.activeTimersCount, 1);
      assert.equal(scheduler.hasTimer(id), true);

      // Aguarda disparo do timer (~80ms)
      await new Promise((r) => setTimeout(r, 90));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'osascript');
      assert.ok(calls[0].args[1].includes('display notification "Tomar água" with title "Lembrete"'));

      // Confirma que o timer foi removido do Map
      assert.equal(scheduler.activeTimersCount, 0);

      // Confirma que notifiedAt foi gravado no store
      const updated = store.read();
      assert.equal(updated.items.length, 1);
      assert.ok(updated.items[0].notifiedAt, 'notifiedAt deve ser preenchido após sucesso');
    });

    it('em caso de erro no execFile: emite console.error e NÃO grava notifiedAt', async () => {
      const originalConsoleError = console.error;
      const errorsLogged: any[] = [];
      console.error = (...args: any[]) => errorsLogged.push(args);

      try {
        const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
          cb(new Error('Permissão negada no macOS'));
        }) as any;

        const scheduler = new ReminderScheduler(store, mockExecFile);

        const id = 'test-item-fail';
        const dueAt = new Date(Date.now() + 30).toISOString();
        store.write({
          items: [{ id, text: 'Comprar café', createdAt: new Date().toISOString(), dueAt, notifiedAt: null }]
        });

        scheduler.schedule({ id, text: 'Comprar café', dueAt });
        await new Promise((r) => setTimeout(r, 60));

        assert.ok(errorsLogged.length >= 1, 'Deve logar erro via console.error');
        assert.equal(scheduler.activeTimersCount, 0, 'Timer ainda deve ser removido do Map');

        // Confirma que notifiedAt continua null
        const updated = store.read();
        assert.equal(updated.items[0].notifiedAt, null);
      } finally {
        console.error = originalConsoleError;
      }
    });

    it('sequenciamento no bootstrap() com itens atrasados (delay incremental de 200ms)', async () => {
      const callTimestamps: number[] = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        callTimestamps.push(Date.now());
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      const now = new Date();
      const item1: StoredItem = {
        id: 'late-1',
        text: 'Atrasado 1',
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() - 1000).toISOString(),
        notifiedAt: null
      };
      const item2: StoredItem = {
        id: 'late-2',
        text: 'Atrasado 2',
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() - 2000).toISOString(),
        notifiedAt: null
      };
      const item3: StoredItem = {
        id: 'late-3',
        text: 'Atrasado 3',
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() - 3000).toISOString(),
        notifiedAt: null
      };

      store.write({ items: [item1, item2, item3] });

      scheduler.bootstrap(now);

      // Espera 500ms para todos os 3 disparos sequenciados ocorrerem (0ms, 200ms, 400ms)
      await new Promise((r) => setTimeout(r, 550));

      assert.equal(callTimestamps.length, 3);
      // Confirma que não foram chamados no mesmo instante
      const diff1 = callTimestamps[1] - callTimestamps[0];
      const diff2 = callTimestamps[2] - callTimestamps[1];
      assert.ok(diff1 >= 150, `diff1 deve ser >= 150ms, obtido: ${diff1}`);
      assert.ok(diff2 >= 150, `diff2 deve ser >= 150ms, obtido: ${diff2}`);
    });

    it('atomicidade de itens expirados sob exceção no loop de bootstrap()', () => {
      const scheduler = new ReminderScheduler(store);

      const now = new Date();
      // item 1: expirado há > 24h
      const item1: StoredItem = {
        id: 'exp-1',
        text: 'Expirado 1',
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() - OVERDUE_CUTOFF_MS - 10_000).toISOString(),
        notifiedAt: null
      };
      // item 2: inválido, lança erro no meio do loop
      const item2: StoredItem = {
        id: 'inv-2',
        text: 'Inválido',
        createdAt: now.toISOString(),
        dueAt: 'data-invalida',
        notifiedAt: null
      };
      // item 3: expirado há > 24h
      const item3: StoredItem = {
        id: 'exp-3',
        text: 'Expirado 3',
        createdAt: now.toISOString(),
        dueAt: new Date(now.getTime() - OVERDUE_CUTOFF_MS - 20_000).toISOString(),
        notifiedAt: null
      };

      store.write({ items: [item1, item2, item3] });

      assert.throws(() => scheduler.bootstrap(now), /Data de agendamento inválida/);

      // Confirma que nenhum dos itens expirados (nem mesmo item1) foi marcado como notifiedAt
      const reRead = store.read();
      assert.equal(reRead.items[0].notifiedAt, null);
      assert.equal(reRead.items[1].notifiedAt, null);
      assert.equal(reRead.items[2].notifiedAt, null);
    });
  });

  describe('H7 — bootstrap() e política de corte de 24 horas', () => {
    it('item vencido há <= 24h dispara com título "Lembrete (atrasado)"', async () => {
      const calls: Array<{ args: string[] }> = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ args });
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      const now = new Date();
      const pastDue = new Date(now.getTime() - 2 * 3600_000).toISOString(); // 2h atrás

      store.write({
        items: [
          {
            id: 'late-item',
            text: 'Reunião esquecida',
            createdAt: now.toISOString(),
            dueAt: pastDue,
            notifiedAt: null
          }
        ]
      });

      scheduler.bootstrap(now);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(calls.length, 1);
      assert.ok(calls[0].args[1].includes('with title "Lembrete (atrasado)"'));
    });

    it('item vencido há > 24h emite console.warn e é marcado como notifiedAt sem popup no SO', async () => {
      const originalConsoleWarn = console.warn;
      const warns: any[] = [];
      console.warn = (...args: any[]) => warns.push(args);

      let osascriptCalled = false;
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        osascriptCalled = true;
        cb(null, '', '');
      }) as any;

      try {
        const scheduler = new ReminderScheduler(store, mockExecFile);

        const now = new Date();
        const ancientDue = new Date(now.getTime() - (OVERDUE_CUTOFF_MS + 3600_000)).toISOString(); // 25h atrás

        store.write({
          items: [
            {
              id: 'ancient-item',
              text: 'Consulta de ontem',
              createdAt: now.toISOString(),
              dueAt: ancientDue,
              notifiedAt: null
            }
          ]
        });

        scheduler.bootstrap(now);
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(osascriptCalled, false, 'Não deve chamar osascript para item > 24h');
        assert.ok(warns.length >= 1, 'Deve emitir console.warn');
        assert.ok(warns[0][0].includes('expirado há mais de 24h'));

        const reRead = store.read();
        assert.ok(reRead.items[0].notifiedAt, 'Item deve ser marcado como notifiedAt');
      } finally {
        console.warn = originalConsoleWarn;
      }
    });

    it('item futuro é agendado no Map sem disparo imediato', async () => {
      let osascriptCalled = false;
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        osascriptCalled = true;
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      const now = new Date();
      const futureDue = new Date(now.getTime() + 10 * 60_000).toISOString(); // 10 min no futuro

      store.write({
        items: [
          {
            id: 'future-item',
            text: 'Comprar frutas',
            createdAt: now.toISOString(),
            dueAt: futureDue,
            notifiedAt: null
          }
        ]
      });

      scheduler.bootstrap(now);
      assert.equal(scheduler.activeTimersCount, 1);
      assert.equal(scheduler.hasTimer('future-item'), true);
      assert.equal(osascriptCalled, false);

      scheduler.shutdown();
    });

    it('achado 7 (auditoria de código, Hermes, 2026-09-24): mix futuro+atrasado+expirado numa chamada só', async () => {
      const calls: Array<{ args: string[] }> = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ args });
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);
      const now = new Date();

      store.write({
        items: [
          {
            id: 'mix-future',
            text: 'Item futuro',
            createdAt: now.toISOString(),
            dueAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
            notifiedAt: null
          },
          {
            id: 'mix-late',
            text: 'Item atrasado',
            createdAt: now.toISOString(),
            dueAt: new Date(now.getTime() - 2 * 3600_000).toISOString(), // 2h atrás
            notifiedAt: null
          },
          {
            id: 'mix-expired',
            text: 'Item expirado',
            createdAt: now.toISOString(),
            dueAt: new Date(now.getTime() - (OVERDUE_CUTOFF_MS + 3600_000)).toISOString(), // 25h atrás
            notifiedAt: null
          }
        ]
      });

      scheduler.bootstrap(now);

      // O futuro entra no Map imediatamente, síncrono.
      assert.equal(scheduler.hasTimer('mix-future'), true);

      await new Promise((r) => setTimeout(r, 60));

      // O atrasado disparou osascript com título de atraso; o expirado nunca chamou osascript.
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args[1].includes('Item atrasado'));
      assert.ok(calls[0].args[1].includes('with title "Lembrete (atrasado)"'));

      const reRead = store.read();
      const byId = Object.fromEntries(reRead.items.map((it) => [it.id, it]));
      assert.equal(byId['mix-future'].notifiedAt, null, 'futuro não deve ser notificado ainda');
      assert.ok(byId['mix-late'].notifiedAt, 'atrasado deve ter notifiedAt gravado após o disparo');
      assert.ok(byId['mix-expired'].notifiedAt, 'expirado deve ser marcado sem popup no SO');

      scheduler.shutdown();
    });
  });

  describe('H8 — shutdown()', () => {
    it('cancela todos os timers pendentes e esvazia o Map', () => {
      const scheduler = new ReminderScheduler(store);

      const future1 = new Date(Date.now() + 100_000).toISOString();
      const future2 = new Date(Date.now() + 200_000).toISOString();

      scheduler.schedule({ id: 'item-1', text: 'Tarefa 1', dueAt: future1 });
      scheduler.schedule({ id: 'item-2', text: 'Tarefa 2', dueAt: future2 });

      assert.equal(scheduler.activeTimersCount, 2);

      scheduler.shutdown();

      assert.equal(scheduler.activeTimersCount, 0);
      assert.equal(scheduler.hasTimer('item-1'), false);
      assert.equal(scheduler.hasTimer('item-2'), false);
    });
  });

  describe('Fase 9 — H4: Disparo com reagendamento e correção de jitter', () => {
    it('item recorrente: notify() bem-sucedido mantém notifiedAt null, avança dueAt para próxima ocorrência e agenda novo timer', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      const id = 'rec-item-1';
      const initialDueAt = new Date(Date.now() + 40).toISOString();
      store.write({
        items: [
          {
            id,
            text: 'Tomar remédio todo dia',
            createdAt: new Date().toISOString(),
            dueAt: initialDueAt,
            notifiedAt: null,
            recurrence: { type: 'daily', hour: 9, minute: 0 }
          }
        ]
      });

      scheduler.schedule({ id, text: 'Tomar remédio todo dia', dueAt: initialDueAt });
      assert.equal(scheduler.activeTimersCount, 1);

      // Aguarda disparo do timer
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(calls.length, 1);
      assert.ok(calls[0].args[1].includes('Tomar remédio todo dia'));
      assert.ok(calls[0].args[1].includes('with title "Lembrete"'));

      const updated = store.read();
      assert.equal(updated.items.length, 1);
      const it = updated.items[0];

      // notifiedAt permanece null (não é finalizado)
      assert.equal(it.notifiedAt, null);
      // dueAt avançou para a próxima ocorrência (estritamente posterior ao initialDueAt)
      assert.ok(new Date(it.dueAt!).getTime() > new Date(initialDueAt).getTime());
      // Novo timer foi agendado
      assert.equal(scheduler.hasTimer(id), true);

      scheduler.shutdown();
    });

    it('jitter no disparo: Math.max garante avanço mesmo se timer disparar milissegundos antes do dueAt', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      // Simula disparo onde dueAt é 100ms no futuro em relação ao momento exato
      const id = 'jitter-item';
      const scheduledDue = new Date(Date.now() + 100).toISOString();

      store.write({
        items: [
          {
            id,
            text: 'Exercício diário',
            createdAt: new Date().toISOString(),
            dueAt: scheduledDue,
            notifiedAt: null,
            recurrence: { type: 'daily', hour: new Date(scheduledDue).getHours(), minute: new Date(scheduledDue).getMinutes() }
          }
        ]
      });

      // Dispara diretamente o fire com o item
      (scheduler as any).fire(id);

      await new Promise((r) => setTimeout(r, 20));

      const updated = store.read();
      const it = updated.items[0];
      assert.equal(it.notifiedAt, null);
      // dueAt deve ser estritamente maior que scheduledDue
      assert.ok(
        new Date(it.dueAt!).getTime() > new Date(scheduledDue).getTime(),
        `dueAt (${it.dueAt}) deve ter avançado para além de scheduledDue (${scheduledDue})`
      );

      scheduler.shutdown();
    });
  });

  describe('Fase 9 — H5: bootstrap() com atrasos >24h e <=24h para itens recorrentes', () => {
    it('item recorrente vencido há > 24h: avança dueAt sem popup no SO nem ReferenceError', () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      const now = new Date('2026-09-24T12:00:00.000Z');
      // Vencido há 48h
      const pastDue = new Date(now.getTime() - 48 * 3600_000).toISOString();
      const id = 'rec-expired-48h';

      store.write({
        items: [
          {
            id,
            text: 'Regar plantas',
            createdAt: pastDue,
            dueAt: pastDue,
            notifiedAt: null,
            recurrence: { type: 'daily', hour: 10, minute: 0 }
          }
        ]
      });

      // Não deve lançar ReferenceError nem erro qualquer
      assert.doesNotThrow(() => {
        scheduler.bootstrap(now);
      });

      // Sem popup no SO para ocorrência perdida > 24h
      assert.equal(calls.length, 0);

      const fresh = store.read();
      assert.equal(fresh.items.length, 1);
      const it = fresh.items[0];

      // notifiedAt continua null
      assert.equal(it.notifiedAt, null);
      // dueAt avançou para o futuro (> now)
      assert.ok(new Date(it.dueAt!).getTime() > now.getTime());
      // Timer foi registrado no scheduler
      assert.equal(scheduler.hasTimer(id), true);

      scheduler.shutdown();
    });

    it('item recorrente vencido há <= 24h: dispara popup de atraso uma vez e reagenda via notify()', async () => {
      const calls: Array<{ cmd: string; args: string[] }> = [];
      const mockExecFile = ((cmd: string, args: string[], opts: any, cb: any) => {
        calls.push({ cmd, args });
        cb(null, '', '');
      }) as any;

      const scheduler = new ReminderScheduler(store, mockExecFile);

      const now = new Date();
      // Vencido há 2h (dentro da janela de 24h)
      const pastDue = new Date(now.getTime() - 2 * 3600_000).toISOString();
      const id = 'rec-late-2h';

      store.write({
        items: [
          {
            id,
            text: 'Pagar conta',
            createdAt: pastDue,
            dueAt: pastDue,
            notifiedAt: null,
            recurrence: { type: 'daily', hour: 9, minute: 0 }
          }
        ]
      });

      scheduler.bootstrap(now);

      // Aguarda disparo do lateTimer (delay 0ms + microtask)
      await new Promise((r) => setTimeout(r, 60));

      // Deve ter disparado o popup com título de atraso UMA VEZ
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args[1].includes('Pagar conta'));
      assert.ok(calls[0].args[1].includes('with title "Lembrete (atrasado)"'));

      const fresh = store.read();
      assert.equal(fresh.items.length, 1);
      const it = fresh.items[0];

      // notifiedAt permanece null porque é recorrente
      assert.equal(it.notifiedAt, null);
      // dueAt avançou para a próxima ocorrência
      assert.ok(new Date(it.dueAt!).getTime() > now.getTime());
      // Novo timer foi agendado
      assert.equal(scheduler.hasTimer(id), true);

      scheduler.shutdown();
    });
  });
});
