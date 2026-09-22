# Fase 5b — Ferramentas de leitura (`ITool`) — v2

Versão: v2
Data: 2026-09-21
Base: commit `9aedb9e`
Antecessor: `docs/phase-5b-v1.md` — **REJEITADO** (Codex, `model_reasoning_effort=medium`,
2026-09-21): 24 achados, 14 de gravidade ALTA.

---

## 1. Resposta aos achados da v1

| # | Achado | Grav. | Verificado? | Resolução |
|---|---|---|---|---|
| 1 | Prompt planejado contradiz o existente ("UMA ÚNICA PALAVRA" vs. `ROTULO\|FERRAMENTA`) | ALTA | ✅ `worker.py:46` | **§4.1 invertido**: o classificador não é tocado |
| 2 | `registerTool()` não existe no registry | ALTA | ✅ só há `registerVoiceProvider`/`registerAgent`/`registerKnowledge` | §6.2 — implementado, idempotente por `name` |
| 3 | Ferramentas registradas mas nunca entregues ao `SessionManager` | ALTA | ✅ o §6.6 da v1 só registrava | §6.6 — 6º parâmetro explícito no construtor, e G7 testa o caminho real |
| 4 | Regressão do classificador **introduzida** pelo desenho e medida tarde | ALTA | ✅ procede | **§4.1 — classificador preservado byte a byte; comando `detect_tool` separado, com pré-filtro** |
| 5 | G8 aprova regressão de ferramenta se o rótulo não mudar | ALTA | ✅ procede | §7 G8 — compara o par `{label, tool}` inteiro |
| 6 | Matriz não cobre falso positivo temporal | ALTA | ✅ procede | §7 G9b — matriz de falsos positivos, bloqueante |
| 7 | Falha da ferramenta **restaura a alucinação** que a fase elimina | ALTA | ✅ procede | **§4.4 — falha fechada** |
| 8 | Fronteira NDJSON não valida o campo novo | MÉDIA | ✅ procede | §6.5 — validação contra conjunto fechado antes de resolver a Promise |
| 9 | "poucos tokens de saída" é justificativa errada | MÉDIA | ✅ procede (o auditor mediu: máx. 11 tokens) | §4.2 — justificativa refeita, e o custo agora é de outra natureza |
| 10 | G4 não prova equivalência global | MÉDIA | ✅ procede | §7 G4 — também com conhecimento não vazio |
| 11 | G3 dito automatizado sem pertencer a suíte | MÉDIA | ✅ procede | §6.4 + §7 G3 — função pura + arquivo de teste + comando |
| 12 | G10 sobrescreve a evidência "antes" | MÉDIA | ✅ procede | §7 G10 — seis tags únicas |

**Nota sobre a frase obsoleta no classificador.** O achado 1 pede também remover de `worker.py:52-54`
o trecho *"pedidos de ação/ferramenta (ainda não implementados, tratar como GERAL)"*. **Aceito
parcialmente, com discordância registrada:** a instrução continua **comportamentalmente correta** —
pedidos de ferramenta devem mesmo ser rotulados `GERAL`, porque é no caminho do agente Geral que as
ferramentas rodam. Só o parêntese "ainda não implementados" fica obsoleto. Mudar o texto obriga a
revalidar a matriz inteira de classificação para um ganho cosmético, que é exatamente o risco que o
achado 4 manda evitar. **Decisão: o classificador não é tocado nesta fase**; a obsolescência do
parêntese fica documentada aqui e no código.

---

## 2. Objetivo e premissa medida

> Preencher `ITool` com ferramentas **de leitura, sem argumento**, para que o assistente responda com
> fato apurado onde hoje responde com invenção confiante.

Medido em 2026-09-21, servidor real (MLX, `Qwen3-4B-Instruct-2507-4bit`), áudio sintetizado:

```
hora real do sistema: 10:54 de Monday, 21 de September de 2026
"Que horas são agora?"  -> GERAL -> "Agora são seis e meia."
"Que dia é hoje?"       -> GERAL -> "Hoje é quinta-feira, 21 de abril."
```

Erradas as duas, com confiança total. **Pronto** exige: as duas respondidas corretamente com áudio
real; par `{label, tool}` inalterado em toda a matriz de classificação; prompt byte a byte idêntico
ao da Fase 5a em turno sem ferramenta; falha da ferramenta **não** retornando à alucinação; latência
dentro das metas; suíte completa sem regressão.

---

## 3. Escopo

**Dentro:** `ITool` com `execute()`; `hora_atual` e `data_atual`; detecção por comando próprio com
pré-filtro; injeção do fato; `registerTool()`; módulo `tools` honesto.

**Fora:** qualquer ação que mute estado (Fase 5c, com confirmação por voz); ferramentas com
argumento; rede/API paga/nuvem; alteração do classificador.

---

## 4. Decisões

### 4.1 O classificador não é tocado. Detecção em comando próprio, atrás de um pré-filtro barato

A v1 estendia o `classify` para devolver `ROTULO|FERRAMENTA`, justificando com latência. O achado 4
está certo: isso **introduz** estruturalmente a regressão que a própria v1 nomeava como risco
central, e propunha medi-la depois em vez de evitá-la. Além disso, o achado 1 mostrou que o prompt
resultante teria instruções mutuamente exclusivas — a v1 teria disparado a regressão que dizia
monitorar.

**Decisão da v2, em três camadas:**

1. **`CLASSIFICATION_SYSTEM_PROMPT` e `handle_classify` ficam byte a byte como estão.** A matriz
   C1-C6 continua válida sem reexecução conceitual (ainda assim é reexecutada como regressão, G8).
2. **Pré-filtro determinístico em Node**, permissivo de propósito: só decide se *vale perguntar ao
   modelo*, nunca decide qual ferramenta usar. Falso positivo custa uma inferência; falso negativo
   custa a funcionalidade — por isso a lista é ampla.
3. **Comando `detect_tool` novo no worker**, com prompt próprio, conjunto fechado e `temp=0.0`,
   executado **somente** quando o pré-filtro dispara.

**Custo medido do pré-filtro** (executado contra os três conjuntos de benchmark, 30 perguntas):

```
geral       2/10   -> "Que horas são agora?"; "Qual é o dia da semana hoje?"
teologia    0/10
virtologia  0/10
TOTAL: 2/30 = 7% dos turnos pagariam a inferência extra

sanidade (fraseado indireto e negativos):
  DISPARA  Que horas são agora?          DISPARA  Me diz a data de hoje
  DISPARA  Que dia é hoje?               DISPARA  Qual o horário?
  DISPARA  Estou com pressa, que horas são?
    passa  Quanto é dezessete por cento de oitocentos e cinquenta?
    passa  Explique a Aceitação dentro da Virtologia
```

Ou seja: 93% dos turnos não pagam nada, e a objeção de latência que motivou o desenho da v1
desaparece sem custar a integridade do classificador.

**Por que o pré-filtro léxico é aceitável aqui, sendo que a Fase 5a inteira é um monumento à
fragilidade de casamento léxico:** lá o casamento era a **decisão final** — errar significava
injetar o trecho errado. Aqui ele é só um **portão**, e quem decide é o modelo logo atrás. A única
falha que importa é o falso negativo (não perguntar quando devia), e o vocabulário de tempo em
português é pequeno e estável. Falso positivo custa uma inferência de 8 tokens e nada mais.

### 4.2 O custo do comando separado, honestamente

A v1 dizia que a extensão custava "poucos tokens de saída". O auditor mostrou que a justificativa
estava errada — e mediu que o formato consome no máximo 11 tokens de saída, mas o custo relevante é
o **prefill** do prompt de sistema, que a v1 ignorava.

Na v2 o custo é de outra natureza e maior por turno afetado: uma passada completa de inferência,
com prompt próprio. Em compensação, incide em ~7% dos turnos em vez de 100%, e **zero** nos turnos
de Teologia e Virtologia, que são os de maior latência hoje. G10 mede isso nos três conjuntos.

### 4.3 `detect_tool` espelha `classify`, sem herdar a severidade dele

Mesmo molde: `temp=0.0`, `max_tokens` pequeno, conjunto fechado, validação estrita. **Uma diferença
deliberada:** no `classify`, formato inválido é erro do turno; aqui, formato inválido vira `NENHUMA`
com linha de diagnóstico. Não reconhecer intenção de ferramenta deve custar a ferramenta, nunca o
turno.

### 4.4 Falha fechada: detectada a intenção, a alucinação não volta

Achado 7, e é o mais sutil da auditoria. Na v1, se `execute()` falhasse, `toolBlock` virava vazio e o
turno seguia — ou seja, a pergunta "que horas são" voltaria a ser respondida pelo conhecimento do
modelo, que é exatamente a invenção que a fase existe para eliminar. Degradar em silêncio para o
comportamento defeituoso é pior que não ter a fase.

**Regra:** uma vez que `detect_tool` devolveu `HORA` ou `DATA`, o turno **não pode** responder com
data/hora vinda do modelo. Se `execute()` lançar, em vez de bloco vazio é injetado um bloco de
proibição:

```
O relógio do sistema não pôde ser consultado neste instante. NÃO invente nem estime a hora ou a
data. Diga ao usuário, de forma breve e natural, que não conseguiu consultar o relógio agora.
```

### 4.5 Consulta temporal não suportada não recebe o fato local

Achado 6. "Que horas são na China?", "que dia foi ontem?", "quantos dias faltam pro Natal?" são
temporais, disparam o pré-filtro, e **não** são atendidas por `hora_atual`/`data_atual`. O prompt do
`detect_tool` traz exemplos negativos explícitos e o conjunto fechado tem só três valores, então o
caminho correto é `NENHUMA`. A matriz G9b torna isso bloqueante.

### 4.6 Formatação pelo runtime, e ICU verificado antes

`Intl.DateTimeFormat` com locale `pt-BR`. O achado do auditor sobre ICU é legítimo: sem ICU completo,
`pt-BR` degrada silenciosamente para inglês. **Verificação obrigatória na implementação, antes de
qualquer outra coisa** (§6.1) — e, se falhar, a fase para e vira decisão do usuário, porque a
alternativa é formatação manual de data, que é a categoria de código que erra em virada de mês e
horário de verão.

---

## 5. Arquivos afetados

**Novos:** `src/backend/tools/systemTools.ts`, `src/backend/tools/index.ts`,
`src/backend/__tests__/tools.test.ts`, `scripts/worker/test_classification_parser.py`.

**Modificados:**
- `src/shared/extensions/tools.ts` — `execute(): string` no `ITool`.
- `src/shared/extensions/registry.ts` — `registerTool()` idempotente; módulo `tools` dinâmico;
  `resetForTesting()` já limpa `this.tools`.
- `src/shared/voiceProtocol.ts` — `TOOL_NAMES`, `ToolName`.
- `scripts/worker/worker.py` — **somente acréscimo**: `DETECT_TOOL_SYSTEM_PROMPT`,
  `parse_tool_output()`, `handle_detect_tool()`, despacho de `detect_tool`. `CLASSIFICATION_*` e
  `handle_classify` **não são tocados**.
- `src/backend/voice/engine.ts` / `mlxWorkerEngine.ts` — método `detectTool()`; validação do campo
  na fronteira NDJSON.
- `src/backend/voice/fakeEngine.ts` — `detectTool()` + `toolToReturn`.
- `src/backend/voice/sessionManager.ts` — pré-filtro, chamada condicional, injeção, falha fechada.
- `src/backend/voice/voiceRuntime.ts` — cria, registra e **passa** as ferramentas.
- `src/backend/__tests__/extensions.test.ts`, `voice.test.ts` — módulo `tools` e fakes.
- `package.json` — o comando de teste passa a incluir os testes Python do worker (§7 G3).

---

## 6. Pseudocódigo completo

### 6.1 Verificação de pré-requisito (antes de escrever código)

```bash
node -e "console.log(new Intl.DateTimeFormat('pt-BR',{weekday:'long',month:'long'}).format(new Date()))"
```

Precisa sair em português (ex.: `segunda-feira, setembro`). Se sair em inglês, o Node não tem ICU
completo: **parar e reportar**, não contornar com formatação manual.

### 6.2 `src/shared/extensions/registry.ts`

```ts
  /**
   * Fase 5b. Idempotente por `name`: registrar a mesma ferramenta duas vezes não duplica —
   * mesma garantia que `registerAgent` dá para os agentes, porque `createSystemTools()` pode
   * ser chamado mais de uma vez em teste.
   */
  public registerTool(tool: ITool): void {
    if (this.tools.some((t) => t.name === tool.name)) return;
    this.tools.push(tool);
  }
```

e o módulo `tools` passa a ser dinâmico:

```ts
      {
        id: 'tools',
        name: 'Ferramentas do sistema',
        phase: 5,
        available: this.tools.length > 0,
        description:
          this.tools.length > 0
            ? `Ferramentas de leitura disponíveis: ${this.tools.map((t) => t.name).join(', ')}.`
            : 'Nenhuma ferramenta registrada — o assistente responde sem consultar o sistema.'
      }
```

### 6.3 `src/shared/voiceProtocol.ts`

```ts
/** Fase 5b — conjunto FECHADO. NENHUMA é o caso normal e o default de degradação. */
export const TOOL_NAMES = ['HORA', 'DATA', 'NENHUMA'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}
```

### 6.4 `scripts/worker/worker.py` — acréscimos apenas

```python
TOOL_NAMES = {"HORA", "DATA", "NENHUMA"}

DETECT_TOOL_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede a HORA atual, a DATA de hoje, ou NENHUMA das duas. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: HORA, DATA ou NENHUMA.\n"
    "HORA: o usuário quer saber que horas são AGORA, neste lugar.\n"
    "DATA: o usuário quer saber que dia é HOJE, o dia da semana, o mês ou o ano atuais.\n"
    "NENHUMA: todo o resto. Isso INCLUI perguntas sobre tempo que não são a hora ou a data de "
    "agora aqui: hora em outro país ou fuso, datas passadas ou futuras, quanto tempo falta para "
    "algo, duração, aniversário, feriado, ou qualquer cálculo com datas.\n"
    "Exemplos:\n"
    "Que horas são agora? -> HORA\n"
    "Estou com pressa, que horas são? -> HORA\n"
    "Qual o horário? -> HORA\n"
    "Que dia é hoje? -> DATA\n"
    "Me diz a data de hoje. -> DATA\n"
    "Em que dia da semana estamos? -> DATA\n"
    "Que horas são na China? -> NENHUMA\n"
    "Que dia foi ontem? -> NENHUMA\n"
    "Quantos dias faltam pro Natal? -> NENHUMA\n"
    "Que horas o mercado abre? -> NENHUMA\n"
    "Quanto tempo dura a reunião? -> NENHUMA\n"
)


def parse_tool_output(raw: str) -> str:
    """Função PURA — testada por scripts/worker/test_classification_parser.py.

    Formato inválido degrada para NENHUMA: não reconhecer intenção de ferramenta deve custar
    a ferramenta, nunca o turno (ao contrário do classificador, onde formato inválido é erro).
    """
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return normalized if normalized in TOOL_NAMES else "NENHUMA"


    def handle_detect_tool(self, msg: dict[str, Any]) -> None:
        req_id = msg["reqId"]
        turn_id = msg["turnId"]
        epoch = msg["epoch"]
        text = msg["text"]

        if not text or not text.strip():
            emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": "NENHUMA"})
            return

        handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
        with self._current_lock:
            self._current = handle
        try:
            messages = [
                {"role": "system", "content": DETECT_TOOL_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ]
            prompt = self._llm_tokenizer.apply_chat_template(
                messages, add_generation_prompt=True, tokenize=False
            )
            from mlx_lm.generate import stream_generate
            from mlx_lm.sample_utils import make_sampler

            sampler = make_sampler(temp=0.0)
            raw = ""
            for response in stream_generate(
                self._llm, self._llm_tokenizer, prompt, max_tokens=6, sampler=sampler
            ):
                if handle.cancel_event.is_set():
                    log_diag(f"Detecção de ferramenta cancelada (turnId={turn_id}).")
                    return
                raw += response.text
            tool = parse_tool_output(raw)
            if tool == "NENHUMA" and raw.strip():
                log_diag(f"Saída de detecção fora do conjunto ({raw.strip()!r}) — degradando para NENHUMA.")
            emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": tool})
        except Exception as exc:  # noqa: BLE001
            log_diag(f"Erro na detecção de ferramenta: {exc}\n{traceback.format_exc()}")
            emit({"event": "tool_detection", "reqId": req_id, "turnId": turn_id, "tool": "NENHUMA"})
        finally:
            with self._current_lock:
                if self._current is handle:
                    self._current = None
            if self._mx is not None:
                self._mx.clear_cache()
```

No despacho, junto de `classify` e `generate`: `elif cmd == "detect_tool": self.handle_detect_tool(msg)`.

### 6.5 Fronteira NDJSON — `mlxWorkerEngine.ts`

```ts
      case 'tool_detection': {
        // Achado 8: valida o campo contra o conjunto fechado ANTES de resolver a Promise.
        // Worker adulterado, versão dessincronizada ou campo ausente não podem virar
        // ToolName por asserção de tipo.
        const pending = this.pendingToolDetections.get(msg.reqId);
        if (!pending) break;
        this.pendingToolDetections.delete(msg.reqId);
        pending.resolve(isToolName(msg.tool) ? msg.tool : 'NENHUMA');
        break;
      }
```

### 6.6 `src/backend/tools/systemTools.ts`

```ts
import type { ITool } from '../../shared/extensions/tools.js';
import type { ToolName } from '../../shared/voiceProtocol.js';

/** Injetável para teste determinístico — G1 não pode depender do relógio real. */
export type Clock = () => Date;
const systemClock: Clock = () => new Date();

export class HoraAtualTool implements ITool {
  readonly name = 'HORA';
  readonly description = 'Hora atual do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean {
    return true;
  }
  execute(): string {
    const hora = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(this.clock());
    return `são ${hora}`;
  }
}

export class DataAtualTool implements ITool {
  readonly name = 'DATA';
  readonly description = 'Data atual e dia da semana, do relógio do sistema.';
  constructor(private readonly clock: Clock = systemClock) {}
  isAvailable(): boolean {
    return true;
  }
  execute(): string {
    const data = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(this.clock());
    return `hoje é ${data}`;
  }
}

export function createSystemTools(clock: Clock = systemClock): ITool[] {
  return [new HoraAtualTool(clock), new DataAtualTool(clock)];
}

export function selectToolByName(tool: ToolName, tools: readonly ITool[]): ITool | null {
  if (tool === 'NENHUMA') return null;
  return tools.find((t) => t.name === tool && t.isAvailable()) ?? null;
}

/**
 * Pré-filtro (§4.1). Permissivo DE PROPÓSITO: decide apenas se vale perguntar ao modelo,
 * nunca qual ferramenta usar. Falso positivo custa uma inferência; falso negativo custa a
 * funcionalidade.
 */
const TIME_GATE =
  /\b(hora|horas|horario|que dia|dia de hoje|data|hoje|agora|amanha|ontem|semana|mes|ano)\b/;

export function mightBeTemporal(transcript: string): boolean {
  const normalized = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return TIME_GATE.test(normalized);
}

export function buildToolBlock(fact: string): string {
  return (
    `Fato apurado do sistema neste instante: ${fact}. ` +
    'Use este dado como verdadeiro e não o contradiga; ele vem do relógio do computador, não do ' +
    'seu conhecimento. Responda de forma natural e falada, sem ler este aviso em voz alta.'
  );
}

/** Falha fechada (§4.4): detectada a intenção, a invenção não volta. */
export function buildToolFailureBlock(): string {
  return (
    'O relógio do sistema não pôde ser consultado neste instante. NÃO invente nem estime a hora ' +
    'ou a data. Diga ao usuário, de forma breve e natural, que não conseguiu consultar o relógio ' +
    'agora.'
  );
}
```

### 6.7 `src/backend/voice/sessionManager.ts`

Construtor ganha o 6º parâmetro, opcional com default (mesma forma do `retriever` da Fase 5a):

```ts
  constructor(
    engine: VoiceEngine,
    ttsProvider: IVoiceProvider,
    audioStore: AudioStore,
    agents: readonly IAgent[],
    retriever: KnowledgeRetriever | null = null,
    tools: readonly ITool[] = []
  ) { /* ... this.tools = tools; ... */ }
```

Em `runTurn`, **depois** da recuperação de conhecimento da Fase 5a e **antes** de emitir `routing`:

```ts
      // Fase 5b: o pré-filtro evita uma inferência extra em ~93% dos turnos (medido).
      // Nada é anunciado antes de estar decidido — mesma regra das fases anteriores.
      let toolBlock = '';
      if (this.tools.length > 0 && mightBeTemporal(transcript)) {
        let detected: ToolName = 'NENHUMA';
        try {
          detected = await this.engine.detectTool(turn.turnId, turn.epoch, transcript);
        } catch (err) {
          detected = 'NENHUMA';
          console.error('[tool] detecção falhou, seguindo sem ferramenta:', err);
        }
        if (session.activeTurn !== turn) return; // cancelamento durante a detecção

        const selected = selectToolByName(detected, this.tools);
        if (selected) {
          try {
            toolBlock = buildToolBlock(selected.execute());
            console.log(`[tool] turno=${turn.turnId} ferramenta=${selected.name}`);
          } catch (err) {
            // Falha FECHADA (§4.4): a intenção foi reconhecida, então a resposta não pode
            // voltar a ser inventada pelo modelo.
            toolBlock = buildToolFailureBlock();
            console.error('[tool] execução falhou — bloco de proibição injetado:', err);
          }
        }
      }

      const systemPrompt = [
        agent.getSystemPrompt(),
        knowledgeBlock,
        toolBlock,
        VOICE_SAFETY_AND_OUTPUT_CONSTRAINTS
      ]
        .filter((part) => part.length > 0)
        .join('\n\n');
```

### 6.8 `src/backend/voice/voiceRuntime.ts`

```ts
  const tools = createSystemTools();
  for (const tool of tools) {
    ExtensionRegistry.getInstance().registerTool(tool);
  }

  const sessionManager = new SessionManager(
    engine, ttsProvider, audioStore, agents, retriever, tools
  );
```

O achado 3 existia porque a v1 registrava e não passava. **As duas linhas andam juntas**, e G7 prova
o caminho real em vez de um `SessionManager` montado à mão no teste.

---

## 7. Critérios de aceite

- **G1** `execute()` com `Clock` fixo (não o relógio real): `HoraAtualTool` devolve `HH:MM` 24h;
  `DataAtualTool` devolve dia da semana, dia, mês e ano em pt-BR.
- **G2** `selectToolByName`: `NENHUMA` → `null`; desconhecido → `null`; `HORA` → instância certa.
- **G3** `scripts/worker/test_classification_parser.py`, **conectado ao comando de teste do
  `package.json`**: `parse_tool_output` cobre `HORA`, `hora`, ` DATA `, `NENHUMA`, `""`, `BANANA`,
  `HORA.`, e saída com quebra de linha. Inválido → `NENHUMA`.
- **G4** Equivalência byte a byte em **dois** cenários, contra referência fixa: (a) sem conhecimento
  e sem ferramenta; (b) **com** conhecimento não vazio e sem ferramenta. Prova que o `filter+join`
  do §6.7 é equivalente às ramificações da Fase 5a.
- **G5** `mightBeTemporal`: dispara nos cinco fraseados da §4.1 e não dispara nos dois negativos.
- **G6** Integração com `FakeVoiceEngine`: `toolToReturn='HORA'` põe o fato em
  `messages[0].content`; `'NENHUMA'` não acrescenta nada; `execute()` que lança injeta o **bloco de
  proibição**, nunca bloco vazio.
- **G7** **Caminho real**: um teste constrói o runtime como `voiceRuntime` constrói (ferramentas
  registradas **e** passadas) e prova que um turno `HORA` chega ao motor com o fato. Sem isso, o
  achado 3 voltaria silenciosamente.
- **G8** `extensions.test.ts`: `tools` com `available: true` e descrição listando as ferramentas;
  `registerTool` idempotente (registrar duas vezes mantém uma); `resetForTesting()` → `available: false`.
- **G9** Suíte completa sem regressão em B1-B8, C1-C6, Fase 4, Fase 5a.

Manuais, com MLX real:

- **G10** **Matriz de classificação antes e depois, comparando o par `{label, tool}` completo**,
  não só o rótulo (achado 5). Bloqueante. Inclui negativos adjacentes que usam "hoje", "dia",
  "data", "hora", "horas" em sentido não-temporal-atual.
- **G11** **Matriz de falsos positivos temporais** (achado 6), bloqueante — todos devem dar
  `NENHUMA` e **nenhum fato local pode ser injetado**:

  | Fala | Esperado |
  |---|---|
  | "Que horas são na China?" | `NENHUMA` |
  | "Que dia foi ontem?" | `NENHUMA` |
  | "Quantos dias faltam pro Natal?" | `NENHUMA` |
  | "Que horas o mercado abre?" | `NENHUMA` |
  | "Quanto tempo dura a reunião?" | `NENHUMA` |
  | "Qual o dia do aniversário dele?" | `NENHUMA` |

- **G12** Áudio real, positivos: "Que horas são agora?", "Que dia é hoje?", "Estou com pressa, que
  horas são?" → resposta conferida contra `date` do sistema.
- **G13** Áudio real, não-regressão: matemática (GERAL), Virtologia com consulta ao corpus,
  Teologia — nenhuma ferramenta, comportamento da Fase 5a preservado.
- **G14** `npm run bench:voice` com **seis tags únicas** (achado 12): `geral-antes`,
  `geral-depois`, `teologia-antes`, `teologia-depois`, `virtologia-antes`, `virtologia-depois`.
  Metas ≤4s mediana / ≤8s p95. O conjunto `geral` mede diretamente o custo do pré-filtro + detecção.

---

## 8. Achados fora de escopo (herdados)

1. `MAX_CONTEXT_TOKENS` é constante morta (`src/shared/voiceProtocol.ts`).
2. Dívida da Fase 5a: o trecho consultado não aparece na interface.
3. `worker.py` diz "ferramentas ainda não implementadas" no prompt do classificador — obsoleto após
   esta fase, **deliberadamente não corrigido** (§1).

---

## 9. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Pré-filtro tem falso negativo em fraseado não previsto | Média | G5 + G12 com fraseado indireto; lista ampla por desenho; recuo: ampliar a lista, que é aditivo e sem risco |
| `detect_tool` dá falso positivo em consulta temporal não suportada | **Média — risco central agora** | G11 é bloqueante; exemplos negativos explícitos no prompt |
| Inferência extra estoura latência nos ~7% de turnos afetados | Baixa-Média | G14; incide zero em Teologia/Virtologia |
| Modelo lê o bloco do fato em voz alta | Média | instrução explícita + G12 na escuta |
| Node sem ICU completo degrada pt-BR para inglês | Baixa | §6.1 verifica antes de escrever código; falha para o usuário, não contorna |

---

## 10. Rastreabilidade

- Planos: `phase-5b-v1.md` (rejeitado, 24 achados), `phase-5b-v2.md` (esta).
- Auditoria v1: Codex CLI `0.146.0`, `model_reasoning_effort=medium`, 2026-09-21.
- Auditoria v2: **pendente**.
- Implementação: delegada ao `agy` em modo de escrita, **somente após aprovação** — decisão do
  usuário em 2026-09-21. Auditoria do código resultante pelo Hermes, que audita executando.
