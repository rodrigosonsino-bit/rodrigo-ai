# Fase 5b — Ferramentas de leitura (`ITool`) — v1

Versão: v1 (não auditada)
Data: 2026-09-21
Base: commit `9aedb9e` (Fase 5a fechada, 62 testes)
Escopo decidido pelo usuário em 2026-09-21: **somente leitura, nenhuma ação que muta estado.**

---

## 1. Objetivo (Passo 0)

> Preencher o ponto de extensão `ITool` com ferramentas **de leitura e sem argumentos**, de modo
> que o assistente responda com **fato apurado** onde hoje responde com invenção confiante.

**Pronto** exige todas:

1. `hora_atual` e `data_atual` implementadas como `ITool`, registradas honestamente no
   `ExtensionRegistry` (módulo `tools` passa a `available: true`).
2. A detecção de ferramenta é **determinística** (`temp=0.0`) e valida contra conjunto fechado;
   formato inesperado degrada para "nenhuma ferramenta", **nunca chuta**.
3. O resultado da ferramenta chega comprovadamente ao motor de geração — teste automatizado sobre o
   `messages`, não inspeção visual.
4. Turnos sem ferramenta produzem prompt **byte a byte idêntico** ao da Fase 5a.
5. Sem regressão em B1-B8 (Fase 2), C1-C6 (Fase 3), critérios da Fase 4 e da Fase 5a — **incluindo
   a matriz de classificação**, que é o que esta fase mais arrisca (§4.2).
6. Latência ainda ≤4s mediana / ≤8s p95, medida par-a-par nos três conjuntos de benchmark.
7. Verificação com áudio real: as duas perguntas da §2 passam a ser respondidas corretamente.

**Não paro em** "a ferramenta existe". Paro quando o áudio real devolve a hora certa e a suíte prova
que nada mais mudou.

### Checagem do anti-padrão (Passo 0)

A skill manda verificar se o plano orquestra mutação local com chamada síncrona a API de terceiros
não-transacional. **Não se aplica**: esta fase não faz chamada de rede, não muta estado e não tem
API externa. Ler o relógio do sistema é uma função pura sobre o ambiente local.

---

## 2. A premissa da fase, medida

Executado em 2026-09-21 contra o servidor real (MLX, `Qwen3-4B-Instruct-2507-4bit`), áudio
sintetizado:

```
hora real do sistema: 10:54 de Monday, 21 de September de 2026

"Que horas são agora?"  -> GERAL -> "Agora são seis e meia."
"Que dia é hoje?"       -> GERAL -> "Hoje é quinta-feira, 21 de abril."
```

Erradas as duas, com confiança total e sem nenhuma marca de incerteza. Isso é o que a fase corrige,
e é o critério de aceite mais direto que este projeto teve até agora: **uma falsidade verificável
vira um fato verificável**. Ambas foram classificadas `GERAL`, o que confirma que o caminho a
instrumentar é o do agente Geral, não o dos especialistas.

---

## 3. Escopo

**Dentro:** `ITool` implementada; duas ferramentas de leitura sem argumento (`hora_atual`,
`data_atual`); detecção de intenção de ferramenta; injeção do resultado no prompt do turno; módulo
`tools` honesto no registry.

**Fora, mesmo que pareça natural:**

- **Qualquer ação que mute estado** (criar lembrete, escrever nota, apagar) — é a Fase 5c, junto com
  o fluxo de confirmação por voz que a Fase 3 removeu por ser prematuro.
- **Ferramentas com argumento** (buscar arquivo, ler agenda de uma data). Extração de argumento em
  texto livre por um modelo de 4B é uma classe de risco diferente de escolher num conjunto fechado —
  e é exatamente o que a 5c precisa de qualquer forma. Manter as duas classes de risco em fases
  separadas é a lição direta da Fase 5a, cujas três primeiras rejeições vieram de escopo grande
  demais.
- Rede, API paga, inferência em nuvem — a restrição do `CLAUDE.md` continua íntegra.
- Fluxo de confirmação por voz.

---

## 4. Decisões de projeto

### 4.1 Detecção dentro do `classify` existente, não numa segunda chamada ao modelo

**Decisão:** estender o comando `classify` do worker para devolver **rótulo e ferramenta numa
resposta só** (`GERAL|HORA`), em vez de acrescentar um segundo comando.

**Por quê:** uma segunda chamada ao LLM por turno paga latência de inferência inteira num orçamento
que já está a 75% do teto (mediana de 3.008ms contra meta de 4.000ms, medido na Fase 5a). O
`classify` já roda em todo turno, já é determinístico (`temp=0.0`) e já valida contra conjunto
fechado; acrescentar um segundo campo custa poucos tokens de saída (`max_tokens` de 8 para 12), não
uma segunda passada.

**Alternativa rejeitada:** comando `detect_tool` separado. Mais limpo em separação de
responsabilidades e mais caro no único recurso escasso desta arquitetura. Fica registrada como o
caminho de recuo se a §4.2 mostrar regressão de classificação.

**Alternativa rejeitada:** detecção determinística em Node por padrão de texto ("que horas",
"que dia"). Zero latência e zero risco de modelo, mas frágil a fraseado — e a Fase 5a inteira é um
monumento ao custo de casamento léxico frágil. Fica como recuo de segunda ordem.

### 4.2 O risco central desta fase é regressão de classificação, não latência

Mudar o prompt do `classify` mexe no componente que as Fases 3 e 4 validaram com uma matriz própria.
Um prompt que passa a pedir duas informações pode degradar a primeira — e a classificação errada tem
efeito real na resposta desde a Fase 4.

**Consequência para o plano:** a matriz de classificação C1-C6 é critério de aceite **bloqueante**,
rodada antes e depois, com os rótulos comparados caso a caso. Se qualquer caso mudar de rótulo, a
fase não passa, mesmo que as ferramentas funcionem.

### 4.3 Formato inesperado degrada, não erra

O `handle_classify` atual trata saída fora do formato como **erro do turno**. Para a parte de
ferramenta isso é severo demais: não reconhecer intenção de ferramenta deve significar "nenhuma
ferramenta", e o turno segue normalmente como na Fase 5a.

**Regra:** o rótulo de orquestração mantém o comportamento atual (formato inválido = erro); o campo
de ferramenta, se ausente ou inválido, vira `NENHUMA` silenciosamente, com uma linha de diagnóstico.

### 4.4 Execução em Node, resultado injetado como bloco

A ferramenta roda no processo Node — é uma função pura sobre `Date`, sem I/O. O resultado entra no
system prompt como um bloco próprio, **entre** o bloco de conhecimento (quando houver) e o
`VOICE_SAFETY_AND_OUTPUT_CONSTRAINTS`, que continua por último pela mesma razão da Fase 5a: ele
contém a cláusula de precedência de instrução.

O bloco declara o dado como **fato apurado do sistema**, não como sugestão:

```
Fato apurado do sistema neste instante: são 10:54 de segunda-feira, 21 de setembro de 2026.
Use este dado como verdadeiro e não o contradiga; ele vem do relógio do computador, não do seu
conhecimento. Responda de forma natural e falada, sem ler o formato acima literalmente.
```

### 4.5 Fuso e formato vêm do sistema, não são reimplementados

`Intl.DateTimeFormat` com `timeZone` do sistema e locale `pt-BR`. Nenhuma formatação manual de data —
é a categoria de código que erra em horário de verão e em virada de mês, e o runtime já resolve.

---

## 5. Arquivos afetados

**Novos:**
- `src/backend/tools/systemTools.ts` — `HoraAtualTool`, `DataAtualTool`, `createSystemTools()`,
  `selectToolByName()`, `buildToolBlock()`.
- `src/backend/tools/index.ts`
- `src/backend/__tests__/tools.test.ts`

**Modificados:**
- `src/shared/extensions/tools.ts` — `ITool` ganha `execute(): string` (hoje só declara
  `name`/`description`/`isAvailable`).
- `src/shared/voiceProtocol.ts` — tipo `ToolName = 'HORA' | 'DATA' | 'NENHUMA'`; `classify` passa a
  devolver `{ label, tool }`.
- `scripts/worker/worker.py` — `CLASSIFICATION_SYSTEM_PROMPT` e `handle_classify`.
- `src/backend/voice/engine.ts` e `mlxWorkerEngine.ts` — assinatura de `classify`.
- `src/backend/voice/fakeEngine.ts` — idem, mais `toolToReturn` para teste.
- `src/backend/voice/sessionManager.ts` — executa a ferramenta e injeta o bloco.
- `src/backend/voice/voiceRuntime.ts` — registra as ferramentas no `ExtensionRegistry`.
- `src/backend/__tests__/extensions.test.ts` — módulo `tools` passa a `available: true`.
- `src/backend/__tests__/voice.test.ts` — assinatura de `classify` nos fakes.

---

## 6. Pseudocódigo completo

### 6.1 `src/shared/extensions/tools.ts`

```ts
/** Ponto de extensão para ferramentas do sistema (Fase 5b — somente leitura). */
export interface ITool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  /**
   * Executa a ferramenta e devolve o fato apurado, já em português legível.
   * Fase 5b: síncrona, sem argumentos, sem I/O e sem efeito colateral — toda ferramenta
   * desta fase é função pura sobre o ambiente local.
   */
  execute(): string;
}
```

### 6.2 `src/shared/voiceProtocol.ts`

```ts
/** Fase 5b — conjunto FECHADO de ferramentas. NENHUMA é o caso normal. */
export const TOOL_NAMES = ['HORA', 'DATA', 'NENHUMA'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ClassificationResult {
  label: OrchestratorLabel;
  tool: ToolName;
}
```

### 6.3 `scripts/worker/worker.py`

O prompt de classificação passa a pedir duas informações num formato fixo. Acréscimo ao
`CLASSIFICATION_SYSTEM_PROMPT` (o texto atual de rótulos é preservado integralmente):

```
Responda SEMPRE em uma única linha, no formato ROTULO|FERRAMENTA, sem espaços e sem pontuação.

FERRAMENTA é HORA quando o usuário pergunta a hora atual; DATA quando pergunta que dia é hoje,
o dia da semana ou a data; e NENHUMA em todos os outros casos, que são a maioria.

Exemplos:
Quanto é dezessete por cento de oitocentos e cinquenta? -> GERAL|NENHUMA
Que horas são agora? -> GERAL|HORA
Que dia é hoje? -> GERAL|DATA
Faça uma análise exegética de Hebreus cinco. -> TEOLOGIA|NENHUMA
Explique a Aceitação dentro da Virtologia. -> VIRTOLOGIA|NENHUMA
Estou com pressa, que horas são? -> GERAL|HORA
```

Em `handle_classify`, `max_tokens` de 8 para 12, e o parsing:

```python
            normalized = raw.strip().upper().strip(".!? \n")
            # Fase 5b: formato ROTULO|FERRAMENTA. O rótulo mantém a regra estrita da Fase 3
            # (formato inválido = erro do turno); a ferramenta degrada para NENHUMA, porque
            # não reconhecer intenção de ferramenta deve custar a ferramenta, não o turno.
            if "|" in normalized:
                label_part, _, tool_part = normalized.partition("|")
            else:
                label_part, tool_part = normalized, "NENHUMA"
            label_part = label_part.strip()
            tool_part = tool_part.strip()

            if label_part not in CLASSIFICATION_LABELS:
                log_diag(f"Saída de classificação fora do formato esperado (turnId={turn_id}).")
                emit({
                    "event": "error", "reqId": req_id, "turnId": turn_id,
                    "message": "Falha ao classificar: formato de saída inesperado.",
                })
                return

            if tool_part not in TOOL_NAMES:
                log_diag(f"Ferramenta fora do conjunto fechado ({tool_part!r}) — degradando para NENHUMA.")
                tool_part = "NENHUMA"

            emit({
                "event": "classification", "reqId": req_id, "turnId": turn_id,
                "label": label_part, "tool": tool_part,
            })
```

com `TOOL_NAMES = {"HORA", "DATA", "NENHUMA"}` junto de `CLASSIFICATION_LABELS`.

### 6.4 `src/backend/tools/systemTools.ts`

```ts
import type { ITool } from '../../shared/extensions/tools.js';
import type { ToolName } from '../../shared/voiceProtocol.js';

/**
 * Formatação delegada ao runtime (Intl), nunca manual: horário de verão, virada de mês e
 * nomes de dia em pt-BR são exatamente onde formatação artesanal erra.
 */
export class HoraAtualTool implements ITool {
  readonly name = 'HORA';
  readonly description = 'Hora atual do relógio do sistema.';
  isAvailable(): boolean {
    return true;
  }
  execute(): string {
    const agora = new Date();
    const hora = new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(agora);
    return `são ${hora}`;
  }
}

export class DataAtualTool implements ITool {
  readonly name = 'DATA';
  readonly description = 'Data atual e dia da semana, do relógio do sistema.';
  isAvailable(): boolean {
    return true;
  }
  execute(): string {
    const agora = new Date();
    const data = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).format(agora);
    return `hoje é ${data}`;
  }
}

/** Sempre as duas juntas, como `createSpecialistAgents()` faz com os agentes. */
export function createSystemTools(): ITool[] {
  return [new HoraAtualTool(), new DataAtualTool()];
}

/** Resolve o nome vindo da classificação. NENHUMA e desconhecido devolvem null. */
export function selectToolByName(tool: ToolName, tools: readonly ITool[]): ITool | null {
  if (tool === 'NENHUMA') return null;
  return tools.find((t) => t.name === tool && t.isAvailable()) ?? null;
}

/** Bloco injetado no system prompt. Vazio quando não há ferramenta. */
export function buildToolBlock(fact: string): string {
  return (
    `Fato apurado do sistema neste instante: ${fact}. ` +
    'Use este dado como verdadeiro e não o contradiga; ele vem do relógio do computador, não do ' +
    'seu conhecimento. Responda de forma natural e falada, sem ler este aviso em voz alta.'
  );
}
```

### 6.5 `src/backend/voice/sessionManager.ts`

Em `runTurn`, o bloco atual (Fase 5a) começa em `const agent = selectAgentForLabel(...)` e termina
na emissão de `routing`. A mudança é **acrescentar** a execução da ferramenta e um terceiro termo na
composição — nada do que existe é removido:

```ts
      // classify agora devolve { label, tool }
      const { label, tool } = classification;

      const agent = selectAgentForLabel(label, this.agents);

      /* ... recuperação de conhecimento da Fase 5a, inalterada ... */

      // Fase 5b: executa a ferramenta ANTES de emitir routing, pela mesma razão das fases
      // anteriores — nada é anunciado antes de estar decidido. Síncrona e pura; o catch
      // degrada para "sem ferramenta", porque perder o fato não deve custar a resposta.
      let toolBlock = '';
      const selectedTool = selectToolByName(tool, this.tools);
      if (selectedTool) {
        try {
          toolBlock = buildToolBlock(selectedTool.execute());
          console.log(`[tool] turno=${turn.turnId} ferramenta=${selectedTool.name}`);
        } catch (err) {
          toolBlock = '';
          console.error('[tool] execução falhou, seguindo sem o fato:', err);
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

**Nota sobre a composição:** o `filter(length > 0)` + `join` substitui as duas ramificações da Fase
5a e é equivalente a elas quando `toolBlock` é vazio — o critério de aceite G4 prova essa
equivalência byte a byte, em vez de afirmá-la.

`SessionManager` ganha `private readonly tools: readonly ITool[]`, recebido no construtor com
default `[]` — mesma forma do `retriever` da Fase 5a, para não quebrar as instanciações existentes.

### 6.6 `src/backend/voice/voiceRuntime.ts`

```ts
  const tools = createSystemTools();
  for (const tool of tools) {
    ExtensionRegistry.getInstance().registerTool(tool);
  }
```

registrado no mesmo ponto onde os agentes já são — ou seja, **somente quando a voz está disponível**,
mantendo a regra de honestidade das fases anteriores. O módulo `tools` do registry passa a reportar
`available: this.tools.length > 0`.

---

## 7. Critérios de aceite

Automatizados:

- **G1** `HoraAtualTool.execute()` devolve string contendo `HH:MM` em 24h; `DataAtualTool.execute()`
  contém dia da semana, dia, mês e ano em pt-BR. Testado com `Date` fixo, não com o relógio real
  (senão o teste é não-determinístico).
- **G2** `selectToolByName`: `'NENHUMA'` → `null`; nome desconhecido → `null`; `'HORA'` → a instância
  certa.
- **G3** Parsing de `ROTULO|FERRAMENTA` no worker: teste Python standalone (padrão do
  `test_repetition_detector.py`) cobrindo `GERAL|HORA`, `GERAL`, sem barra, ferramenta inválida,
  espaços e minúsculas. Rótulo inválido → erro; ferramenta inválida → `NENHUMA`.
- **G4** **Equivalência byte a byte**: turno sem ferramenta e sem conhecimento produz
  `messages[0].content` idêntico ao que a Fase 5a produzia, comparado contra uma string de
  referência fixada no teste — não contra "ausência de substring", que foi o teste fraco que a
  auditoria de código da Fase 5a derrubou.
- **G5** Integração com `FakeVoiceEngine`: `toolToReturn = 'HORA'` faz o corpo do fato aparecer em
  `messages[0].content`; `'NENHUMA'` não acrescenta bloco nenhum.
- **G6** `extensions.test.ts`: módulo `tools` com `available: true` e `phase: 5` quando há
  ferramentas registradas; `available: false` após `resetForTesting()`.
- **G7** Suíte completa passando, sem regressão em B1-B8, C1-C6, Fase 4 e Fase 5a.

Manuais, com MLX real:

- **G8** **Matriz de classificação antes e depois**, caso a caso, com os rótulos comparados. Esta é
  bloqueante (§4.2): qualquer mudança de rótulo reprova a fase.
- **G9** Áudio real:

  | # | Fala | Esperado |
  |---|---|---|
  | 1 | "Que horas são agora?" | hora correta do sistema, conferida contra `date` |
  | 2 | "Que dia é hoje?" | data e dia da semana corretos |
  | 3 | "Estou com pressa, que horas são?" | hora correta — fraseado indireto |
  | 4 | "Quanto é dezessete por cento de oitocentos e cinquenta?" | GERAL, sem ferramenta, prompt idêntico ao da Fase 5a |
  | 5 | "Explique a Aceitação dentro da Virtologia" | VIRTOLOGIA, sem ferramenta, consulta ao corpus preservada |
  | 6 | "Faça uma análise exegética de Hebreus cinco" | TEOLOGIA, sem ferramenta |
  | 7 | "Que horas são na China?" | **não deve** usar a ferramenta como se fosse a resposta — a ferramenta dá a hora local; o modelo precisa responder que é outro fuso, ou a fase tem um defeito de escopo |

- **G10** `npm run bench:voice` nos três conjuntos, antes e depois. Metas ≤4s mediana / ≤8s p95.
  O `geral` é o conjunto mais afetado (é onde as ferramentas disparam) e serve de medida direta do
  custo dos tokens extras no `classify`.

---

## 8. Achados fora de escopo (herdados)

1. **`MAX_CONTEXT_TOKENS` é constante morta** — `src/shared/voiceProtocol.ts` é a única ocorrência
   no repo. Merece plano próprio.
2. **Dívida da Fase 5a:** o trecho consultado não aparece na interface. Não é tocada aqui.

---

## 9. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Prompt de classificação com duas saídas degrada o rótulo | **Média — risco central** | G8 é bloqueante; recuo declarado: comando `detect_tool` separado (§4.1) |
| Tokens extras no `classify` estouram latência | Baixa-Média | G10; o custo é de saída (8→12 tokens), não de uma segunda passada |
| Modelo lê o bloco do fato em voz alta | Média | instrução explícita no bloco + G9 casos 1-3 verificam na escuta |
| Ferramenta responde pergunta que não era a dela (fuso de outro país) | Média | G9 caso 7 existe exatamente para isso |
| `Intl` com locale/fuso do sistema diverge do esperado | Baixa | G1 com `Date` fixo; conferência contra `date` do sistema em G9 |

---

## 10. Rastreabilidade

- Plano: `docs/phase-5b-v1.md` (esta versão).
- Base: commit `9aedb9e`.
- Auditoria: **pendente**. Rodada 1 — auditor a definir entre Codex (cota restabelecida em 19/09) e
  Hermes (que audita executando, e foi quem achou os defeitos que a auditoria de plano não podia
  achar na Fase 5a).
- Implementação: delegada ao `agy` em modo de escrita, **somente depois** de o plano ser aprovado —
  decisão do usuário em 2026-09-21. Auditoria do resultado pelo Hermes.
