# Fase 6 — Agendamento de lembretes (horário/data de disparo + notificação) — v1

## 0. Escopo combinado com o usuário antes de escrever este plano

O roteiro original menciona "Fase 6 — memória entre sessões" sem detalhar (referenciado em
`docs/phase-5a-v1.md` §"fora de escopo" e `docs/phase-5c-v1.md` §"fora de escopo": *"Lembrete com
horário/data de disparo (isso é um agendador — Fase 6+ território, 'memória entre sessões' e
possivelmente notificação, que não existe no projeto)"*). Ao fechar a Fase 5c (2026-09-24,
`docs/implementation-phase-5c.md` §10), três perguntas foram feitas ao usuário antes de escrever
este plano — mesmo protocolo que toda fase anterior seguiu (ex. Fase 4, `docs/
phase-4-kickoff-prompt.md` passo 1):

1. **Escopo da Fase 6**: "memória entre sessões" cobre duas coisas distintas — memória de
   fatos/contexto (o Rodrigo lembra do que o usuário disse em sessões passadas) e agendamento de
   lembretes (horário/data de disparo + notificação). Decisão: **as duas, em fases separadas**,
   nunca misturadas num plano só.
2. **Ordem**: agendamento vem primeiro (Fase 6, este documento); memória de contexto fica pra
   Fase 7 — escopo mais contido e testável, extensão direta do que já existe (`LembreteTool`/
   `NotaTool`, Fase 5c), enquanto memória de contexto tem perguntas de desenho maiores em aberto
   (o que lembrar, onde guardar, como usar na geração, privacidade) que merecem seu próprio
   levantamento antes de planejar.
3. **Notificação sem sessão ativa**: quando o horário do lembrete chega e não há sessão de voz
   aberta, a notificação é a **notificação nativa do macOS** (`osascript`/`terminal-notifier`) —
   não fala em voz alta via TTS (isso exigiria o backend rodando permanentemente como daemon,
   mudança de arquitetura maior, fora de escopo aqui) e não fica só "avisando no início da próxima
   sessão" (isso não seria notificação em tempo real).
4. **Parsing de horário, nesta primeira versão**: só **relativo simples** — "daqui a 20 minutos",
   "em 2 horas", "amanhã de manhã". Horário absoluto exato ("às 15h de sexta") e recorrência
   ("todo dia às 8h") ficam fora de escopo, candidatos a fase própria depois.

## 1. Objetivo

Um lembrete criado por voz pode carregar "quando" ele deve disparar, e no horário certo o usuário
recebe uma notificação nativa do macOS com o texto do lembrete — mesmo que não esteja com uma
sessão de voz aberta no momento.

**Critério de conclusão, em linguagem do roteiro**: o usuário fala "me lembra de ligar pro dentista
daqui a 20 minutos", confirma, fecha (ou minimiza) o app, e 20 minutos depois recebe uma
notificação do macOS com o texto "Ligar pro dentista".

## 2. A premissa da fase

`LembreteTool` (Fase 5c) já cria/apaga lembretes com confirmação de voz real (`markPlayed()`) —
essa garantia central **não muda nesta fase**. O que falta é: (a) capturar "quando" na mesma frase
de criação, (b) guardar isso junto do item, (c) um mecanismo que, passado esse "quando", dispare a
notificação — independente de haver ou não uma sessão de voz aberta naquele momento.

**Premissa que muda o raciocínio de arquitetura, e que precisa ficar explícita para o auditor**:
hoje o processo Node só roda enquanto alguém executa `npm run dev`/`npm start` manualmente. Esta
fase **não** resolve "o processo precisa estar sempre rodando" — assume que o usuário deixa o
processo ativo (mesma responsabilidade que hoje já existe para o app funcionar). Se o processo Node
estiver parado no horário do disparo, a notificação simplesmente não acontece nesse momento; ao
processo subir de novo, lembretes com `dueAt` já vencido dentro dos últimos N minutos são tratados
como "atrasados" (ver §4.4) em vez de silenciosamente descartados ou disparados tarde demais sem
aviso. Rodar como `launchd`/daemon de sistema fica fora de escopo — é uma decisão de infraestrutura
separada, não uma decisão desta fase de produto.

## 3. Escopo

**Dentro do escopo:**
- Extrair uma expressão de tempo relativo simples da mesma frase que cria o lembrete ("me lembra
  de X daqui a 20 minutos" / "em 2 horas" / "amanhã de manhã" / "amanhã à noite").
- Persistir `dueAt` (ISO 8601, ou `null` se a frase não trouxe horário — lembrete sem agendamento
  continua funcionando exatamente como na Fase 5c) no mesmo `JsonStore` de lembretes.
- Um agendador em processo (setTimeout/verificação periódica) que, com o servidor rodando, dispara
  notificação nativa do macOS no horário certo.
- Notificação nativa do macOS (`osascript -e 'display notification ...'`) com o texto do lembrete.
- Tratamento de lembretes "atrasados" encontrados na subida do processo (§4.4).
- `NotaTool` **não** ganha agendamento — notas não têm "quando", só lembretes.

**Fora de escopo, mesmo que pareça natural:**
- Horário absoluto exato ("às 15h de sexta", "dia 30 às 9h") — só relativo simples, por decisão
  explícita acima.
- Recorrência ("todo dia às 8h", "toda segunda").
- Notificação falada via TTS quando não há sessão ativa (exigiria daemon sempre ativo).
- Rodar o backend como serviço de sistema (`launchd`) — infraestrutura, não escopo de produto.
- Integração com Lembretes.app/Notas.app do macOS (decisão do usuário já registrada em
  `docs/phase-5c-v1.md` §0 — continua de fora).
- Editar o horário de um lembrete já criado (só criar com horário, ou sem; apagar continua
  existindo como já era).
- Memória de contexto entre sessões — isso é a Fase 7 (ver §0.2 acima).

## 4. Decisões de projeto

### 4.1 Onde a extração de horário acontece

A frase de criação já passa por `classify()` (worker Python) para virar `LEMBRETE_CRIAR` +
`content`. A extração de tempo relativo acontece **no lado Node**, não no worker Python — é
determinística o bastante (um conjunto fechado de padrões: "daqui a N minutos/horas", "em N
minutos/horas", "amanhã de manhã/tarde/à noite") para não precisar de LLM, e evita adicionar mais
uma chamada ao worker MLX (latência) para algo que regex/parsing de data resolve. Um novo módulo
`src/backend/tools/relativeTimeParser.ts` expõe:

```ts
// Retorna a data absoluta (ISO) se reconhecer uma expressão de tempo relativo simples no
// texto, e o texto residual (a frase sem a expressão de tempo, pra não poluir o conteúdo
// salvo). Retorna null em ambos os campos se nada bater — lembrete sem agendamento, igual à
// Fase 5c.
export interface ParsedRelativeTime {
  dueAt: string | null;      // ISO 8601, sempre no futuro relativo ao momento da chamada
  residualText: string;      // conteúdo do lembrete sem a expressão de tempo
}

export function parseRelativeTime(text: string, now: Date = new Date()): ParsedRelativeTime {
  // Padrões cobertos (case-insensitive, após normalização NFD como mightBeMutation já faz):
  //   /daqui a (\d+) minutos?/        -> now + N min
  //   /daqui a (\d+) horas?/          -> now + N h
  //   /em (\d+) minutos?/             -> now + N min
  //   /em (\d+) horas?/               -> now + N h
  //   /amanh[ãa] de manh[ãa]/         -> amanhã, 08:00 local
  //   /amanh[ãa] (a|à) tarde/         -> amanhã, 14:00 local
  //   /amanh[ãa] (a|à) noite/         -> amanhã, 19:00 local
  //   /amanh[ãa]/ (sem período)       -> amanhã, 09:00 local (mesmo default de "de manhã")
  // Primeiro padrão que bate vence; a expressão correspondente é removida do texto residual
  // (trim de espaços/pontuação sobrando). Nenhum padrão bate -> { dueAt: null, residualText: text }.
}
```

**Risco nomeado para o auditor**: horários fixos para "de manhã"/"à tarde"/"à noite" (08h/14h/19h)
são uma escolha arbitrária — não há forma de derivar isso de "amanhã de manhã" sem inventar um
número. Alternativa considerada e descartada: perguntar de volta ("que horas de manhã?") —
adicionaria um terceiro turno de conversa só pra isso, desproporcional ao ganho; a escolha de
horário fixo é reversível e documentada, não escondida.

### 4.2 Onde `dueAt` é persistido

`StoredItem` (`src/backend/storage/jsonStore.ts`) ganha um campo opcional:

```ts
export interface StoredItem {
  id: string;
  text: string;
  createdAt: string;
  dueAt?: string | null;      // NOVO — ISO 8601, só usado por LembreteTool; NotaTool nunca escreve.
  notifiedAt?: string | null; // NOVO — ISO 8601, setado quando a notificação de fato disparou;
                               // existe pra distinguir "ainda não chegou a hora" de "já notificou,
                               // não notificar de novo" quando o agendador varre a lista.
}
```

Campo opcional e retrocompatível: itens já existentes em `lembretes.json`/`notas.json` (sem
`dueAt`) continuam válidos, lidos como "sem agendamento" (mesmo comportamento de hoje).

### 4.3 `LembreteTool.execute()` — onde o parsing entra

```ts
execute(kind: MutationName, content: string | null): string {
  if (kind === 'LEMBRETE_CRIAR') {
    if (!content || !content.trim()) throw new Error('Conteúdo ausente para criação de lembrete.');

    const { dueAt, residualText } = parseRelativeTime(content);
    const finalText = residualText.trim() || content; // nunca salvar texto vazio

    const store = this.store.read();
    const last = store.items[store.items.length - 1];
    if (last && last.text === finalText) return 'Isso já estava salvo.'; // achado 6-like: dedupe usa o texto residual

    store.items.push({
      id: crypto.randomUUID(),
      text: finalText,
      createdAt: new Date().toISOString(),
      dueAt,
      notifiedAt: null
    });
    this.store.write(store);

    if (dueAt) this.scheduler.schedule({ id: <o id recém-criado>, text: finalText, dueAt }); // NOVO
    return dueAt
      ? `Lembrete criado para ${formatHumanRelative(dueAt)}.` // ex. "daqui a 20 minutos"
      : 'Lembrete criado.';
  }
  // LEMBRETE_APAGAR: ao apagar o mais recente, também cancelar seu agendamento se houver
  // (this.scheduler.cancel(id) antes de store.items.pop()).
  ...
}
```

`LembreteTool` recebe uma dependência nova no construtor (`scheduler: ReminderScheduler`), injetada
por `createMutatingTools()` — mesmo padrão de injeção que `JsonStore` já usa.

### 4.4 O agendador (`ReminderScheduler`)

Novo módulo `src/backend/tools/reminderScheduler.ts`, sem dependência de MLX/worker — só
`setTimeout` e `child_process.execFile('osascript', ...)`.

```ts
export class ReminderScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: JsonStore<StoredItem>) {}

  /** Chamado uma vez na subida do servidor (voiceRuntime.ts), depois de createMutatingTools(). */
  bootstrap(now: Date = new Date()): void {
    const { items } = this.store.read();
    for (const item of items) {
      if (!item.dueAt || item.notifiedAt) continue;
      const due = new Date(item.dueAt);
      if (due <= now) {
        // Atrasado: o processo estava parado no horário certo. Notifica agora, com o texto
        // deixando claro que está atrasado, em vez de descartar silenciosamente ou disparar
        // sem contexto — mesma disciplina de honestidade das outras fases (não esconder o gap).
        this.notify(item, { late: true });
      } else {
        this.schedule({ id: item.id, text: item.text, dueAt: item.dueAt });
      }
    }
  }

  schedule(item: { id: string; text: string; dueAt: string }): void {
    const ms = new Date(item.dueAt).getTime() - Date.now();
    const timer = setTimeout(() => this.fire(item.id), Math.max(0, ms));
    timer.unref(); // nunca deve ser o motivo do processo não encerrar (mesma disciplina de
                    // scripts/dev.mjs pra timers — CLAUDE.md, armadilha de setTimeout ref'd)
    this.timers.set(item.id, timer);
  }

  cancel(id: string): void {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
  }

  private fire(id: string): void {
    const { items } = this.store.read();
    const item = items.find((i) => i.id === id);
    if (!item || item.notifiedAt) return; // apagado ou já notificado entre o schedule e o disparo
    this.notify(item, { late: false });
  }

  private notify(item: StoredItem, opts: { late: boolean }): void {
    const title = opts.late ? 'Lembrete (atrasado)' : 'Lembrete';
    execFile('osascript', ['-e',
      `display notification ${JSON.stringify(item.text)} with title ${JSON.stringify(title)}`
    ], () => {}); // fire-and-forget deliberado — falha de notificação não deve derrubar o
                   // servidor nem re-tentar em loop; próxima subida do processo já trata via
                   // bootstrap() se o item continuar sem notifiedAt

    const store = this.store.read();
    const idx = store.items.findIndex((i) => i.id === item.id);
    if (idx !== -1) {
      store.items[idx] = { ...store.items[idx], notifiedAt: new Date().toISOString() };
      this.store.write(store);
    }
  }
}
```

**Risco nomeado para o auditor**: `execFile('osascript', ...)` assume que o macOS concede permissão
de notificação ao processo que chama `osascript` (normalmente Terminal.app/o processo pai) — se o
usuário nunca autorizou notificações para esse processo, `osascript` pode falhar silenciosamente ou
a notificação pode não aparecer sem nenhum erro visível. Isto precisa de verificação manual (§7,
critério de aceite) porque não há como testar automaticamente se uma notificação do SO realmente
apareceu na tela.

### 4.5 Concorrência bootstrap vs. sessão ativa

Se uma sessão de voz cria um lembrete com `dueAt` no mesmo instante em que `bootstrap()` roda (só
acontece na subida do processo, janela de milissegundos), não há corrida real — `bootstrap()` lê o
arquivo uma vez e agenda o que encontrar; um lembrete criado depois passa pelo caminho normal de
`execute()` → `scheduler.schedule()`, que é sempre chamado depois do bootstrap na ordem de
inicialização (`createMutatingTools()` antes de qualquer rota HTTP aceitar tráfego).

## 5. Arquivos afetados

```
src/backend/tools/relativeTimeParser.ts   NOVO — parseRelativeTime(), formatHumanRelative()
src/backend/tools/reminderScheduler.ts    NOVO — ReminderScheduler
src/backend/tools/mutatingTools.ts        LembreteTool ganha scheduler no construtor, usa parseRelativeTime()
src/backend/storage/jsonStore.ts          StoredItem ganha dueAt?/notifiedAt?
src/backend/voice/voiceRuntime.ts         cria o ReminderScheduler, chama bootstrap() na subida
src/backend/__tests__/                    testes novos para os 3 módulos acima
```

`scripts/worker/worker.py` **não muda nesta fase** — confirma que o escopo é só Node/TS.

## 6. Critérios de aceite (rascunho — numerar H1..Hn na versão auditada)

1. Testes unitários novos passam, suíte completa 100%, build limpo, sem regressão em Fase 5c.
2. `parseRelativeTime()` cobre os padrões listados em §4.1 com casos de teste para cada um, mais
   casos negativos (texto sem expressão de tempo → `dueAt: null`).
3. Teste de integração: `LembreteTool.execute('LEMBRETE_CRIAR', 'ligar pro dentista daqui a 20
   minutos')` persiste `dueAt` correto e `text` sem a expressão de tempo.
4. Teste de integração do `ReminderScheduler`: usando `setTimeout` real com um `dueAt` de ~100ms no
   futuro (não mockar timer — mesmo princípio de "não aceitar atalho que não exercita a capacidade
   real", `CLAUDE.md`/armadilhas conhecidas), confirma que `notifiedAt` é preenchido após o disparo
   e que `execFile('osascript', ...)` foi chamado com o texto certo (mockando só o `execFile`, não
   o timer).
5. Teste de `bootstrap()`: um item com `dueAt` no passado e `notifiedAt: null` dispara notificação
   imediata marcada como atrasada; um item com `dueAt` no futuro é agendado, não disparado na hora.
6. **Verificação manual com o SO real** (não automatizável): criar um lembrete por voz com "daqui a
   1 minuto", fechar a aba/minimizar, e confirmar que a notificação nativa do macOS aparece no
   Centro de Notificações dentro de ~1 minuto. Sem isso, o critério 4 (mock de `execFile`) não prova
   que o usuário realmente vê algo na tela.
7. Regressão: lembrete criado sem expressão de tempo continua funcionando exatamente como na Fase
   5c (sem `dueAt`, sem agendamento, `Lembrete criado.` sem menção a horário).

## 7. Riscos

- **Horários fixos arbitrários para períodos do dia** (§4.1) — documentado, não escondido, mas é
  uma decisão de produto que o auditor deve confirmar como aceitável, não assumir como óbvia.
- **Falha silenciosa de notificação do SO** (§4.4) — sem telemetria de "a notificação realmente
  apareceu", só "o comando `osascript` foi chamado sem erro". Mitigado só pela verificação manual
  do critério 6, não por teste automatizado.
- **Processo precisa estar rodando no horário exato** (§2) — fora de escopo resolver, mas o
  usuário precisa entender essa limitação; vale expor isso na resposta falada quando um lembrete é
  criado com agendamento (ex. considerar avisar "só enquanto o Rodrigo estiver aberto" na primeira
  vez — decisão de UX a validar na auditoria, não fechada aqui).
- **`setTimeout` com atraso muito longo** (ex. "amanhã de manhã" pode ser >24h): `setTimeout` do
  Node aceita `delay` até `2^31-1` ms (~24.8 dias) antes de estourar para `1`ms (comportamento
  documentado do Node) — dentro do escopo desta fase (só relativo simples, no máximo ~1 dia), não é
  um risco real ainda, mas fica registrado para quando "absoluto"/recorrência forem adicionados.

## 8. Rastreabilidade

- Referência original ao conceito: `docs/phase-5a-v1.md` §"fora de escopo", `docs/phase-5c-v1.md`
  §"fora de escopo".
- Decisão de fechamento da Fase 5c e abertura da Fase 6: `docs/implementation-phase-5c.md` §10.
- Escopo combinado com o usuário: três perguntas via `AskUserQuestion`, 2026-09-24 (ver §0 acima —
  não há arquivo de log separado; as respostas estão citadas literalmente neste documento).
