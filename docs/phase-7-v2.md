# Fase 7 — Memória de contexto entre sessões — v2

Versão: v2
Data: 2026-09-26
Status: Aguardando rodada 2 de auditoria adversarial
Base: Corrige os 11 achados da auditoria adversarial da rodada 1 sobre o v1
(`docs/audits/phase-7-v1-agy-rodada1-2026-09-26.log`, veredito REJEITADO — 2 CRÍTICA, 3 ALTA,
4 MÉDIA, 1 BAIXA).

## 0. Escopo combinado com o usuário antes de escrever este plano

Decisão de fechamento da Fase 6 já registrou a Fase 7 como "memória de contexto entre sessões".
Antes de escrever o v1, quatro perguntas foram feitas ao usuário via `AskUserQuestion`
(2026-09-25) — mesmo protocolo de todas as fases anteriores:

1. **O que lembrar**: fatos/preferências explícitas — o que o usuário disser de forma clara pra
   guardar ("lembra que eu prefiro café sem açúcar", "guarda que meu nome é Rodrigo"). Decisão:
   **explícito**, não extração automática de fatos da conversa.
2. **Escopo por agente**: **compartilhada** entre GERAL/TEOLOGIA/VIRTOLOGIA — uma memória só.
3. **Como usar na geração**: **injetada sempre** no system prompt de cada turno, mesmo padrão já
   usado pela Fase 5a para conhecimento recuperado — não um passo de busca condicional.
4. **Controle do usuário**: **sim**, comando de voz pra apagar — mesma família de
   `LEMBRETE_APAGAR`/`NOTA_APAGAR` já em produção desde a Fase 5c.

Nenhuma dessas quatro decisões muda na v2 — só a implementação técnica delas, corrigida contra
os achados da rodada 1.

## 1. Objetivo

O usuário diz "lembra que eu prefiro respostas curtas" numa sessão; numa sessão **completamente
nova**, dias depois, o Rodrigo já sabe disso sem o usuário repetir — porque o fato foi persistido
em disco e é injetado no prompt de todo turno, de qualquer agente.

**Critério de conclusão, em linguagem do roteiro**: o usuário fala "guarda que meu nome é
Rodrigo", confirma, encerra a sessão (ou o processo é reiniciado), inicia uma sessão nova, pergunta
"qual é o meu nome?", e o Rodrigo responde corretamente usando o fato guardado — sem que o dado
tenha sobrevivido só na `session.history` em memória (que morre com a sessão), mas por ter sido
lido do arquivo em disco no novo turno.

## 2. A premissa da fase

Este é o **segundo** tipo de mutação de estado do projeto (depois de `LEMBRETE`/`NOTA` na Fase
5c) — e reutiliza a mesma arquitetura de segurança já construída e auditada (v7→v9): `MemoriaTool`
implementa `IMutatingTool`, passa pela mesma confirmação de voz de três camadas (Camada 0
whitelist exata, Camada 1 LLM, Camada 2 gate de marcador afirmativo) e só grava depois de
`markPlayed()` confirmar que a pergunta de confirmação foi de fato ouvida. **Nenhuma dessas
garantias muda de comportamento nesta fase** — mas a rodada 1 encontrou um jeito real de a v1
quebrar essa garantia sem querer (achado 2, §4.3.1 abaixo), e isto é corrigido escolhendo palavras
de confirmação que não colidam com o gate, não mudando o gate em si.

## 3. Escopo

**Dentro do escopo:**
- Reconhecer um pedido explícito de guardar um fato/preferência sobre o usuário na mesma frase.
- Persistir o fato em `memorias.json` (mesmo padrão `JsonStore<StoredItem>` de lembretes/notas).
- Injetar os fatos guardados no system prompt de **todo** turno, de qualquer agente, com um teto
  de quantidade **e** de caracteres (§4.3, corrigido — achado 9 da rodada 1).
- Apagar o fato mais recente por comando de voz — mesma convenção de `LEMBRETE_APAGAR`/
  `NOTA_APAGAR`: apaga o **mais recente**, não um item específico por conteúdo.
- Confirmação de voz obrigatória antes de qualquer gravação ou remoção, reutilizando a
  infraestrutura já existente (Camadas 0/1/2, `markPlayed()`) — o gate em si não muda; o que muda
  é a frase de confirmação, pra não colidir com ele (achado 2).

**Fora de escopo, mesmo que pareça natural:** (inalterado da v1)
- Extração automática de fatos da conversa sem pedido explícito.
- Apagar uma memória específica por tema/conteúdo — só a mais recente.
- Editar uma memória existente.
- Expiração/TTL de memórias.
- Memória por agente/especialista.
- Qualquer envio de memória pra fora da máquina.
- Resumo automático de sessão inteira.

## 4. Decisões de projeto

### 4.1 Novos tipos de mutação (`MUTATION_NAMES`)

`src/shared/voiceProtocol.ts` ganha dois novos nomes na lista `MUTATION_NAMES`:
`MEMORIA_GUARDAR`, `MEMORIA_ESQUECER`. `selectMutatingToolByAction()` (`mutatingTools.ts`) já
deriva o prefixo e casa pelo nome da ferramenta — `MemoriaTool.name = 'MEMORIA'` é suficiente,
nenhuma mudança nessa função.

**Filtro permissivo de pré-checagem** (`MUTATION_GATE`, `mutatingTools.ts:175-176`) — **corrigindo
o achado 11 (BAIXA) da rodada 1**: o regex atual (`lembr|anot|guard|escrev|salv|apag|esquec|
cancel|nota|lembrete|aviso|tarefa|compromisso|registr`) não reconhece "memorize" nem "grave".
Adicionar o radical `memor` (sem colisão conhecida) e uma forma verbal restrita de "gravar" —
**achado novo, BAIXA, rodada 2 (agy)**: o radical solto `grav` casa também com "grave"
("problema grave"), "gravidade" e "grávida", palavras comuns em conversas de aconselhamento
(Teologia) que nada têm a ver com mutação — cada match aciona `detect_mutation` no worker
desnecessariamente, custando latência sem risco de mutação incorreta (o worker classificaria como
`NENHUMA`, só o gasto de uma chamada a mais). Restrito às formas verbais de "gravar":

```ts
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr|memor|grava|grave|gravou|gravand|gravar)\w*\b/;
```

### 4.2 `MemoriaTool` (`mutatingTools.ts`) — frase de confirmação corrigida, dedupe corrigido

**Corrigindo o achado 2 (CRÍTICA) da rodada 1**: a frase de confirmação de `MEMORIA_ESQUECER` na
v1 era "Posso esquecer o que você me disse por último?" — mas `esquece`/`esquecer` estão em
`NEGATION_MARKERS` (`sessionManager.ts:105`) e `"esquece isso"` está em `CONFIRM_NO_EXACT`
(`sessionManager.ts:54`). Se o usuário responde "pode esquecer" (a resposta afirmativa mais
natural a essa pergunta), o gate da Camada 2 lê "esquece" como veto de negação e rebaixa o SIM da
Camada 1 para NÃO — o comando nunca conseguiria ser confirmado. **A correção não mexe no gate**
(ele está correto e auditado para o caso que motivou sua existência, a Fase 5c); a correção é
não fazer uma pergunta cuja resposta natural contém a própria palavra de veto — exatamente como
`LEMBRETE_APAGAR`/`NOTA_APAGAR` já fazem hoje, usando "apagar" em vez de "esquecer" na pergunta:

```ts
if (kind === 'MEMORIA_ESQUECER') return 'Posso apagar a memória mais recente?';
```

**Achado novo, BAIXA, rodada 2 (agy)** — a primeira redação desta correção (`"Posso apagar a
memória mais recente **que você me pediu para guardar**?"`) resolvia o problema do achado 2 mas
introduzia um risco secundário: a cauda "que você me pediu para guardar" reintroduz o verbo
antagônico ("guardar") na pergunta de exclusão, e `'pode guardar'` é ele mesmo um marcador
afirmativo (`sessionManager.ts:98`) — um usuário respondendo "pode guardar" com o sentido de
"não apaga, deixa guardado" seria lido como confirmação de exclusão pelo gate. Corrigido pra
simetria estrita com `LEMBRETE_APAGAR`/`NOTA_APAGAR` (`"Posso apagar o lembrete mais recente?"`/
`"Posso apagar a nota mais recente?"`, `mutatingTools.ts:43,136` hoje) — frase curta, um verbo só.

**Corrigindo o achado 8 (MÉDIA) da rodada 1** — reescrita em 3ª pessoa não-natural para fala: a
v1 tinha exemplos como `MEMORIA_GUARDAR|O nome do usuário é Rodrigo`, que soa estranho quando
`preview()` o encaixa numa frase falada ("Posso guardar isso sobre você: O nome do usuário é
Rodrigo?"). O conteúdo extraído deve ser um predicado direto, sem sujeito redundante, adequado
pra encaixar depois de "sobre você": `seu nome é Rodrigo`, `prefere respostas curtas`, `é
alérgico a amendoim` — ver exemplos corrigidos em §4.4.

**Corrigindo o achado 7 (MÉDIA) da rodada 1** — dedupe ingênuo: a v1 comparava só contra o último
item (`store.items[store.items.length - 1]`), correto para `NotaTool` (log temporal, repetição
em dias diferentes é aceitável) mas errado para memórias (lista estática, teto fixo de itens
injetados — um duplicado desperdiça um slot). Corrigido para checar o array inteiro,
case-insensitive:

```ts
export class MemoriaTool implements IMutatingTool {
  readonly name = 'MEMORIA';
  readonly description = 'Guarda e esquece fatos/preferências do usuário entre sessões.';

  constructor(private readonly store: JsonStore<StoredItem>) {}

  isAvailable(): boolean { return true; }

  preview(kind: MutationName, content: string | null): string {
    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) throw new Error('Conteúdo ausente para guardar memória.');
      return `Posso guardar isso sobre você: ${content}?`;
    }
    if (kind === 'MEMORIA_ESQUECER') {
      // Achado 2 (CRÍTICA, rodada 1): "apagar", nunca "esquecer" — a palavra "esquece" está em
      // NEGATION_MARKERS (sessionManager.ts) e vetaria a própria confirmação afirmativa.
      // Achado novo (BAIXA, rodada 2): frase curta, simétrica a LEMBRETE_APAGAR/NOTA_APAGAR —
      // uma cauda como "...que você me pediu para guardar?" reintroduziria "guardar", que é ele
      // mesmo um marcador afirmativo ('pode guardar'), abrindo espaço pra ambiguidade contrária.
      return 'Posso apagar a memória mais recente?';
    }
    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) throw new Error('Conteúdo ausente para guardar memória.');
      const store = this.store.read();
      // Achado 7 (MÉDIA, rodada 1): checa o array inteiro, não só o último item — memória é
      // lista estática de fatos, não um log temporal como NotaTool.
      const normalized = content.trim().toLowerCase();
      const isDuplicate = store.items.some((it) => it.text.trim().toLowerCase() === normalized);
      if (isDuplicate) return 'Isso já estava guardado.';
      store.items.push({ id: crypto.randomUUID(), text: content, createdAt: new Date().toISOString() });
      this.store.write(store);
      return 'Guardado.';
    }
    if (kind === 'MEMORIA_ESQUECER') {
      const store = this.store.read();
      if (store.items.length === 0) return 'Não há nada guardado pra apagar.';
      store.items.pop();
      this.store.write(store);
      return 'Apagado.';
    }
    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }
}
```

Nenhum campo `dueAt`/`notifiedAt` — memórias não têm "quando", só existem ou não.

### 4.3 Injeção no prompt (`sessionManager.ts`) — teto de caracteres, `try/catch`, dependência opcional

**Corrigindo o achado 9 (MÉDIA) da rodada 1** — sem teto de caracteres: a v1 só limitava a
*quantidade* de memórias (20), não o tamanho total do bloco. A rodada 1 estimou 20 memórias de
até 200 caracteres cada (o mesmo `MAX_MUTATION_CONTENT_CHARS` de lembretes/notas) somando ~4.150
caracteres — arriscando aproximar o prompt total do teto de contexto do worker (`MAX_CONTEXT_
TOKENS = 4096`) e adicionar latência de prefill em **todo** turno, pressionando a meta de ≤4s de
TTFT que já opera perto do limite (p95 3,8s medido, `CLAUDE.md`). Corrigido com dois tetos
independentes — quantidade **e** caracteres — e reduzindo o padrão de quantidade:

```ts
export const MAX_MEMORIES_INJECTED = 10;    // reduzido de 20 (rodada 1) — metade do risco de prefill
export const MAX_MEMORY_BLOCK_CHARS = 1200; // NOVO — teto duro independente da quantidade

export function buildMemoryBlock(items: readonly StoredItem[]): string {
  if (items.length === 0) return '';
  const recent = items.slice(-MAX_MEMORIES_INJECTED).reverse();
  const lines: string[] = [];
  let totalChars = 0;
  for (const it of recent) {
    const line = `- ${it.text}`;
    if (totalChars + line.length > MAX_MEMORY_BLOCK_CHARS) break; // corta as mais antigas primeiro
    lines.push(line);
    totalChars += line.length + 1;
  }
  if (lines.length === 0) return '';
  return `[Fatos que o usuário pediu para você lembrar entre sessões — use-os naturalmente na conversa, nunca liste-os como uma lista para o usuário a menos que ele peça explicitamente]\n${lines.join('\n')}`;
}
```

**Corrigindo o achado 5 (ALTA) da rodada 1** — ausência de `try/catch` violando a filosofia de
resiliência já estabelecida pela Fase 5a ("perder a consulta não deve custar a resposta",
`sessionManager.ts:560-568`): a leitura de `memoriaStore.read()` pode lançar (JSON corrompido,
erro de I/O — `jsonStore.ts:44`). Sem proteção, isso derrubaria **todo** turno de fala, de
qualquer agente. Corrigido com o mesmo padrão exato já usado pela Fase 5a para o retriever:

```ts
let memoryItems: readonly StoredItem[] = [];
if (this.memoriaStore) {
  try {
    memoryItems = this.memoriaStore.read().items;
  } catch (err) {
    memoryItems = [];
    console.error('[memory] leitura de memórias falhou, seguindo sem elas:', err);
  }
}
const memoryBlock = buildMemoryBlock(memoryItems);
const knowledgeBlock = buildKnowledgeBlock(retrieved);
const blocks = [agent.getSystemPrompt(), memoryBlock, knowledgeBlock, VOICE_SAFETY_AND_OUTPUT_CONSTRAINTS]
  .filter((b) => b)
  .join('\n\n');
const systemPrompt = blocks;
```

Ao contrário do `knowledgeBlock` (gated por `label === 'TEOLOGIA' || 'VIRTOLOGIA'`), o
`memoryBlock` entra **sempre**, para os 4 rótulos — decisão do usuário em §0.3, inalterada.

**Corrigindo o achado 4 (ALTA) da rodada 1** — quebra de retrocompatibilidade e blast radius nos
testes: a v1 propunha `memoriaStore: JsonStore<StoredItem>` como parâmetro **obrigatório** do
construtor de `SessionManager`, o que quebraria a compilação de `voice.test.ts` (17 suítes
passam por `setupHarness()`, que chama `new SessionManager(...)` sem esse argumento —
`voice.test.ts:86-94`) e lançaria `TypeError` em runtime se fosse opcional sem tratamento. Corrigido
tornando o parâmetro opcional com default `null`, seguindo exatamente o mesmo padrão que
`retriever: KnowledgeRetriever | null = null` já usa no mesmo construtor:

```ts
constructor(
  engine: VoiceEngine,
  ttsProvider: IVoiceProvider,
  audioStore: AudioStore,
  agents: readonly IAgent[],
  retriever: KnowledgeRetriever | null = null,
  tools: readonly ITool[] = [],
  mutatingTools: readonly IMutatingTool[] = [],
  memoriaStore: JsonStore<StoredItem> | null = null   // NOVO — opcional, mesmo padrão do retriever
) {
  // ...atribuições existentes...
  this.memoriaStore = memoriaStore;
}
```

Com isso, **nenhum call site de teste existente precisa mudar** — `voice.test.ts:86-94` continua
compilando e passando sem memória (bloco vazio, `this.memoriaStore` é `null`, cai no `if
(this.memoriaStore)` acima). Só o call site de produção em `voiceRuntime.ts` (§4.5) passa o
argumento de verdade.

### 4.4 Extensão do worker (`scripts/worker/worker.py`) — conteúdo extraído, colisões adicionais

**Corrigindo o achado 1 (CRÍTICA) da rodada 1** — o mais grave: `parse_mutation_output()`
(`worker.py:164-170`) só extrai `content` para `action in ("LEMBRETE_CRIAR", "NOTA_CRIAR")`;
qualquer outra ação (incluindo o novo `MEMORIA_GUARDAR`) retorna `(action, None)`. Sem esta
correção, `MemoriaTool.preview()` lançaria `Error('Conteúdo ausente para guardar memória.')` em
**toda** tentativa de guardar memória — a funcionalidade nasceria completamente quebrada.
Correção obrigatória, não opcional:

```python
MUTATION_NAMES = {
    "LEMBRETE_CRIAR", "LEMBRETE_APAGAR", "NOTA_CRIAR", "NOTA_APAGAR",
    "MEMORIA_GUARDAR", "MEMORIA_ESQUECER",  # NOVO
    "NENHUMA"
}

def parse_mutation_output(raw, truncated):
    ...
    if action not in MUTATION_NAMES:
        return ("NENHUMA", None)
    if action in ("LEMBRETE_CRIAR", "NOTA_CRIAR", "MEMORIA_GUARDAR"):  # MEMORIA_GUARDAR adicionado aqui
        if not content or len(content) > MAX_MUTATION_CONTENT_CHARS:
            return ("NENHUMA", None)
        return (action, content)
    return (action, None)
```

`scripts/worker/test_mutation_parser.py` (testes unitários puros do parser, citados pela
auditoria) precisa de casos novos cobrindo `MEMORIA_GUARDAR` com e sem conteúdo, e
`MEMORIA_ESQUECER` sem conteúdo.

**Corrigindo o achado 6 (MÉDIA) da rodada 1** — colisões de verbo não cobertas: a v1 só deu
exemplo contrastivo para `LEMBRETE_CRIAR` vs. `MEMORIA_GUARDAR`. A rodada 1 identificou duas
outras colisões reais: `NOTA_CRIAR` também usa "anota"/"salva"/"registra" (mesmos verbos que
`MEMORIA_GUARDAR` usaria para fatos pessoais), e `LEMBRETE_APAGAR` já usa "esquece o que eu pedi
pra lembrar" (colidindo com `MEMORIA_ESQUECER`). `DETECT_MUTATION_SYSTEM_PROMPT` corrigido,
cobrindo as três frentes de colisão.

**Achado novo, ALTA, rodada 2 (agy)** — a v2 original corrigiu o corpo do prompt (as descrições
de cada ação e os exemplos) mas deixou o **cabeçalho** da instrução intocado
(`worker.py:109-112`, hoje): *"Você decide se a frase do usuário pede para CRIAR ou APAGAR um
LEMBRETE ou uma NOTA, ou NENHUMA das **quatro**"* e *"AÇÃO|conteúdo para **\*\_CRIAR**"*.
`MEMORIA_GUARDAR` não termina em `_CRIAR` — se o modelo seguir o cabeçalho ao pé da letra em vez
dos exemplos, ele pode responder só `MEMORIA_GUARDAR` sem o `|conteúdo`, reintroduzindo por outra
via o mesmo efeito do achado 1 (CRÍTICA) da rodada 1 que este plano já corrigiu. O cabeçalho
precisa ser reescrito explicitamente, não só o corpo:

```python
DETECT_MUTATION_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede para CRIAR ou APAGAR um LEMBRETE, uma NOTA ou uma "
    "MEMÓRIA, ou NENHUMA das seis. Responda em UMA LINHA: AÇÃO, ou AÇÃO|conteúdo para *_CRIAR e "
    "MEMORIA_GUARDAR (o texto do que deve ser lembrado/anotado/guardado, sem aspas, sem "
    "explicação extra).\n"
    ...
```

```
MEMORIA_GUARDAR: um FATO ou PREFERÊNCIA sobre o próprio usuário, pra você lembrar quem ele é —
  'lembra que eu prefiro', 'guarda que meu nome é', 'anota que eu gosto de'. Diferença de
  LEMBRETE_CRIAR: aqui não é uma TAREFA a fazer num momento futuro, é uma INFORMAÇÃO SOBRE A
  PESSOA que vale pra sempre. Diferença de NOTA_CRIAR: nota é uma ideia ou observação qualquer
  (sobre qualquer assunto); memória é especificamente um fato sobre QUEM O USUÁRIO É — nome,
  preferência, restrição, característica pessoal.
MEMORIA_ESQUECER: pede pra apagar o fato mais recente guardado sobre o usuário — 'apaga essa
  memória sobre mim', 'apaga o que você guardou sobre mim'. Diferença de LEMBRETE_APAGAR: aquele
  apaga uma TAREFA pendente; este apaga um FATO sobre a pessoa.

Exemplos contrastivos (as três colisões mais importantes desta lista):
Lembra de ligar pro dentista amanhã -> LEMBRETE_CRIAR|Ligar pro dentista amanhã
Lembra que eu prefiro respostas curtas -> MEMORIA_GUARDAR|prefere respostas curtas
Guarda que meu nome é Rodrigo -> MEMORIA_GUARDAR|seu nome é Rodrigo
Anota que eu sou alérgico a amendoim -> MEMORIA_GUARDAR|é alérgico a amendoim
Anota que a reunião de terça foi produtiva -> NOTA_CRIAR|A reunião de terça foi produtiva
Salva essa ideia: usar madeira de demolição -> NOTA_CRIAR|Usar madeira de demolição
Apaga o lembrete que eu acabei de pedir -> LEMBRETE_APAGAR
Apaga essa memória sobre mim -> MEMORIA_ESQUECER
Apaga o que você guardou sobre mim -> MEMORIA_ESQUECER
```

Note que os exemplos de `MEMORIA_GUARDAR` agora extraem o predicado em minúsculas, sem sujeito
redundante (`prefere respostas curtas`, não `O usuário prefere respostas curtas`) — corrige o
achado 8 (§4.2 acima) na origem, no próprio prompt que gera o conteúdo.

**Nota de honestidade mantida da v1**: mudar um prompt de classificação já calibrado (`DETECT_
MUTATION_SYSTEM_PROMPT`) historicamente precisou de teste com áudio real neste projeto antes de
ser aceito como funcionando de verdade (Fase 5c: H-mutação nunca passou de 76,5% apesar de 5
versões de plano). Este plano **não promete** que a extensão funcione de primeira — ver H7 em §6.

### 4.5 Registro em `voiceRuntime.ts` e `createMutatingTools()` — assinatura fechada, sem contradição

**Corrigindo o achado 3 (ALTA) da rodada 1** — decisão de interface deixada em aberto: a v1 dizia
"a decidir na implementação", violando a regra desta skill de auditoria ("decisões já tomadas,
não perguntas em aberto pro auditor"). Pior, a redação sugeria substituir `scheduler` por
`memoriaStore` no retorno de `createMutatingTools()`, o que quebraria `reminderScheduler.
bootstrap()`/`shutdown()` em `voiceRuntime.ts` (Fase 6) e os testes de `mutatingTools.test.ts`
que dependem de `result.scheduler`. **Assinatura fechada agora, aditiva, nunca substitutiva**:

```ts
export interface MutatingToolsResult {
  tools: IMutatingTool[];
  scheduler: ReminderScheduler;      // já existe desde a Fase 6 — preservado, não removido
  memoriaStore: JsonStore<StoredItem>; // NOVO
}

export function createMutatingTools(
  baseDir: string,
  customScheduler?: ReminderScheduler
): MutatingToolsResult {
  const lembreteStore = new JsonStore<StoredItem>(baseDir, 'lembretes.json');
  const notaStore = new JsonStore<StoredItem>(baseDir, 'notas.json');
  const memoriaStore = new JsonStore<StoredItem>(baseDir, 'memorias.json'); // NOVO

  const scheduler = customScheduler ?? new ReminderScheduler(lembreteStore);
  const lembreteTool = new LembreteTool(lembreteStore, scheduler);
  const notaTool = new NotaTool(notaStore);
  const memoriaTool = new MemoriaTool(memoriaStore); // NOVO

  return {
    tools: [lembreteTool, notaTool, memoriaTool], // 3 ferramentas agora, era 2 — ver §5
    scheduler,
    memoriaStore
  };
}
```

**Corrigindo o achado 4 (contradição interna, MÉDIA) da rodada 1**: a v1 criava uma segunda
instância de `JsonStore` para memórias em `voiceRuntime.ts` (`new JsonStore(dataDir,
'memorias.json')`) na mesma seção em que dizia "reaproveitar a MESMA instância" — duas fontes de
verdade para o mesmo arquivo, exatamente o problema que o achado 5 da auditoria de código da
Fase 6 (`customScheduler` com store divergente) já tinha nomeado como risco. Corrigido —
`voiceRuntime.ts` só desestrutura, nunca instancia de novo:

```ts
const { tools: mutatingTools, scheduler: reminderScheduler, memoriaStore } = createMutatingTools(dataDir);
for (const mTool of mutatingTools) ExtensionRegistry.getInstance().registerMutatingTool(mTool);
reminderScheduler.bootstrap();

const audioStore = new AudioStore(path.join(rootDir, '.runtime', 'tmp'));
const sessionManager = new SessionManager(
  engine, ttsProvider, audioStore, agents, retriever, tools, mutatingTools, memoriaStore
);
```

## 5. Arquivos afetados

```
src/shared/voiceProtocol.ts               MUTATION_NAMES ganha MEMORIA_GUARDAR/MEMORIA_ESQUECER
src/backend/tools/mutatingTools.ts        NOVO: MemoriaTool; MUTATION_GATE ganha memor/grav;
                                           createMutatingTools() devolve { tools, scheduler, memoriaStore }
src/backend/memory/memoryBlock.ts         NOVO — buildMemoryBlock(), MAX_MEMORIES_INJECTED,
                                           MAX_MEMORY_BLOCK_CHARS
src/backend/voice/sessionManager.ts       construtor ganha memoriaStore (opcional, default null);
                                           injeta memoryBlock sempre, com try/catch
src/backend/voice/voiceRuntime.ts         desestrutura memoriaStore de createMutatingTools(),
                                           repassa pro SessionManager
scripts/worker/worker.py                  MUTATION_NAMES, parse_mutation_output() (extração de
                                           conteúdo pra MEMORIA_GUARDAR), DETECT_MUTATION_SYSTEM_PROMPT
scripts/worker/test_mutation_parser.py    casos novos para MEMORIA_GUARDAR/MEMORIA_ESQUECER
src/backend/__tests__/mutatingTools.test.ts  ATUALIZAR: linha ~518, result.tools.length passa de
                                           2 para 3; testes novos para MemoriaTool
src/backend/__tests__/voice.test.ts       testes de integração novos (memória injetada no prompt);
                                           NENHUM call site existente precisa mudar (§4.3, achado 4)
```

## 6. Critérios de aceite (H1..H9)

- **H1** — `MemoriaTool.execute()`: dedupe correto contra o array inteiro (não só o último item);
  `preview()`/`execute()` seguem o mesmo contrato de erro de `LembreteTool`.
- **H2** — `buildMemoryBlock()`: cobre 0 memórias (bloco vazio), N dentro dos dois tetos (todas
  entram, mais recente primeiro), N além do teto de quantidade, e um caso onde o teto de
  **caracteres** corta antes do teto de quantidade (itens longos).
- **H3** — Teste de integração: `MEMORIA_GUARDAR` confirmado grava em `memorias.json`; um turno
  seguinte, de **qualquer** rótulo (`GERAL`/`TEOLOGIA`/`VIRTOLOGIA`/`AMBIGUO`), recebe o fato no
  `systemPrompt` gerado.
- **H4** — Teste de integração: `MEMORIA_ESQUECER` confirmado remove o item mais recente; a
  frase de confirmação usada ("posso apagar...") é testada contra o gate real de confirmação
  (`hasAffirmativeMarker`) com a resposta real esperada do usuário ("sim", "pode apagar") para
  provar que o achado 2 da rodada 1 não se repete — teste de regressão direto, não só revisão de
  código.
- **H5** — `memoriaStore.read()` lançando exceção (JSON corrompido simulado): turno continua sem
  o bloco de memória, `console.error` chamado, nenhum evento de erro emitido pro cliente.
- **H6** — Regressão: `SessionManager` construído sem `memoriaStore` (como todos os call sites de
  teste existentes já fazem) continua funcionando idêntico ao comportamento pré-Fase-7.
- **H7** — **H-memoria-mutação** (mede a extensão do worker, §4.4, contra uma amostra hold-out
  real gerada por uma IA independente — mesmo protocolo de congelamento das Fases 5b/5c: commitar
  a implementação antes de pedir a amostra): meta de partida ≥80%, sujeita a revisão do auditor;
  amostra deve conter casos específicos das três colisões nomeadas em §4.4 (LEMBRETE_CRIAR,
  NOTA_CRIAR, LEMBRETE_APAGAR vs. os dois novos tipos). Não passar não bloqueia a fase — mesma
  disciplina de honestidade de todas as anteriores.
- **H8** — Verificação manual com áudio real: "guarda que meu nome é X" numa sessão, confirmar
  com "sim" (não "esquece" nem qualquer palavra de `NEGATION_MARKERS`), reiniciar o **processo**
  Node inteiro (não só a sessão), nova sessão, "qual é o meu nome?" — resposta correta.
- **H9** — Verificação manual: "apaga a memória mais recente", confirmar com "sim" ou "pode
  apagar" — a confirmação precisa funcionar de primeira, prova viva de que o achado 2 foi
  corrigido fora do ambiente de teste também.

## 7. Riscos

- **Ambiguidade `LEMBRETE_CRIAR`/`NOTA_CRIAR`/`LEMBRETE_APAGAR` vs. `MEMORIA_GUARDAR`/
  `MEMORIA_ESQUECER`** (§4.4) — risco central da fase, agora com as três frentes de colisão
  nomeadas (a v1 só nomeava uma). H7 mede antes de aceitar.
- **Tetos de `MAX_MEMORIES_INJECTED`/`MAX_MEMORY_BLOCK_CHARS` ainda arbitrários** — reduzidos e
  com teto duplo (corrigindo o achado 9), mas continuam sem medição real de orçamento de contexto
  do modelo local. Se o TTFT medido em H8/H9 se aproximar visivelmente do p95 de 3,8s já
  documentado, isto precisa de revisão, não de suposição.
- **Privacidade dentro da própria máquina**: memórias compartilhadas entre os 3 agentes (decisão
  explícita §0.2) — comportamento pedido, não bug, mas a resposta de confirmação deixa isso
  implícito ("sobre você", não "só pra este assunto").
- **Sem TTL/expiração**: inalterado da v1, aceito por decisão de escopo.

## 8. Rastreabilidade

- Decisão de abrir a Fase 7: conversa de fechamento da Fase 6 (2026-09-25).
- Escopo combinado com o usuário: quatro perguntas via `AskUserQuestion`, 2026-09-25 (§0).
- Auditoria adversarial v1: `docs/audits/phase-7-v1-agy-rodada1-2026-09-26.log` (11 achados,
  REJEITADO).
- Precedente de arquitetura reaproveitado: `docs/phase-5c-v9.md` (confirmação de três camadas),
  `docs/phase-6-v2.md` (padrão de `createMutatingTools()` devolvendo objeto aditivo, nunca
  substitutivo — lição já aprendida ali e reafirmada aqui pelo achado 3).

## 9. Achados da rodada 1 (agy) e como foram resolvidos

| # | Achado | Gravidade | Resolução no v2 | Seção |
|---|---|---|---|---|
| 1 | `parse_mutation_output()` descarta o conteúdo de `MEMORIA_GUARDAR` | CRÍTICA | `MEMORIA_GUARDAR` adicionado ao ramo que extrai `content` | §4.4 |
| 2 | Confirmação de `MEMORIA_ESQUECER` vetada pelo próprio gate (`esquece` em `NEGATION_MARKERS`) | CRÍTICA | Frase de confirmação trocada para "apagar", nunca "esquecer" — gate intocado | §4.2 |
| 3 | Assinatura de `createMutatingTools()` "a decidir na implementação", risco de derrubar `ReminderScheduler` | ALTA | Assinatura fechada, aditiva (`{ tools, scheduler, memoriaStore }`), nunca substitutiva | §4.5 |
| 4 | Contradição interna: cria segunda instância de `JsonStore` de memórias em vez de reaproveitar | MÉDIA | `voiceRuntime.ts` só desestrutura de `createMutatingTools()`, nunca instancia de novo | §4.5 |
| 5 | `SessionManager` com `memoriaStore` obrigatório quebra 17 suítes de teste existentes | ALTA | Parâmetro opcional, default `null`, mesmo padrão do `retriever` — nenhum call site muda | §4.3 |
| 6 | Sem `try/catch` na leitura de memória — quebraria todo turno em caso de erro de disco | ALTA | Mesmo padrão de resiliência da Fase 5a (`try/catch`, `console.error`, segue sem o bloco) | §4.3 |
| 7 | Colisão de verbo não coberta com `NOTA_CRIAR` e `LEMBRETE_APAGAR` | MÉDIA | Exemplos contrastivos cobrindo as três frentes de colisão, não só uma | §4.4 |
| 8 | Extração em 3ª pessoa não-natural para fala | MÉDIA | Exemplos corrigidos pra predicado direto, sem sujeito redundante | §4.2, §4.4 |
| 9 | Dedupe só contra o último item, memória duplicaria com repetição meses depois | MÉDIA | Dedupe contra o array inteiro, case-insensitive | §4.2 |
| 10 | Sem teto de caracteres, risco de latência/TTFT não quantificado | MÉDIA | Teto duplo (quantidade + caracteres), quantidade padrão reduzida de 20 para 10 | §4.3 |
| 11 | `MUTATION_GATE` não reconhece "memorize"/"grave" | BAIXA | Radicais `memor`/`grav` adicionados ao regex permissivo | §4.1 |

## 10. Auditoria da v2 (agy, rodada 2) — APROVADO COM RESSALVAS, 3 achados aplicados

Rodada 2 verificou os 11 achados da rodada 1 **contra o código real**, não contra a alegação da
tabela acima — todos os 11 confirmados como genuinamente resolvidos, item por item, com evidência
de arquivo:linha (`docs/audits/phase-7-v2-agy-rodada2-2026-09-26.log`). Achou 3 problemas novos,
introduzidos pela própria correção da v2 (o tipo de coisa que uma segunda rodada existe pra
pegar), todos aplicados diretamente neste documento:

| Achado (rodada 2) | Gravidade | Resolução |
|---|---|---|
| Cabeçalho de `DETECT_MUTATION_SYSTEM_PROMPT` ("...das quatro", "AÇÃO\|conteúdo para `*_CRIAR`") nunca foi reescrito — só o corpo/exemplos. `MEMORIA_GUARDAR` não termina em `_CRIAR`; se o modelo seguir o cabeçalho ao pé da letra, reintroduz o mesmo efeito do achado 1 (CRÍTICA) da rodada 1 por outra via. | ALTA | Cabeçalho reescrito explicitamente em §4.4: "...das seis", "AÇÃO\|conteúdo para `*_CRIAR` e `MEMORIA_GUARDAR`" |
| A frase de confirmação corrigida do achado 2 tinha uma cauda ("...que você me pediu para guardar?") que reintroduzia "guardar" — que é ele mesmo um marcador afirmativo (`'pode guardar'`), abrindo uma ambiguidade nova na direção oposta. | BAIXA | Frase encurtada para simetria estrita com `LEMBRETE_APAGAR`/`NOTA_APAGAR`: "Posso apagar a memória mais recente?" |
| Radical solto `grav` no `MUTATION_GATE` casa com "grave" (problema grave), "gravidade", "grávida" — custo de latência desnecessário em conversas de aconselhamento, sem risco de mutação incorreta. | BAIXA | Restrito a formas verbais de "gravar" (`grava\|grave\|gravou\|gravand\|gravar`) — a ambiguidade entre "grave" adjetivo e "grave" imperativo de "gravar" é irredutível por regex, aceita como custo residual baixo |

Log completo: `docs/audits/phase-7-v2-agy-rodada2-2026-09-26.log`. Plano pronto para implementação.
