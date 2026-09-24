import { execFile } from 'node:child_process';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';

export const OVERDUE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 horas

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
          const lateTimer = setTimeout(() => {
            this.timers.delete(item.id);
            this.notify(item, { late: true });
          }, lateDelayMs);
          lateTimer.unref();
          this.timers.set(item.id, lateTimer);
          lateDelayMs += 200;
        } else {
          // Vencido há mais de 24h: registra log explícito, não dispara no SO, acumula pra
          // persistir em bloco no fim do loop (nunca dentro dele — ver expiredIds acima).
          console.warn(
            `[ReminderScheduler] Lembrete id=${item.id} ("${item.text}") expirado há mais de 24h (${item.dueAt}). Não será disparado.`
          );
          expiredIds.push(item.id);
        }
      } else {
        // Agendamento futuro normal
        this.schedule({ id: item.id, text: item.text, dueAt: item.dueAt });
      }
    }

    if (expiredIds.length > 0) {
      // Uma leitura fresca + um write só, depois que o loop inteiro terminou sem lançar —
      // se o loop lançar no meio, nenhum item expirado é marcado, e a próxima subida do
      // processo reprocessa exatamente os mesmos itens (idempotente, nunca perde o registro).
      const fresh = this.store.read();
      for (const it of fresh.items) {
        if (expiredIds.includes(it.id)) it.notifiedAt = new Date().toISOString();
      }
      this.store.write(fresh);
    }
  }

  schedule(item: { id: string; text: string; dueAt: string }): void {
    // Limpa timer anterior para o mesmo ID se houver
    this.cancel(item.id);

    const ms = new Date(item.dueAt).getTime() - Date.now();
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
        if (idx !== -1) {
          store.items[idx] = { ...store.items[idx], notifiedAt: new Date().toISOString() };
          this.store.write(store);
        }
      } catch (err) {
        console.error(
          `[ReminderScheduler] Erro ao persistir notifiedAt para lembrete id=${item.id}:`,
          err
        );
      }
    });
  }
}
