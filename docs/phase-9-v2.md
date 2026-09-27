# Fase 9 — Recorrência de lembretes — v2

Versão: v2
Data: 2026-09-27
Status: Auditado (agy rodada 1: REJEITADO, 10 achados — todos corrigidos abaixo)
Base: Corrige os 10 achados da auditoria adversarial da rodada 1 sobre o v1
(`docs/audits/phase-9-v1-agy-rodada1-2026-09-27.log`).

## 0. Escopo combinado com o usuário — inalterado da v1

1. **Padrões de recorrência**: diário e semanal simples.
2. **Reagendamento**: o mesmo item se reagenda após disparar.

## 1. Objetivo — inalterado da v1

## 2. A premissa da fase — inalterado da v1 (riscos centrais já nomeados corretamente; a v2
corrige a execução desses riscos, não a identificação deles)

## 3. Escopo — inalterado da v1

## 4. Decisões de projeto

### 4.1 `StoredItem`/`RecurrenceRule` — inalterado da v1

```ts
export interface RecurrenceRule {
  type: 'daily' | 'weekly';
  hour: number;
  minute: number;
  weekday?: number; // 0 (domingo) a 6 (sábado), Date.getDay()
}

export interface StoredItem {
  id: string;
  text: string;
  createdAt: string;
  dueAt?: string | null;
  notifiedAt?: string | null;
  recurrence?: RecurrenceRule | null;
}
```

### 4.2 `computeNextOccurrence()` — corrigido (achado 1, CRÍTICA — loop infinito real)

**A v1 descrevia o avanço semanal como "somar 7 dias até achar o dia certo" — se hoje não for
o dia pedido, somar 7 dias em cíclos nunca muda o dia da semana do candidato (quarta + 7 dias =
quarta seguinte, pra sempre), travando em loop infinito.** Verificado empiricamente em Node antes
de aceitar a correção (três casos: dia diferente, mesmo dia já passou, mesmo dia ainda não
passou — os três calculam certo):

```ts
export function computeNextOccurrence(rule: RecurrenceRule, now: Date = new Date()): string {
  const candidate = new Date(now);
  candidate.setHours(rule.hour, rule.minute, 0, 0);

  if (rule.type === 'daily') {
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }

  // weekly — salto exato em dias via aritmética modular, nunca incremento cego de 7 em 7
  // (achado 1, CRÍTICA, rodada 1):
  let daysAhead = (rule.weekday! - now.getDay() + 7) % 7;
  if (daysAhead === 0 && candidate <= now) daysAhead = 7;
  candidate.setDate(candidate.getDate() + daysAhead);
  return candidate.toISOString();
}
```

**Assinatura formal, export e imports** (achado 9, BAIXA — a v1 não declarava isso
explicitamente): `computeNextOccurrence` mora em `src/backend/tools/relativeTimeParser.ts`,
exportada. `RecurrenceRule` mora em `src/backend/storage/jsonStore.ts` — `relativeTimeParser.ts`
já importa `StoredItem` de lá hoje (confirmar no código real qual arquivo importa o quê; se
`RecurrenceRule` não estiver lá ainda, este plano a está definindo em `jsonStore.ts` por §4.1).
`reminderScheduler.ts` importa `computeNextOccurrence` de `./relativeTimeParser.js` — mesmo
padrão de import relativo `.js` já usado em todo o arquivo hoje. Grafo de dependência:
`jsonStore.ts` → `relativeTimeParser.ts` → `reminderScheduler.ts` → `mutatingTools.ts`, acíclico
(confirmado na auditoria).

### 4.3 `parseRecurrence()` — regexes corrigidos (achado 4, ALTA — falhavam nos próprios exemplos do plano)

**A v1 tinha três erros reais e verificáveis nos próprios exemplos que o plano citava**:
1. `toda\s+(...|sábado|domingo)` exige "toda", mas "sábado"/"domingo" são masculinos em
   português — o próprio exemplo do escopo (§0.1) era "todo domingo de manhã", que o regex da v1
   não reconhecia.
2. O regex de hora explícita exigia `h`/`horas` obrigatório — mas o próprio exemplo do objetivo
   (§1) era "todo dia às 8 **da manhã**", sem a palavra "h"/"horas".
3. Sem suporte a minutos ("todo dia às 8h30", "todo dia às 8 e meia").

Corrigido — separando o artigo do nome do dia (`(?:todo|toda)` sempre, dia decide o gênero só na
prosa de exemplo, não no regex), aceitando "da manhã"/"horas"/dígito solto, e capturando minutos
opcionais reaproveitando `parseNumberOrWord` (já existe em `relativeTimeParser.ts` desde a Fase 6
pra números por extenso):

```ts
const DIAS_SEMANA: Record<string, number> = {
  domingo: 0, segunda: 1, terça: 2, terca: 2, quarta: 3, quinta: 4, sexta: 5, sábado: 6, sabado: 6
};

// Diário, hora explícita (dígito ou por extenso, minutos opcionais):
// /(?:todo|toda)\s+dia\s+(?:(?:a|à|de|pela)\s+)?s?\s*(\d{1,2}|[a-zçã]+)(?:\s*(?:h|horas?|:|e)\s*(\d{1,2})?)?/
// Diário, período do dia (mesmo padrão de preposições já usado por parseRelativeTime — achado 4.3,
// "todo dia à tarde" e "todo dia a tarde" também precisam casar, não só "todo dia de tarde"):
// /(?:todo|toda)\s+dia\s+(?:(?:a|à|de|pela)\s+)?manh[ãa]/   -> 09:00
// /(?:todo|toda)\s+dia\s+(?:(?:a|à|de|pela)\s+)?tarde/       -> 14:00
// /(?:todo|toda)\s+dia\s+(?:(?:a|à|de|pela)\s+)?noite/       -> 19:00
// Semanal — mesmo padrão de hora/período, com o nome do dia entre "toda"/"todo" e a hora:
// /(?:todo|toda)\s+(domingo|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado)(?:-feira)?\s+
//   (?:(?:a|à|de|pela)\s+)?s?\s*(\d{1,2}|[a-zçã]+)(?:\s*(?:h|horas?|:|e)\s*(\d{1,2})?)?/
// /(?:todo|toda)\s+(domingo|...)(?:-feira)?\s+(?:(?:a|à|de|pela)\s+)?manh[ãa]/ -> 09:00
// (mesma cobertura de tarde/noite)
```

**Corrigindo o achado 8 (BAIXA) da rodada 1** — a v1 dizia erroneamente "mesma normalização NFD
de `mightBeMutation`". Isso está errado: `parseRecurrence()`, como `parseRelativeTime()` já faz
desde a Fase 6, opera sobre o **conteúdo já extraído pelo worker** (preserva maiúsculas/
acentos, só é case-insensitive via flag `/i`) — `mightBeMutation()` é um filtro permissivo
diferente, que roda sobre a transcrição bruta antes de chamar o worker, e esse sim remove
acentos. Os dois nunca operam no mesmo texto. Nota removida do plano.

`parseRecurrence()` retorna `{ recurrence: null, dueAt: null, residualText: text }` se nada casar
— mesmo contrato de `parseRelativeTime()`.

### 4.4 `formatRecurrenceHuman()` — sem depender de função inexistente (achado 3, ALTA)

**A v1 chamava uma função `formatHourSpoken()` que não existe em `relativeTimeParser.ts`.**
Corrigido com a formatação por extenso definida inline, cobrindo os mesmos períodos do dia já
usados em `formatHumanRelative()` (achado 3, ação recomendada — "de manhã"/"de tarde"/"de
noite" quando a hora bate exatamente com os horários fixos da Fase 6, hora falada nos outros
casos):

```ts
function formatHourPart(hour: number, minute: number): string {
  if (hour === 9 && minute === 0) return 'de manhã';
  if (hour === 14 && minute === 0) return 'de tarde';
  if (hour === 19 && minute === 0) return 'de noite';
  if (minute === 0) return `às ${hour} horas`;
  if (minute === 30) return `às ${hour} e meia`;
  return `às ${hour} e ${minute}`;
}

export function formatRecurrenceHuman(rule: RecurrenceRule): string {
  const hora = formatHourPart(rule.hour, rule.minute);
  if (rule.type === 'daily') return `todo dia ${hora}`;
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  return `toda ${dias[rule.weekday!]} ${hora}`;
}
```

`LembreteTool.preview()`/`execute()` usam essa função no lugar de `formatHumanRelative()` quando
`recurrence !== null`: `"Posso criar o lembrete de ${finalText}, todo dia de manhã?"` /
`"Lembrete criado, vou te avisar todo dia de manhã."`.

### 4.5 `LembreteTool` (`mutatingTools.ts`) — pseudocódigo completo (achado 6, MÉDIA)

**A v1 não especificava as mudanças em `LembreteTool` além de "chama `parseRecurrence()`
primeiro" — três lacunas reais que a auditoria achou**: tipo de `lastParsed` incompatível,
`recurrence` nunca incluído no `store.items.push`, e deduplicação que não considera `recurrence`
(um lembrete único com mesmo texto/horário da primeira ocorrência de um recorrente seria barrado
como duplicata indevidamente). Corrigido, pseudocódigo completo:

```ts
// LembreteTool ganha um segundo campo de cache, ao lado de lastParsed — tipos diferentes
// (ParsedRelativeTime vs ParsedRecurrence), não dá pra reaproveitar o mesmo campo:
private lastParsed: { raw: string; parsed: ParsedRelativeTime } | null = null;
private lastParsedRecurrence: { raw: string; parsed: ParsedRecurrence } | null = null;

preview(kind: MutationName, content: string | null): string {
  if (kind === 'LEMBRETE_CRIAR') {
    if (!content || !content.trim()) throw new Error('Conteúdo ausente para criação de lembrete.');

    const recurrenceParsed = parseRecurrence(content);
    if (recurrenceParsed.recurrence) {
      this.lastParsedRecurrence = { raw: content, parsed: recurrenceParsed };
      this.lastParsed = null;
      const finalText = recurrenceParsed.residualText.trim() || content;
      return `Posso criar o lembrete de ${finalText}, ${formatRecurrenceHuman(recurrenceParsed.recurrence)}?`;
    }
    this.lastParsedRecurrence = null;

    // fluxo existente da Fase 6, inalterado:
    const parsed = parseRelativeTime(content);
    this.lastParsed = { raw: content, parsed };
    // ...resto igual a hoje...
  }
  // ...LEMBRETE_APAGAR/LEMBRETE_EDITAR inalterados...
}

execute(kind: MutationName, content: string | null): string {
  const cachedParsed = this.lastParsed;
  const cachedRecurrence = this.lastParsedRecurrence;
  this.lastParsed = null;
  this.lastParsedRecurrence = null;

  if (kind === 'LEMBRETE_CRIAR') {
    if (!content || !content.trim()) throw new Error('Conteúdo ausente para criação de lembrete.');

    const recurrenceParsed =
      cachedRecurrence && cachedRecurrence.raw === content ? cachedRecurrence.parsed : parseRecurrence(content);

    if (recurrenceParsed.recurrence) {
      const { recurrence, dueAt, residualText } = recurrenceParsed;
      const finalText = residualText.trim() || content;
      const store = this.store.read();
      const last = store.items[store.items.length - 1];
      // Dedupe considera recurrence agora (achado 6) — sem isso, um lembrete único com o mesmo
      // texto/horário da primeira ocorrência de um recorrente seria barrado por engano:
      const isDuplicate =
        last &&
        last.text === finalText &&
        (last.dueAt ?? null) === (dueAt ?? null) &&
        JSON.stringify(last.recurrence ?? null) === JSON.stringify(recurrence) &&
        last.notifiedAt === null;
      if (isDuplicate) return 'Isso já estava salvo.';

      const id = crypto.randomUUID();
      store.items.push({ id, text: finalText, createdAt: new Date().toISOString(), dueAt, notifiedAt: null, recurrence });
      this.store.write(store);
      this.scheduler.schedule({ id, text: finalText, dueAt: dueAt! });
      return `Lembrete criado, vou te avisar ${formatRecurrenceHuman(recurrence)}.`;
    }

    // fluxo existente da Fase 6, inalterado (parseRelativeTime, sem campo recurrence — undefined
    // por padrão, retrocompatível):
    const parsed = cachedParsed && cachedParsed.raw === content ? cachedParsed.parsed : parseRelativeTime(content);
    // ...resto igual a hoje...
  }
  // ...
}
```

### 4.6 `ReminderScheduler.notify()` — jitter corrigido, bifurcação por recorrência

**Ajuste da verificação item-a-item da auditoria** (não um achado formal, mas um ponto de atenção
confirmado): usar `Math.max(Date.now(), new Date(current.dueAt).getTime())` como referência do
recálculo, não só `new Date()` — evita que um timer disparando alguns milissegundos antes do
horário exato calcule a mesma ocorrência de novo por causa de jitter do `setTimeout`:

```ts
// notify(), dentro do callback de sucesso do execFile — substituindo o bloco atual:
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
  console.error(`[ReminderScheduler] Erro ao processar disparo do lembrete id=${item.id}:`, err);
}
```

**Nada muda no ramo `diffMs <= OVERDUE_CUTOFF_MS` de `bootstrap()`** — corrigindo o achado 5
(MÉDIA, contradição de prosa) abaixo.

### 4.7 `bootstrap()` — corrigido (achado 2 ALTA: variável errada; achado 5 MÉDIA: prosa incorreta; achado 10 BAIXA: O(n²))

**Achado 2 (ALTA, confiança 100%)**: a v1 usava `current.recurrence` dentro do loop `for (const
item of items)` — `current` não existe nesse escopo, é `item`. Sem esta correção, qualquer
processo reiniciado com um lembrete recorrente vencido há mais de 24h lançaria `ReferenceError`
e derrubaria a inicialização do `ReminderScheduler` (e do servidor de voz inteiro,
`voiceRuntime.ts`). Corrigido: todas as ocorrências de `current` no bloco `>24h` viram `item`.

**Achado 5 (MÉDIA) — prosa corrigida, não o comportamento**: a v1 dizia em §2/§7 "nunca dispara
popup pras ocorrências perdidas" sem qualificar — mas isso só é verdade pro ramo `>24h`. O ramo
`<=24h` (atraso dentro da janela normal) **continua dispará o popup "Lembrete (atrasado)" uma vez,
igual a um lembrete não-recorrente** — e isso está correto, não é um bug: é o mesmo comportamento
de sempre pra um atraso pequeno, e o reagendamento pra próxima ocorrência já acontece
automaticamente dentro do `notify()` bifurcado (§4.6), sem precisar de nenhuma mudança extra no
ramo `<=24h` do `bootstrap()`. A frase da v1 foi corrigida pra: *"`bootstrap()` nunca marca
`notifiedAt` permanente pra item recorrente — pra atrasos **acima de 24h**, pula direto pra
próxima ocorrência sem popup; pra atrasos **até 24h**, dispara o popup de atraso uma vez (mesmo
comportamento de sempre) e reagenda automaticamente via `notify()`."*

**Achado 10 (BAIXA) — O(n²) e non-null assertion removidos**: agendamento movido pro mesmo loop
de escrita, sem `find()` repetido:

```ts
const expiredIds: string[] = [];
const recurringReschedules: Array<{ id: string; nextDueAt: string }> = [];

for (const item of items) {
  // ... (lógica de due <= now / diffMs inalterada) ...
  if (diffMs <= OVERDUE_CUTOFF_MS) {
    // ramo <=24h: inalterado — dispara notify({late:true}), que já bifurca por recorrência (§4.6)
  } else {
    if (item.recurrence) {
      const nextDueAt = computeNextOccurrence(item.recurrence, now);
      console.warn(
        `[ReminderScheduler] Lembrete recorrente id=${item.id} perdeu ocorrência(ões) durante ` +
        `downtime — pulando direto para a próxima: ${nextDueAt}.`
      );
      recurringReschedules.push({ id: item.id, nextDueAt });
    } else {
      console.warn(`[ReminderScheduler] Lembrete id=${item.id} ("${item.text}") expirado há mais de 24h...`);
      expiredIds.push(item.id);
    }
  }
}

if (expiredIds.length > 0 || recurringReschedules.length > 0) {
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
```

Contrato final, sem decisão em aberto: itens recorrentes vencidos há mais de 24h NUNCA recebem
`notifiedAt` — sempre recebem um `dueAt` novo no futuro, sempre com `console.warn`. Itens
recorrentes vencidos há até 24h disparam o popup de atraso uma vez, igual a hoje, e se
reagendam via `notify()`.

### 4.8 `LEMBRETE_EDITAR` (Fase 8) — defesa em profundidade concreta (achado 7, MÉDIA)

**A v1 dizia "reaproveitar `parseRecurrence()`" sem mostrar onde nem qual mensagem retornar.**
Corrigido — mesmo ponto do código onde a Fase 8 já checa horário, checagem adicional logo depois,
usando a MESMA função `parseRecurrence()` que `LEMBRETE_CRIAR` usa (não uma detecção paralela,
evitando o risco nomeado em §7 da v1 de dois parsers divergirem):

```ts
// LembreteTool.execute(), ramo LEMBRETE_EDITAR — logo após a checagem de notifiedAt existente
// da Fase 8, antes da checagem de horário simples que a Fase 8 já tem:
const trimmed = content.trim();

const wouldBeRecurrent = parseRecurrence(trimmed).recurrence !== null;
if (wouldBeRecurrent) {
  return 'Não dá pra mudar a recorrência editando o texto — apague e crie um lembrete novo.';
}

const wouldScheduleTime = parseRelativeTime(trimmed).dueAt !== null;
if (wouldScheduleTime) {
  return 'Não dá pra mudar o horário editando o texto — apague e crie um lembrete novo com o horário certo.';
}
// ...resto inalterado...
```

Mensagem distinta da de horário simples (mais específica: "recorrência" em vez de "horário"),
porque são erros de usuário conceitualmente diferentes mesmo que a ação recomendada seja igual.

### 4.9 Nota sobre `MUTATION_GATE` e classificação — limitação aceita, não um bug (verificação da rodada 1)

A auditoria observou que uma frase de recorrência **sem** nenhum verbo de mutação reconhecido
("todo dia às 8h tomar remédio", sem "lembra"/"anota"/etc.) não ativaria `MUTATION_GATE`
(`mutatingTools.ts`) e nunca chegaria ao worker. Isto é esperado e não é um problema desta fase:
o `MUTATION_GATE` é um filtro permissivo que já existe desde a Fase 5c e nunca foi desenhado pra
reconhecer recorrência sozinha — todo exemplo real deste plano (§0, §1) já inclui um verbo de
mutação junto ("me lembra todo dia..."). Nenhuma mudança necessária; registrado aqui pra não ser
redescoberto como "achado novo" numa rodada futura.

A auditoria também levantou se `LEMBRETE_EDITAR` classificaria corretamente "corrige o lembrete
pra toda segunda às 9h" — confirmado que sim, sem mudança necessária no worker: a classificação
de `LEMBRETE_EDITAR` (Fase 8) já extrai qualquer texto de correção como `content` bruto,
independente do que esse texto contém — o worker não precisa "entender" que é sobre recorrência,
só que é uma correção de texto do lembrete mais recente. A defesa em profundidade (§4.8) roda em
cima do `content` já extraído, no lado Node, não depende de o worker reconhecer o padrão.

## 5. Arquivos afetados

```
src/backend/storage/jsonStore.ts          StoredItem ganha recurrence?: RecurrenceRule | null
src/backend/tools/relativeTimeParser.ts   parseRecurrence(), formatRecurrenceHuman(),
                                           computeNextOccurrence() — todos exportados (§4.2)
src/backend/tools/reminderScheduler.ts    notify() bifurca por recorrência com correção de jitter
                                           (§4.6); bootstrap() corrigido (item, não current; O(n²)
                                           removido; prosa de <=24h corrigida) (§4.7)
src/backend/tools/mutatingTools.ts        LembreteTool ganha lastParsedRecurrence, chama
                                           parseRecurrence() antes de parseRelativeTime() em
                                           preview()/execute(), dedupe considera recurrence (§4.5);
                                           LEMBRETE_EDITAR ganha defesa contra recorrência (§4.8)
src/backend/__tests__/                    testes novos para os módulos acima
```

`scripts/worker/worker.py` não muda — confirmado na auditoria (§4.9), não é mais uma afirmação
sem verificação.

## 6. Critérios de aceite (H1..H10)

- **H1** — `computeNextOccurrence()`: nunca entra em loop infinito, testado pros 7 dias da semana
  a partir de qualquer dia atual, com e sem o horário já ter passado hoje — inclui
  especificamente o caso que causava o loop infinito da v1 (pedir um dia diferente do atual).
- **H2** — `parseRecurrence()`: cobre os próprios exemplos do plano ("todo domingo de manhã",
  "todo dia às 8 da manhã"), gênero correto pra sábado/domingo, minutos opcionais, mesmas
  preposições de `parseRelativeTime()` (a/à/de/pela).
- **H3** — Criação de lembrete recorrente: persiste `recurrence`+`dueAt`, dedupe considera
  `recurrence`, `preview()`/resposta usam `formatRecurrenceHuman()`.
- **H4** — Disparo com reagendamento: `notify()` bem-sucedido mantém `notifiedAt: null`, avança
  `dueAt`, agenda timer novo — incluindo o caso de jitter (`Math.max`).
- **H5** — `bootstrap()`: item recorrente vencido >24h avança `dueAt` sem popup nem
  `ReferenceError`; item recorrente vencido <=24h dispara popup uma vez e reagenda via `notify()`.
- **H6** — `LEMBRETE_APAGAR` cancela recorrência (regressão, sem mudança de código nesta função).
- **H7** — `LEMBRETE_EDITAR` recusa frase de recorrência com a mensagem específica de §4.8,
  usando a mesma `parseRecurrence()`.
- **H8** — Regressão: lembrete não-recorrente continua funcionando idêntico (campo `recurrence`
  ausente/`undefined`, dedupe compatível).
- **H9** — Regressão: suíte completa das Fases 1-8 passa sem alteração de comportamento.
- **H10** — Verificação manual com tempo acelerado: criar lembrete recorrente com horário
  próximo, confirmar disparo e reagendamento reais no `lembretes.json`.

## 7. Riscos — atualizados

- **Cálculo de calendário** — corrigido e verificado empiricamente (§4.2), não mais um risco em
  aberto, mas mantido como candidato a teste de regressão permanente (H1).
- **`LEMBRETE_EDITAR` vs. recorrência** — resolvido reaproveitando a mesma função (§4.8), risco
  original da v1 (dois parsers divergindo) eliminado por construção.
- **Sem teste automatizado real de "esperar 24h/1 semana"**: H5/H10 dependem de simular
  `now`/tempo decorrido, mesmo padrão já usado desde a Fase 6.

## 8. Rastreabilidade

- Escopo combinado com o usuário: `AskUserQuestion`, 2026-09-27 (§0).
- Auditoria adversarial v1: `docs/audits/phase-9-v1-agy-rodada1-2026-09-27.log` (10 achados,
  REJEITADO — 1 CRÍTICA, 3 ALTA, 3 MÉDIA, 3 BAIXA).
- Precedente de arquitetura: `docs/phase-6-v2.md`, `docs/phase-8-v2.md` §4.2.

## 9. Achados da rodada 1 (agy) e como foram resolvidos

| # | Achado | Gravidade | Resolução no v2 | Seção |
|---|---|---|---|---|
| 1 | Loop infinito no cálculo semanal (`current + 7 dias` nunca muda o dia da semana) | CRÍTICA | Fórmula modular `(weekday - now.getDay() + 7) % 7`, verificada empiricamente em Node antes de aceitar | §4.2 |
| 2 | Variável `current` inexistente em `bootstrap()` (é `item`) — causaria `ReferenceError` na subida do servidor | ALTA | Todas as ocorrências corrigidas para `item` | §4.7 |
| 3 | `formatHourSpoken()` referenciada mas nunca definida nem existente no código real | ALTA | Substituída por `formatHourPart()` definida inline, cobrindo os períodos fixos da Fase 6 | §4.4 |
| 4 | Regexes falhavam nos próprios exemplos do plano (gênero de dia, "da manhã" sem "h", sem minutos) | ALTA | Regexes reescritos cobrindo os casos reais, minutos via `parseNumberOrWord` | §4.3 |
| 5 | Contradição de prosa sobre popup em atrasos <=24h vs. >24h | MÉDIA | Prosa corrigida — só >24h pula sem popup; <=24h dispara uma vez e reagenda, comportamento já correto por construção do `notify()` bifurcado | §4.7 |
| 6 | `LembreteTool` sem pseudocódigo de tipo/persistência/dedupe pra recorrência | MÉDIA | Pseudocódigo completo com `lastParsedRecurrence`, `recurrence` no push, dedupe considerando `recurrence` | §4.5 |
| 7 | Defesa em profundidade de `LEMBRETE_EDITAR` sem código concreto nem mensagem | MÉDIA | Código exato e mensagem específica adicionados | §4.8 |
| 8 | Nota incorreta sobre normalização NFD (parseRecurrence não roda sobre texto sem acento) | BAIXA | Nota removida, esclarecido que opera sobre o conteúdo já extraído, como `parseRelativeTime()` | §4.3 |
| 9 | Assinatura/export/imports de `computeNextOccurrence()` não declarados | BAIXA | Declarado explicitamente onde a função mora e quem importa o quê | §4.2 |
| 10 | O(n²) com `find()` dentro de loop e non-null assertion em `bootstrap()` | BAIXA | Reescrito com `Map`, agendamento no mesmo loop de escrita | §4.7 |
