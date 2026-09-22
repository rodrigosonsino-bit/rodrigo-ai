# Fase 5b — Ferramentas de leitura (`ITool`) — v4 (híbrida)

Versão: v4
Data: 2026-09-21
Base: commit `9aedb9e`
Antecessores: v1 (REJEITADO, 24 achados), v2 (REJEITADO, ~12), v3 (REJEITADO, 8).

---

## 1. O que as três rejeições ensinaram, e por que a v4 é a soma delas

Cada versão foi rejeitada por um motivo diferente, e **cada uma isolou metade da resposta certa**:

| Versão | Desenho | Por que caiu | O que ela acertou |
|---|---|---|---|
| v1 | classificador devolve rótulo+ferramenta | introduzia regressão no classificador validado; prompt contraditório | — |
| v2 | modelo detecta, resultado injetado no prompt, **modelo responde** | o "fechamento" dependia de obediência probabilística do mesmo 4B que já alucina a hora | **a detecção por modelo generaliza sobre fraseado** |
| v3 | regex de enunciado inteiro detecta, **código responde** | cobertura de 3–15% em fala real (29/30 falso negativo na amostra adversarial do auditor) | **a resposta determinística não pode ser contradita pelo modelo** |

**A v4 junta as duas metades:** o **modelo detecta** (resolve o falso negativo da v3) e o **código
responde** (resolve a obediência probabilística da v2). Nenhuma das duas estava certa sozinha, e
isso só ficou visível depois de as duas falharem por motivos opostos.

### O argumento que derrubou a §4.3 da v3, e que a v4 aceita

A v3 afirmava que falso negativo é benigno porque "cai no comportamento de hoje". O auditor da 3ª
rodada respondeu, e está certo: **acertar alguns fraseados e falhar em outros é pior que falhar em
todos**. Falhar sempre ensina ao usuário "não pergunte a hora a ele"; acertar às vezes não ensina
nada e cria confiança falsa. É por isso que cobertura, nesta fase, não é um "nice to have" — é
critério de aceite.

---

## 2. Premissa medida

Servidor real (MLX, `Qwen3-4B-Instruct-2507-4bit`), áudio sintetizado, 2026-09-21:

```
hora real do sistema: 10:54 de Monday, 21 de September de 2026
"Que horas são agora?"  -> GERAL -> "Agora são seis e meia."
"Que dia é hoje?"       -> GERAL -> "Hoje é quinta-feira, 21 de abril."
```

**Pronto** exige: as duas corretas com áudio real; **cobertura medida contra amostra que eu não
escolhi** (§8 H9); turno sem ferramenta byte a byte idêntico à Fase 5a; nenhum falso positivo;
latência dentro das metas; suíte sem regressão.

---

## 3. Escopo

**Dentro:** `ITool` com `execute()`; `HoraAtualTool` e `DataAtualTool`; filtro permissivo em Node;
comando `detect_tool` no worker; resposta determinística sintetizada direto; `registerTool()`.

**Fora:** ações que mutam estado (Fase 5c); ferramentas com argumento; alteração do classificador;
rede/nuvem/API paga.

---

## 4. Decisões

### 4.1 Três camadas, cada uma com uma responsabilidade que as outras não têm

1. **Filtro permissivo (Node, regex).** Decide **só** se vale gastar uma inferência. Alta cobertura
   de propósito; falso positivo custa uma inferência e nada mais.
2. **`detect_tool` (worker, modelo, `temp=0.0`).** Decide **qual** ferramenta, num conjunto fechado
   de três valores. É aqui que mora a generalização sobre fraseado que a v3 não tinha.
3. **Resposta (Node, determinística).** O modelo **não** participa. Não há como ele contradizer o
   relógio, porque ele não é consultado.

**Medição do filtro permissivo** (executada antes de escrever este plano):

```
COLOQUIAIS que o filtro pega: 22/22
  inclui exatamente os que mataram a v3: "São que horas?", "Que hora que é?", "Tá que horas?",
  "Hoje é que dia?", "Hoje é dia quanto?", "Cê sabe que horas são?", "Tá tarde?",
  "Já passou do meio-dia?"

NEGATIVOS de domínio que disparam à toa: 0/8
  ("Explique a Aceitação dentro da Virtologia", "Faça uma análise exegética de Hebreus cinco",
   "Quanto é dezessete por cento...", "Quem foi Policarpo de Esmirna?", ...)
```

O filtro **não decide nada sozinho** — é essa a diferença em relação à v3, onde a regex era a
decisão final. Aqui, errar para mais custa uma inferência; a decisão é do modelo.

### 4.2 `detect_tool` entra no `pending` existente, como terceiro `kind`

`MlxWorkerEngine` já mantém um único `Map` de operações pendentes com discriminante
`kind: 'classify' | 'generate' | …`, cada uma com `timeout`, `spawnGeneration` e tratamento próprio
em `cancel(turnId)`. O achado das rodadas anteriores era que o plano não especificava esse ciclo.

**A v4 espelha `classify` exatamente**: mesmo `Map`, `kind: 'detect_tool'`, `timeout` limpo em
`handleLine`, e em `cancel(turnId)` o pending é **rejeitado** (como `classify`, não resolvido como
`generate`), porque o chamador está aguardando um valor para decidir o caminho do turno.

### 4.3 Falha de execução: fechada e determinística

Detectada a ferramenta, se `execute()` lançar, a resposta **não volta ao modelo**. É sintetizada uma
frase fixa:

```
Não consegui consultar o relógio do sistema agora.
```

Sem prompt, sem instrução, sem aposta em obediência. Esta é a diferença concreta em relação ao
"bloco de proibição" da v2, que pedia a um modelo que já alucina a hora que não alucinasse.

### 4.4 Falha da **detecção**: cai no caminho normal, e isso é honesto

Se `detect_tool` falhar ou estourar timeout, o turno segue o caminho da Fase 5a. **Não é possível
falhar fechado aqui**, porque a intenção nunca foi estabelecida — o filtro permissivo só diz "talvez
seja sobre tempo", e fechar com base num talvez transformaria "Me fale sobre o perdão ao longo dos
anos" numa recusa a responder.

**Análise honesta da frequência:** `detect_tool` roda no mesmo worker que `classify` e `generate`.
Se ele falhar por indisponibilidade do worker, o turno inteiro falha de qualquer forma — o caso de
"detecção falha mas o resto funciona" é praticamente vazio. Está registrado como limitação, não
resolvido.

### 4.5 O caminho da ferramenta reusa o encerramento existente, não inventa um

Dois achados da 3ª rodada, ambos sobre o pseudocódigo da v3 e ambos corrigidos por **remover**
código em vez de acrescentar:

- **`state: ouvindo`** — o caminho normal emite `turn_done` **e** `state: ouvindo`
  (`sessionManager.ts:323-326`). A v3 omitia o segundo e deixava a interface presa em "falando".
- **Histórico** — a v3 empurrava a fala no histórico direto. O padrão da Fase 2 é que o texto só
  entre via `markPlayed()`, depois que o cliente confirma reprodução (`sessionManager.ts:361-373`),
  justamente para que um barge-in não grave fala que o usuário não ouviu. **A v4 não empurra nada**:
  sintetiza e deixa o mecanismo existente fazer o resto. O conserto é a ausência de código.

### 4.6 O turno de ferramenta ainda pula o classificador

Mantido da v3, com a mesma ressalva e o mesmo recuo: `routing` é emitido com `label: 'GERAL'`,
`handled: true`, fixado por construção. H8 reexecuta o classificador real sobre uma amostra de
fraseados que chegam ao caminho de ferramenta; qualquer divergência aciona o recuo (chamar
`classify` e pular apenas a geração).

Diferença em relação à v3: lá o conjunto de frases que chegavam era fechado e inspecionável (a
regex era exata). Aqui é aberto, porque quem decide é o modelo — então a asserção é mais forte e a
verificação H8 é mais importante. **Sinalizado de propósito para a auditoria julgar.**

### 4.7 Formatação pelo runtime; ICU verificado

```
$ node -e "console.log(new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date()))"
segunda-feira, 21 de setembro de 2026
$ node -e "console.log(new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()))"
11:06
```

---

## 5. Arquivos afetados

**Novos:** `src/backend/tools/systemTools.ts`, `src/backend/tools/index.ts`,
`src/backend/__tests__/tools.test.ts`, `scripts/worker/test_tool_parser.py`.

**Modificados:**
- `src/shared/extensions/tools.ts` — `execute(): string`.
- `src/shared/extensions/registry.ts` — **`registerTool()`** (não existe hoje; verificado) idempotente
  por `name`; módulo `tools` com `available: this.tools.length > 0`.
- `src/shared/voiceProtocol.ts` — `TOOL_NAMES`, `ToolName`, `isToolName()`.
- `scripts/worker/worker.py` — **somente acréscimo**: `TOOL_NAMES`, `DETECT_TOOL_SYSTEM_PROMPT`,
  `parse_tool_output()` (função pura), `handle_detect_tool()`, despacho. O classificador **não é
  tocado**.
- `src/backend/voice/engine.ts` — `detectTool()` na interface.
- `src/backend/voice/mlxWorkerEngine.ts` — `kind: 'detect_tool'` no `pending`; validação do campo na
  fronteira NDJSON; tratamento em `cancel()` e `handleLine()`.
- `src/backend/voice/fakeEngine.ts` — `detectTool()` + `toolToReturn` + `detectToolCalls`.
- `src/backend/voice/sessionManager.ts` — filtro, chamada condicional, caminho determinístico.
- `src/backend/voice/voiceRuntime.ts` — cria, registra **e passa** as ferramentas.
- `src/backend/__tests__/extensions.test.ts`, `voice.test.ts`.
- `package.json` — comando de teste inclui os testes Python do worker.

---

## 6. Pseudocódigo completo

### 6.1 `registry.ts`

```ts
  /** Idempotente por `name` — `createSystemTools()` pode rodar mais de uma vez em teste. */
  public registerTool(tool: ITool): void {
    if (this.tools.some((t) => t.name === tool.name)) return;
    this.tools.push(tool);
  }
```

e no módulo `tools`: `available: this.tools.length > 0`, descrição listando os nomes.
(`resetForTesting()` **já** limpa `this.tools` — verificado no código atual.)

### 6.2 `voiceProtocol.ts`

```ts
export const TOOL_NAMES = ['HORA', 'DATA', 'NENHUMA'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v);
}
```

### 6.3 `worker.py` — acréscimos apenas

```python
TOOL_NAMES = {"HORA", "DATA", "NENHUMA"}

DETECT_TOOL_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede a HORA atual, a DATA de hoje, ou NENHUMA das duas. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: HORA, DATA ou NENHUMA.\n"
    "HORA: o usuário quer saber que horas são agora, neste lugar. Vale para qualquer jeito de "
    "perguntar, inclusive coloquial: 'que horas são', 'são que horas', 'que hora que é', "
    "'tá que horas', 'me vê as horas', 'cê sabe que horas são', 'tá tarde', "
    "'já passou do meio-dia'.\n"
    "DATA: o usuário quer saber que dia é hoje, o dia da semana, o mês ou o ano atuais. Também "
    "vale coloquial: 'que dia é hoje', 'hoje é que dia', 'hoje é dia quanto', 'qual que é a data', "
    "'estamos em que dia', 'tá em que mês'.\n"
    "NENHUMA: todo o resto. Isso INCLUI perguntas sobre tempo que não são a hora ou a data de "
    "agora aqui: hora em outro fuso ou país, datas passadas ou futuras, quanto tempo falta para "
    "algo, duração, aniversário, feriado, horário de funcionamento, ou qualquer cálculo com datas.\n"
    "Exemplos:\n"
    "São que horas? -> HORA\n"
    "Que hora que é? -> HORA\n"
    "Tá que horas? -> HORA\n"
    "Cê sabe que horas são? -> HORA\n"
    "Hoje é que dia? -> DATA\n"
    "Hoje é dia quanto? -> DATA\n"
    "Estamos em que dia? -> DATA\n"
    "Que horas são na China? -> NENHUMA\n"
    "Que dia foi ontem? -> NENHUMA\n"
    "Quantos dias faltam pro Natal? -> NENHUMA\n"
    "Que horas o mercado abre? -> NENHUMA\n"
    "Me fale sobre o perdão ao longo dos anos. -> NENHUMA\n"
)


def parse_tool_output(raw: str) -> str:
    """Função PURA — testada em scripts/worker/test_tool_parser.py.

    Formato inválido degrada para NENHUMA: não reconhecer intenção deve custar a ferramenta,
    nunca o turno (ao contrário do classificador, onde formato inválido é erro).
    """
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return normalized if normalized in TOOL_NAMES else "NENHUMA"
```

`handle_detect_tool()` espelha `handle_classify()` — `temp=0.0`, `max_tokens=6`, checagem de
`cancel_event`, `clear_cache()` no `finally` — e emite
`{"event": "tool_detection", "reqId", "turnId", "tool"}`. Texto vazio devolve `NENHUMA` sem chamar
o modelo. Despacho: `elif cmd == "detect_tool": self.handle_detect_tool(msg)`, nos **dois** pontos
onde `classify` aparece hoje.

### 6.4 `mlxWorkerEngine.ts`

`kind: 'detect_tool'` acrescentado à união de `pending`, com:

- **`handleLine`**: `if (event === 'tool_detection' && pending.kind === 'detect_tool')` →
  `clearTimeout(pending.timeout)` e `pending.resolve(isToolName(msg.tool) ? msg.tool : 'NENHUMA')`.
  A validação acontece **antes** de resolver: worker dessincronizado ou campo ausente não viram
  `ToolName` por asserção de tipo.
- **`cancel(turnId)`**: `if (pending.kind === 'detect_tool') pending.reject(new VoiceEngineError(...))`
  — **rejeita**, como `classify`, porque o chamador aguarda um valor para decidir o caminho.
- **timeout**: mesmo tratamento de `classify` (limpeza em `handleLine` e em `failAllPending`).

```ts
  async detectTool(turnId: string, epoch: number, text: string): Promise<ToolName> {
    // espelha classify() linha a linha, trocando cmd e evento
  }
```

### 6.5 `src/backend/tools/systemTools.ts`

```ts
import type { ITool } from '../../shared/extensions/tools.js';

export type Clock = () => Date;
const systemClock: Clock = () => new Date();

export class HoraAtualTool implements ITool {
  readonly name = 'HORA';
  readonly description = 'Hora atual do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean { return true; }
  execute(): string {
    const hhmm = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(this.clock());
    const [h, m] = hhmm.split(':');
    return `São ${Number(h)} horas e ${Number(m)} minutos.`;
  }
}

export class DataAtualTool implements ITool {
  readonly name = 'DATA';
  readonly description = 'Data atual e dia da semana, do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean { return true; }
  execute(): string {
    const data = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }).format(this.clock());
    return `Hoje é ${data}.`;
  }
}

export function createSystemTools(clock: Clock = systemClock): ITool[] {
  return [new HoraAtualTool(clock), new DataAtualTool(clock)];
}

export function selectToolByName(name: string, tools: readonly ITool[]): ITool | null {
  if (name === 'NENHUMA') return null;
  return tools.find((t) => t.name === name && t.isAvailable()) ?? null;
}

/**
 * Filtro permissivo (§4.1). NÃO decide qual ferramenta — decide só se vale gastar uma
 * inferência perguntando ao modelo. Medido: 22/22 de cobertura em fraseado coloquial,
 * 0/8 de disparo em perguntas de domínio.
 */
const TIME_GATE =
  /\b(hora|horas|horario|hrs|dia|dias|data|hoje|agora|semana|mes|meses|ano|anos|manha|tarde|noite|amanha|ontem|minuto|minutos|relogio|calendario|quando)\b/;

export function mightBeTemporal(transcript: string): boolean {
  const n = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
  return TIME_GATE.test(n);
}

/** Falha de execução (§4.3): frase fixa, sem passar pelo modelo. */
export const TOOL_FAILURE_TEXT = 'Não consegui consultar o relógio do sistema agora.';
```

### 6.6 `sessionManager.ts`

Construtor ganha 6º parâmetro `tools: readonly ITool[] = []`.

Em `runTurn`, após `trimHistory(session)` e **antes** da chamada a `classify`:

```ts
      // Fase 5b: três camadas — filtro permissivo, modelo decide, código responde.
      if (this.tools.length > 0 && mightBeTemporal(transcript)) {
        let detected = 'NENHUMA';
        try {
          detected = await this.engine.detectTool(turn.turnId, turn.epoch, transcript);
        } catch (err) {
          // §4.4: a intenção nunca foi estabelecida — cair no caminho normal é o correto.
          detected = 'NENHUMA';
          console.error('[tool] detecção falhou, seguindo pelo caminho normal:', err);
        }
        if (session.activeTurn !== turn) return; // cancelado durante a detecção

        const tool = selectToolByName(detected, this.tools);
        if (tool) {
          let text: string;
          try {
            text = tool.execute();
          } catch (err) {
            // §4.3: falha FECHADA e determinística — o modelo não volta ao caminho.
            text = TOOL_FAILURE_TEXT;
            console.error('[tool] execução falhou:', err);
          }
          console.log(`[tool] turno=${turn.turnId} ferramenta=${tool.name}`);

          this.emit(session, {
            type: 'routing', turnId: turn.turnId, label: 'GERAL', handled: true
          });
          this.emit(session, { type: 'state', state: 'falando' });

          const clean = cleanTextForSpeech(text);
          turn.expectedSentences.add(0);
          turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, clean, 0));
          await Promise.allSettled(turn.pendingSynthesis);

          // Encerramento IDÊNTICO ao do caminho normal (sessionManager.ts:323-326).
          // O histórico NÃO é tocado aqui: entra por markPlayed(), quando o cliente
          // confirma a reprodução — mesma invariante que protege o barge-in na Fase 2.
          if (session.activeTurn === turn) {
            this.emit(session, { type: 'turn_done', turnId: turn.turnId });
            this.emit(session, { type: 'state', state: 'ouvindo' });
            session.activeTurn = null;
          }
          return;
        }
      }

      /* ... daqui para baixo, o caminho da Fase 5a segue inalterado ... */
```

### 6.7 `voiceRuntime.ts`

```ts
  const tools = createSystemTools();
  for (const tool of tools) ExtensionRegistry.getInstance().registerTool(tool);

  const sessionManager = new SessionManager(
    engine, ttsProvider, audioStore, agents, retriever, tools
  );
```

Registrar **e** passar — foi a ausência da segunda linha que gerou um achado ALTA na v1.

---

## 7. Critérios de aceite

Automatizados:

- **H1** `mightBeTemporal`: pega os 22 coloquiais da §4.1 e não dispara nos 8 negativos de domínio.
- **H2** `parse_tool_output` (Python, arquivo próprio **ligado ao comando de teste**): `HORA`,
  `hora`, ` DATA `, `NENHUMA`, `""`, `BANANA`, `HORA.`, quebra de linha. Inválido → `NENHUMA`.
- **H3** `execute()` com `Clock` fixo: igualdade de string exata para `2026-09-21T11:06:00` →
  `"São 11 horas e 6 minutos."` e `"Hoje é segunda-feira, 21 de setembro de 2026."`.
- **H4** `selectToolByName`: `NENHUMA` → null; desconhecido → null; `HORA` → instância.
- **H5** Integração com `FakeVoiceEngine`, `toolToReturn='HORA'`: emite `routing`, `falando`, **uma**
  frase com o texto exato, `turn_done` **e `state: ouvindo`**; `generateCalls.length === 0` e
  `classifyCalls.length === 0`; e **o histórico permanece inalterado** até `markPlayed`.
- **H6** `execute()` que lança → frase sintetizada é exatamente `TOOL_FAILURE_TEXT`, e o modelo
  continua não sendo chamado.
- **H7** `detectTool` que lança → turno segue o caminho normal: `classify` e `generate` chamados,
  `messages[0].content` **byte a byte** igual à referência da Fase 5a.
- **H8** Cancelamento: `cancel(turnId)` durante `detect_tool` rejeita o pending; o turno encerra sem
  pending órfão nem timer preso (mesmo teste que a Fase 3 tem para `classify`).
- **H9** `extensions.test.ts`: `tools` com `available: true`, descrição com os nomes, `registerTool`
  idempotente, `resetForTesting()` → false.
- **H10** Suíte completa sem regressão em B1-B8, C1-C6, Fase 4, Fase 5a.

Manuais, com MLX real:

- **H11** **COBERTURA CONTRA AMOSTRA QUE EU NÃO ESCOLHI.** É o critério que define a fase. As 30
  frases coloquiais escritas pelo auditor da 3ª rodada (log em
  `docs/audits/phase-5b-v3-hermes-2026-09-21.log`) são enviadas ao pipeline real. **Aprovação exige
  ≥ 80% detectadas corretamente.** Abaixo disso, a fase não passa — foi exatamente esse número
  (3%) que reprovou a v3, e medir contra amostra própria seria repetir o erro que já custou três
  versões.
- **H12** **Falsos positivos**, bloqueante: "Que horas são na China?", "Que dia foi ontem?",
  "Quantos dias faltam pro Natal?", "Que horas o mercado abre?", "Qual o dia do aniversário dele?",
  "Me fale sobre o perdão ao longo dos anos" → todos `NENHUMA`, nenhum fato injetado.
- **H13** Áudio real: hora e data conferidas contra `date`; a fala precisa soar natural (numerais
  lidos pelo TTS — conferir de ouvido).
- **H14** Não-regressão com áudio real: matemática, Virtologia com consulta ao corpus, Teologia.
- **H15** Classificador sobre os fraseados que chegam ao caminho de ferramenta (§4.6): todos devem
  dar `GERAL`. Divergência aciona o recuo declarado.
- **H16** `bench:voice` com **seis tags únicas** (`geral-antes`, `geral-depois`, …). O conjunto
  `geral` mede o custo real do filtro + detecção.

---

## 8. Limitações assumidas

1. **Falha da detecção cai no caminho normal** (§4.4) — não é possível falhar fechado sobre uma
   intenção nunca estabelecida.
2. **`label: 'GERAL'` fixado por construção** (§4.6), agora sobre um conjunto aberto de frases.
   H15 mede; recuo declarado.
3. Fraseado que o filtro permissivo não pega não chega ao modelo. Ampliar é aditivo.

---

## 9. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Cobertura real abaixo de 80% mesmo com o modelo detectando | **Média — risco central** | H11 é bloqueante e usa amostra de terceiro; recuo: ampliar exemplos no prompt de detecção, que é aditivo |
| Falso positivo do modelo em consulta temporal não suportada | Média | H12 bloqueante; exemplos negativos explícitos no prompt |
| Ciclo de cancelamento de `detect_tool` com bug sutil | Média | H8 espelha o teste que a Fase 3 já tem para `classify` |
| Inferência extra estoura latência nos turnos temporais | Baixa-Média | H16; zero em Teologia/Virtologia |
| `label: 'GERAL'` errado para algum fraseado | Baixa-Média | H15; conjunto agora é aberto — risco maior que na v3 |

---

## 10. Rastreabilidade

- Planos: v1, v2, v3 (rejeitados), v4 (esta).
- Auditorias e **modelos** (a rotação é entre modelos, não entre CLIs):
  - v1 e v2: `codex-cli 0.146.0` / **gpt-5.6-sol**, `effort=medium`.
  - v3: `agy 1.2.7` / **Gemini 3.8 Flash (High)** — falhou por OAuth expirado; substituído por
    Hermes (container Nous) / **longcat-2.0:free**, que audita executando.
  - Três fornecedores diferentes até aqui.
- Rodada 4: preferir `agy` (Gemini), agora autenticado — foi o único dos três que ainda não julgou
  este desenho.
- Implementação: `agy` em modo de escrita, após aprovação. Auditoria do código pelo Hermes.
