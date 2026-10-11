// F14 Fatia 4 — Suíte de estresse (docs/phase-14-v2.md §4), continuação de phase14Stress.test.ts.
// H14.3: >= 99/100 notificações disparadas até 10s do horário pretendido.
// H14.4: 30 cenários de reinício/suspensão sem perda de lembretes pendentes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReminderScheduler, OVERDUE_CUTOFF_MS } from '../reminderScheduler.js';
import { JsonStore, type StoredItem, type RecurrenceRule } from '../../storage/jsonStore.js';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'f14-sched-stress-'));
}

function makeStore(dir: string): JsonStore<StoredItem> {
  return new JsonStore<StoredItem>(dir, 'lembretes.json');
}

// execFileFn falso — nunca chama osascript de verdade, só registra quando foi invocado.
function fakeExecFile(onCall: (args: readonly string[]) => void) {
  return (_cmd: string, args: readonly string[] | undefined, _opts: unknown, cb: (err: Error | null) => void) => {
    onCall(args ?? []);
    cb(null);
    return {} as any;
  };
}

// ============================================================================================
// H14.3 — timing: >= 99/100 disparos dentro de 10s do dueAt pretendido
// ============================================================================================

describe('F14 Fatia 4 — H14.3: precisão de disparo das notificações (>= 99/100 em <= 10s)', () => {
  it('100 lembretes com offsets curtos disparam dentro de 10s do horário pretendido', async () => {
    const dir = freshTmpDir();
    const store = makeStore(dir);
    store.write({ items: [] });

    const fireTimes = new Map<string, number>();
    const intendedDueAt = new Map<string, number>();
    let firedCount = 0;

    const execFileFn = fakeExecFile(() => {
      // O fake não sabe qual item disparou (osascript recebe só o script de texto) — por isso
      // o teste identifica o item no momento do agendamento (ver abaixo) e mede o tempo real
      // pelo setTimeout do próprio scheduler, não pelo conteúdo do script.
    });

    const scheduler = new ReminderScheduler(store, execFileFn as any);

    const N = 100;
    const items: StoredItem[] = [];
    for (let i = 0; i < N; i++) {
      const id = `t-${i}`;
      const offsetMs = 300 + Math.floor(Math.random() * 2700); // 0.3s a 3s no futuro
      const dueAt = new Date(Date.now() + offsetMs).toISOString();
      items.push({ id, text: `lembrete de estresse ${i}`, createdAt: new Date().toISOString(), dueAt, notifiedAt: null });
      intendedDueAt.set(id, new Date(dueAt).getTime());
    }
    store.write({ items });

    // Mede o disparo real por item: substitui notify() indiretamente observando quando o store
    // marca notifiedAt — faz polling leve em vez de depender do conteúdo do script osascript
    // (que não carrega o id do item).
    for (const it of items) {
      scheduler.schedule({ id: it.id, text: it.text, dueAt: it.dueAt! });
    }

    const pollStart = Date.now();
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        const current = store.read().items;
        for (const it of current) {
          if (it.notifiedAt && !fireTimes.has(it.id)) {
            fireTimes.set(it.id, Date.now());
            firedCount++;
          }
        }
        if (firedCount >= N || Date.now() - pollStart > 15000) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });
    scheduler.shutdown();

    const deltas: Array<{ id: string; deltaMs: number }> = [];
    for (const [id, fireMs] of fireTimes) {
      const due = intendedDueAt.get(id)!;
      deltas.push({ id, deltaMs: Math.abs(fireMs - due) });
    }

    const within10s = deltas.filter((d) => d.deltaMs <= 10_000).length;
    const notFired = N - fireTimes.size;

    if (notFired > 0 || within10s < N) {
      const tarde = deltas.filter((d) => d.deltaMs > 10_000);
      console.log(
        `H14.3 — ${notFired} não dispararam; ${tarde.length} dispararam fora de 10s: ` +
          tarde.map((d) => `${d.id}=${d.deltaMs}ms`).join(', ')
      );
    }

    assert.ok(
      fireTimes.size >= N - 1,
      `pelo menos ${N - 1}/${N} precisam ter disparado; disparou só ${fireTimes.size}`
    );
    assert.ok(
      within10s >= 99,
      `H14.3 exige >= 99/100 dentro de 10s; só ${within10s}/${fireTimes.size} cumpriram (dos que dispararam)`
    );
  });
});

// ============================================================================================
// H14.4 — 30 cenários de reinício/suspensão sem perda de lembretes pendentes
// ============================================================================================

interface RestartScenario {
  id: string;
  describe: string;
  run: () => Outcome;
}
interface Outcome {
  ok: boolean;
  detail: string;
}

const restartScenarios: RestartScenario[] = [];

function minutesAgo(n: number, from: Date): string {
  return new Date(from.getTime() - n * 60_000).toISOString();
}
function minutesFromNow(n: number, from: Date): string {
  return new Date(from.getTime() + n * 60_000).toISOString();
}

function freshScheduler(dir: string): { scheduler: ReminderScheduler; store: JsonStore<StoredItem> } {
  const store = makeStore(dir);
  const scheduler = new ReminderScheduler(store, fakeExecFile(() => {}) as any);
  return { scheduler, store };
}

// --- 1-3: item futuro simples (reinício não deveria mexer em nada, só reagendar o timer) ---
[1, 60, 60 * 24 * 7].forEach((minutosNoFuturo, i) => {
  restartScenarios.push({
    id: `F14.4-futuro-${i}`,
    describe: `item futuro (${minutosNoFuturo}min à frente) sobrevive ao bootstrap`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      store.write({ items: [{ id: 'a', text: 'item futuro', createdAt: now.toISOString(), dueAt: minutesFromNow(minutosNoFuturo, now), notifiedAt: null }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1) return { ok: false, detail: `item sumiu: ${JSON.stringify(after)}` };
      if (after[0].notifiedAt) return { ok: false, detail: `item futuro não deveria estar notificado: ${JSON.stringify(after[0])}` };
      if (!scheduler.hasTimer('a')) return { ok: false, detail: 'item futuro deveria ter timer ativo após bootstrap' };
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 4-8: não-recorrente atrasado DENTRO de 24h (deve agendar timer de "atrasado", nunca sumir) ---
[1, 60, 6 * 60, 12 * 60, 23 * 60 + 59].forEach((minutosAtras, i) => {
  restartScenarios.push({
    id: `F14.4-atrasado24h-${i}`,
    describe: `não-recorrente atrasado ${minutosAtras}min (dentro de 24h) ganha timer de atraso`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      store.write({ items: [{ id: 'a', text: 'item atrasado', createdAt: minutesAgo(minutosAtras + 10, now), dueAt: minutesAgo(minutosAtras, now), notifiedAt: null }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1) return { ok: false, detail: `item sumiu: ${JSON.stringify(after)}` };
      if (after[0].notifiedAt) return { ok: false, detail: `não deveria estar notificado ainda (só agendado): ${JSON.stringify(after[0])}` };
      if (!scheduler.hasTimer('a')) return { ok: false, detail: 'deveria ter timer de atraso agendado' };
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 9-11: fronteira exata dos 24h ---
[OVERDUE_CUTOFF_MS - 1000, OVERDUE_CUTOFF_MS, OVERDUE_CUTOFF_MS + 1000].forEach((atrasoMs, i) => {
  const dentro = atrasoMs <= OVERDUE_CUTOFF_MS;
  restartScenarios.push({
    id: `F14.4-fronteira24h-${i}`,
    describe: `atraso de exatamente ${atrasoMs}ms (${dentro ? 'dentro' : 'fora'} do corte de 24h)`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      store.write({ items: [{ id: 'a', text: 'item fronteira', createdAt: new Date(now.getTime() - atrasoMs - 60_000).toISOString(), dueAt: new Date(now.getTime() - atrasoMs).toISOString(), notifiedAt: null }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1) return { ok: false, detail: `item sumiu: ${JSON.stringify(after)}` };
      if (dentro) {
        if (!scheduler.hasTimer('a')) return { ok: false, detail: 'esperava timer de atraso (dentro de 24h)' };
        if (after[0].notifiedAt) return { ok: false, detail: 'não deveria estar notificado ainda' };
      } else {
        if (!after[0].notifiedAt) return { ok: false, detail: 'esperava notifiedAt marcado (expirado, não-recorrente, >24h)' };
      }
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 12-16: não-recorrente expirado HÁ MAIS de 24h (marcado como notificado, sem disparar) ---
[25 * 60, 2 * 24 * 60, 7 * 24 * 60, 30 * 24 * 60, 365 * 24 * 60].forEach((minutosAtras, i) => {
  restartScenarios.push({
    id: `F14.4-expirado-${i}`,
    describe: `não-recorrente expirado há ${minutosAtras}min (>24h) é marcado, não dispara`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      store.write({ items: [{ id: 'a', text: 'item antigo', createdAt: minutesAgo(minutosAtras + 10, now), dueAt: minutesAgo(minutosAtras, now), notifiedAt: null }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1) return { ok: false, detail: `ITEM SUMIU DO STORE — perda silenciosa! antes: 1 depois: ${after.length}` };
      if (!after[0].notifiedAt) return { ok: false, detail: `item expirado deveria estar marcado notifiedAt: ${JSON.stringify(after[0])}` };
      if (scheduler.hasTimer('a')) return { ok: false, detail: 'item expirado >24h não deveria ter timer ativo' };
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 17-21: recorrente expirado HÁ MAIS de 24h (pula pra próxima ocorrência, nunca some) ---
const DAILY_RULE: RecurrenceRule = { type: 'daily', hour: 9, minute: 0 };
const WEEKLY_RULE: RecurrenceRule = { type: 'weekly', hour: 9, minute: 0, weekday: 1 };
[
  { minutosAtras: 25 * 60, rule: DAILY_RULE },
  { minutosAtras: 2 * 24 * 60, rule: DAILY_RULE },
  { minutosAtras: 10 * 24 * 60, rule: WEEKLY_RULE },
  { minutosAtras: 40 * 24 * 60, rule: WEEKLY_RULE },
  { minutosAtras: 90 * 24 * 60, rule: DAILY_RULE }
].forEach((cenario, i) => {
  restartScenarios.push({
    id: `F14.4-recorrente-${i}`,
    describe: `recorrente (${cenario.rule.type}) expirado há ${cenario.minutosAtras}min pula pra próxima ocorrência`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      store.write({ items: [{ id: 'a', text: 'item recorrente', createdAt: minutesAgo(cenario.minutosAtras + 60 * 24, now), dueAt: minutesAgo(cenario.minutosAtras, now), notifiedAt: null, recurrence: cenario.rule }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1) return { ok: false, detail: `ITEM SUMIU — recorrente não pode desaparecer! depois: ${after.length}` };
      if (after[0].notifiedAt) return { ok: false, detail: `recorrente reagendado não deveria estar com notifiedAt: ${JSON.stringify(after[0])}` };
      if (!after[0].dueAt || new Date(after[0].dueAt).getTime() <= now.getTime()) {
        return { ok: false, detail: `próxima ocorrência deveria estar no futuro: ${JSON.stringify(after[0])}` };
      }
      if (!scheduler.hasTimer('a')) return { ok: false, detail: 'recorrente reagendado deveria ter timer ativo pra próxima ocorrência' };
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 22-23: recorrente atrasado DENTRO de 24h (mesmo caminho do atraso normal; recorrência só
//            se aplica quando o timer de atraso efetivamente disparar, não no bootstrap) ---
[30, 600].forEach((minutosAtras, i) => {
  restartScenarios.push({
    id: `F14.4-recorrente-atrasado24h-${i}`,
    describe: `recorrente atrasado ${minutosAtras}min (dentro de 24h) ganha timer de atraso normalmente`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      store.write({ items: [{ id: 'a', text: 'item recorrente atrasado', createdAt: minutesAgo(minutosAtras + 60 * 24, now), dueAt: minutesAgo(minutosAtras, now), notifiedAt: null, recurrence: DAILY_RULE }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1) return { ok: false, detail: `item sumiu: ${JSON.stringify(after)}` };
      if (!scheduler.hasTimer('a')) return { ok: false, detail: 'deveria ter timer de atraso (dentro de 24h), recorrente ou não' };
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 24-26: já notificado (bootstrap não deve mexer) ---
[1, 60, 24 * 60].forEach((minutosDesdeNotificado, i) => {
  restartScenarios.push({
    id: `F14.4-ja-notificado-${i}`,
    describe: `item já notificado há ${minutosDesdeNotificado}min permanece intocado`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      const notifiedAt = minutesAgo(minutosDesdeNotificado, now);
      store.write({ items: [{ id: 'a', text: 'item já visto', createdAt: minutesAgo(minutosDesdeNotificado + 10, now), dueAt: minutesAgo(minutosDesdeNotificado + 1, now), notifiedAt }] });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 1 || after[0].notifiedAt !== notifiedAt) {
        return { ok: false, detail: `item já notificado foi alterado: ${JSON.stringify(after)}` };
      }
      if (scheduler.hasTimer('a')) return { ok: false, detail: 'item já notificado não deveria ganhar timer novo' };
      scheduler.shutdown();
      return { ok: true, detail: 'ok' };
    }
  });
});

// --- 27-28: store vazia / só itens já notificados (degenerado, não pode travar) ---
restartScenarios.push({
  id: 'F14.4-vazio',
  describe: 'store vazia não trava o bootstrap',
  run: () => {
    const dir = freshTmpDir();
    const { scheduler, store } = freshScheduler(dir);
    store.write({ items: [] });
    scheduler.bootstrap(new Date('2026-10-11T12:00:00.000Z'));
    const after = store.read().items;
    scheduler.shutdown();
    return after.length === 0 ? { ok: true, detail: 'ok' } : { ok: false, detail: `esperava vazio, achou ${after.length}` };
  }
});
restartScenarios.push({
  id: 'F14.4-todos-ja-notificados',
  describe: 'store só com itens já notificados não gera timers',
  run: () => {
    const dir = freshTmpDir();
    const now = new Date('2026-10-11T12:00:00.000Z');
    const { scheduler, store } = freshScheduler(dir);
    store.write({
      items: [
        { id: 'a', text: 'x', createdAt: now.toISOString(), dueAt: minutesAgo(10, now), notifiedAt: minutesAgo(5, now) },
        { id: 'b', text: 'y', createdAt: now.toISOString(), dueAt: minutesAgo(20, now), notifiedAt: minutesAgo(15, now) }
      ]
    });
    scheduler.bootstrap(now);
    const ok = !scheduler.hasTimer('a') && !scheduler.hasTimer('b') && store.read().items.length === 2;
    scheduler.shutdown();
    return ok ? { ok: true, detail: 'ok' } : { ok: false, detail: `estado inesperado: ${JSON.stringify(store.read())}` };
  }
});

// --- 29-30: múltiplos itens mistos no mesmo store — todos contabilizados simultaneamente ---
[0, 1].forEach((seed) => {
  restartScenarios.push({
    id: `F14.4-misto-${seed}`,
    describe: `store com 5 itens de categorias diferentes — nenhum perdido`,
    run: () => {
      const dir = freshTmpDir();
      const now = new Date('2026-10-11T12:00:00.000Z');
      const { scheduler, store } = freshScheduler(dir);
      const items: StoredItem[] = [
        { id: `${seed}-futuro`, text: 'futuro', createdAt: now.toISOString(), dueAt: minutesFromNow(60, now), notifiedAt: null },
        { id: `${seed}-atrasado`, text: 'atrasado dentro de 24h', createdAt: now.toISOString(), dueAt: minutesAgo(120, now), notifiedAt: null },
        { id: `${seed}-expirado`, text: 'expirado', createdAt: now.toISOString(), dueAt: minutesAgo(2 * 24 * 60, now), notifiedAt: null },
        { id: `${seed}-recorrente`, text: 'recorrente expirado', createdAt: now.toISOString(), dueAt: minutesAgo(3 * 24 * 60, now), notifiedAt: null, recurrence: DAILY_RULE },
        { id: `${seed}-notificado`, text: 'já visto', createdAt: now.toISOString(), dueAt: minutesAgo(600, now), notifiedAt: minutesAgo(500, now) }
      ];
      store.write({ items });
      scheduler.bootstrap(now);
      const after = store.read().items;
      if (after.length !== 5) return { ok: false, detail: `PERDA! esperava 5 itens, achou ${after.length}: ${JSON.stringify(after)}` };
      const byId = new Map(after.map((it) => [it.id, it]));
      const checks: Array<[string, boolean]> = [
        [`${seed}-futuro tem timer`, scheduler.hasTimer(`${seed}-futuro`)],
        [`${seed}-atrasado tem timer`, scheduler.hasTimer(`${seed}-atrasado`)],
        [`${seed}-expirado marcado`, Boolean(byId.get(`${seed}-expirado`)?.notifiedAt)],
        [`${seed}-recorrente reagendado`, Boolean(byId.get(`${seed}-recorrente`)?.dueAt && new Date(byId.get(`${seed}-recorrente`)!.dueAt!).getTime() > now.getTime())],
        [`${seed}-notificado sem timer`, !scheduler.hasTimer(`${seed}-notificado`)]
      ];
      const falhou = checks.filter(([, ok]) => !ok).map(([desc]) => desc);
      scheduler.shutdown();
      if (falhou.length > 0) return { ok: false, detail: `checagens falhas: ${falhou.join(', ')}` };
      return { ok: true, detail: 'ok' };
    }
  });
});

describe('F14 Fatia 4 — H14.4: 30 cenários de reinício/suspensão sem perda de lembrete', () => {
  it('monta pelo menos 30 cenários', () => {
    assert.ok(restartScenarios.length >= 30, `esperava >= 30 cenários, montou ${restartScenarios.length}`);
  });

  it('ZERO lembrete pendente perdido em nenhum cenário de reinício (H14.4 — tolerância zero)', () => {
    const failures: string[] = [];
    for (const s of restartScenarios) {
      const res = s.run();
      if (!res.ok) failures.push(`${s.id} (${s.describe}): ${res.detail}`);
    }
    if (failures.length > 0) {
      console.log(`H14.4 — ${failures.length} falha(s) de ${restartScenarios.length}:\n` + failures.join('\n'));
    }
    assert.equal(failures.length, 0, `H14.4 exige zero falhas (tolerância zero). Falhas:\n${failures.join('\n')}`);
  });
});
