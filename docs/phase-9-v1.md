# Fase 9 — Recorrência de lembretes — v1

## 0. Escopo combinado com o usuário antes de escrever este plano

Duas perguntas foram feitas ao usuário via `AskUserQuestion` (2026-09-27) antes de escrever este
plano:

1. **Padrões de recorrência**: **diário e semanal simples** — "todo dia às 8h", "toda segunda às
   9h", "todo domingo de manhã". Intervalos numéricos ("a cada 3 dias") ficam fora de escopo,
   candidatos a fase futura.
2. **O que acontece com o item após disparar**: **o mesmo item se reagenda** — um único item por
   lembrete recorrente, sem crescer o arquivo a cada disparo; o `ReminderScheduler` calcula a
   próxima ocorrência e atualiza o próprio item.

## 1. Objetivo

O usuário fala "me lembra todo dia às 8 da manhã de tomar o remédio", confirma, e o Rodrigo
dispara a notificação todo dia nesse horário, indefinidamente, sem precisar recriar o lembrete —
até o usuário apagá-lo.

**Critério de conclusão, em linguagem do roteiro**: o usuário cria um lembrete recorrente diário,
o `dueAt` do item calcula a primeira ocorrência futura; simulando o disparo (via teste de
integração, não esperando um dia real), o item permanece no `lembretes.json` com um novo `dueAt`
apontando pra ocorrência seguinte, `notifiedAt` continua `null` (nunca "termina"), e o timer do
`ReminderScheduler` é reagendado automaticamente pro novo horário.

## 2. A premissa da fase

Diferente de todas as fases anteriores de mutação (5c, 6, 7, 8), **esta não adiciona nenhum tipo
novo de mutação** (`MUTATION_NAMES`/`worker.py` não mudam) — recorrência é uma propriedade da
mesma frase de `LEMBRETE_CRIAR` que a Fase 6 já processa, não uma ação separada. O parsing de
recorrência acontece inteiramente no lado Node (`relativeTimeParser.ts`), do mesmo jeito que o
parsing de horário relativo simples já acontece — **nenhuma mudança no worker Python, nenhum
risco novo de colisão de classificação**, ao contrário do padrão de risco central que as Fases 7 e
8 tiveran.

O que é genuinamente novo, e onde está o risco real desta fase:

1. Um lembrete recorrente **nunca marca `notifiedAt`** — ao disparar com sucesso, em vez de
   "terminar", o `ReminderScheduler` recalcula a próxima ocorrência e atualiza `dueAt` no mesmo
   item, reagendando o timer. Isso muda o significado operacional de `notify()` pela primeira vez
   desde que foi escrita na Fase 6.
2. **Interação com `bootstrap()` (achado de arquitetura nomeado explicitamente, §4.4)**: um
   lembrete recorrente que ficou mais de 24h sem o processo rodar (a janela de "atrasado" que já
   existe) não pode ser tratado como os lembretes não-recorrentes expirados — marcá-lo como
   `notifiedAt` pararia a recorrência pra sempre por causa de uma janela de downtime. Precisa
   pular pra próxima ocorrência futura válida, não desistir.
3. **Interação com a Fase 8 (`LEMBRETE_EDITAR`)**: a defesa em profundidade que a Fase 8 já
   construiu (`parseRelativeTime()` recusando edição de texto que contenha horário) precisa ser
   estendida pra também recusar frases de recorrência — sem isso, "corrige o lembrete pra: toda
   segunda às 9h" editaria só o `text`, deixando o `recurrence`/`dueAt` reais intocados e o
   usuário com a falsa impressão de que mudou a recorrência.

## 3. Escopo

**Dentro do escopo:**
- Reconhecer "todo dia às Xh", "toda [dia da semana] às Xh", e as variações com período do dia já
  existentes da Fase 6 ("todo dia de manhã/tarde/à noite", reaproveitando os mesmos horários fixos
  09h/14h/19h).
- Persistir a regra de recorrência no item (`recurrence`, novo campo opcional em `StoredItem`,
  só usado por `LembreteTool`).
- Calcular a primeira ocorrência futura no momento da criação, e recalcular a próxima ocorrência
  após cada disparo bem-sucedido — o mesmo item, nunca um item novo por ocorrência.
- Tratamento honesto de janela de downtime (§4.4): recorrência nunca "morre" silenciosamente por
  causa do processo ter ficado parado.
- `LEMBRETE_APAGAR` cancela a recorrência (o item some, o timer é cancelado) — comportamento já
  existente, sem mudança de código.
- Fala de confirmação e de retorno mencionando a recorrência de forma natural ("Lembrete criado,
  vou te avisar toda segunda de manhã.").

**Fora de escopo, mesmo que pareça natural:**
- Intervalos numéricos ("a cada 3 dias", "a cada 2 semanas") — decisão explícita §0.1.
- Recorrência mensal/anual.
- Editar a regra de recorrência de um lembrete já existente (só criar recorrente desde o início,
  ou apagar e recriar) — mesmo limite de sempre (editar horário já é fora de escopo da Fase 8).
- Múltiplos horários por dia pro mesmo lembrete recorrente ("todo dia às 8h e às 20h").
- `NOTA_CRIAR`/`MEMORIA_GUARDAR` ganharem recorrência — não fazem sentido pra essas ferramentas
  (nota e memória não têm "quando").

## 4. Decisões de projeto

### 4.1 Novo campo em `StoredItem` (`jsonStore.ts`)

```ts
export interface RecurrenceRule {
  type: 'daily' | 'weekly';
  hour: number;   // 0-23, local time
  minute: number; // 0-59
  weekday?: number; // 0 (domingo) a 6 (sábado), só presente quando type === 'weekly'
}

export interface StoredItem {
  id: string;
  text: string;
  createdAt: string;
  dueAt?: string | null;
  notifiedAt?: string | null;
  recurrence?: RecurrenceRule | null; // NOVO — só LembreteTool escreve; undefined/null = não recorrente
}
```

### 4.2 Parsing de recorrência (`relativeTimeParser.ts`) — antes do parsing de horário simples

Nova função `parseRecurrence(text, now)`, testada **antes** de `parseRelativeTime()` dentro de
`LembreteTool.execute('LEMBRETE_CRIAR')` — se casar, não roda o parsing de horário simples da
Fase 6 (são mutuamente exclusivos: um lembrete é recorrente OU tem horário único, nunca os dois):

```ts
export interface ParsedRecurrence {
  recurrence: RecurrenceRule | null;
  dueAt: string | null;       // primeira ocorrência futura, já calculada
  residualText: string;
}

/**
 * Padrões (case-insensitive, mesma normalização NFD de mightBeMutation):
 *   /todo\s+dia\s+(?:a|à)s?\s+(\d{1,2})\s*h(?:oras?)?/       -> daily, hora explícita
 *   /todo\s+dia\s+de\s+manh[ãa]/                             -> daily, 09:00 (mesmo default da Fase 6)
 *   /todo\s+dia\s+(?:de\s+)?tarde/                            -> daily, 14:00
 *   /todo\s+dia\s+(?:de\s+)?noite/                            -> daily, 19:00
 *   /toda\s+(segunda|terça|quarta|quinta|sexta|sábado|domingo)(?:-feira)?\s+(?:a|à)s?\s+(\d{1,2})\s*h(?:oras?)?/
 *                                                              -> weekly, dia da semana + hora explícita
 *   /toda\s+(segunda|.../domingo)(?:-feira)?\s+de\s+manh[ãa]/ -> weekly, 09:00
 *   (mesma cobertura de tarde/noite pro semanal)
 * Cálculo da primeira ocorrência: se o horário/dia de hoje já passou, primeira ocorrência é a
 * PRÓXIMA data que bate (amanhã, se diário; o próximo dia da semana pedido, se semanal — nunca
 * hoje mesmo se o horário já passou, nunca a semana seguinte se ainda não passou).
 */
export function parseRecurrence(text: string, now: Date = new Date()): ParsedRecurrence {
  // implementação: mapa de nomes de dia da semana -> índice 0-6 (domingo=0, igual a Date.getDay()),
  // calcula candidato pra hoje com a hora pedida; se already passou (ou não é o dia certo pro
  // caso semanal), avança em incrementos de 1 dia (diário) ou 7 dias (semanal) até achar a
  // primeira ocorrência estritamente no futuro.
}
```

**Ordem de chamada em `LembreteTool.execute('LEMBRETE_CRIAR')`**: `parseRecurrence()` primeiro;
se `recurrence !== null`, usa o resultado dele (ignora `parseRelativeTime()`); senão, cai no
fluxo já existente da Fase 6 (`parseRelativeTime()`). Mesma ordem em `preview()`, pro texto da
pergunta de confirmação refletir a recorrência quando houver.

### 4.3 Fala de confirmação e retorno (`formatHumanRelative` ganha uma irmã)

Nova função `formatRecurrenceHuman(rule: RecurrenceRule)` em `relativeTimeParser.ts`:

```ts
export function formatRecurrenceHuman(rule: RecurrenceRule): string {
  const hora = formatHourSpoken(rule.hour, rule.minute); // reaproveita lógica de formatação de
                                                          // horário por extenso já usada em
                                                          // formatHumanRelative para "amanhã às X horas"
  if (rule.type === 'daily') return `todo dia ${hora}`;
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  return `toda ${dias[rule.weekday!]} ${hora}`;
}
```

`LembreteTool.preview()`/`execute()` usam essa função no lugar de `formatHumanRelative()` quando
`recurrence !== null`: `"Posso criar o lembrete de ${finalText}, todo dia às 8 horas?"` /
`"Lembrete criado, vou te avisar todo dia às 8 horas."`.

### 4.4 `ReminderScheduler` — reagendamento após disparo, tratamento de downtime

**Risco central da fase, nomeado explicitamente**: `notify()` (`reminderScheduler.ts`) hoje só
tem um caminho de sucesso — marcar `notifiedAt` e parar. Precisa bifurcar por recorrência:

```ts
// notify(), dentro do callback de sucesso do execFile — substituindo o bloco atual:
try {
  const store = this.store.read();
  const idx = store.items.findIndex((i) => i.id === item.id);
  if (idx === -1) return; // item removido entre o disparo e este callback (já documentado)

  const current = store.items[idx];
  if (current.recurrence) {
    // Reagenda: nunca marca notifiedAt — recorrência não "termina" por disparar.
    const nextDueAt = computeNextOccurrence(current.recurrence, new Date());
    store.items[idx] = { ...current, dueAt: nextDueAt, notifiedAt: null };
    this.store.write(store);
    this.schedule({ id: current.id, text: current.text, dueAt: nextDueAt });
  } else {
    // Comportamento existente, inalterado: marca notifiedAt, não reagenda.
    store.items[idx] = { ...current, notifiedAt: new Date().toISOString() };
    this.store.write(store);
  }
} catch (err) {
  console.error(`[ReminderScheduler] Erro ao processar disparo do lembrete id=${item.id}:`, err);
}
```

`computeNextOccurrence(rule, now)`: mesma lógica de "avançar em incrementos de 1 dia/7 dias até
achar a primeira ocorrência estritamente no futuro" que `parseRecurrence()` já usa pra calcular a
primeira ocorrência — extraída como função compartilhada entre `relativeTimeParser.ts` (cálculo
inicial) e `reminderScheduler.ts` (recálculo pós-disparo), pra nunca ter duas implementações da
mesma regra de calendário divergindo.

**`bootstrap()` — corrigindo a interação com downtime, §2.2 acima**: o bloco que hoje marca
itens vencidos há mais de 24h como `notifiedAt` (`OVERDUE_CUTOFF_MS`) **não pode fazer isso com
itens recorrentes** — pararia a recorrência pra sempre por causa de o processo ter ficado
desligado. `expiredIds: string[]` (a coleta em bloco que já existe, achado MÉDIA da auditoria
Hermes da Fase 6) só serve pro caso não-recorrente (grava `notifiedAt`); itens recorrentes vencidos
precisam de um dueAt novo, não de `notifiedAt` — por isso ganham sua própria coleta, com o mesmo
princípio de "acumular durante o loop, escrever em bloco só no fim, nunca dentro do loop":

```ts
// bootstrap(): duas coleções em vez de uma, mesmo princípio de atomicidade contra exceção
// no meio do loop que expiredIds já tinha (Fase 6, Hermes):
const expiredIds: string[] = [];                      // não-recorrentes vencidos >24h -> notifiedAt
const recurringReschedules: Array<{ id: string; nextDueAt: string }> = []; // recorrentes vencidos >24h -> novo dueAt

// dentro do ramo "vencido há mais de 24h", bifurcado por recorrência:
if (current.recurrence) {
  const nextDueAt = computeNextOccurrence(current.recurrence, now);
  console.warn(
    `[ReminderScheduler] Lembrete recorrente id=${item.id} perdeu ocorrência(ões) durante ` +
    `downtime — pulando direto para a próxima: ${nextDueAt}.`
  );
  recurringReschedules.push({ id: item.id, nextDueAt });
} else {
  console.warn(`[ReminderScheduler] Lembrete id=${item.id} ("${item.text}") expirado há mais de 24h...`);
  expiredIds.push(item.id);
}

// Depois do loop, mesmo padrão de releitura fresca + write único que expiredIds já usa:
if (expiredIds.length > 0 || recurringReschedules.length > 0) {
  const fresh = this.store.read();
  for (const it of fresh.items) {
    if (expiredIds.includes(it.id)) it.notifiedAt = new Date().toISOString();
    const resched = recurringReschedules.find((r) => r.id === it.id);
    if (resched) { it.dueAt = resched.nextDueAt; it.notifiedAt = null; }
  }
  this.store.write(fresh);
  // Agenda os timers dos recorrentes reagendados — schedule() já existe, chamado fora do loop
  // de escrita pra não misturar leitura/escrita de disco com efeito colateral de timer:
  for (const r of recurringReschedules) {
    const it = fresh.items.find((i) => i.id === r.id)!;
    this.schedule({ id: it.id, text: it.text, dueAt: r.nextDueAt });
  }
}
```

Contrato explícito, sem decisão em aberto: itens recorrentes vencidos NUNCA recebem
`notifiedAt` — sempre recebem um `dueAt` novo no futuro, sempre com `console.warn`, nunca
disparam popup pras ocorrências perdidas.

## 5. Arquivos afetados

```
src/backend/storage/jsonStore.ts          StoredItem ganha recurrence?: RecurrenceRule | null
src/backend/tools/relativeTimeParser.ts   parseRecurrence(), formatRecurrenceHuman(),
                                           computeNextOccurrence() (compartilhada)
src/backend/tools/reminderScheduler.ts    notify() bifurca por recorrência; bootstrap() trata
                                           downtime de itens recorrentes sem parar a recorrência
src/backend/tools/mutatingTools.ts        LembreteTool.preview()/execute() chamam
                                           parseRecurrence() antes de parseRelativeTime();
                                           LEMBRETE_EDITAR (Fase 8) ganha a mesma defesa em
                                           profundidade contra frases de recorrência que já tem
                                           contra horário simples
src/backend/__tests__/                    testes novos para os módulos acima
```

`scripts/worker/worker.py` **não muda nesta fase** — confirma que o escopo é só Node/TS, sem
risco novo de classificação (§2).

## 6. Critérios de aceite (H1..H8)

- **H1** — `parseRecurrence()`: cobre diário com hora explícita, diário com período do dia,
  semanal (os 7 dias) com hora explícita e com período do dia; calcula a primeira ocorrência
  corretamente tanto quando o horário de hoje já passou quanto quando ainda não passou.
- **H2** — `computeNextOccurrence()`: dado um `RecurrenceRule` e um "agora", sempre retorna uma
  data estritamente no futuro (nunca igual, nunca no passado).
- **H3** — Criação de lembrete recorrente: `LEMBRETE_CRIAR` confirmado persiste `recurrence` e
  `dueAt` corretos; `preview()`/resposta final usam `formatRecurrenceHuman()`.
- **H4** — Disparo com reagendamento: teste de integração simulando `notify()` bem-sucedido num
  item recorrente — confirma que `notifiedAt` permanece `null`, `dueAt` avança pra próxima
  ocorrência, e o `ReminderScheduler` tem um timer novo agendado pro `id` do item.
- **H5** — `bootstrap()` com item recorrente vencido há mais de 24h: `dueAt` avança pra próxima
  ocorrência futura, `notifiedAt` continua `null`, nenhum popup é disparado pras ocorrências
  perdidas, `console.warn` registra o pulo.
- **H6** — `LEMBRETE_APAGAR` num lembrete recorrente: remove o item e cancela o timer — a
  recorrência para de verdade, sem vazamento de timer (mesmo padrão já testado na Fase 6).
- **H7** — `LEMBRETE_EDITAR` (Fase 8) recusa uma frase de recorrência disfarçada de edição de
  texto ("corrige o lembrete pra: toda segunda às 9h"), mesma disciplina de defesa em
  profundidade que já existe pra horário simples.
- **H8** — Verificação manual com tempo acelerado (não é prático esperar 24h de teste real):
  criar um lembrete recorrente com horário poucos minutos no futuro, confirmar que dispara, e
  confirmar manualmente (inspecionando `lembretes.json`) que o item se reagendou em vez de
  desaparecer ou marcar `notifiedAt`.

## 7. Riscos

- **Cálculo de calendário duplicado** (`parseRecurrence()` vs. `computeNextOccurrence()`) —
  mitigado extraindo a lógica de avanço em função compartilhada (§4.4), não duas implementações
  independentes que podem divergir silenciosamente.
- **Rajada de notificações atrasadas** se o processo ficar off-line por muito tempo com vários
  lembretes recorrentes — mitigado: `bootstrap()` nunca dispara ocorrências perdidas, só pula
  direto pra próxima futura (§4.4), mesmo espírito da janela de 24h que a Fase 6 já tem pra
  lembretes normais.
- **`LEMBRETE_EDITAR` da Fase 8 nunca editando recorrência** — decisão explícita de escopo (§3),
  mas o risco real é a defesa em profundidade (H7) não cobrir todos os padrões de frase de
  recorrência que `parseRecurrence()` reconhece — se os dois parsers (defesa de EDITAR e
  `parseRecurrence()` de CRIAR) usarem regras diferentes, um padrão pode escapar da defesa. A
  implementação deve reaproveitar a MESMA função `parseRecurrence()` pra detectar o caso a
  recusar em `LEMBRETE_EDITAR`, não reescrever a detecção.
- **Sem teste automatizado real de "esperar 24h"**: H5 e H8 dependem de simular `now`/tempo
  decorrido nos testes, não de esperar de verdade — mesmo padrão já usado pelos testes de
  `bootstrap()` desde a Fase 6.

## 8. Rastreabilidade

- Escopo combinado com o usuário: `AskUserQuestion`, 2026-09-27 (§0).
- Decisão de abrir a Fase 9: conversa de fechamento da Fase 8, mesmo dia.
- Precedente de arquitetura reaproveitado: `docs/phase-6-v2.md` (períodos do dia, `bootstrap()`,
  janela de 24h de atraso), `docs/phase-8-v2.md` §4.2 (defesa em profundidade via
  `parseRelativeTime()`, estendida aqui pra `parseRecurrence()`).
