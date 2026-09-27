# Fase 8 — Editar lembrete/nota/memória existente — v2

Versão: v2
Data: 2026-09-27
Status: Aguardando rodada 2 de auditoria adversarial
Base: Corrige os 10 achados da auditoria adversarial da rodada 1 sobre o v1
(`docs/audits/phase-8-v1-agy-rodada1-2026-09-27.log`, veredito REJEITADO — 1 CRÍTICA, 3 ALTA,
3 MÉDIA, 3 BAIXA).

## 0. Escopo combinado com o usuário antes de escrever este plano

Três perguntas foram feitas ao usuário via `AskUserQuestion` (2026-09-27), inalteradas nesta v2:

1. **O que a Fase 8 cobre**: editar e recorrência viram **duas fases separadas** — editar vem
   primeiro (este documento); recorrência fica pra Fase 9.
2. **Qual item é editado**: **sempre o mais recente** — mesma convenção de
   `LEMBRETE_APAGAR`/`NOTA_APAGAR`/`MEMORIA_ESQUECER`.
3. **O que pode ser editado**: **só o texto**. O horário (`dueAt`, Fase 6) não é editável nesta
   fase.

## 1. Objetivo

O usuário cria um lembrete/nota/memória, percebe que errou ou quer corrigir algo, e corrige o
texto do item mais recente diretamente, sem apagar e recriar.

**Critério de conclusão, em linguagem do roteiro**: o usuário cria um lembrete, percebe um erro
de texto, fala "troca esse lembrete pra X", confirma, e o Rodrigo confirma a edição — mesmo `id`,
mesmo agendamento (se houver), só o texto muda.

## 2. A premissa da fase

Terceiro tipo de ação de mutação do projeto — reutiliza a arquitetura de confirmação já
auditada. **A v1 afirmou que isso não exigia nenhuma mudança em `sessionManager.ts` — essa
afirmação estava errada** (achado 1, CRÍTICA, rodada 1): a frase de confirmação natural pra uma
edição ("pode trocar") não é reconhecida pelo gate de segurança da Camada 2 como está hoje. A
correção não inventa um mecanismo novo — adiciona as frases que faltam à lista que já existe,
mesmo padrão que toda extensão de vocabulário de confirmação já seguiu neste projeto.

## 3. Escopo

**Dentro do escopo:** (inalterado da v1)
- Reconhecer um pedido explícito de editar o item mais recente de cada tipo, extraindo o novo
  texto na mesma frase.
- Substituir o `text` do item mais recente, preservando `id`/`createdAt`/`dueAt`/`notifiedAt`.
- Confirmação de voz obrigatória, reutilizando a Camada 0/1 sem mudança — a Camada 2
  (`AFFIRMATIVE_MARKERS`) ganha os marcadores específicos de edição (§4.2, corrigindo o achado 1).
- **Corrigindo o achado 7 (MÉDIA) da rodada 1** — edição de um lembrete que já disparou
  (`notifiedAt !== null`): recusada com mensagem honesta, não silenciosamente aceita como se o
  lembrete ainda fosse disparar.

**Fora de escopo, mesmo que pareça natural:** (inalterado da v1, mais uma exclusão explícita)
- Editar um item específico por conteúdo/tema — só o mais recente.
- Editar o horário (`dueAt`) de um lembrete — trocar horário continua sendo apagar + recriar.
- **Corrigindo o achado 3 (ALTA) da rodada 1**: pedidos de trocar **dia ou horário** de um
  lembrete NÃO são `LEMBRETE_EDITAR` — são um pedido fora do escopo desta fase (o usuário precisa
  apagar e recriar). O worker precisa reconhecer essa distinção, não tratá-la como edição de
  texto comum (ver §4.3).
- Recorrência de lembretes — Fase 9.
- Histórico de edições.

## 4. Decisões de projeto

### 4.1 Novos tipos de mutação (`MUTATION_NAMES`)

Inalterado da v1: `src/shared/voiceProtocol.ts` ganha `LEMBRETE_EDITAR`, `NOTA_EDITAR`,
`MEMORIA_EDITAR`. `selectMutatingToolByAction()` não muda.

### 4.2 `*_EDITAR` em `LembreteTool`/`NotaTool`/`MemoriaTool` (`mutatingTools.ts`) — gate corrigido, dedupe corrigido, lembrete notificado recusado

**Corrigindo o achado 1 (CRÍTICA) da rodada 1** — o mais grave: testei o `AFFIRMATIVE_REGEX` real
contra "pode trocar"/"pode editar"/"pode corrigir" e confirmei empiricamente que os três
retornam `false` — a Camada 2 vetaria uma confirmação legítima do usuário, cancelando a edição
sempre. `AFFIRMATIVE_MARKERS` (`sessionManager.ts:96-104`) precisa ganhar os três marcadores
específicos, mesmo padrão de bigramas já usado pra `pode criar`/`pode apagar`/etc:

```ts
// sessionManager.ts — AFFIRMATIVE_MARKERS ganha, ao lado de 'pode criar', 'pode apagar', etc.:
'pode trocar', 'pode editar', 'pode corrigir', 'pode ser', 'pode mudar',
```

Isto significa que **`src/backend/voice/sessionManager.ts` muda nesta fase**, ao contrário do que
a v1 afirmava — corrigido em §5 abaixo.

**Achado novo 4 (MÉDIA, rodada 2)**, duas partes:
1. `'pode ser'`/`'pode mudar'` adicionados acima — respostas afirmativas coloquiais igualmente
   naturais à pergunta "Posso trocar...?" que os três bigramas originais não cobriam.
2. `CONFIRM_YES_EXACT` (Camada 0, `sessionManager.ts:36-47`) também ganha `'pode trocar'`,
   `'pode editar'`, `'pode corrigir'` — sem isso, essas três respostas resolvem só na Camada 1
   (chamada ao worker MLX, ~3.2s de latência local) em vez de na Camada 0 (0ms, resolução
   síncrona), mesma otimização que `'pode confirmar'` já tem:

```ts
// sessionManager.ts — CONFIRM_YES_EXACT ganha, ao lado de 'pode confirmar':
'pode trocar', 'pode editar', 'pode corrigir'
```

**Corrigindo o achado 4 (ALTA) da rodada 1** — deduplicação e no-op não tratados: a v1 não
especificava o que acontece se o novo texto for igual a outro item já existente (memória) ou ao
próprio texto atual (qualquer um dos três). Corrigido, uniformemente.

**`preview()` — achado novo 2 (ALTA, rodada 2): a v2 anterior omitiu por completo o pseudocódigo
de `preview()`, deixando só `execute()`. Documento tem que ser autocontido — reintroduzido aqui:**

```ts
// LembreteTool.preview():
if (kind === 'LEMBRETE_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar lembrete.');
  return `Posso trocar o lembrete mais recente para: ${content.trim()}?`;
}
// NotaTool.preview():
if (kind === 'NOTA_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar nota.');
  return `Posso trocar a nota mais recente para: ${content.trim()}?`;
}
// MemoriaTool.preview():
if (kind === 'MEMORIA_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar memória.');
  return `Posso trocar essa memória para: ${content.trim()}?`;
}
```

**`execute()`:**

```ts
// LembreteTool.execute(), ramo LEMBRETE_EDITAR:
if (kind === 'LEMBRETE_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar lembrete.');
  const store = this.store.read();
  if (store.items.length === 0) return 'Não há nenhum lembrete para editar.';
  const idx = store.items.length - 1;
  const current = store.items[idx];

  // Achado 6 (MÉDIA, rodada 1): lembrete já disparado não pode ser "reativado" silenciosamente
  // editando o texto — o ReminderScheduler já descartou o timer (fire() ignora notifiedAt) e o
  // usuário teria a falsa impressão de que o lembrete ainda vai soar.
  if (current.notifiedAt) return 'Esse lembrete já foi disparado, não é possível editar mais.';

  const trimmed = content.trim();

  // Achado novo 3 (MÉDIA, rodada 2) — defesa em profundidade: não confiar só no prompt do
  // worker pra barrar pedidos de troca de horário disfarçados de edição de texto ("troca o
  // lembrete pra: reunião amanhã às dez"). O modelo local é 4B quantizado — já erra em outros
  // pontos do projeto (H-mutação nunca passou de 76,5%, Fase 5c) — então o backend TypeScript
  // precisa da própria checagem, não depender 100% do LLM seguir a instrução do prompt (§4.3).
  const wouldScheduleTime = parseRelativeTime(trimmed).dueAt !== null;
  if (wouldScheduleTime) {
    return 'Não dá pra mudar o horário editando o texto — apague e crie um lembrete novo com o horário certo.';
  }

  if (current.text === trimmed) return 'Isso já era o texto do lembrete.'; // no-op, achado 4

  store.items[idx] = { ...current, text: trimmed };
  this.store.write(store);
  return 'Lembrete atualizado.';
}
```

```ts
// NotaTool.execute(), ramo NOTA_EDITAR: mesmo formato de LembreteTool (sem a checagem de
// notifiedAt nem de parseRelativeTime — notas não têm horário, então a defesa em profundidade
// contra horário não se aplica); no-op se current.text === trimmed -> 'Isso já era o texto da
// nota.'; sucesso -> 'Nota atualizada.'

// MemoriaTool.execute(), ramo MEMORIA_EDITAR: mesmo formato, MAIS a checagem de duplicata contra
// os OUTROS itens (achado 4 — memória é lista estática de fatos únicos, mesmo cuidado que o
// dedupe de MEMORIA_GUARDAR já tem na Fase 7):
if (kind === 'MEMORIA_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar memória.');
  const store = this.store.read();
  if (store.items.length === 0) return 'Não há nada guardado para editar.';
  const idx = store.items.length - 1;
  const trimmed = content.trim();
  const normalized = trimmed.toLowerCase();

  if (store.items[idx].text.trim().toLowerCase() === normalized) {
    return 'Isso já era o texto guardado.'; // no-op
  }
  // Duplicata contra OUTRO item (não o que está sendo editado) — acompanha a mesma disciplina
  // do dedupe de MEMORIA_GUARDAR (Fase 7, achado 7 da rodada 1 de lá).
  const isDuplicateOfOther = store.items.some(
    (it, i) => i !== idx && it.text.trim().toLowerCase() === normalized
  );
  if (isDuplicateOfOther) return 'Isso já estava guardado.';

  store.items[idx] = { ...store.items[idx], text: trimmed };
  this.store.write(store);
  return 'Atualizado.';
}
```

`LembreteTool` precisa importar `parseRelativeTime` de `relativeTimeParser.ts` — já importado
hoje pra `LEMBRETE_CRIAR` (`mutatingTools.ts`), reaproveitado aqui sem import novo.

**Corrigindo o achado 10 (BAIXA) da rodada 1** — mensagens de store vazio uniformizadas e
gramaticalmente corretas por ferramenta (não uma fórmula genérica "Não há nenhum X"):
- Lembrete: `'Não há nenhum lembrete para editar.'`
- Nota: `'Não há nenhuma nota para editar.'`
- Memória: `'Não há nada guardado para editar.'`

**Verificação de colisão de marcador, corrigida**: as três frases de confirmação ("Posso
trocar...") continuam sem nenhuma palavra de `NEGATION_MARKERS`. A afirmação da v1 de que "sim"/
"pode"/"claro" resolveriam sem mudança nenhuma estava **incompleta** — "sim"/"claro" resolvem
pela Camada 0 sem mudança; "pode" sozinho nunca foi um marcador (nem antes desta fase), mas as
formas compostas "pode trocar"/"pode editar"/"pode corrigir" precisam da adição em §4.2 acima.

### 4.3 Extensão do worker (`scripts/worker/worker.py`) — cabeçalho com MEMORIA_GUARDAR, exemplo de horário removido, NOTA_EDITAR incluída, negativo de "trocar"

**Corrigindo o achado 2 (ALTA) da rodada 1** — o cabeçalho reescrito da v1 removeu
`MEMORIA_GUARDAR` da lista de ações que extraem conteúdo (regressão direta da lição que a própria
Fase 7 já tinha ensinado). Corrigido — cabeçalho lista as três categorias de conteúdo
explicitamente:

```python
DETECT_MUTATION_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede para CRIAR, EDITAR ou APAGAR um LEMBRETE, uma NOTA "
    "ou uma MEMÓRIA, ou NENHUMA das nove. Responda em UMA LINHA: AÇÃO, ou AÇÃO|conteúdo para "
    "*_CRIAR, *_EDITAR e MEMORIA_GUARDAR (o texto do que deve ser lembrado/anotado/guardado/"
    "corrigido, sem aspas, sem explicação extra).\n"
    ...
    "LEMBRETE_EDITAR: pede pra CORRIGIR ou TROCAR o TEXTO do lembrete mais recente, sem criar "
    "um novo e sem mudar quando ele dispara — 'troca esse lembrete pra', 'corrige o lembrete, é'. "
    "Diferença de LEMBRETE_CRIAR: EDITAR sempre se refere a um lembrete que JÁ EXISTE. "
    "IMPORTANTE: se o pedido for pra mudar o DIA ou HORÁRIO do lembrete (não o texto), NÃO é "
    "LEMBRETE_EDITAR — é NENHUMA, porque o sistema ainda não sabe reagendar um lembrete "
    "existente (só apagar e criar um novo).\n"
    "NOTA_EDITAR: mesma ideia de LEMBRETE_EDITAR, mas pra nota.\n"
    "MEMORIA_EDITAR: mesma ideia, mas pra memória.\n"
    ...
)
```

**Corrigindo o achado 3 (ALTA) da rodada 1** — o exemplo `"Na verdade, corrige o lembrete: é
sexta, não quinta -> LEMBRETE_EDITAR|É sexta, não quinta"` ensinava o modelo a tratar mudança de
**dia** como edição de texto — e como `LembreteTool.execute('LEMBRETE_EDITAR')` nunca chama
`parseRelativeTime()` nem toca `dueAt`, o lembrete ficaria com o texto "É sexta, não quinta" mas
continuaria disparando na quinta — um bug de dado silencioso, não só um problema de classificação.
Removido e substituído por um exemplo estritamente textual, mais um exemplo negativo mostrando o
caso de horário caindo em `NENHUMA`:

```
Na verdade, corrige o lembrete: é café solúvel, não em pó -> LEMBRETE_EDITAR|Comprar café solúvel, não em pó
Muda esse lembrete pra sexta em vez de quinta -> NENHUMA
```

**Corrigindo o achado 6 (MÉDIA) da rodada 1** — faltava exemplo de `NOTA_EDITAR` e um negativo
pro verbo "trocar" (muito comum em português fora do contexto de mutação — "trocar de assunto",
"trocar de roupa"):

```
Troca essa nota pra: comprar materiais na segunda -> NOTA_EDITAR|Comprar materiais na segunda
Vamos trocar de assunto agora -> NENHUMA
```

Lista completa de exemplos contrastivos desta fase (substituindo a lista da v1):
```
Lembra de ligar pro dentista -> LEMBRETE_CRIAR|Ligar pro dentista
Troca esse lembrete pra ligar pro médico -> LEMBRETE_EDITAR|Ligar pro médico
Na verdade, corrige o lembrete: é café solúvel, não em pó -> LEMBRETE_EDITAR|Comprar café solúvel, não em pó
Muda esse lembrete pra sexta em vez de quinta -> NENHUMA
Troca essa nota pra: comprar materiais na segunda -> NOTA_EDITAR|Comprar materiais na segunda
Guarda que meu nome é Rodrigo -> MEMORIA_GUARDAR|seu nome é Rodrigo
Na verdade, corrige isso que eu falei: meu nome é Rodrigo Sonsino -> MEMORIA_EDITAR|seu nome é Rodrigo Sonsino
Vamos trocar de assunto agora -> NENHUMA
```

**Corrigindo o achado 9 (BAIXA) da rodada 1** — `DETECT_CONFIRMATION_SYSTEM_PROMPT`
(`worker.py`) ainda descreve a pergunta que o usuário ouviu como sendo só "criar ou apagar algo".
Atualizado pra mencionar editar também:

```python
DETECT_CONFIRMATION_SYSTEM_PROMPT = (
    "O usuário acabou de ouvir uma pergunta perguntando se ele confirma uma ação (criar, editar "
    "ou apagar algo). Responda em UMA PALAVRA: SIM se a resposta confirma a ação, NAO se nega, "
    ...
)
```

**`parse_mutation_output()` — achado novo 1 (ALTA, rodada 2): a v2 anterior só disse em prosa
"inalterado da v1, já cobria" sem reproduzir o código — mas a v1 nunca foi implementada
(REJEITADA), e um documento de plano tem que ser autocontido. Sem este bloco explícito aqui, o
código real de produção hoje (`worker.py`) não extrai `content` pra nenhum `*_EDITAR`, e a
implementação sairia quebrada por omissão de leitura, não por erro de lógica.** Reproduzido:

```python
if action not in MUTATION_NAMES:
    return ("NENHUMA", None)
if action in ("LEMBRETE_CRIAR", "NOTA_CRIAR", "MEMORIA_GUARDAR",
              "LEMBRETE_EDITAR", "NOTA_EDITAR", "MEMORIA_EDITAR"):
    if not content or len(content) > MAX_MUTATION_CONTENT_CHARS:
        return ("NENHUMA", None)
    return (action, content)
return (action, None)
```

### 4.4 `MUTATION_GATE` (`mutatingTools.ts`) — formas fechadas, sem `\w*` aberto nos termos novos

**Corrigindo o achado 5 (MÉDIA) da rodada 1** — testei o regex da v1 em Node contra "edital",
"trocadilho" e "trocado": os três retornam `true` — falso positivo real, porque `\w*` no final do
grupo inteiro deixa toda alternativa (incluindo as novas) como prefixo aberto, não só as antigas
que já tinham esse comportamento aceito. A correção separa as formas novas num segundo grupo
**sem** `\w*` de cauda — fechado nas conjugações relevantes, não um prefixo:

```ts
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr|memor|grava|grave|gravou|gravand|gravar)\w*\b|\b(edita|editar|edite|editou|editando|troca|trocar|troque|trocou|trocando|corrige|corrigir|corrija|corrigiu|corrigindo)\b/;
```

Verificado (Node): "edital"/"editais" → `false`; "trocadilho"/"trocado" → `false`; "troca esse
lembrete"/"corrige a nota"/"editando" → `true`. As formas antigas (`lembr|anot|...`) continuam
com `\w*` aberto porque já são aceitas assim desde a Fase 5c — esta correção só evita repetir o
mesmo problema nas formas novas, não reabre uma discussão já resolvida sobre as antigas.

## 5. Arquivos afetados

```
src/shared/voiceProtocol.ts               MUTATION_NAMES ganha LEMBRETE_EDITAR/NOTA_EDITAR/MEMORIA_EDITAR
src/backend/tools/mutatingTools.ts        3 novos ramos preview() E execute() (com checagem de
                                           notifiedAt, defesa contra horário via parseRelativeTime,
                                           no-op e dedupe); MUTATION_GATE corrigido (§4.4)
src/backend/voice/sessionManager.ts       AFFIRMATIVE_MARKERS ganha 'pode trocar'/'pode editar'/
                                           'pode corrigir'/'pode ser'/'pode mudar' (achado 1 CRÍTICA
                                           + achado novo 4 MÉDIA — NOVO nesta v2, a v1 afirmava
                                           incorretamente que este arquivo não mudava);
                                           CONFIRM_YES_EXACT ganha 'pode trocar'/'pode editar'/
                                           'pode corrigir' (achado novo 4 — resolve na Camada 0,
                                           sem chamar o worker MLX, ~3.2s de latência evitada)
scripts/worker/worker.py                  MUTATION_NAMES, parse_mutation_output() (extração de
                                           content pros 3 *_EDITAR — achado novo 1, reproduzido
                                           explicitamente em §4.3, não só citado em prosa),
                                           DETECT_MUTATION_SYSTEM_PROMPT (cabeçalho
                                           corrigido com MEMORIA_GUARDAR, exemplo de horário
                                           removido, NOTA_EDITAR e negativo de "trocar" incluídos),
                                           DETECT_CONFIRMATION_SYSTEM_PROMPT (menciona "editar")
scripts/worker/test_mutation_parser.py    casos novos para os 3 *_EDITAR (parse_mutation_output
                                           já cobria o ramo de extração corretamente na v1)
src/backend/__tests__/mutatingTools.test.ts  testes novos para os 3 ramos EDITAR (item mais
                                           recente atualizado, id/createdAt/dueAt/notifiedAt
                                           preservados, store vazio, no-op, dedupe de memória,
                                           lembrete já notificado recusado, timer do
                                           ReminderScheduler não duplicado nem cancelado — teste
                                           de integração corrigido para este arquivo, achado 8 da
                                           rodada 1, não voice.test.ts como a v1 apontava)
src/backend/__tests__/voice.test.ts       teste de regressão: "pode trocar"/"pode editar"/
                                           "pode corrigir" não são vetados por hasAffirmativeMarker
```

`src/backend/voice/voiceRuntime.ts` não muda — nenhuma assinatura nova, nenhum blast radius de
call sites (a correção do achado 1 é uma adição de strings numa constante, não uma mudança de
assinatura).

## 6. Critérios de aceite (H1..H9)

- **H1** — Cada `*_EDITAR` substitui só o `text` do item mais recente, preservando os demais
  campos (`id`/`createdAt`/`dueAt`/`notifiedAt` para lembretes).
- **H2** — Store vazio: cada `*_EDITAR` retorna a mensagem exata especificada em §4.2 por
  ferramenta, sem lançar exceção não tratada.
- **H3** — Lembrete agendado editado: teste de integração em `mutatingTools.test.ts` provando que
  o `ReminderScheduler` não recebe nenhuma chamada nova (`schedule()`/`cancel()`) e que o timer
  original, ao disparar, usa o texto atualizado.
- **H4** — Confirmação de voz: as três frases de confirmação, MAIS as respostas reais "pode
  trocar"/"pode editar"/"pode corrigir", testadas contra `hasAffirmativeMarker()` de verdade —
  teste de regressão direto provando que o achado 1 (CRÍTICA) não se repete no código.
- **H5** — Lembrete já notificado: editar retorna `'Esse lembrete já foi disparado, não é
  possível editar mais.'` sem alterar o item.
- **H6** — No-op e dedupe: editar pro mesmo texto retorna a mensagem de no-op sem duplicar
  entrada; editar uma memória pro texto de outra memória já existente é recusado.
- **H7** — **H-editar-mutação** (mede a extensão do worker contra amostra hold-out real, mesmo
  protocolo de congelamento das fases anteriores): cobertura mínima ≥80% sujeita a revisão do
  auditor, com casos específicos para a colisão `EDITAR` vs. `CRIAR` e para o caso de horário
  caindo corretamente em `NENHUMA`. Não passar não bloqueia a fase.
- **H8** — Regressão: suíte completa das Fases 1-7 passa sem alteração de comportamento.
- **H9** — Verificação manual com áudio real: criar um lembrete, editá-lo por voz confirmando com
  "pode trocar" (não só "sim"), confirmar que o texto mudou e a notificação ainda dispara no
  horário certo com o texto novo.

## 7. Riscos

- **Colisão `EDITAR` vs. `CRIAR`** (§4.3) — inalterado, risco central da fase. H7 mede antes de
  aceitar.
- **Ambiguidade genuína em português** com o verbo "trocar" — mitigada com exemplo negativo
  explícito (§4.3), não eliminável por completo.
- **Edição de dia/horário sendo pedida mas não suportada**: o worker agora classifica isso como
  `NENHUMA` (§4.3) em vez de silenciosamente corromper o agendamento — mas o usuário que pedir
  isso vai ouvir uma resposta genérica de "não entendi", não uma explicação de que precisa apagar
  e recriar. Risco de UX aceito nesta fase; melhorar a mensagem de `NENHUMA` pra esse caso
  específico fica como candidato de fase futura, não bloqueia esta.

## 8. Rastreabilidade

- Escopo combinado com o usuário: duas rodadas de `AskUserQuestion`, 2026-09-27 (§0).
- Auditoria adversarial v1: `docs/audits/phase-8-v1-agy-rodada1-2026-09-27.log` (10 achados,
  REJEITADO).
- Precedente de arquitetura reaproveitado: `docs/phase-5c-v9.md`, `docs/phase-7-v2.md` §4.3/§4.4.
- Precedente do risco de `MUTATION_GATE`: `docs/audits/phase-7-codigo-hermes-2026-09-26.log`.

## 9. Achados das duas rodadas de auditoria (agy) e como foram resolvidos

### Rodada 1 (10 achados, veredito REJEITADO)

| # | Achado | Gravidade | Resolução no v2 | Seção |
|---|---|---|---|---|
| 1 | Gate de confirmação veta "pode trocar"/"pode editar" — a v1 afirmava incorretamente que `sessionManager.ts` não mudaria | CRÍTICA | `AFFIRMATIVE_MARKERS` ganha os 3 bigramas; `sessionManager.ts` passa a constar em §5 | §4.2, §5 |
| 2 | Cabeçalho do prompt do worker omite `MEMORIA_GUARDAR` | ALTA | Cabeçalho reescrito listando as 3 categorias de conteúdo (`*_CRIAR`, `*_EDITAR`, `MEMORIA_GUARDAR`) | §4.3 |
| 3 | Exemplo contrastivo ensina o modelo a tratar mudança de dia como edição de texto — corromperia `dueAt` silenciosamente | ALTA | Exemplo trocado por correção estritamente textual; exemplo negativo de horário → `NENHUMA`; regra explícita no corpo do prompt | §4.3 |
| 4 | `MEMORIA_EDITAR` sem tratamento de duplicata contra outros itens nem no-op | ALTA | Checagem de no-op e de duplicata contra os outros itens adicionada às três ferramentas | §4.2 |
| 5 | `MUTATION_GATE` com `\w*` aberto gera falsos positivos ("edital", "trocadilho") | MÉDIA | Formas novas isoladas num grupo fechado, sem `\w*` de cauda; verificado em Node | §4.4 |
| 6 | Faltava exemplo contrastivo de `NOTA_EDITAR` e negativo do verbo "trocar" → `NENHUMA` | MÉDIA | Exemplos adicionados: `Troca essa nota pra... -> NOTA_EDITAR\|...` e `Vamos trocar de assunto agora -> NENHUMA` | §4.3 |
| 7 | Lembrete já notificado editado silenciosamente, sem nunca mais disparar | MÉDIA | Edição recusada com mensagem honesta se `notifiedAt !== null` | §4.2 |
| 8 | §5 apontava o teste de integração do scheduler pro arquivo errado (`voice.test.ts`) | BAIXA | Corrigido para `mutatingTools.test.ts`, mesmo padrão da Fase 6 | §5 |
| 9 | `DETECT_CONFIRMATION_SYSTEM_PROMPT` não menciona "editar" | BAIXA | Texto atualizado | §4.3 |
| 10 | Mensagens de store vazio inconsistentes entre seções, fórmula genérica gramaticalmente errada pra memória | BAIXA | Strings exatas por ferramenta especificadas em §4.2 | §4.2 |

### Rodada 2 sobre a v2 (5 achados novos, veredito APROVADO COM RESSALVAS — todos aplicados)

| # | Achado | Gravidade | Resolução | Seção |
|---|---|---|---|---|
| 1 | `parse_mutation_output()` só citado em prosa ("inalterado da v1"), sem o código — v1 nunca foi implementada, documento tem que ser autocontido | ALTA | Bloco de código reproduzido explicitamente; `parse_mutation_output()` listado em §5 | §4.3, §5 |
| 2 | `preview()` das três ferramentas totalmente omitido da v2, só `execute()` estava presente | ALTA | Pseudocódigo de `preview()` das 3 ferramentas reintroduzido | §4.2 |
| 3 | Sem defesa em profundidade no backend contra frases mistas texto+horário ("troca o lembrete pra: reunião amanhã às dez") — dependia 100% do LLM local (4B quantizado) seguir a regra do prompt | MÉDIA | `LembreteTool.execute('LEMBRETE_EDITAR')` chama `parseRelativeTime()` e recusa se detectar horário, independente do que o worker classificou | §4.2 |
| 4 | `AFFIRMATIVE_MARKERS` ainda vetava "pode ser"/"pode mudar"; `CONFIRM_YES_EXACT` não ganhou os bigramas (resolveria só via Camada 1, ~3,2s a mais) | MÉDIA | `'pode ser'`/`'pode mudar'` adicionados a `AFFIRMATIVE_MARKERS`; `'pode trocar'`/`'pode editar'`/`'pode corrigir'` adicionados a `CONFIRM_YES_EXACT` | §4.2 |
| 5 | Tabela de rastreabilidade da v2 anterior tinha só 9 linhas pros 10 achados da rodada 1 (uma foi perdida na reescrita) | BAIXA | Tabela corrigida para 10 linhas, numeração realinhada com o log original | §9 |
