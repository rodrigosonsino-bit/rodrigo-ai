# Fase 5b — Ferramentas de leitura (`ITool`) — v3

Versão: v3
Data: 2026-09-21
Base: commit `9aedb9e`
Antecessores: `phase-5b-v1.md` (REJEITADO, 24 achados / 14 ALTA), `phase-5b-v2.md` (REJEITADO,
~12 achados / 14 ALTA). Ambas auditadas pelo Codex CLI, `model_reasoning_effort=medium`.

**Mudança de desenho, decidida pelo usuário em 2026-09-21 a partir do achado mais profundo da 2ª
rodada:** nada de LLM no caminho da ferramenta. Detecção **e** resposta são determinísticas.

---

## 1. Por que o desenho mudou, e o que isso apaga

A 2ª auditoria encontrou, entre outros: *"o fechamento ainda depende de obediência probabilística do
mesmo modelo de 4B"*. Está certo. O "bloco de proibição" da v2 era uma instrução de texto pedindo a
um modelo que **já alucina a hora** que, desta vez, não alucinasse. A recomendação do auditor foi
direta: *"em falha após intenção temporal reconhecida, não chamar o LLM — produzir frase
determinística e enviá-la diretamente ao TTS"*.

A v3 aplica isso ao caminho inteiro, não só à falha. E ao fazê-lo, **12 achados das duas rodadas
deixam de existir** em vez de serem corrigidos:

| Achado (v1/v2) | Como a v3 o apaga |
|---|---|
| Prompt do classificador contraditório | o classificador não é tocado, e nada é acrescentado a ele |
| `detect_tool` sem ciclo de cancelamento / `spawnGeneration` | não há comando novo no worker |
| Despacho do worker não atualizado | idem |
| Fronteira NDJSON não valida campo novo | não há campo novo |
| Custo de inferência extra / latência diluída | **não há inferência nenhuma** — o caminho fica mais rápido que hoje |
| Falha da detecção reabre a alucinação | a detecção é uma regex: não falha por indisponibilidade |
| Fechamento depende de obediência probabilística | **a resposta não passa pelo modelo** |
| Pré-filtro perde fraseado (falso negativo silencioso) | continua existindo, mas agora é a **única** fonte de erro, e falha para o comportamento de hoje (§4.3) |
| "7% em 30 perguntas curadas" não é representativo | métrica descartada; não há custo por turno a justificar |
| G7 exige caminho real não testável sem MLX | o caminho agora é função pura, testável sem MLX (§7 G6) |
| G10/G11 dependem de runner que observe `{label, tool}` | não há `tool` vindo do modelo para observar |
| `NENHUMA` válido diagnosticado como inválido | não há parser de saída de modelo |

O que **não** desaparece: a cobertura de fraseado. Ela vira o único risco da fase, está medida na
§5, e o modo de falha é benigno (§4.3).

---

## 2. Objetivo e premissa medida

> Responder hora e data com **fato apurado do relógio do sistema**, sem passar pelo modelo, onde
> hoje o assistente responde com invenção confiante.

Medido em 2026-09-21, servidor real (MLX, `Qwen3-4B-Instruct-2507-4bit`), áudio sintetizado:

```
hora real do sistema: 10:54 de Monday, 21 de September de 2026
"Que horas são agora?"  -> GERAL -> "Agora são seis e meia."
"Que dia é hoje?"       -> GERAL -> "Hoje é quinta-feira, 21 de abril."
```

**Pronto** exige: as duas respondidas corretamente com áudio real, conferidas contra `date`; turno
sem ferramenta com prompt e comportamento **byte a byte** idênticos à Fase 5a; nenhum falso positivo
na matriz da §5; latência do caminho de ferramenta **menor** que a de hoje (é o único caminho desta
fase que muda latência, e muda para baixo); suíte completa sem regressão.

---

## 3. Escopo

**Dentro:** `ITool` com `execute()`; `HoraAtualTool` e `DataAtualTool`; detecção determinística por
casamento de enunciado inteiro; resposta sintetizada direto ao TTS, sem geração; `registerTool()`;
módulo `tools` honesto.

**Fora:** ações que mutam estado (Fase 5c, com confirmação por voz); ferramentas com argumento;
qualquer alteração no worker, no classificador ou no protocolo NDJSON; rede/nuvem/API paga.

---

## 4. Decisões

### 4.1 Casamento de enunciado inteiro, não busca de padrão dentro da frase

A detecção normaliza o transcript, remove um conjunto fechado de **preenchimentos** que não deslocam
a pergunta ("por favor", "aí", "agora", "estou com pressa", "me diz"), e exige que **o que sobrar
seja exatamente um dos núcleos**. Sobra qualquer outra coisa → `NENHUMA`.

Isso é o oposto do pré-filtro da v2, que procurava palavras dentro da frase. A diferença é
decisiva para a precisão:

- `"que horas são"` → sobra vazia depois do núcleo → **HORA**
- `"que horas são na China"` → sobra `"na china"` → **NENHUMA**
- `"qual a data da reforma protestante"` → sobra `"da reforma protestante"` → **NENHUMA**
- `"me diz a data do casamento"` → sobra `"do casamento"` → **NENHUMA**

**Falso positivo é estruturalmente improvável**: exige que a frase inteira do usuário seja, palavra
por palavra, um pedido de hora ou data atual. É a propriedade que a v2 não tinha e que custou o
achado de falsos positivos temporais.

### 4.2 A resposta não passa pelo modelo

Detectada a ferramenta, o turno **não chama `engine.generate()`**. O texto é montado em Node a
partir do `execute()` e vai direto para o caminho de síntese que já existe
(`synthesizeSentence`), seguido de `turn_done`.

Consequências, todas desejáveis:

- **A resposta é exatamente previsível** e verificável por igualdade de string em teste, não por
  `assert.match` sobre saída de modelo.
- **É mais rápido que hoje**: elimina a geração (até 160 tokens) e, na §4.4, também a classificação.
- **Não há como o modelo contradizer o fato**, porque ele não participa.
- **O bloco de segurança de voz não é necessário neste caminho** — não há instrução a proteger de
  injeção, porque não há prompt. O texto é nosso, fixo, e passa pelo `cleanTextForSpeech` existente
  como qualquer outra frase.

### 4.3 O único modo de falha é o falso negativo, e ele é benigno

Fraseado não coberto (`"tá tarde?"`, `"já passou do meio-dia?"`) não casa e o turno segue **o
caminho normal da Fase 5a** — ou seja, o modelo responde, possivelmente inventando. Isso é
exatamente o comportamento de hoje: a fase não piora nada, apenas deixa de melhorar aquele caso.

**Isso é assumido, não escondido.** Ampliar a cobertura é aditivo, sem risco, e não exige nova
auditoria: acrescentar um núcleo não pode criar falso positivo em frase que antes casava.

### 4.4 O turno de ferramenta não passa pelo classificador

Detectada a ferramenta, o turno responde sem chamar `classify`. O evento `routing` continua sendo
emitido, com `label: 'GERAL'` e `handled: true`.

**Base empírica para fixar `GERAL`:** as duas perguntas-alvo foram classificadas `GERAL` pelo
classificador real na medição da §2. **Ressalva honesta:** isso é uma asserção por construção, não
um resultado computado naquele turno — um usuário poderia, em tese, produzir um enunciado que casa o
núcleo e que o classificador chamaria de outra coisa. Dado que os núcleos exigem casamento do
enunciado inteiro, o conjunto de frases que chegam aqui é pequeno, fechado e inspecionável; G8
reexecuta a classificação sobre **todos** os núcleos para confirmar que todos dão `GERAL`.

Se G8 mostrar qualquer núcleo classificado diferente, o recuo declarado é: manter a chamada a
`classify` e pular apenas a geração — custa uma inferência curta e remove a asserção.

### 4.5 Formatação pelo runtime; ICU verificado

`Intl.DateTimeFormat('pt-BR', …)`. Verificado nesta máquina antes de escrever este plano:

```
$ node -e "console.log(new Intl.DateTimeFormat('pt-BR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date()))"
segunda-feira, 21 de setembro de 2026
$ node -e "console.log(new Intl.DateTimeFormat('pt-BR',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()))"
11:06
```

Nenhuma formatação manual de data — é a categoria que erra em virada de mês e horário de verão.

---

## 5. Evidência de execução (detector, 34 casos)

Saída real do detector proposto, sem edição:

```
HORA (10/10): "Que horas são?" · "Que horas são agora?" · "Estou com pressa, que horas são?" ·
  "Me diz as horas" · "Qual é a hora?" · "Qual o horário?" · "Que horas você tem?" ·
  "Que horas marca o relógio?" · "Tem horas aí?" · "Me diz as horas, por favor"

DATA (9/9): "Que dia é hoje?" · "Qual a data de hoje?" · "Me diz a data" · "Que dia da semana é?" ·
  "Em que dia estamos?" · "Qual o dia de hoje?" · "Em que mês estamos?" · "Em que ano estamos?" ·
  "Que dia é hoje, por favor?"

NENHUMA (15/15): "Que horas são na China?" · "Que dia foi ontem?" · "Quantos dias faltam pro Natal?" ·
  "Que horas o mercado abre?" · "Quanto tempo dura a reunião?" · "Qual o dia do aniversário dele?" ·
  "Que horas você chega amanhã?" · "Quanto é dezessete por cento de oitocentos e cinquenta?" ·
  "Explique a Aceitação dentro da Virtologia" · "Faça uma análise exegética de Hebreus cinco" ·
  "Qual sua posição sobre o batismo?" · "Que dia Jesus nasceu?" · "Que horas eu devo tomar o remédio?" ·
  "Qual a data da reforma protestante?" · "Me diz a data do casamento"

ERROS: 0 de 34
```

**Ressalva de amostra:** 34 casos escolhidos por mim, e quem escolhe a amostra escolhe o resultado.
O que essa medição sustenta é que o **mecanismo** (casamento de enunciado inteiro) rejeita sobra —
uma propriedade estrutural, não estatística. A cobertura de fraseado real continua desconhecida e é
o risco declarado da §4.3.

---

## 6. Arquivos afetados

**Novos:** `src/backend/tools/systemTools.ts`, `src/backend/tools/index.ts`,
`src/backend/__tests__/tools.test.ts`.

**Modificados:**
- `src/shared/extensions/tools.ts` — `execute(): string`.
- `src/shared/extensions/registry.ts` — `registerTool()` idempotente por `name`; módulo `tools`
  dinâmico. (`resetForTesting()` **já** limpa `this.tools` — verificado.)
- `src/backend/voice/sessionManager.ts` — detecção e caminho determinístico.
- `src/backend/voice/voiceRuntime.ts` — cria, **registra e passa** as ferramentas.
- `src/backend/__tests__/extensions.test.ts` — módulo `tools` disponível.

**Não modificados, de propósito:** `scripts/worker/worker.py`, `voiceProtocol.ts` (nenhum tipo
novo no protocolo), `engine.ts`, `mlxWorkerEngine.ts`, `fakeEngine.ts`, frontend.

---

## 7. Pseudocódigo completo

### 7.1 `src/shared/extensions/tools.ts`

```ts
export interface ITool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  /** Fase 5b: síncrona, sem argumento, sem I/O — função pura sobre o ambiente local. */
  execute(): string;
}
```

### 7.2 `src/shared/extensions/registry.ts`

```ts
  /** Idempotente por `name`: `createSystemTools()` pode ser chamado mais de uma vez em teste. */
  public registerTool(tool: ITool): void {
    if (this.tools.some((t) => t.name === tool.name)) return;
    this.tools.push(tool);
  }
```

e o módulo `tools` passa a `available: this.tools.length > 0`, com descrição listando os nomes.

### 7.3 `src/backend/tools/systemTools.ts`

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

/* ------------------------------------------------------------------ detecção */

export type DetectedTool = 'HORA' | 'DATA' | 'NENHUMA';

/** Preenchimentos que NÃO deslocam a pergunta de "agora, aqui". Conjunto fechado. */
const FILLER =
  /\b(por favor|pra mim|para mim|ai|agora|entao|ne|olha|escuta|oi|ola|estou com pressa|to com pressa|rapido|me|diz|diga|fala|fale|sabe|voce|vc|tem|hoje em dia)\b/g;

/**
 * Núcleos: o enunciado INTEIRO, já sem preenchimento, precisa ser um destes.
 * Qualquer sobra impede o casamento — é isto que torna o falso positivo estruturalmente
 * improvável, em vez de depender de uma lista de qualificadores proibidos.
 */
const HORA_CORE =
  /^(que horas sao|que hora e|qual e a hora|qual a hora|qual e o horario|qual o horario|as horas|a hora|que horas|horas|que horas marca o relogio|que horas marca)$/;
const DATA_CORE =
  /^(que dia e hoje|que dia e|qual e a data de hoje|qual a data de hoje|qual e a data|qual a data|a data|a data de hoje|que dia da semana e|que dia da semana|em que dia estamos|qual o dia de hoje|qual e o dia de hoje|que dia|em que mes estamos|em que ano estamos|qual o mes|qual o ano|qual e o mes|qual e o ano|o dia de hoje)$/;

export function detectTool(transcript: string): DetectedTool {
  const normalized = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const core = normalized.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  if (HORA_CORE.test(core)) return 'HORA';
  if (DATA_CORE.test(core)) return 'DATA';
  return 'NENHUMA';
}

export function selectToolByName(name: DetectedTool, tools: readonly ITool[]): ITool | null {
  if (name === 'NENHUMA') return null;
  return tools.find((t) => t.name === name && t.isAvailable()) ?? null;
}
```

### 7.4 `src/backend/voice/sessionManager.ts`

Construtor ganha 6º parâmetro opcional (`tools: readonly ITool[] = []`), mesma forma do `retriever`
da Fase 5a.

Em `runTurn`, **imediatamente após** `session.history.push({ role: 'user', content: transcript })` e
`trimHistory`, e **antes** da chamada a `classify`:

```ts
      // Fase 5b: caminho determinístico. Detectada a ferramenta, o turno não chama o modelo —
      // nem para classificar, nem para gerar. A resposta é montada em Node e sintetizada
      // direto, então não há como o modelo contradizer o fato apurado.
      const detected = this.tools.length > 0 ? detectTool(transcript) : 'NENHUMA';
      const tool = selectToolByName(detected, this.tools);
      if (tool) {
        const text = tool.execute();
        console.log(`[tool] turno=${turn.turnId} ferramenta=${tool.name}`);

        // label fixado por construção (§4.4), com G8 confirmando que todo núcleo dá GERAL
        this.emit(session, {
          type: 'routing', turnId: turn.turnId, label: 'GERAL', handled: true
        });
        this.emit(session, { type: 'state', state: 'falando' });

        const clean = cleanTextForSpeech(text);
        turn.expectedSentences.add(0);
        turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, clean, 0));
        await Promise.allSettled(turn.pendingSynthesis);

        if (session.activeTurn === turn) {
          session.history.push({ role: 'assistant', content: text });
          this.trimHistory(session);
          this.emit(session, { type: 'turn_done', turnId: turn.turnId });
          session.activeTurn = null;
        }
        return;
      }

      /* ... daqui para baixo, o caminho da Fase 5a segue inalterado ... */
```

**Nota sobre o histórico:** a Fase 2 só confirma a fala do assistente depois que o cliente avisa que
terminou de tocar (`POST /api/voice/session/played`). Aqui o texto é empurrado direto no histórico
porque ele é **determinístico e curto** — mas isso é uma divergência do padrão existente e está
sinalizada de propósito para a auditoria julgar (§9, risco 4).

### 7.5 `src/backend/voice/voiceRuntime.ts`

```ts
  const tools = createSystemTools();
  for (const tool of tools) ExtensionRegistry.getInstance().registerTool(tool);

  const sessionManager = new SessionManager(
    engine, ttsProvider, audioStore, agents, retriever, tools
  );
```

As duas coisas — registrar e **passar** — andam juntas. O achado 3 da v1 existia exatamente porque
o plano fazia uma e não a outra.

---

## 8. Critérios de aceite

Automatizados:

- **G1** `detectTool` sobre os **34 casos da §5**, com a saída esperada de cada um. Exaustivo por
  construção: o domínio é fechado.
- **G2** `detectTool` rejeita sobra: para cada núcleo de HORA e DATA, o mesmo núcleo seguido de
  `" na china"` devolve `NENHUMA`. Gerado a partir das listas, não escrito à mão.
- **G3** `execute()` com `Clock` fixo: `HoraAtualTool` devolve exatamente
  `"São 11 horas e 6 minutos."` para `2026-09-21T11:06:00`; `DataAtualTool` devolve exatamente
  `"Hoje é segunda-feira, 21 de setembro de 2026."`. Igualdade de string, não `match`.
- **G4** `selectToolByName`: `NENHUMA` → `null`; nome desconhecido → `null`; `HORA` → instância.
- **G5** Integração com `FakeVoiceEngine`: transcript `"que horas são"` produz `routing` (GERAL,
  handled), `state: falando`, **uma** frase sintetizada com o texto exato, `turn_done`, e
  **`engine.generateCalls.length === 0` e `engine.classifyCalls.length === 0`** — a prova de que o
  modelo não foi chamado.
- **G6** **Caminho real**: transcript não-temporal produz exatamente o comportamento da Fase 5a —
  `classify` chamado, `generate` chamado, `messages[0].content` **byte a byte** igual à referência
  fixa da Fase 5a (com e sem bloco de conhecimento).
- **G7** `extensions.test.ts`: `tools` com `available: true` e descrição listando os nomes;
  `registerTool` idempotente; `resetForTesting()` → `available: false`.
- **G8** Suíte completa sem regressão em B1-B8, C1-C6, Fase 4, Fase 5a.

Manuais, com MLX real:

- **G9** **Todos os núcleos pelo classificador** (§4.4): cada núcleo de HORA e DATA enviado ao
  `classify` real; **todos** devem devolver `GERAL`. Qualquer divergência aciona o recuo declarado.
- **G10** Áudio real, positivos: "Que horas são agora?", "Que dia é hoje?", "Estou com pressa, que
  horas são?" → resposta conferida contra `date`, e **a fala precisa soar natural** (os numerais lidos
  pelo TTS: conferir de ouvido, é o único critério desta fase que não é automatizável).
- **G11** Áudio real, negativos: os 15 casos `NENHUMA` da §5 — nenhum pode ser respondido pelo
  caminho determinístico; todos seguem o comportamento da Fase 5a.
- **G12** Latência do caminho de ferramenta, medida: deve ser **menor** que a de hoje para as mesmas
  perguntas (não há inferência). Medir com `bench:voice` usando tags únicas
  (`geral-antes`, `geral-depois`) — nunca a mesma tag para as duas medições.

---

## 9. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Fraseado real não coberto (falso negativo) | **Média — único risco real** | §4.3: falha para o comportamento de hoje; ampliar núcleos é aditivo e não pode criar falso positivo |
| Falso positivo em frase que casa o núcleo inteiro | Baixa | estrutural (§4.1); G1/G2/G11 |
| `label: 'GERAL'` fixado por construção está errado para algum núcleo | Baixa | G9 mede todos; recuo declarado em §4.4 |
| Empurrar a fala no histórico sem esperar `played` diverge do padrão da Fase 2 | **Média — sinalizado para a auditoria** | §7.4; alternativa é seguir o padrão existente e só confirmar após `played` |
| TTS lê "11 horas e 6 minutos" de forma esquisita | Média | G10 confere de ouvido; texto é nosso e ajustável sem tocar em lógica |

---

## 10. Rastreabilidade

- Planos: v1 (rejeitado), v2 (rejeitado), v3 (esta).
- Auditorias: `docs/audits/phase-5b-v1-codex-2026-09-21.log`,
  `phase-5b-v2-codex-2026-09-21.log`.
- Ferramentas e **modelos** por trás delas (o que importa para a rotação é o modelo, não a CLI):
  - rodadas 1 e 2: `codex-cli 0.146.0`, `gpt-5.6-sol`, `model_reasoning_effort=medium` — suficiente,
    a rodada 1 produziu 24 achados com medição própria de tokenizer.
  - rodada 3: `agy 1.2.7` (**Gemini 3.8 Flash High**) tentado e **falhou por sessão OAuth expirada**;
    substituído pelo Hermes (container Nous, `longcat-2.0:free`), que audita executando.
  - As auditorias da Fase 5a rodaram em `agy 1.2.4`; a CLI foi atualizada desde então.

  **Nota de rastreabilidade:** até aqui os planos registravam só a versão da CLI. A CLI é invólucro —
  quem audita é o modelo, e é ele que define os pontos cegos que a rotação existe para cruzar. Uma
  atualização de CLI pode trocar o modelo sem aviso e transformar "rotação" em ilusão. A partir
  desta fase, registrar **CLI + modelo**.
- Rodada 3: **trocar de auditor** pela regra de rotação. O Codex auditou v1 e v2.
- Implementação: `agy` em modo de escrita, após aprovação. Auditoria do código pelo Hermes, que
  audita executando.
