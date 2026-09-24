# Fase 6 — Agendamento de lembretes (horário/data de disparo + notificação) — v2

Versão: v2  
Data: 2026-09-24  
Status: Auditado (agy rodada 1 sobre v1: REJEITADO; Hermes sobre v2: APROVADO COM RESSALVAS, aplicadas) — pronto para implementação  
Base: Revisão estruturada sobre o plano v1 (`docs/phase-6-v1.md`), aplicando a resolução de todos os 12 achados da auditoria adversarial da rodada 1 (`docs/audits/phase-6-v1-agy-rodada1-2026-09-24.log`).

---

## 0. Escopo combinado com o usuário antes de escrever este plano

O roteiro original menciona "Fase 6 — memória entre sessões" sem detalhar (referenciado em
`docs/phase-5a-v1.md` §"fora de escopo" e `docs/phase-5c-v1.md` §"fora de escopo": *"Lembrete com
horário/data de disparo (isso é um agendador — Fase 6+ território, 'memória entre sessões' e
possivelmente notificação, que não existe no projeto)"*). Ao fechar a Fase 5c (2026-09-24,
`docs/implementation-phase-5c.md` §10), três perguntas foram feitas ao usuário antes de escrever
o plano inicial — mesmo protocolo que toda fase anterior seguiu (ex. Fase 4, `docs/phase-4-kickoff-prompt.md` passo 1):

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
   aberta, a notificação é a **notificação nativa do macOS** (`osascript` via `display notification`) —
   não fala em voz alta via TTS (isso exigiria o backend rodando permanentemente como daemon,
   mudança de arquitetura maior, fora de escopo aqui) e não fica só "avisando no início da próxima
   sessão" (isso não seria notificação em tempo real).
4. **Parsing de horário, nesta primeira versão**: só **relativo simples** — "daqui a 20 minutos",
   "em 2 horas", "amanhã de manhã". Horário absoluto exato ("às 15h de sexta") e recorrência
   ("todo dia às 8h") ficam fora de escopo, candidatos a fase própria depois.

---

## 1. Objetivo

Um lembrete criado por voz pode carregar "quando" ele deve disparar, e no horário certo o usuário
recebe uma notificação nativa do macOS com o texto do lembrete — mesmo que não esteja com uma
sessão de voz aberta no momento.

**Critério de conclusão, em linguagem do roteiro (ajustado conforme Achado 12):** o usuário fala
"me lembra de ligar pro dentista daqui a 20 minutos", confirma por voz na pergunta que explicita o
horário agendado, fecha ou minimiza a aba do navegador mantendo o processo do servidor ativo no
terminal, e 20 minutos depois recebe uma notificação nativa do macOS com o texto "Ligar pro dentista".

---

## 2. A premissa da fase

`LembreteTool` (Fase 5c) já cria/apaga lembretes com confirmação de voz real (`markPlayed()`) —
essa garantia central **não muda nesta fase**. O que se acrescenta é: (a) capturar "quando" na mesma frase
de criação com suporte a números por extenso do Whisper, (b) guardar isso junto do item, (c) alinhar a
pergunta de confirmação de voz (`preview`) com o que será agendado (`execute`), e (d) um mecanismo em
processo que, passado esse "quando", dispare a notificação nativa — independente de haver ou não uma sessão
de voz aberta naquele momento.

**Premissa de arquitetura e política de atraso (ajustada conforme Achado 8 e 12):**
Hoje o processo Node roda enquanto o usuário mantiver `npm run dev`/`npm start` ativo no terminal. Esta fase
**não** transforma o Rodrigo AI em um serviço de sistema (`launchd`/daemon permanente) — assume que o usuário
deixa o processo do servidor ativo no terminal. Se o processo Node estiver parado no horário do disparo, a
notificação não ocorre naquele instante.

Ao reiniciar o processo, o agendador executa `bootstrap()` e aplica uma política de corte clara:
- **Janela de corte N = 24 horas (1440 minutos):** Definimos N = 24 horas porque em uso pessoal local é
  comum suspender o computador à noite ou fechar a tampa do notebook e reabri-lo horas depois; lembretes do
  mesmo dia ainda guardam utilidade prática se sinalizados como atrasados.
- **Itens vencidos há até 24 horas:** São tratados como atrasados e disparados no macOS com o título
  `"Lembrete (atrasado)"`, sequenciados com pequeno intervalo para evitar sobrecarga de processos.
- **Itens vencidos há mais de 24 horas:** Não disparam notificações em cascata no SO para não poluir a tela
  do usuário com alertas obsoletos de dias ou semanas atrás. Em conformidade com o princípio de honestidade e
  rastreabilidade, esses itens **não são descartados silenciosamente**: um aviso é emitido no terminal
  (`console.warn`) registrando o ID, texto e horário de expiração, e o item tem seu campo `notifiedAt` preenchido
  no `lembretes.json` para evitar reprocessamento repetitivo a cada subida do servidor.

---

## 3. Escopo

**Dentro do escopo:**
- Extrair uma expressão de tempo relativo da frase que cria o lembrete ("me lembra de X daqui a 20 minutos" /
  "em duas horas" / "daqui a meia hora" / "amanhã de manhã" / "amanhã de tarde" / "amanhã de noite").
- Suporte a cardinais numéricos por extenso usuais do Whisper STT (de 1 a 59, "um/uma", "dois/duas", "meia hora").
- Suporte às preposições coloquiais em períodos do dia ("amanhã de tarde", "amanhã à tarde", "amanhã de noite", "amanhã à noite").
- Persistir `dueAt` (ISO 8601, ou `null` se a frase não trouxe horário — lembrete atemporal continua funcionando
  como na Fase 5c) e `notifiedAt` no `StoredItem` de `lembretes.json`.
- Alinhamento estrito entre a confirmação por voz em `preview()` e a persistência em `execute()`, centralizando o parsing.
- Deduplicação corrigida em `execute()`, considerando `text`, `dueAt` e `notifiedAt === null`.
- Agendador em processo (`ReminderScheduler`) com controle de ciclo de vida completo (`bootstrap()`, `schedule()`,
  `cancel()`, `shutdown()`), sem vazamento de timers no Map.
- Disparo confiável via `osascript -e 'display notification ...'` com timeout de 5000ms, gravação de `notifiedAt`
  **apenas após sucesso confirmado**, e `console.error` em caso de falha.
- Cancelamento do timer ativo quando um lembrete for apagado via `LEMBRETE_APAGAR`.
- Tratamento estruturado de itens vencidos no boot do processo (corte de 24 horas).
- Formatação em linguagem natural para fala (`formatHumanRelative()`) respeitando restrições de voz do sistema.
- Injeção e ciclo de vida desacoplados em `createMutatingTools()` e `voiceRuntime.ts`.
- `NotaTool` **não** ganha agendamento — notas não têm "quando", só lembretes.

**Fora de escopo, mesmo que pareça natural:**
- Horário absoluto exato ("às 15h de sexta", "dia 30 às 9h") — só relativo simples nesta fase.
- Recorrência ("todo dia às 9h", "toda segunda-feira").
- Notificação falada via TTS quando não há sessão ativa (exigiria áudio sintetizado em background sem sessão).
- Rodar o backend como daemon de sistema (`launchd`) — infraestrutura de SO separada.
- Integração com Lembretes.app/Notas.app do macOS (decisão de produto fixada na Fase 5c §0).
- Editar o horário de um lembrete já criado (apagar e recriar continua sendo o fluxo suportado).
- Memória de contexto entre sessões — reservada exclusivamente para a Fase 7.

---

## 4. Decisões de projeto

### 4.1 Onde a extração de horário acontece (`relativeTimeParser.ts`)

A frase de criação já passa por `classify()` (worker Python) para virar `LEMBRETE_CRIAR` + `content`. A extração
de tempo relativo ocorre **no lado Node**, de forma determinística e testável isoladamente, evitando adicionar
latência de inferência no worker MLX.

O módulo `src/backend/tools/relativeTimeParser.ts` exporta as estruturas, a função de extração e a formatação falada:

```ts
export interface ParsedRelativeTime {
  dueAt: string | null;      // ISO 8601, sempre no futuro relativo ao momento da chamada
  residualText: string;      // Conteúdo do lembrete sem a expressão de tempo e sem pontuações residuais
}

/** Mapa de números cardinais por extenso comuns no Whisper STT (PT-BR). */
export const CARDINAL_WORDS: Record<string, number> = {
  zero: 0,
  um: 1, uma: 1,
  dois: 2, duas: 2,
  tres: 3, três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14, catorze: 14,
  quinze: 15,
  dezesseis: 16, dezeseis: 16,
  dezessete: 17, dezesete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50
};

/**
 * Converte dígitos ("20") ou cardinais por extenso (1 a 59, "vinte e cinco", "uma", "duas") em número.
 */
export function parseNumberOrWord(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    const val = parseInt(trimmed, 10);
    return Number.isFinite(val) ? val : null;
  }
  const parts = trimmed.split(/\s+e\s+/);
  if (parts.length === 2) {
    const tens = CARDINAL_WORDS[parts[0]];
    const units = CARDINAL_WORDS[parts[1]];
    if (tens !== undefined && units !== undefined) {
      return tens + units;
    }
  }
  return CARDINAL_WORDS[trimmed] ?? null;
}
```

#### Expressões regulares e precedência (corrigindo Achados 3, 4 e 9)

A ordem dos padrões é rigorosa: especificações de período ("tarde", "noite", "manhã") são testadas
**antes** do padrão genérico "amanhã" sem período. A hora da manhã é uniformizada em **09:00 local**
em todo o sistema (eliminando a contradição 08h vs 09h do v1):

1. **"Meia hora":**
   - Expressão: `/(?:daqui\s+a|em)\s+meia\s+hora/i`
   - Cálculo: `now + 30 minutos`
2. **Minutos (dígitos ou por extenso):**
   - Expressão: `/(?:daqui\s+a|em)\s+([a-zçãéíóú\d\s]+?)\s+minutos?/i`
   - Extrai o token numérico com `parseNumberOrWord()`. Se válido (> 0), calcula `now + N minutos`.
3. **Horas (dígitos ou por extenso):**
   - Expressão: `/(?:daqui\s+a|em)\s+([a-zçãéíóú\d\s]+?)\s+horas?/i`
   - Extrai o token numérico com `parseNumberOrWord()`. Se válido (> 0), calcula `now + N horas`.
4. **"Amanhã de tarde" / "amanhã à tarde":**
   - Expressão: `/amanh[ãa]\s+(?:(?:a|à|de)\s+)?tarde/i`
   - Cálculo: dia seguinte às **14:00** local.
5. **"Amanhã de noite" / "amanhã à noite":**
   - Expressão: `/amanh[ãa]\s+(?:(?:a|à|de)\s+)?noite/i`
   - Cálculo: dia seguinte às **19:00** local.
6. **"Amanhã de manhã" / "amanhã pela manhã":**
   - Expressão: `/amanh[ãa]\s+(?:(?:pela|de)\s+)?manh[ãa]/i`
   - Cálculo: dia seguinte às **09:00** local.
7. **"Amanhã" (isolado, sem período especificado):**
   - Expressão: `/amanh[ãa]/i`
   - Cálculo: dia seguinte às **09:00** local (mesmo horário padrão da manhã).

Caso nenhum padrão case ou o número extraído seja inválido, a função retorna `{ dueAt: null, residualText: text }`.
Quando um padrão casa, a expressão temporal correspondente é removida do texto, e pontuações e preposições residuais
(ex.: "de", "para", espaços duplos) são limpas (`trim`), preservando apenas o conteúdo da tarefa.

#### Especificação técnica de `formatHumanRelative()` (corrigindo Achado 10)

Usada para gerar a fala de confirmação e de retorno do TTS. Precisa cumprir as diretrizes de fala do sistema
(`VOICE_SAFETY_AND_OUTPUT_CONSTRAINTS` em `sessionManager.ts:126-138`): sem markdown, sem abreviações, com
números curtos preferencialmente por extenso e linguagem natural.

```ts
/**
 * Converte um timestamp ISO de disparo em texto coloquial em português para síntese por voz.
 * @param dueAtIso Data e hora futura em formato ISO 8601.
 * @param now Data de referência (injeção para testes; default = new Date()).
 */
export function formatHumanRelative(dueAtIso: string, now: Date = new Date()): string {
  const target = new Date(dueAtIso);
  const diffMs = target.getTime() - now.getTime();
  const diffMin = Math.round(diffMs / 60_000);

  // Se o horário já passou ou é imediato
  if (diffMin <= 0) return 'agora';

  // Verifica se cai no dia seguinte (amanhã)
  const isTomorrow =
    target.getDate() !== now.getDate() &&
    target.getTime() > now.getTime() &&
    diffMs < 36 * 3600 * 1000;

  if (isTomorrow) {
    const hours = target.getHours();
    if (hours === 9) return 'amanhã de manhã';
    if (hours === 14) return 'amanhã de tarde';
    if (hours === 19) return 'amanhã de noite';
    return `amanhã às ${hours} horas`;
  }

  // Deltas em minutos (< 60 min)
  if (diffMin < 60) {
    if (diffMin === 1) return 'daqui a um minuto';
    if (diffMin === 2) return 'daqui a dois minutos';
    if (diffMin === 30) return 'daqui a meia hora';
    return `daqui a ${diffMin} minutos`;
  }

  // Deltas em horas (>= 60 min)
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  const hWord = h === 1 ? 'uma hora' : `${h} horas`;

  if (m === 0) {
    return `daqui a ${hWord}`;
  }
  if (m === 30) {
    return `daqui a ${hWord} e meia`;
  }
  const mWord = m === 1 ? 'um minuto' : `${m} minutos`;
  return `daqui a ${hWord} e ${mWord}`;
}
```

Casos de teste verificáveis para `formatHumanRelative`:
- `now + 1 minuto` -> `"daqui a um minuto"`
- `now + 20 minutos` -> `"daqui a 20 minutos"`
- `now + 30 minutos` -> `"daqui a meia hora"`
- `now + 60 minutos` -> `"daqui a uma hora"`
- `now + 90 minutos` -> `"daqui a uma hora e meia"`
- `now + 120 minutos` -> `"daqui a 2 horas"`
- Data com amanhã 09:00 -> `"amanhã de manhã"`
- Data com amanhã 14:00 -> `"amanhã de tarde"`
- Data com amanhã 19:00 -> `"amanhã de noite"`

---

### 4.2 Onde `dueAt` e `notifiedAt` são persistidos (`jsonStore.ts`)

`StoredItem` (`src/backend/storage/jsonStore.ts`) recebe os campos opcionais:

```ts
export interface StoredItem {
  id: string;
  text: string;
  createdAt: string;
  dueAt?: string | null;      // NOVO — ISO 8601, preenchido quando há agendamento; NotaTool nunca escreve.
  notifiedAt?: string | null; // NOVO — ISO 8601, preenchido SOMENTE após o disparo bem-sucedido da notificação.
}
```

Retrocompatibilidade garantida: arquivos `lembretes.json` existentes sem esses campos são interpretados
como itens atemporais e não disparados pelo agendador.

---

### 4.3 `LembreteTool` — `preview()`, `execute()` e deduplicação centralizada (`mutatingTools.ts`)

Para resolver os Achados 5 e 6:
1. **Centralização do parsing:** `preview()` executa `parseRelativeTime(content)` e armazena o resultado em
   um campo de instância `private lastParsed: { raw: string; parsed: ParsedRelativeTime } | null`.
   - A pergunta falada ao usuário reflete exatamente o que será salvo:
     - Se houver `dueAt`: `"Posso criar o lembrete de ${finalText} para ${formatHumanRelative(dueAt)}?"`
     - Se não houver `dueAt`: `"Posso criar o lembrete: ${finalText}?"`
   - Quando `execute()` é chamado no turno seguinte com a confirmação `SIM`, verifica se `lastParsed.raw === content`.
     Havendo cache hit, reutiliza o resultado exato confirmado pelo usuário; se houver cache miss (ex.: chamadas
     diretas em testes unitários sem preview prévio), executa `parseRelativeTime(content)`.
   - Limpa `lastParsed = null` ao final da execução.
   - **Premissa explícita (achado BAIXA, auditoria Hermes rodada 1 sobre o v2)**: este cache de
     instância única só é seguro porque o `SessionManager` de hoje garante uma sessão ativa por
     vez com no máximo uma mutação armada por vez (`armedMutation`/`pendingMutation`) — não é uma
     garantia estrutural do `LembreteTool` em si. Se uma fase futura permitir múltiplas sessões
     concorrentes, este cache precisa migrar para o `SessionManager` (que já guarda o estado por
     sessão), não continuar como campo de instância compartilhado do `LembreteTool`.
2. **Deduplicação estrita:** Apenas bloqueia a criação se o item mais recente tiver **o mesmo texto residual,
   o mesmo `dueAt` (ou ambos nulos) e ainda não tiver sido notificado (`notifiedAt === null`)**.
   Isso permite criar lembretes idênticos para horários futuros distintos ou recriar lembretes que já foram notificados.
3. **Cancelamento do timer em `LEMBRETE_APAGAR`:** Antes de remover o último item da lista (`store.items.pop()`),
   chama `this.scheduler.cancel(removed.id)` para evitar disparos órfãos de lembretes deletados.

```ts
export class LembreteTool implements IMutatingTool {
  readonly name = 'LEMBRETE';
  readonly description = 'Gerencia lembretes locais.';
  private lastParsed: { raw: string; parsed: ParsedRelativeTime } | null = null;

  constructor(
    private readonly store: JsonStore<StoredItem>,
    private readonly scheduler: ReminderScheduler
  ) {}

  isAvailable(): boolean {
    return true;
  }

  preview(kind: MutationName, content: string | null): string {
    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }
      const parsed = parseRelativeTime(content);
      this.lastParsed = { raw: content, parsed };

      const finalText = parsed.residualText.trim() || content;
      if (parsed.dueAt) {
        return `Posso criar o lembrete de ${finalText} para ${formatHumanRelative(parsed.dueAt)}?`;
      }
      return `Posso criar o lembrete: ${finalText}?`;
    }
    if (kind === 'LEMBRETE_APAGAR') {
      return 'Posso apagar o lembrete mais recente?';
    }
    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    if (kind === 'LEMBRETE_CRIAR') {
      if (!content || !content.trim()) {
        throw new Error('Conteúdo ausente para criação de lembrete.');
      }

      // Reusa o parsing validado na pergunta ou roda fallback se chamado diretamente
      const parsed =
        this.lastParsed && this.lastParsed.raw === content
          ? this.lastParsed.parsed
          : parseRelativeTime(content);
      this.lastParsed = null;

      const { dueAt, residualText } = parsed;
      const finalText = residualText.trim() || content;

      const store = this.store.read();
      const last = store.items[store.items.length - 1];

      // Correção do Achado 5: deduplicação temporal segura
      const isDuplicate =
        last &&
        last.text === finalText &&
        (last.dueAt ?? null) === (dueAt ?? null) &&
        last.notifiedAt === null;

      if (isDuplicate) {
        return 'Isso já estava salvo.';
      }

      const id = crypto.randomUUID();
      store.items.push({
        id,
        text: finalText,
        createdAt: new Date().toISOString(),
        dueAt,
        notifiedAt: null
      });
      this.store.write(store);

      if (dueAt) {
        this.scheduler.schedule({ id, text: finalText, dueAt });
        return `Lembrete criado para ${formatHumanRelative(dueAt)}.`;
      }
      return 'Lembrete criado.';
    }

    if (kind === 'LEMBRETE_APAGAR') {
      const store = this.store.read();
      if (store.items.length === 0) {
        return 'Não há nenhum lembrete para apagar.';
      }
      const removed = store.items.pop()!;
      // Cancela o agendamento em memória se houver
      this.scheduler.cancel(removed.id);
      this.store.write(store);
      return 'Lembrete apagado.';
    }

    throw new Error(`Ação inválida para LembreteTool: ${kind}`);
  }
}
```

---

### 4.4 O agendador (`ReminderScheduler` em `reminderScheduler.ts`)

Módulo dedicado que gerencia timeouts em memória e executa as notificações no macOS.

Correções estruturais aplicadas sobre a v1:
1. **Gravação estrita de `notifiedAt` após confirmação do SO (Achado 1):** `execFile` é executado com timeout
   de `5000ms`. Se o comando falhar, expirar ou retornar erro de permissão, o erro é emitido com `console.error`
   e `notifiedAt` **não é gravado**. O item permanece íntegro para posterior recuperação.
2. **Gerenciamento de timers e encerramento limpo (Achado 7):**
   - `fire()` remove a entrada do Map `this.timers` imediatamente.
   - `schedule()` cancela qualquer timer pré-existente do mesmo ID antes de inserir.
   - Método `shutdown()` percorre todos os timers ativos, chama `clearTimeout()` e esvazia o Map.
3. **Tratamento de boot e política de 24 horas (Achados 8 e 12):**
   - Itens vencidos há <= 24 horas recebem notificação de atraso, com leve espaçamento entre chamadas.
   - Itens vencidos há > 24 horas são registrados via `console.warn` e marcados com `notifiedAt` no disco,
     sem disparar notificações no macOS.

```ts
import { execFile } from 'node:child_process';
import { JsonStore, type StoredItem } from '../storage/jsonStore.js';

export const OVERDUE_CUTOFF_MS = 24 * 60 * 60 * 1000; // 24 horas

export class ReminderScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly store: JsonStore<StoredItem>) {}

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
      if (due <= now) {
        const diffMs = now.getTime() - due.getTime();
        if (diffMs <= OVERDUE_CUTOFF_MS) {
          // Atrasado dentro da janela de 24h: notifica com título explicativo, espaçado no
          // tempo (200ms entre disparos) para nunca lançar N processos osascript de uma vez —
          // a promessa de "sequenciado" do §2 agora tem um mecanismo real, não só prosa.
          setTimeout(() => this.notify(item, { late: true }), lateDelayMs);
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

    execFile('osascript', ['-e', script], { timeout: 5000 }, (error) => {
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
      // caso — o item removido simplesmente não é encontrado e nada é escrito. Não é uma
      // corrida real: é uma checagem que já resolve corretamente, só precisava ficar nomeada.
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
```

---

### 4.5 Ciclo de instanciação e injeção de dependências (`voiceRuntime.ts` e `mutatingTools.ts`)

Para resolver o Achado 2, desacoplamos a instanciação e expomos o scheduler em uma factory estruturada:

#### Assinatura de `createMutatingTools()` em `src/backend/tools/mutatingTools.ts`:

```ts
export interface MutatingToolsResult {
  tools: IMutatingTool[];
  scheduler: ReminderScheduler;
}

export function createMutatingTools(
  baseDir: string,
  customScheduler?: ReminderScheduler
): MutatingToolsResult {
  const lembreteStore = new JsonStore<StoredItem>(baseDir, 'lembretes.json');
  const notaStore = new JsonStore<StoredItem>(baseDir, 'notas.json');

  const scheduler = customScheduler ?? new ReminderScheduler(lembreteStore);
  const lembreteTool = new LembreteTool(lembreteStore, scheduler);
  const notaTool = new NotaTool(notaStore);

  return {
    tools: [lembreteTool, notaTool],
    scheduler
  };
}
```

#### Integração em `src/backend/voice/voiceRuntime.ts`:

```ts
  const dataDir = process.env.RODRIGO_DATA_DIR
    ? path.resolve(process.env.RODRIGO_DATA_DIR)
    : path.join(rootDir, 'data');

  // Factory retorna as ferramentas e a instância única do agendador
  const { tools: mutatingTools, scheduler: reminderScheduler } = createMutatingTools(dataDir);
  for (const mTool of mutatingTools) ExtensionRegistry.getInstance().registerMutatingTool(mTool);

  // Inicializa o agendador carregando lembretes persistidos
  reminderScheduler.bootstrap();

  const audioStore = new AudioStore(path.join(rootDir, '.runtime', 'tmp'));
  const sessionManager = new SessionManager(
    engine, ttsProvider, audioStore, agents, retriever, tools, mutatingTools
  );

  return {
    available: true,
    sessionManager,
    audioStore,
    scheduler: reminderScheduler,
    shutdown: async () => {
      reminderScheduler.shutdown(); // Cancela timers pendentes na finalização do runtime
      await sessionManager.shutdownAll();
      await engine.shutdown();
    }
  };
```

#### Tratamento do caso `RODRIGO_VOICE_DISABLE=1`:

Quando `RODRIGO_VOICE_DISABLE=1` está definido, `voiceRuntime.ts` retorna antecipadamente antes de
instanciar as ferramentas mutantes e o agendador:

```ts
  if (process.env.RODRIGO_VOICE_DISABLE === '1') {
    return {
      available: false,
      reason: 'Voz desabilitada explicitamente (RODRIGO_VOICE_DISABLE=1).',
      shutdown: async () => {}
    };
  }
```

**Por que este comportamento é aceitável e correto:**  
A flag `RODRIGO_VOICE_DISABLE=1` é utilizada estritamente pela suíte de testes unitários e de integração
básicos (`npm test`), permitindo que a base do servidor (rotas estáticas, health checks) seja testada
sem depender de hardware de áudio, modelos de IA ou processos em segundo plano. Em tal modo, nenhuma
interação por voz ocorre e nenhum lembrete pode ser criado. Não instanciar o `ReminderScheduler` nesse caminho
impede a criação de timers globais indesejados durante testes automatizados paralelos. A suíte de testes
específica do `ReminderScheduler` instancia a classe isoladamente com `JsonStore` temporário (`mkdtempSync`),
garantindo cobertura sem acoplamento.

---

### 4.6 Concorrência bootstrap vs. sessão ativa

`bootstrap()` é síncrono em sua leitura inicial do disco e roda durante a subida do servidor de voz,
antes de qualquer requisição de áudio ser aceita pelo `SessionManager`. Lembretes criados em sessões
posteriores passam pelo fluxo sequencial de `execute()` → `scheduler.schedule()`, eliminando condições
de corrida entre a inicialização e mutações de usuários.

---

## 5. Arquivos afetados

```
src/backend/tools/relativeTimeParser.ts   NOVO — parseRelativeTime(), parseNumberOrWord(), formatHumanRelative()
src/backend/tools/reminderScheduler.ts    NOVO — ReminderScheduler (bootstrap, schedule, cancel, shutdown, notify)
src/backend/tools/mutatingTools.ts        createMutatingTools devolve { tools, scheduler }; LembreteTool ganha cache preview/execute, dedupe temporal e cancelamento
src/backend/storage/jsonStore.ts          StoredItem ganha campos opcionais dueAt? e notifiedAt?
src/backend/voice/voiceRuntime.ts         Desacopla createMutatingTools, executa bootstrap() e hook no shutdown()
src/backend/__tests__/                    Novos testes unitários e de integração para os módulos acima
```

`scripts/worker/worker.py` **não sofre alterações nesta fase** — a extração e o agendamento pertencem
exclusivamente à camada Node/TypeScript.

**Blast radius da mudança de assinatura de `createMutatingTools()` (achado ALTA, auditoria Hermes
rodada 1 sobre o v2, confiança 100%) — dimensionado explicitamente, não implícito:**

A assinatura muda de `(baseDir: string): IMutatingTool[]` para `(baseDir: string, customScheduler?):
{ tools: IMutatingTool[]; scheduler: ReminderScheduler }`. Isto quebra **todo call site existente**
que hoje espera o array diretamente — 13 ocorrências confirmadas por `grep -n "createMutatingTools"`:

- `src/backend/voice/voiceRuntime.ts:92` — call site de **produção**, já reescrito em §4.5 acima.
- `src/backend/__tests__/mutatingTools.test.ts:86,118,155` — 3 ocorrências, cada uma precisa virar
  `const { tools } = createMutatingTools(tmpDir);`.
- `src/backend/__tests__/voice.test.ts:885,939,989,1046,1115,1177,1234,1297,1361` — 9 ocorrências,
  cada uma precisa virar `const { tools: mutatingTools } = createMutatingTools(tmpDataDir);`
  (mantendo o nome de variável local `mutatingTools` que o resto de cada teste já usa, para minimizar
  o diff).

Sem essa atualização em todos os 12 call sites de teste, `npm test` quebra na compilação
(`tsc -p tsconfig.server.json`) antes mesmo de rodar qualquer teste novo desta fase — isso é
trabalho obrigatório da fase de implementação, não um efeito colateral opcional.

---

## 6. Critérios de aceite

Codificados sob o padrão estrito `H1..Hn` do repositório:

- **H1 — Parsing de tempo relativo (`parseRelativeTime`):**  
  Testes unitários cobrem:
  - Expressões em minutos com dígitos e por extenso ("daqui a 20 minutos", "daqui a vinte minutos", "em 5 minutos", "em cinco minutos", "daqui a um minuto", "daqui a dois minutos").
  - Expressões em horas com dígitos e por extenso ("em 2 horas", "em duas horas", "daqui a 1 hora", "daqui a uma hora").
  - Expressão especial "meia hora" ("daqui a meia hora", "em meia hora") -> `now + 30 min`.
  - Variações de amanhã com preposição "de", "a" e "à": "amanhã de tarde" e "amanhã à tarde" -> 14:00; "amanhã de noite" e "amanhã à noite" -> 19:00; "amanhã de manhã" e "amanhã pela manhã" -> 09:00.
  - "amanhã" isolado sem período especificado -> 09:00 (mesmo padrão da manhã).
  - Casos negativos: frases sem indicação de tempo retornam `{ dueAt: null, residualText: text }`.
  - Remoção limpa do texto residual sem sobras de preposições ou pontuação.

- **H2 — Formatação em linguagem natural para fala (`formatHumanRelative`):**  
  Testes unitários cobrem:
  - Deltas de minutos: 1 minuto -> `"daqui a um minuto"`; 2 minutos -> `"daqui a dois minutos"`; 30 minutos -> `"daqui a meia hora"`; 20 minutos -> `"daqui a 20 minutos"`.
  - Deltas de horas: 60 minutos -> `"daqui a uma hora"`; 90 minutos -> `"daqui a uma hora e meia"`; 120 minutos -> `"daqui a 2 horas"`.
  - Períodos de amanhã: 09:00 -> `"amanhã de manhã"`; 14:00 -> `"amanhã de tarde"`; 19:00 -> `"amanhã de noite"`.
  - Ausência de markdown, pontuação indevida ou abreviações visuais.

- **H3 — Integração `preview()` e `execute()` em `LembreteTool`:**  
  - `preview('LEMBRETE_CRIAR', ...)` formula a pergunta mencionando explicitamente o horário agendado ("Posso criar o lembrete de ligar pro dentista para daqui a 20 minutos?").
  - O resultado do parsing é mantido em cache e reutilizado em `execute()`, garantindo que o que foi falado na confirmação é exatamente o que é persistido.
  - Chamadas a `execute()` isoladas (sem preview prévio) continuam realizando o parsing com fallback.

- **H4 — Deduplicação temporal em `LembreteTool.execute()`:**  
  - Dois lembretes com o mesmo texto residual, mesmo `dueAt` e `notifiedAt === null` são bloqueados com `"Isso já estava salvo."`.
  - Dois lembretes com mesmo texto mas com `dueAt` diferente são aceitos e salvos normalmente.
  - Um lembrete com mesmo texto de um item anterior que já possui `notifiedAt !== null` é aceito e agendado normalmente.

- **H5 — Cancelamento de agendamento em `LEMBRETE_APAGAR`:**  
  - Ao executar `LEMBRETE_APAGAR`, `scheduler.cancel(removed.id)` é chamado para o item removido, cancelando o timer ativo e removendo-o de `timers`.

- **H6 — Agendamento e notificação confiável (`ReminderScheduler.schedule` e `fire`):**  
  - Teste de integração com timer real curto (~100ms): confirma que o timer dispara e invoca `execFile('osascript', ...)`.
  - Confirma que `notifiedAt` é gravado no disco **apenas após o retorno de sucesso do callback** de `execFile`.
  - Simulação de erro em `execFile`: verifica que o erro é registrado via `console.error` e que `notifiedAt` **permanece nulo** no disco.
  - Verifica que o timer disparado é removido do Map `timers`.
  - **Sequenciamento no `bootstrap()`** (achado Hermes v2): com 3+ itens atrasados simulados, confirma que as chamadas a `execFile` não acontecem todas no mesmo tick — cada uma agendada com `setTimeout` incremental de 200ms.
  - **Atomicidade de itens expirados** (achado Hermes v2): simula uma exceção no meio do loop de `bootstrap()` (item com `dueAt` inválido entre dois itens expirados válidos) e confirma que nenhum dos itens expirados anteriores ao ponto de falha é marcado como `notifiedAt` — a próxima subida reprocessa todos, idempotente.

- **H7 — Tratamento de inicialização e política de corte (`ReminderScheduler.bootstrap`):**  
  - Lembrete com `dueAt` vencido há menos de 24 horas e `notifiedAt: null` dispara notificação imediata marcada com título de atraso.
  - Lembrete com `dueAt` vencido há mais de 24 horas não dispara popup no SO; emite aviso no terminal e é marcado como notificado/expirado no store.
  - Lembrete com `dueAt` futuro é agendado no Map de timers sem disparo imediato.

- **H8 — Encerramento seguro (`ReminderScheduler.shutdown`):**  
  - Chamar `shutdown()` cancela todos os timers pendentes com `clearTimeout` e deixa o Map `timers` vazio, sem travar o event loop.

- **H9 — Injeção de dependências e ciclo de vida em `voiceRuntime.ts`:**  
  - `createMutatingTools()` fornece `{ tools, scheduler }`.
  - `voiceRuntime.ts` chama `bootstrap()` na inicialização e inclui `scheduler.shutdown()` na sua rotina de encerramento limpo.
  - `RODRIGO_VOICE_DISABLE=1` encerra o runtime de voz antecipadamente sem instanciar timers.

- **H10 — Regressão da Fase 5c e suíte completa:**  
  - Criação de lembrete sem especificação de tempo continua funcionando idêntica à Fase 5c (`dueAt: null`, resposta `"Lembrete criado."`).
  - `NotaTool` permanece estritamente atemporal (sem agendamento).
  - Suíte completa de testes das Fases 1 a 5c passa 100% sem falhas.

- **H11 — Verificação manual com o SO real:**  
  - Em ambiente macOS real: criar lembrete por voz com a frase "me lembra de tomar água daqui a 1 minuto", confirmar com "sim", minimizar/fechar a aba do navegador mantendo o servidor Node rodando no terminal, e verificar que a notificação nativa do macOS aparece no Centro de Notificações em aproximadamente 1 minuto.

---

## 7. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Horários fixos para períodos do dia (09h, 14h, 19h) não coincidirem com o desejo do usuário | Baixa-Média | Documentado abertamente no plano e refletido na fala de confirmação de voz (`preview`), permitindo ao usuário cancelar antes de salvar se não concordar. |
| Falha silenciosa de permissão do macOS ao rodar `osascript` | Baixa-Média | Timeout de 5000ms, gravação de `notifiedAt` condicionada ao sucesso de `execFile`, log de erro no terminal e validação manual obrigatória via H11. |
| Processo do servidor fechado pelo usuário no terminal | Média | Esclarecido formalmente em §1 e §2; lembretes pendentes são recuperados ou avaliados na subida seguinte via `bootstrap()`. |
| Acúmulo de notificações de atraso no reinício do servidor após longo período | Baixa | Janela de corte estrita de 24 horas: itens mais antigos que 24h são marcados como expirados e não disparam alertas gráficos em massa. |
| Vazamento de memória por referências de timers concluídos | Baixa | Removidos explicitamente do Map no `fire()`, cancelados antes de re-agendamento e limpos globalmente no `shutdown()`. |

---

## 8. Rastreabilidade

- Referência original: `docs/phase-5a-v1.md` §"fora de escopo", `docs/phase-5c-v1.md` §"fora de escopo".
- Decisão de fechamento da Fase 5c: `docs/implementation-phase-5c.md` §10.
- Auditoria adversarial v1: `docs/audits/phase-6-v1-agy-rodada1-2026-09-24.log` (12 achados estruturados, veredito REJEITADO).
- Plano v2: `docs/phase-6-v2.md` (este documento).

---

## 9. Achados da rodada 1 (agy) e como foram resolvidos

A tabela abaixo correlaciona cada um dos 12 achados da auditoria adversarial da rodada 1 com a ação técnica
específica implementada neste documento e a seção correspondente:

| ID | Achado na Auditoria v1 | Gravidade | Resolução Aplicada no v2 | Seção do v2 |
|---|---|---|---|---|
| 1 | Escrita prematura de `notifiedAt` e silenciamento de erros do `osascript` | CRÍTICA | `notifiedAt` movido estritamente para o callback de sucesso do `execFile`; adicionado timeout de 5000ms e log com `console.error` em falhas. | §4.4, §6 (H6) |
| 2 | Ciclo de injeção quebrado entre `voiceRuntime.ts`, `createMutatingTools` e `ReminderScheduler` | ALTA | `createMutatingTools()` passa a retornar `{ tools, scheduler }`; `voiceRuntime.ts` chama `bootstrap()` na subida e `scheduler.shutdown()` no encerramento; documentado isolamento de `RODRIGO_VOICE_DISABLE=1`. | §4.5, §6 (H9) |
| 3 | Falha de parsing em números por extenso comuns no Whisper STT | ALTA | Implementada função `parseNumberOrWord()` com suporte a números por extenso de 1 a 59, "um/uma", "dois/duas", compostos e caso especial "meia hora" (30 min). | §4.1, §6 (H1) |
| 4 | "Amanhã de tarde" e "amanhã de noite" agendam incorretamente para a manhã | ALTA | Regexes corrigidas para aceitar explicitamente a preposição "de" (`(?:(?:a\|à\|de)\s+)?tarde` e `(?:(?:a\|à\|de)\s+)?noite`) com precedência antes do padrão genérico "amanhã". | §4.1, §6 (H1) |
| 5 | Deduplicação em `execute()` bloqueia novos lembretes legítimos com mesmo texto | ALTA | Verificação de duplicata corrigida para checar `last.text === finalText && last.dueAt === dueAt && last.notifiedAt === null`, permitindo lembretes com horários distintos ou após disparo. | §4.3, §6 (H4) |
| 6 | Divergência entre a confirmação por voz em `preview()` e a execução em `execute()` | ALTA | Centralizado o parsing em `preview()` com cache em instância `lastParsed` reutilizado em `execute()`, refletindo o horário na pergunta falada ao usuário. | §4.3, §6 (H3) |
| 7 | Vazamento de timers no Map `timers` e ausência de método de shutdown | MÉDIA | `fire()` remove timer do Map no disparo; `schedule()` cancela timer existente antes de sobrescrever; adicionado método `shutdown()` limpando todos os timeouts ativos. | §4.4, §6 (H6, H8) |
| 8 | Contradição entre §2 e §4.4 na política de lembretes atrasados ("últimos N minutos") | MÉDIA | Fixado corte concreto em N = 24 horas (1440 min) com justificativa; itens <= 24h notificam como atrasados; itens > 24h emitem `console.warn` e são marcados no disco sem popup. | §2, §4.4, §6 (H7) |
| 9 | Contradição interna de horários de disparo para "amanhã" em §4.1 (08h vs 09h) | BAIXA | Uniformizado o horário da manhã em **09:00 local** em todo o documento ("amanhã de manhã" e "amanhã" sem período). | §4.1, §6 (H1, H2) |
| 10 | Função `formatHumanRelative` usada no retorno de `execute()` sem especificação | MÉDIA | Especificação técnica completa, assinatura, pseudocódigo e casos de teste descritos para minutos, horas e amanhã sob diretrizes de fala de `sessionManager.ts`. | §4.1, §6 (H2) |
| 11 | Critérios de aceite incompletos e sem codificação H1..Hn padronizada | MÉDIA | Critérios padronizados como H1..H11, incluindo testes de cancelamento em `LEMBRETE_APAGAR` (H5) e formatação falada (H2). | §6 |
| 12 | Formulação enganosa de "fecha (ou minimiza) o app" no critério de conclusão | BAIXA | Redação ajustada para "fecha ou minimiza a aba do navegador mantendo o processo do servidor ativo no terminal" em §1, §2 e H11. | §1, §2, §6 (H11) |

## 10. Auditoria do v2 (Hermes) e ressalvas aplicadas

O v2 foi auditado por um segundo avaliador (Hermes Agent, `docker exec hermes hermes -z`, material
copiado só código/testes/plano, nunca `docs/research/`) especificamente para conferir se os 12
achados acima foram de fato resolvidos, não apenas alegados. **Veredito: APROVADO COM RESSALVAS.**
Confirmou os 12 como resolvidos e achou 5 novos, todos mecânicos, aplicados diretamente neste
documento (sem rodada 3, mesmo padrão da Fase 5c: ressalva mecânica não precisa de re-auditoria):

| Achado (Hermes, sobre o v2) | Gravidade | Resolução |
|---|---|---|
| Blast radius de `createMutatingTools()` não reconhecido — 12 call sites de teste quebram | ALTA | §5 ganhou uma seção dedicada listando os 13 call sites (1 produção + 12 teste) exatos, com o `grep` que os localiza |
| `bootstrap()` prometia disparos "sequenciados" mas chamava `notify()` sem nenhum delay | MÉDIA | `setTimeout` escalonado (200ms por item) entre disparos de itens atrasados, em §4.4 |
| Persistência de itens expirados dentro do loop, sem proteção contra exceção no meio | MÉDIA | Reescrito para acumular ids expirados e persistir em bloco só depois do loop terminar, com releitura fresca do store, em §4.4 |
| Cache `lastParsed` assume implicitamente uma única mutação armada por vez | BAIXA | Premissa documentada explicitamente em §4.3, com a mitigação futura nomeada (mover pro `SessionManager` se sessões concorrentes existirem) |
| Corrida aparente entre `fire()`/`notify()` assíncrono e `LEMBRETE_APAGAR`/`cancel()` | BAIXA | Confirmado que a checagem `idx !== -1` sobre releitura fresca já cobre o caso; comentário adicionado em §4.4 nomeando a garantia |

Log completo: `docs/audits/phase-6-v2-hermes-2026-09-24.log`.
