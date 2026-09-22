# Fase 5c — Ações que mutam estado (lembretes e notas) — v1

Versão: v1
Data: 2026-09-22
Base: commit `73db364`
Antecessora: Fase 5b (`docs/implementation-phase-5b.md`) — implementada, H11 pendente, não bloqueante
para esta fase por decisão explícita do usuário.

---

## 0. Escopo combinado com o usuário antes de escrever este plano

Três perguntas fechadas, respondidas antes de qualquer linha de desenho:

1. **O quê:** lembretes e notas, as duas na mesma fase, reusando a mesma infraestrutura de
   mutação/confirmação.
2. **Onde persiste:** arquivo local (JSON) — não integração com Lembretes.app/Notas.app do macOS.
3. **Confirmação por voz:** obrigatória para **toda** ação que muta estado, sem exceção — não só
   para apagar.

---

## 1. Objetivo (Passo 0)

Até aqui, o Rodrigo AI só lê: responde, consulta conhecimento (Fase 5a), lê o relógio (Fase 5b).
Esta é a primeira fase em que ele **escreve** — cria e apaga lembretes e notas por voz, com
confirmação falada antes de qualquer mutação. É uma classe de risco nova, não uma extensão da 5b: a
5b decidia entre um conjunto fechado de três valores (HORA/DATA/NENHUMA); aqui o modelo precisa
**extrair texto livre** (o conteúdo do lembrete/nota) da fala do usuário, e uma extração errada tem
consequência real — grava algo que o usuário não disse, ou apaga a coisa errada.

### Checagem do anti-padrão (Passo 0 da skill de auditoria)

Isto é "escrever em disco local, sem API externa, sem transação distribuída, com confirmação humana
antes de cada escrita" — não é 2PC disfarçado nem consistência eventual sobre múltiplos sistemas.
Uma escrita, um arquivo, uma confirmação. Não se aplica.

---

## 2. A premissa da fase

Hoje, se o usuário disser "lembra de comprar leite amanhã", o Rodrigo responde alguma coisa em
prosa e **esquece no instante seguinte** — não existe nenhum mecanismo de persistência além do
histórico de conversa em memória, que é descartado ao fim da sessão (`SessionManager`, Fase 2).
Não há premissa a medir contra comportamento real de produção porque a capacidade não existe — a
"premissa medida" das fases anteriores (hora errada, corpus não consultado) não tem equivalente
aqui. O gate real desta fase é diferente: **nenhuma mutação pode acontecer sem confirmação falada
explícita**, e isso é testável desde o primeiro commit.

---

## 3. Escopo

**Dentro:**
- `LembreteTool` e `NotaTool`, cada uma com duas ações: `CRIAR` (extrai texto livre do que o
  usuário disse) e `APAGAR` (**só o item mais recente** — ver decisão abaixo).
- Fluxo de confirmação por voz de dois turnos: pedido → pergunta de confirmação falada → resposta
  do usuário (sim/não) → executa ou cancela.
- Persistência em arquivo JSON local, fora de `.runtime/` (que é regenerado por
  `npm run setup:voice` — não é lugar para dado do usuário).
- Detecção por LLM (`temp=0.0`), mesmo padrão de três camadas da 5b: filtro permissivo → modelo
  decide ação + extrai conteúdo → código executa, nunca o modelo.

**Fora, mesmo que pareça natural — narrowing deliberado, mesma lição da 5a (3 rejeições por escopo
grande) e da 5b (misturar duas classes de risco na mesma versão):**

- **Apagar por conteúdo/busca** ("apaga o lembrete de comprar leite"). Exige ou (a) o modelo escolher
  entre uma lista dinâmica de itens existentes — prompt de tamanho variável, uma classe de risco
  nova — ou (b) busca fuzzy em Node — heurística sem o rigor que esta fase quer estabelecer primeiro
  com o caso mais simples. **v1 só apaga o item mais recente de cada tipo**, sem ambiguidade de
  seleção nenhuma. Apagar por conteúdo é a extensão natural de uma v2, não desta.
- **Listar/ler lembretes e notas de volta em voz alta.** Parece óbvio que devia estar aqui, mas é
  uma superfície própria (quantos ler, em que ordem, o que fazer se a lista for longa) e não é
  necessário para provar que criar+apagar com confirmação funciona. Fica para a mesma extensão que
  vai tratar "apagar por conteúdo" — nesse ponto, buscar/listar são a mesma capacidade.
- Editar um lembrete/nota existente.
- Lembrete com horário/data de disparo (isso é um agendador — Fase 6+ território, "memória entre
  sessões" e possivelmente notificação, que não existe no projeto).
- Integração com Lembretes.app/Notas.app do macOS (decisão do usuário, §0).
- Rede, API paga, inferência em nuvem.

---

## 4. Decisões de projeto

### 4.1 Terceira ferramenta de detecção: `detect_mutation`, mesmo padrão de `detect_tool`

Novo comando no worker (`temp=0.0`, `max_tokens` maior que os 6 de `detect_tool` porque precisa
devolver texto livre, não uma palavra), com saída em formato `AÇÃO|conteúdo`:

```
MUTATION_NAMES = {"LEMBRETE_CRIAR", "LEMBRETE_APAGAR", "NOTA_CRIAR", "NOTA_APAGAR", "NENHUMA"}
```

`LEMBRETE_APAGAR`/`NOTA_APAGAR`/`NENHUMA` não carregam conteúdo (v1 não precisa — apaga o mais
recente). Só `*_CRIAR` tem um `|conteúdo` depois. Parsing é função pura (mesmo padrão de
`parse_tool_output`, testada isoladamente): formato inesperado degrada para `NENHUMA` — não
reconhecer intenção de mutação nunca deve custar o turno, princípio herdado da 5b.

**Por que uma extração e não duas chamadas ao modelo:** separar "que ação é essa" de "qual o
conteúdo" em duas chamadas dobraria a latência da 5b, o problema que a própria 5b evitou ao rejeitar
o recuo em runtime (v5 §4.6). Uma chamada, formato estruturado, parser tolerante.

### 4.2 O filtro permissivo não pode ser regex — precisa ser mais amplo que o da 5b

O filtro de 5b (`TIME_GATE`) funciona porque "hora"/"dia"/"agora" cobrem quase todo pedido de
tempo. Não há vocabulário fechado equivalente para "quero que você lembre/anote algo" — os verbos
são abertos (lembrar, anotar, guardar, escrever, salvar, apagar, esquecer, cancelar). **Decisão:**
o filtro permissivo desta fase usa uma lista maior de verbos de escrita/memória, aceitando que terá
mais falso positivo (custa uma inferência extra) do que o da 5b — o mesmo trade-off, calibrado à
parte nesta fase, não herdado às cegas.

### 4.3 Confirmação: estado de sessão de dois turnos, não dentro de um único turno

Diferente de tudo que existe hoje (cada turno é autocontido: transcreve, responde, termina), a
confirmação precisa **sobreviver entre dois turnos**. `Session` (`sessionManager.ts`) ganha um campo
novo:

```ts
interface PendingMutation {
  kind: 'LEMBRETE_CRIAR' | 'LEMBRETE_APAGAR' | 'NOTA_CRIAR' | 'NOTA_APAGAR';
  content: string | null; // null para *_APAGAR
  askedAtTurnId: string;
}
```

Fluxo:

1. **Turno N** — filtro dispara, `detect_mutation` retorna `LEMBRETE_CRIAR|Comprar leite amanhã`.
   O turno **não executa nada** — grava `session.pendingMutation`, sintetiza a pergunta de
   confirmação ("Quer que eu crie o lembrete: comprar leite amanhã?"), encerra normalmente
   (`turn_done`, `state: ouvindo`).
2. **Turno N+1** — antes de qualquer outra coisa em `runTurn`, se `session.pendingMutation` não é
   null: chama um `detect_confirmation` (mesmo padrão de três camadas — filtro permissivo próprio,
   provavelmente sem filtro nenhum, dado que a *existência* do pending já é o gate; LLM decide
   `SIM`/`NAO`, degrada para `NAO` em formato inesperado — **fail closed em ação que muta estado**,
   diferente da 5b, onde formato inesperado degradava para "não fazer nada" porque não fazer nada
   nunca tinha custo de dado perdido). Se `SIM`: executa a mutação, fala confirmação de sucesso,
   limpa `pendingMutation`. Se `NAO` (inclusive formato inesperado): fala cancelamento, limpa
   `pendingMutation`, **não executa**. Em ambos os casos, o turno N+1 pula classify/detect_tool
   normais — a resposta do usuário aqui é sobre a confirmação, não uma pergunta nova.
3. **Pending expira em uma tentativa.** Se o turno N+1 não confirma nem nega de forma reconhecível
   (dois `NAO` seguidos por ambiguidade não existe — já degrada para `NAO` na primeira vez), a
   mutação é descartada, não fica pendurada esperando um turno N+2. Evita o sistema ficar "preso"
   numa pergunta que o usuário já esqueceu.
4. **Preempção de sessão limpa `pendingMutation` de graça** — é campo de `Session`, e uma sessão
   nova começa com o objeto `Session` inteiro recriado (mesma garantia que já existe para `history`).

### 4.4 Execução: código escreve o arquivo, nunca o modelo

Idêntico em espírito à 5b (`HoraAtualTool.execute()`): depois do `SIM`, o código — não uma segunda
chamada ao LLM — grava a entrada no JSON. Falha de escrita (disco cheio, permissão) é fechada e
determinística: frase fixa de erro, sem tentar de novo, sem o modelo inventar que funcionou.

### 4.5 Armazenamento: `data/lembretes.json` e `data/notas.json`, fora de `.runtime/`

`.runtime/` é regenerado por `npm run setup:voice` (`.gitignore` já trata como descartável). Dado do
usuário não pode morar lá. Novo diretório `data/` na raiz do projeto, criado sob demanda se ausente,
adicionado ao `.gitignore` (é dado pessoal do usuário, não do repositório). Formato por arquivo:

```json
{
  "items": [
    { "id": "uuid-v4", "text": "Comprar leite amanhã", "createdAt": "2026-09-22T15:00:00.000Z" }
  ]
}
```

`APAGAR` remove o último elemento do array (mais recente por `createdAt`, mas como só se
acrescenta ao fim, é também o último índice — sem precisar ordenar). Escrita é atômica: escreve em
arquivo temporário no mesmo diretório e renomeia por cima do arquivo final (`fs.renameSync` é
atômico no mesmo filesystem) — evita arquivo truncado se o processo morrer no meio da escrita.

---

## 5. Arquivos afetados

**Novos:**
- `src/backend/tools/mutatingTools.ts` — `LembreteTool`, `NotaTool`, `mightBeMutation()`.
- `src/backend/storage/jsonStore.ts` — leitura/escrita atômica genérica, reusada pelas duas
  ferramentas (evita duplicar a lógica de escrita atômica).
- `src/backend/__tests__/mutatingTools.test.ts`, `src/backend/__tests__/storage.test.ts`.
- `scripts/worker/test_mutation_parser.py` — mesmo padrão standalone de `test_tool_parser.py`.
- `data/` — criado em runtime, não commitado (adicionar ao `.gitignore`).

**Modificados:**
- `.gitignore` — acrescenta `data/`.
- `src/shared/voiceProtocol.ts` — `MUTATION_NAMES`, `MutationName`, `CONFIRMATION_TIMEOUT_MS`,
  `DETECT_MUTATION_TIMEOUT_MS`.
- `scripts/worker/worker.py` — `DETECT_MUTATION_SYSTEM_PROMPT`, `DETECT_CONFIRMATION_SYSTEM_PROMPT`,
  `parse_mutation_output()`, `parse_confirmation_output()`, `handle_detect_mutation()`,
  `handle_detect_confirmation()`, despacho nos dois pontos (mesmo achado ALTA que a 5b encontrou na
  própria pele — `stdin_reader_loop()` **e** `work_loop()`, não só o segundo).
- `src/backend/voice/engine.ts` — `detectMutation()`, `detectConfirmation()` na interface.
- `src/backend/voice/mlxWorkerEngine.ts`, `fakeEngine.ts` — mesmo padrão de `detectTool` (pending,
  timeout sem `SIGKILL`, barreira no fake).
- `src/backend/voice/sessionManager.ts` — `pendingMutation` em `Session`; ramo novo em `runTurn`
  antes do caminho normal (mesma posição estrutural do filtro de ferramenta da 5b, mas checado
  **primeiro**, porque uma confirmação pendente precede até o filtro de ferramenta — ver §4.3).
- `src/backend/voice/voiceRuntime.ts` — cria e registra as duas ferramentas novas.
- `src/shared/extensions/registry.ts` — nada estrutural novo (mesmo `tools: ITool[]`), mas as
  ferramentas de mutação usam uma interface própria — ver §6.1 sobre por que não estender `ITool`.

---

## 6. Pseudocódigo — pontos que exigem decisão de desenho (não exaustivo; v1 é a base para auditoria)

### 6.1 Por que uma interface nova, não estender `ITool`

`ITool.execute(): string` não tem argumento nem é assíncrono em relação a confirmação — e não devia
ganhar isso, porque `HoraAtualTool`/`DataAtualTool` (5b) continuam corretas exatamente como são,
síncronas e sem argumento. Nova interface:

```ts
export interface IMutatingTool {
  readonly name: string;
  readonly description: string;
  isAvailable(): boolean;
  /** Extrai o que muda; não executa nada ainda — a confirmação acontece fora da ferramenta. */
  preview(content: string | null): string; // texto da pergunta de confirmação
  /** Só chamado depois do SIM do usuário. */
  execute(content: string | null): string; // texto de sucesso, ou lança em falha de I/O
}
```

`registry.ts` ganha uma segunda lista, `mutatingTools: IMutatingTool[]`, e `registerMutatingTool()`
idempotente por `name` (mesmo padrão de `registerTool()`).

### 6.2 `worker.py` — prompts de detecção (rascunho, a refinar em rodada de auditoria)

```python
DETECT_MUTATION_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede para CRIAR ou APAGAR um LEMBRETE ou uma NOTA, ou "
    "NENHUMA das quatro. Responda em UMA LINHA: AÇÃO ou AÇÃO|conteúdo (só para *_CRIAR, o texto "
    "exato do que deve ser lembrado/anotado, sem aspas, sem explicação).\n"
    "LEMBRETE_CRIAR: pede para lembrar/anotar algo temporário, um compromisso, uma tarefa.\n"
    "NOTA_CRIAR: pede para guardar uma ideia, observação, texto mais livre — não uma tarefa.\n"
    "LEMBRETE_APAGAR / NOTA_APAGAR: pede para apagar o lembrete/nota mais recente.\n"
    "NENHUMA: todo o resto.\n"
    # exemplos NOVOS aqui, nunca reusando os da Fase 5b nem de nenhum log de auditoria —
    # mesmo protocolo de congelamento, aplicado desde a v1 desta vez.
)

DETECT_CONFIRMATION_SYSTEM_PROMPT = (
    "O usuário acabou de ouvir uma pergunta de confirmação de uma ação. Responda SIM se a frase "
    "confirma, NAO se nega ou cancela, ou se não for claramente um dos dois.\n"
    # exemplos novos, cobrindo confirmação/negação coloquial em português.
)
```

### 6.3 Ordem em `runTurn` — confirmação pendente é checada antes de tudo

```ts
// sessionManager.ts, dentro de runTurn, logo após a transcrição:
if (session.pendingMutation) {
  const confirmed = await this.engine.detectConfirmation(turn.turnId, turn.epoch, transcript);
  // confirmed: 'SIM' | 'NAO' (NAO é o padrão seguro em qualquer ambiguidade — §4.3)
  const mutation = session.pendingMutation;
  session.pendingMutation = null;

  if (confirmed === 'SIM') {
    const tool = selectMutatingToolByAction(mutation.kind, this.mutatingTools);
    let text: string;
    try {
      text = tool.execute(mutation.content);
    } catch (err) {
      text = MUTATION_FAILURE_TEXT; // fechado e determinístico, mesmo espírito de TOOL_FAILURE_TEXT
    }
    // fala o resultado, turn_done, state: ouvindo — mesmo encerramento da 5b
  } else {
    // fala cancelamento fixo, turn_done, state: ouvindo
  }
  return; // não continua para filtro/classify normais neste turno
}

// só chega aqui se NÃO havia confirmação pendente:
if (this.mutatingTools.length > 0 && mightBeMutation(transcript)) {
  // detect_mutation, e se retornar *_CRIAR/*_APAGAR: grava pendingMutation, fala a pergunta,
  // encerra o turno SEM executar nada — ver §4.3
}

// filtro de ferramenta de leitura (Fase 5b), depois classify normal — inalterados
```

---

## 7. Critérios de aceite (rascunho — a versão auditada vai numerar H1..Hn como a 5b)

Automatizados:
- Parsers puros (`parse_mutation_output`, `parse_confirmation_output`): formato válido, inválido,
  vazio, com/sem conteúdo — degradam para `NENHUMA`/`NAO` respectivamente.
- `jsonStore`: escreve, lê, apaga o último; escrita é atômica (arquivo temporário nunca fica visível
  com o nome final); arquivo ausente no início não lança, começa com lista vazia.
- Fluxo de confirmação completo com `FakeVoiceEngine`: turno N grava `pendingMutation` e NÃO chama
  `jsonStore.write`; turno N+1 com `SIM` executa e limpa `pendingMutation`; turno N+1 com `NAO` não
  executa; turno N+1 com resposta ambígua não executa (fail closed); preempção de sessão limpa
  `pendingMutation` sem executar nada.
- Nenhuma regressão em nenhum teste das fases 1-5b.

Manuais, com MLX real, mesmo protocolo de congelamento da 5b (§0 de `docs/phase-5b-v5.md`): plano
escrito e auditado, prompts congelados por commit, **só então** uma amostra nova (não reaproveitar a
da 5b) de pedidos de lembrete/nota e de respostas de confirmação coloquiais, cobertura medida contra
ela.

---

## 8. Riscos

| Risco | Prob. | Mitigação |
|---|---|---|
| Extração de conteúdo livre pelo LLM incluir/perder parte do que o usuário disse | Média-Alta — risco central, classe de risco nova | A pergunta de confirmação **lê de volta o conteúdo extraído antes de gravar** — o usuário ouve exatamente o que vai ser salvo antes de confirmar. Extração errada vira "não, cancela" audível, não dado silenciosamente errado. |
| Confirmação mal-interpretada executa mutação que o usuário não queria | Baixa se fail-closed for respeitado | `NAO` como padrão em qualquer ambiguidade (§4.3); nunca `SIM` por default. |
| Escrita concorrente corrompe o JSON (duas sessões, embora o projeto só permita uma ativa) | Baixa | Escrita atômica via arquivo temporário + rename; `SessionManager` já impõe uma sessão ativa por vez (Fase 2). |
| Filtro permissivo desta fase, mais amplo que o da 5b, gerar inferências demais em conversa normal | Média | Medido na auditoria com áudio real, mesmo formato da 5b (H-equivalente de cobertura vs. falso positivo). |
| Escopo crescer durante a implementação (listar, editar, apagar por conteúdo) | Média — já aconteceu 2x neste projeto (5a, 5b) | Fora de escopo explícito em §3, com justificativa; qualquer auditoria que sugerir ampliar deve primeiro decidir se é v2 ou dentro da v1. |

---

## 9. Rastreabilidade

- Escopo combinado com o usuário antes da escrita (§0), 2026-09-22.
- Este é o plano v1 — segue para rodada 1 de auditoria adversarial (rotação de auditor, começando
  por quem não julgou a 5b por último) antes de qualquer implementação, mesmo processo que todas as
  fases anteriores.
- Depende da Fase 5b apenas por reuso de padrão de arquitetura (três camadas de detecção,
  `pending`/`Map` no `MlxWorkerEngine`) — não depende do H11 da 5b estar resolvido.
