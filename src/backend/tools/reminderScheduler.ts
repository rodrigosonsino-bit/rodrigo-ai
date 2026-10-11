import { execFile } from 'node:child_process';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';
import { computeNextOccurrence } from './relativeTimeParser.js';

export const OVERDUE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 horas
// Teto de 32 bits do setTimeout do Node (2^31-1 ms, ~24,85 dias) — acima disso o delay é
// truncado e o timer dispara quase imediatamente (achado 2, auditoria Kimi K3). schedule()
// encadeia reagendamentos nesse incremento em vez de passar o delay real de uma vez.
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

export class ReminderScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: JsonStore<StoredItem>,
    private readonly execFileFn: typeof execFile = execFile
  ) {}

  get activeTimersCount(): number {
    return this.timers.size;
  }

  hasTimer(id: string): boolean {
    return this.timers.has(id);
  }

  /**
   * Chamado na inicialização do servidor de voz para recuperar lembretes pendentes.
   */
  bootstrap(now: Date = new Date()): void {
    const { items } = this.store.read();
    const expiredIds: string[] = []; // achado MÉDIA (Hermes v2): persistir em bloco, não por item
                                     // mutado em memória — evita perder writes se algo lançar
                                     // no meio do loop, sem precisar de um write por iteração
    const recurringReschedules: Array<{ id: string; nextDueAt: string }> = [];
    let lateDelayMs = 0; // achado MÉDIA (Hermes v2): sequenciar disparos, nunca simultâneos

    for (const item of items) {
      if (!item.dueAt || item.notifiedAt) continue;

      const due = new Date(item.dueAt);
      if (Number.isNaN(due.getTime())) {
        throw new Error(
          `[ReminderScheduler] Data de agendamento inválida para o lembrete id=${item.id}: ${item.dueAt}`
        );
      }

      if (due <= now) {
        const diffMs = now.getTime() - due.getTime();
        if (diffMs <= OVERDUE_CUTOFF_MS) {
          // Atrasado dentro da janela de 24h: notifica com título explicativo, espaçado no
          // tempo (200ms entre disparos) para nunca lançar N processos osascript de uma vez —
          // a promessa de "sequenciado" do §2 agora tem um mecanismo real, não só prosa.
          // Achado 1 (auditoria de código, Hermes, 2026-09-24): este timer precisa do mesmo
          // tratamento de schedule() — rastreado no Map (pra shutdown() poder cancelá-lo) e
          // unref()'d (pra nunca ser o motivo do processo não encerrar, mesma armadilha do
          // CLAUDE.md global sobre setTimeout ref'd).
          // Achado 5 (auditoria de código, Kimi K3, rodada da Fatia 4, revisado — NÃO corrigido
          // estruturalmente): em teoria, um processo sem NENHUM outro handle ref'd poderia
          // encerrar antes deste timer disparar, perdendo a notificação de atraso do reinício.
          // Verificado contra o caminho real (src/backend/index.ts): createVoiceRuntime() chama
          // bootstrap() e, poucas linhas depois, startServer() chama server.listen() — o socket
          // HTTP fica ref'd quase imediatamente, bem antes de qualquer janela real de
          // esvaziamento do event loop. Reverter o unref() reintroduziria o bug original do
          // achado 1 (processo nunca encerra com timer atrasado pendente). Risco aceito e
          // documentado para quem reusar bootstrap() fora desse caminho de startup (ex. um
          // script CLI que chama bootstrap() e sai logo em seguida sem abrir servidor) —
          // nesse caso específico, a perda é real.
          const lateTimer = setTimeout(() => {
            this.timers.delete(item.id);
            this.notify(item, { late: true });
          }, lateDelayMs);
          lateTimer.unref();
          this.timers.set(item.id, lateTimer);
          lateDelayMs += 200;
        } else {
          // Vencido há mais de 24h: registra log explícito, não dispara no SO
          if (item.recurrence) {
            const nextDueAt = computeNextOccurrence(item.recurrence, now);
            console.warn(
              `[ReminderScheduler] Lembrete recorrente id=${item.id} perdeu ocorrência(ões) durante ` +
              `downtime — pulando direto para a próxima: ${nextDueAt}.`
            );
            recurringReschedules.push({ id: item.id, nextDueAt });
          } else {
            console.warn(
              `[ReminderScheduler] Lembrete id=${item.id} ("${item.text}") expirado há mais de 24h (${item.dueAt}). Não será disparado.`
            );
            expiredIds.push(item.id);
          }
        }
      } else {
        // Agendamento futuro normal
        this.schedule({ id: item.id, text: item.text, dueAt: item.dueAt });
      }
    }

    if (expiredIds.length > 0 || recurringReschedules.length > 0) {
      // Uma leitura fresca + um write só, depois que o loop inteiro terminou sem lançar —
      // se o loop lançar no meio, nenhum item expirado é marcado, e a próxima subida do
      // processo reprocessa exatamente os mesmos itens (idempotente, nunca perde o registro).
      const fresh = this.store.read();
      const reschedMap = new Map(recurringReschedules.map((r) => [r.id, r.nextDueAt]));
      for (const it of fresh.items) {
        if (expiredIds.includes(it.id)) it.notifiedAt = new Date().toISOString();
        const nextDueAt = reschedMap.get(it.id);
        if (nextDueAt) {
          it.dueAt = nextDueAt;
          it.notifiedAt = null;
          this.schedule({ id: it.id, text: it.text, dueAt: nextDueAt }); // agenda no mesmo loop, sem find()
        }
      }
      this.store.write(fresh);
    }
  }

  schedule(item: { id: string; text: string; dueAt: string }): void {
    // Limpa timer anterior para o mesmo ID se houver
    this.cancel(item.id);

    const target = new Date(item.dueAt).getTime();
    // Achado 4 (auditoria de código, Kimi K3, rodada da Fatia 4): dueAt malformado (NaN) fazia
    // Math.max(0, NaN) = NaN, e setTimeout(fn, NaN) dispara com delay efetivo 0 — o lembrete
    // recém-criado notificaria IMEDIATAMENTE em silêncio. bootstrap() já validava isso com
    // throw; o caminho de criação (muito mais frequentado) não validava nada. Aqui, único
    // ponto de entrada de todo agendamento, loga e recusa em vez de disparar às cegas.
    if (Number.isNaN(target)) {
      console.error(`[ReminderScheduler] dueAt inválido para lembrete id=${item.id}: "${item.dueAt}" — não agendado.`);
      return;
    }

    const ms = target - Date.now();
    // Achado 2 (auditoria de código, Kimi K3, CRÍTICO): setTimeout do Node trunca qualquer
    // delay > 2^31-1 ms (~24,85 dias) para 1ms — dispara quase na hora, e notify() persiste
    // notifiedAt, marcando como entregue um lembrete que na verdade nunca tocou. Lembretes de
    // "daqui a um mês" ou o reagendamento automático de uma recorrência anual cruzam esse teto.
    // Em vez de agendar o delay real de uma vez, agenda o máximo seguro e, ao vencer essa
    // parcela, chama schedule() de novo — a cadeia de reagendamentos converge pro horário real
    // em incrementos de no máximo ~24,85 dias, nunca dispara cedo.
    if (ms > MAX_SAFE_TIMEOUT_MS) {
      const timer = setTimeout(() => this.schedule(item), MAX_SAFE_TIMEOUT_MS);
      timer.unref();
      this.timers.set(item.id, timer);
      return;
    }

    const timer = setTimeout(() => this.fire(item.id), Math.max(0, ms));
    timer.unref();
    this.timers.set(item.id, timer);
  }

  cancel(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  shutdown(): void {
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }

  private fire(id: string): void {
    // Remove do Map no momento do disparo para evitar acúmulo de memória
    this.timers.delete(id);

    const { items } = this.store.read();
    const item = items.find((i) => i.id === id);
    if (!item || item.notifiedAt) return;
    this.notify(item, { late: false });
  }

  private notify(item: StoredItem, opts: { late: boolean }): void {
    const title = opts.late ? 'Lembrete (atrasado)' : 'Lembrete';
    const script = `display notification ${JSON.stringify(item.text)} with title ${JSON.stringify(title)}`;

    this.execFileFn('osascript', ['-e', script], { timeout: 5000 }, (error) => {
      if (error) {
        console.error(
          `[ReminderScheduler] Falha ao disparar notificação macOS para lembrete id=${item.id}:`,
          error
        );
        // Não persiste notifiedAt em caso de falha — honestidade de entrega
        return;
      }

      // Persiste notifiedAt exclusivamente após confirmação de sucesso do execFile.
      // Garantia explícita (achado BAIXA, auditoria Hermes rodada 1 sobre o v2): se
      // LEMBRETE_APAGAR remover este item entre o disparo do timer e este callback, a releitura
      // fresca do store aqui (não o `item` capturado no closure) mais o `idx !== -1` cobrem o
      // caso — o item removido simplesmente não é encontrado e nada é escrito.
      // Limite conhecido, documentado (achado 2, auditoria de código, Hermes, 2026-09-24): o
      // `idx !== -1` acima protege só a PERSISTÊNCIA de notifiedAt, não a ENTREGA — o processo
      // `osascript` já foi disparado (linha acima) antes desta checagem rodar, então numa janela
      // de milissegundos entre o disparo do timer e LEMBRETE_APAGAR cancelar/remover o item, o
      // usuário ainda vê o popup de um lembrete que acabou de apagar. Janela pequena o bastante
      // (exigiria apagar no exato tick do disparo) pra não justificar checar o store antes do
      // execFile — mas é real, não um falso positivo, e fica nomeada aqui.
      try {
        const store = this.store.read();
        const idx = store.items.findIndex((i) => i.id === item.id);
        if (idx === -1) return;

        const current = store.items[idx];
        if (current.recurrence) {
          const reference = new Date(Math.max(Date.now(), new Date(current.dueAt!).getTime()));
          const nextDueAt = computeNextOccurrence(current.recurrence, reference);
          store.items[idx] = { ...current, dueAt: nextDueAt, notifiedAt: null };
          this.store.write(store);
          this.schedule({ id: current.id, text: current.text, dueAt: nextDueAt });
        } else {
          store.items[idx] = { ...current, notifiedAt: new Date().toISOString() };
          this.store.write(store);
        }
      } catch (err) {
        console.error(
          `[ReminderScheduler] Erro ao processar disparo do lembrete id=${item.id}:`,
          err
        );
      }
    });
  }
}
