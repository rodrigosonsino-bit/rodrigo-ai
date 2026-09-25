# Fase 7 — Memória de contexto entre sessões — v1

## 0. Escopo combinado com o usuário antes de escrever este plano

Decisão de fechamento da Fase 6 (`docs/implementation-phase-6.md`, quando escrito) já registrou a
Fase 7 como "memória de contexto entre sessões". Antes de escrever este plano, quatro perguntas
foram feitas ao usuário via `AskUserQuestion` (2026-09-25) — mesmo protocolo de todas as fases
anteriores:

1. **O que lembrar**: fatos/preferências explícitas — o que o usuário disser de forma clara pra
   guardar ("lembra que eu prefiro café sem açúcar", "guarda que meu nome é Rodrigo"). Decisão:
   **explícito**, não extração automática de fatos da conversa (essa segunda opção citada na
   pergunta original fica fora de escopo do v1 — ver §3).
2. **Escopo por agente**: **compartilhada** entre GERAL/TEOLOGIA/VIRTOLOGIA — uma memória só, não
   uma por especialista.
3. **Como usar na geração**: **injetada sempre** no system prompt de cada turno, mesmo padrão já
   usado pela Fase 5a para conhecimento recuperado (`buildKnowledgeBlock`) — não um passo de busca
   condicional.
4. **Controle do usuário**: **sim**, comando de voz pra apagar — mesmo padrão de `LEMBRETE_APAGAR`/
   `NOTA_APAGAR` já em produção desde a Fase 5c.

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
5c) — e reutiliza a mesma arquitetura de segurança já construída e auditada 4 vezes (v7→v9),
em vez de inventar uma nova: `MemoriaTool` implementa `IMutatingTool`, passa pela mesma
confirmação de voz de três camadas (Camada 0 whitelist exata, Camada 1 LLM, Camada 2 gate de
marcador afirmativo) e só grava depois de `markPlayed()` confirmar que a pergunta de confirmação
foi de fato ouvida. **Nenhuma dessas garantias muda nesta fase.** O que é novo:

1. Dois novos tipos de mutação no worker (`MEMORIA_GUARDAR`, `MEMORIA_ESQUECER`), com o mesmo
   risco de ambiguidade de classificação que toda extensão de vocabulário de intenção já teve
   neste projeto (`CLAUDE.md`: "espere passes de tuning similares contra uma matriz de teste real
   sempre que categorias ou agentes mudarem") — ver §4.4, risco nomeado explicitamente.
2. Um novo bloco de contexto (`buildMemoryBlock`), injetado incondicionalmente (não gated por
   `label`, ao contrário do bloco de conhecimento da Fase 5a que só entra para TEOLOGIA/
   VIRTOLOGIA) em todo turno de qualquer agente.
3. Um teto de sanidade em quantos fatos entram no prompt (§4.3) — sem ele, uma lista que só
   cresce se torna, cedo ou tarde, um prompt que estoura o orçamento de contexto do modelo local.

## 3. Escopo

**Dentro do escopo:**
- Reconhecer um pedido explícito de guardar um fato/preferência sobre o usuário na mesma frase
  ("lembra que eu prefiro X", "guarda que meu Y é Z", "anota que eu Z").
- Persistir o fato em `memorias.json` (mesmo padrão `JsonStore<StoredItem>` de lembretes/notas).
- Injetar os fatos guardados no system prompt de **todo** turno, de qualquer agente, com um teto
  de quantidade (§4.3).
- Apagar o fato mais recente por comando de voz ("esquece o que eu falei", "apaga essa memória")
  — mesma convenção de `LEMBRETE_APAGAR`/`NOTA_APAGAR`: apaga o **mais recente**, não um item
  específico por conteúdo.
- Confirmação de voz obrigatória antes de qualquer gravação ou remoção, reutilizando a
  infraestrutura já existente (Camadas 0/1/2, `markPlayed()`), sem nenhuma mudança nela.

**Fora de escopo, mesmo que pareça natural:**
- Extração automática de fatos da conversa sem pedido explícito (ex.: o sistema decidir sozinho
  que "eu moro em São Paulo", dito de passagem, vira uma memória permanente) — risco de privacidade
  e de "lembrar" coisas que o usuário nunca pediu para guardar; decisão explícita do usuário em §0.
- Apagar uma memória específica por tema/conteúdo ("esquece o que eu falei sobre o carro") — só
  apagar a mais recente, mesmo limite já aceito para `LEMBRETE_APAGAR`/`NOTA_APAGAR` desde a Fase
  5c (`docs/phase-5c-v1.md` já registrava isso como fora de escopo, nunca implementado depois).
- Editar uma memória existente.
- Expiração/TTL de memórias (uma preferência dita hoje nunca "vence" sozinha).
- Memória por agente/especialista — decisão explícita em §0.2, sempre compartilhada.
- Qualquer envio de memória pra fora da máquina — continua tudo local, mesma restrição de sempre.
- Resumo automático de sessão inteira (a segunda opção descartada em §0.1).

## 4. Decisões de projeto

### 4.1 Novos tipos de mutação (`MUTATION_NAMES`)

`src/shared/voiceProtocol.ts` ganha dois novos nomes na lista `MUTATION_NAMES`:
`MEMORIA_GUARDAR`, `MEMORIA_ESQUECER` — mesmo padrão de `LEMBRETE_CRIAR`/`LEMBRETE_APAGAR`.
`selectMutatingToolByAction()` (`mutatingTools.ts`) já deriva o prefixo (`kind.split('_')[0]`) e
casa pelo nome da ferramenta — `MemoriaTool.name = 'MEMORIA'` é suficiente, **nenhuma mudança**
nessa função de resolução genérica.

### 4.2 `MemoriaTool` (`mutatingTools.ts`)

Implementa `IMutatingTool`, mesmo formato de `LembreteTool`/`NotaTool`:

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
    if (kind === 'MEMORIA_ESQUECER') return 'Posso esquecer o que você me disse por último?';
    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }

  execute(kind: MutationName, content: string | null): string {
    if (kind === 'MEMORIA_GUARDAR') {
      if (!content || !content.trim()) throw new Error('Conteúdo ausente para guardar memória.');
      const store = this.store.read();
      const last = store.items[store.items.length - 1];
      if (last && last.text === content) return 'Isso já estava guardado.';
      store.items.push({ id: crypto.randomUUID(), text: content, createdAt: new Date().toISOString() });
      this.store.write(store);
      return 'Guardado.';
    }
    if (kind === 'MEMORIA_ESQUECER') {
      const store = this.store.read();
      if (store.items.length === 0) return 'Não há nada guardado pra esquecer.';
      store.items.pop();
      this.store.write(store);
      return 'Esquecido.';
    }
    throw new Error(`Ação inválida para MemoriaTool: ${kind}`);
  }
}
```

Nenhum campo `dueAt`/`notifiedAt` — memórias não têm "quando", só existem ou não. Registrado em
`createMutatingTools()` (`mutatingTools.ts`) junto com `LembreteTool`/`NotaTool`, mesmo `baseDir`,
novo arquivo `memorias.json`.

### 4.3 Injeção no prompt (`sessionManager.ts`) — sempre, com teto de sanidade

Novo módulo `src/backend/memory/memoryBlock.ts`, mesmo espírito de
`buildKnowledgeBlock` (`src/backend/knowledge/retriever.ts:193-197`):

```ts
export const MAX_MEMORIES_INJECTED = 20; // teto de sanidade — ver risco §7

export function buildMemoryBlock(items: readonly StoredItem[]): string {
  if (items.length === 0) return '';
  // Mais recentes primeiro — se o teto cortar, corta as mais ANTIGAS, não as mais recentes
  // (um fato dito ontem importa mais que um dito há 3 meses, na ausência de qualquer outro sinal).
  const recent = items.slice(-MAX_MEMORIES_INJECTED).reverse();
  const lines = recent.map((it) => `- ${it.text}`).join('\n');
  return `[Fatos que o usuário pediu para você lembrar entre sessões — use-os naturalmente na conversa, nunca liste-os como uma lista para o usuário a menos que ele peça explicitamente]\n${lines}`;
}
```

Em `sessionManager.ts`, ao lado do `knowledgeBlock` já existente (linhas 576-579 hoje), **antes**
da montagem final do `systemPrompt` — ao contrário do `knowledgeBlock`, que só entra para
TEOLOGIA/VIRTOLOGIA, o `memoryBlock` entra **sempre**, para os 4 rótulos (`GERAL`/`TEOLOGIA`/
`VIRTOLOGIA`/`AMBIGUO`), reutilizando a leitura do `JsonStore` de memórias (síncrona, em memória,
mesmo padrão de leitura de `lembretes.json`/`notas.json` já usado por `LembreteTool`):

```ts
const memoryBlock = buildMemoryBlock(this.memoriaStore.read().items);
const knowledgeBlock = buildKnowledgeBlock(retrieved);
const blocks = [agent.getSystemPrompt(), memoryBlock, knowledgeBlock, VOICE_SAFETY_AND_OUTPUT_CONSTRAINTS]
  .filter((b) => b) // remove blocos vazios (ex.: memoryBlock === '' se nada foi guardado ainda)
  .join('\n\n');
const systemPrompt = blocks;
```

`SessionManager` ganha uma dependência nova no construtor (`memoriaStore: JsonStore<StoredItem>`),
injetada por `voiceRuntime.ts` — o mesmo `JsonStore` que `createMutatingTools()` já cria pra
`MemoriaTool`, não uma segunda instância independente (uma única fonte de verdade por arquivo,
mesmo cuidado que a Fase 6 já teve com `lembreteStore` vs. `ReminderScheduler`).

### 4.4 Extensão do worker (`scripts/worker/worker.py`) — risco de ambiguidade nomeado

`MUTATION_NAMES` ganha `MEMORIA_GUARDAR` e `MEMORIA_ESQUECER`. `DETECT_MUTATION_SYSTEM_PROMPT`
precisa de exemplos contrastivos explícitos — **este é o ponto de maior risco real da fase**,
porque o verbo mais natural para "lembra que eu prefiro X" (`MEMORIA_GUARDAR`) é literalmente o
mesmo verbo (`lembra`) já usado para `LEMBRETE_CRIAR` ("lembra de ligar pro dentista"). A distinção
semântica é clara para um humano (tarefa a fazer vs. fato sobre a pessoa), mas o LLM de
classificação nunca viu essa distinção antes — mesmo padrão de risco que motivou o exemplo
contrastivo de "aceitação" (sentimento cotidiano vs. termo técnico de Virtologia) na Fase 3/4
(`CLAUDE.md`, seção Orquestrador). Pseudocódigo da extensão do prompt:

```
MEMORIA_GUARDAR: um FATO ou PREFERÊNCIA sobre o próprio usuário, pra você lembrar quem ele é —
  'lembra que eu prefiro', 'guarda que meu nome é', 'anota que eu gosto de', 'não esquece que eu
  sou'. Diferença de LEMBRETE_CRIAR: aqui não é uma TAREFA a fazer num momento futuro, é uma
  INFORMAÇÃO SOBRE A PESSOA que vale pra sempre (até ela pedir pra esquecer).
MEMORIA_ESQUECER: pede pra esquecer o fato mais recente guardado sobre o usuário — 'esquece o
  que eu te falei', 'apaga essa memória sobre mim', 'não precisa lembrar mais disso'.

Exemplos contrastivos (LEMBRETE_CRIAR vs. MEMORIA_GUARDAR — a distinção mais importante desta
lista, prestar atenção especial):
Lembra de ligar pro dentista amanhã -> LEMBRETE_CRIAR|Ligar pro dentista amanhã
Lembra que eu prefiro respostas curtas -> MEMORIA_GUARDAR|Prefere respostas curtas
Não deixa eu esquecer de pagar a conta -> LEMBRETE_CRIAR|Pagar a conta
Guarda que meu nome é Rodrigo -> MEMORIA_GUARDAR|O nome do usuário é Rodrigo
Anota que eu sou alérgico a amendoim -> MEMORIA_GUARDAR|É alérgico a amendoim
Esquece o que eu te falei sobre mim -> MEMORIA_ESQUECER
```

**Isto muda um arquivo que já tem 4 tipos de mutação testados e um prompt de classificação
calibrado contra casos reais (`DETECT_MUTATION_SYSTEM_PROMPT`, atualmente 12 linhas de exemplos)
— qualquer mudança de prompt de classificação neste projeto historicamente precisou de pelo menos
uma rodada de teste com áudio real antes de ser aceita como funcionando de verdade** (Fase 5c:
H-mutação nunca passou de 76,5%, mesmo depois de 5 versões de plano). Este plano **não promete**
que a extensão funcione de primeira — trata isso como esperado, não como falha, e propõe medir
antes de aceitar (§6, H-memoria-mutação).

### 4.5 Registro em `voiceRuntime.ts`

```ts
const memoriaStore = new JsonStore<StoredItem>(dataDir, 'memorias.json');
// createMutatingTools() já cria memorias.json internamente para o MemoriaTool — reaproveitar a
// MESMA instância aqui, não criar uma segunda (mesmo cuidado do achado 5 da auditoria de código
// da Fase 6, sobre schedulers com stores divergentes).
const sessionManager = new SessionManager(
  engine, ttsProvider, audioStore, agents, retriever, tools, mutatingTools, memoriaStore
);
```

`createMutatingTools()` precisa expor o `memoriaStore` que já cria internamente (mesmo padrão da
Fase 6, onde `createMutatingTools()` passou a devolver `{ tools, scheduler }` em vez de só o
array — aqui devolve `{ tools, memoriaStore }`, ou os dois stores relevantes, a decidir na
implementação de forma consistente com o padrão já estabelecido).

## 5. Arquivos afetados

```
src/shared/voiceProtocol.ts               MUTATION_NAMES ganha MEMORIA_GUARDAR/MEMORIA_ESQUECER
src/backend/tools/mutatingTools.ts        NOVO: MemoriaTool; createMutatingTools() expõe o memoriaStore
src/backend/memory/memoryBlock.ts         NOVO — buildMemoryBlock(), MAX_MEMORIES_INJECTED
src/backend/voice/sessionManager.ts       injeta memoryBlock sempre (não gated por label); construtor ganha memoriaStore
src/backend/voice/voiceRuntime.ts         cria/repassa o memoriaStore compartilhado
scripts/worker/worker.py                  MUTATION_NAMES + DETECT_MUTATION_SYSTEM_PROMPT com exemplos contrastivos
src/backend/__tests__/                    testes novos para os módulos acima
```

## 6. Critérios de aceite (rascunho — numerar H1..Hn na versão auditada)

1. Testes unitários novos passam, suíte completa 100%, build limpo, sem regressão nas Fases 1-6.
2. `MemoriaTool`: criar/apagar segue exatamente o mesmo contrato de `LembreteTool` (dedupe,
   mensagens de erro, `preview()`/`execute()` consistentes).
3. `buildMemoryBlock()`: teste unitário cobrindo 0 memórias (bloco vazio), N < teto (todas
   entram, mais recente primeiro), N > teto (só as mais recentes entram, mais antigas cortadas).
4. Teste de integração: `MEMORIA_GUARDAR` confirmado grava em `memorias.json`; um turno
   **seguinte, de qualquer rótulo** (`GERAL`/`TEOLOGIA`/`VIRTOLOGIA`), recebe o fato no
   `systemPrompt` gerado (mockando o engine e inspecionando as mensagens enviadas).
5. Teste de integração: `MEMORIA_ESQUECER` confirmado remove o item mais recente de
   `memorias.json`, e o turno seguinte não injeta mais esse fato.
6. Regressão: turno sem nenhuma memória guardada gera `systemPrompt` idêntico ao de antes desta
   fase (nenhum bloco vazio poluindo o prompt).
7. **H-memoria-mutação** (mede a extensão do worker, §4.4, contra uma amostra hold-out real —
   mesmo protocolo de congelamento das Fases 5b/5c: commitar a implementação antes de pedir a
   amostra): cobertura mínima a definir na auditoria do plano (sugestão de partida: ≥80%, mesmo
   piso de H-mutação original da Fase 5c, sujeito a revisão do auditor). Caso não passe, mesma
   disciplina de honestidade das fases anteriores — documentar o gap, não escondê-lo, não bloquear
   a fase seguinte sem decisão explícita do usuário.
8. **Verificação manual com áudio real** (não automatizável só com H7 acima): "guarda que meu
   nome é X" numa sessão, reiniciar o processo (não só a sessão — o processo Node inteiro, para
   provar que não é só `session.history` em memória), nova sessão, "qual é o meu nome?" — resposta
   correta usando o fato persistido em disco.

## 7. Riscos

- **Ambiguidade `LEMBRETE_CRIAR` vs. `MEMORIA_GUARDAR`** (§4.4) — risco central da fase, nomeado
  explicitamente, não escondido atrás de "deve funcionar com os exemplos certos".
- **Teto de `MAX_MEMORIES_INJECTED` arbitrário** (20) — mesma categoria dos horários fixos de
  período do dia na Fase 6 (§4.1 de lá): decisão reversível, documentada, não derivada de nenhuma
  medição real de orçamento de contexto do modelo local (`Qwen3-4B-Instruct-2507-4bit`). Se 20
  fatos + o resto do prompt (agente + conhecimento + salvaguardas) se aproximar do limite de
  contexto do modelo, isto precisa ser medido, não assumido.
- **Privacidade dentro da própria máquina**: memórias compartilhadas entre os 3 agentes (decisão
  explícita §0.2) significa que um fato dito casualmente numa conversa de Virtologia aparece
  numa resposta de Teologia depois. Isto é o comportamento pedido, não um bug — mas vale deixar
  claro na resposta de confirmação (`preview()`, "Posso guardar isso sobre você: X?") que não é
  um escopo isolado por assunto.
- **Sem TTL/expiração**: uma preferência dita uma vez nunca expira sozinha — se o usuário mudar de
  ideia sem dizer explicitamente "esquece", o fato antigo continua sendo injetado indefinidamente
  (só `MEMORIA_ESQUECER`, que só remove o mais recente, resolve isso — apagar um fato específico
  do meio da lista está fora de escopo, §3).

## 8. Rastreabilidade

- Decisão de abrir a Fase 7: conversa de fechamento da Fase 6 (2026-09-25).
- Escopo combinado com o usuário: quatro perguntas via `AskUserQuestion`, 2026-09-25 (ver §0).
- Precedente de arquitetura reaproveitado: `docs/phase-5c-v9.md` (confirmação de três camadas),
  `docs/phase-6-v2.md` (padrão de `createMutatingTools()` devolvendo objeto em vez de array puro).
- Precedente do risco de ambiguidade de classificação: `CLAUDE.md`, seção Orquestrador
  ("aceitação" sentimento vs. termo técnico), e `docs/implementation-phase-5c.md` §5 (H-mutação
  nunca passou de 76,5% apesar de 5 versões de plano).
