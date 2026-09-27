# Fase 8 — Editar lembrete/nota/memória existente — v1

## 0. Escopo combinado com o usuário antes de escrever este plano

Diferente das Fases 6 e 7, a Fase 8 nunca tinha sido referenciada em nenhum documento anterior
deste projeto — não havia "fora de escopo" apontando pra ela. Três perguntas foram feitas ao
usuário via `AskUserQuestion` (2026-09-27) antes de escrever este plano:

1. **O que a Fase 8 cobre**: o usuário pediu duas coisas — editar um lembrete/nota/memória
   existente, e recorrência de lembretes ("todo dia às 8h"). Decisão: **duas fases separadas**,
   mesmo protocolo de sempre neste projeto (nunca misturar duas capacidades testáveis num plano
   só). Editar vem primeiro (este documento, Fase 8); recorrência fica pra Fase 9 — editar não
   depende de nada da Fase 6, enquanto recorrência estende o `ReminderScheduler` que já existe.
2. **Qual item é editado**: **sempre o mais recente** — mesma convenção já usada por
   `LEMBRETE_APAGAR`/`NOTA_APAGAR`/`MEMORIA_ESQUECER` desde a Fase 5c/7. Editar por conteúdo
   específico ("edita o lembrete do dentista") fica fora de escopo — mesmo limite que
   `docs/phase-5c-v1.md` já registrava para apagar, nunca implementado, e que a Fase 7 (achado 7
   da rodada 1) também respeitou pra memórias.
3. **O que pode ser editado**: **só o texto**. Para lembretes, o horário (`dueAt`, Fase 6)
   **não** é editável nesta fase — editar continua sendo só correção de conteúdo; trocar o
   horário de um lembrete já agendado continua exigindo apagar e recriar, como hoje.

## 1. Objetivo

O usuário cria um lembrete/nota/memória, percebe que errou ou quer corrigir algo, e em vez de
apagar e recriar do zero, corrige o texto do item mais recente diretamente: "na verdade, troca
esse lembrete pra 'ligar pro dentista às 15h'" — confirma, e o texto muda, mantendo o mesmo item
(mesmo `id`/`createdAt`, e para lembretes, o mesmo `dueAt`/agendamento, se houver).

**Critério de conclusão, em linguagem do roteiro**: o usuário cria um lembrete ("anota que eu
preciso ligar pro dentista"), percebe que quis dizer "pro médico", fala "troca esse lembrete pra
ligar pro médico", confirma, e o Rodrigo responde confirmando a edição — o item no
`lembretes.json` tem o texto atualizado, mesmo `id`, e (se havia `dueAt`) o agendamento continua
intacto, sem duplicar nem cancelar o timer.

## 2. A premissa da fase

Terceiro tipo de ação de mutação do projeto (depois de `*_CRIAR`/`*_APAGAR` na Fase 5c e
`MEMORIA_GUARDAR`/`MEMORIA_ESQUECER` na Fase 7) — e reutiliza integralmente a arquitetura de
confirmação já auditada (Camadas 0/1/2, `markPlayed()`). **Nenhuma mudança na garantia central.**
O que é novo, seguindo o padrão que as Fases 6 e 7 já deixaram estabelecido (extensão de
vocabulário de mutação = risco de colisão de classificação, sempre nomeado explicitamente):

1. Três novos tipos de mutação (`LEMBRETE_EDITAR`, `NOTA_EDITAR`, `MEMORIA_EDITAR`) — um por
   ferramenta existente, mesma convenção de prefixo que `selectMutatingToolByAction()`
   (`mutatingTools.ts:246-252`) já resolve sem nenhuma mudança nela.
2. `EDITAR` extrai conteúdo (o novo texto) exatamente como `*_CRIAR` já faz — mesma mudança de
   `parse_mutation_output()` que a Fase 7 já precisou fazer pra `MEMORIA_GUARDAR`, agora
   estendida pras três ações `*_EDITAR`.
3. Risco de colisão novo, nomeado explicitamente: `EDITAR` vs. `CRIAR` — "troca esse lembrete
   pra X" e "cria um lembrete pra X" podem soar parecido pro classificador se a frase não deixar
   claro que já existe um item sendo referenciado. Ver §4.3.

## 3. Escopo

**Dentro do escopo:**
- Reconhecer um pedido explícito de editar o item mais recente de cada tipo (lembrete, nota,
  memória), extraindo o novo texto na mesma frase ("troca esse lembrete pra X", "corrige a nota
  pra dizer Y", "na verdade, o certo é Z").
- Substituir o `text` do item mais recente, preservando `id`/`createdAt` — e, para lembretes,
  preservando `dueAt`/`notifiedAt` sem tocar no agendamento (`ReminderScheduler`) de forma
  alguma.
- Confirmação de voz obrigatória antes de qualquer edição, reutilizando a infraestrutura já
  existente (Camadas 0/1/2, `markPlayed()`), sem nenhuma mudança nela.
- Editar quando não há nenhum item ainda: mensagem honesta ("Não há nenhum lembrete pra editar."),
  mesmo padrão de `LEMBRETE_APAGAR` num store vazio.

**Fora de escopo, mesmo que pareça natural:**
- Editar um item específico por conteúdo/tema, não o mais recente — decisão explícita §0.2,
  mesmo limite de `LEMBRETE_APAGAR`/`NOTA_APAGAR`/`MEMORIA_ESQUECER` desde sempre.
- Editar o horário (`dueAt`) de um lembrete — decisão explícita §0.3; trocar horário continua
  sendo apagar + recriar.
- Recorrência de lembretes — isso é a Fase 9 (§0.1).
- Histórico de edições (versões anteriores do texto) — o texto antigo simplesmente não existe
  mais depois de editado, mesmo comportamento de qualquer mutação anterior no projeto.

## 4. Decisões de projeto

### 4.1 Novos tipos de mutação (`MUTATION_NAMES`)

`src/shared/voiceProtocol.ts` ganha três novos nomes: `LEMBRETE_EDITAR`, `NOTA_EDITAR`,
`MEMORIA_EDITAR`. `selectMutatingToolByAction()` já deriva o prefixo e resolve pra
`LembreteTool`/`NotaTool`/`MemoriaTool` sem nenhuma mudança.

### 4.2 `*_EDITAR` em `LembreteTool`/`NotaTool`/`MemoriaTool` (`mutatingTools.ts`)

Mesmo formato nas três classes — `preview()` extrai e confirma o novo texto, `execute()`
substitui o item mais recente preservando os campos que não são `text`:

```ts
// LembreteTool.preview(), novo ramo:
if (kind === 'LEMBRETE_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar lembrete.');
  return `Posso trocar o lembrete mais recente para: ${content}?`;
}

// LembreteTool.execute(), novo ramo:
if (kind === 'LEMBRETE_EDITAR') {
  if (!content || !content.trim()) throw new Error('Conteúdo ausente para editar lembrete.');
  const store = this.store.read();
  if (store.items.length === 0) return 'Não há nenhum lembrete para editar.';
  const idx = store.items.length - 1;
  // Preserva id/createdAt/dueAt/notifiedAt — só o texto muda. O agendamento (se houver) não é
  // tocado: mesmo id, o ReminderScheduler nunca precisa saber que o texto mudou até disparar,
  // e quando disparar vai ler o texto atualizado do store (fire() sempre relê do disco).
  store.items[idx] = { ...store.items[idx], text: content.trim() };
  this.store.write(store);
  return 'Lembrete atualizado.';
}
```

**Por que não precisa reagendar nada no `ReminderScheduler`**: `ReminderScheduler.fire()`
(`reminderScheduler.ts`) já relê o item do disco pelo `id` no momento do disparo (`const { items }
= this.store.read(); const item = items.find((i) => i.id === id)`) — o texto exibido na
notificação sempre reflete o estado mais recente do arquivo, não um valor capturado no momento do
`schedule()`. Editar o texto de um lembrete agendado não precisa cancelar/reagendar timer nenhum.

`NotaTool` e `MemoriaTool` seguem o mesmo padrão, sem a ressalva do scheduler (não têm):

```ts
// NotaTool — preview()/execute() para NOTA_EDITAR: "Posso trocar a nota mais recente para: X?"
// / substitui store.items[last].text, retorna 'Nota atualizada.'

// MemoriaTool — preview()/execute() para MEMORIA_EDITAR: "Posso trocar essa memória para: X?"
// / substitui store.items[last].text, retorna 'Atualizado.'
```

**Verificação de colisão de marcador, mesmo cuidado da Fase 7 (§4.2 de lá)**: nenhuma das três
frases de confirmação ("Posso trocar...") contém palavra de `NEGATION_MARKERS`
(`nao|nem|nunca|jamais|cancela|cancelar|esquece|esquecer|tira|tirar|nada`) nem depende de
`AFFIRMATIVE_MARKERS` conter algo incomum — "sim"/"pode"/"claro" resolvem normalmente pela
Camada 0/2 já existentes.

### 4.3 Extensão do worker (`scripts/worker/worker.py`) — colisão `EDITAR` vs. `CRIAR` nomeada

`MUTATION_NAMES` ganha os três `*_EDITAR`. **Cabeçalho de `DETECT_MUTATION_SYSTEM_PROMPT`
reescrito de novo** — lição da rodada 2 da auditoria da Fase 7: o cabeçalho da instrução (não só
o corpo/exemplos) precisa mencionar explicitamente o novo total de ações e que `EDITAR` também
extrai conteúdo, ou o modelo pode seguir a instrução geral ao pé da letra e omitir o `|conteúdo`:

```python
DETECT_MUTATION_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede para CRIAR, EDITAR ou APAGAR um LEMBRETE, uma NOTA "
    "ou uma MEMÓRIA, ou NENHUMA das nove. Responda em UMA LINHA: AÇÃO, ou AÇÃO|conteúdo para "
    "*_CRIAR e *_EDITAR (o texto do que deve ser lembrado/anotado/guardado/corrigido, sem "
    "aspas, sem explicação extra).\n"
    ...
    "LEMBRETE_EDITAR: pede pra CORRIGIR ou TROCAR o texto do lembrete mais recente, sem criar "
    "um novo — 'troca esse lembrete pra', 'corrige o lembrete, é', 'na verdade o lembrete é'. "
    "Diferença de LEMBRETE_CRIAR: EDITAR sempre se refere a um lembrete que JÁ EXISTE e acabou "
    "de ser mencionado ou criado na conversa; CRIAR é sempre um lembrete NOVO, sem referência a "
    "um anterior.\n"
    "NOTA_EDITAR: mesma ideia de LEMBRETE_EDITAR, mas pra nota — 'corrige essa nota', 'troca a "
    "nota pra'.\n"
    "MEMORIA_EDITAR: mesma ideia, mas pra memória — 'na verdade, o certo é', 'corrige isso que "
    "eu falei sobre mim'.\n"
    ...
)
```

Exemplos contrastivos obrigatórios (a colisão mais importante desta fase):
```
Lembra de ligar pro dentista -> LEMBRETE_CRIAR|Ligar pro dentista
Troca esse lembrete pra ligar pro médico -> LEMBRETE_EDITAR|Ligar pro médico
Na verdade, corrige o lembrete: é sexta, não quinta -> LEMBRETE_EDITAR|É sexta, não quinta
Guarda que meu nome é Rodrigo -> MEMORIA_GUARDAR|seu nome é Rodrigo
Na verdade, corrige isso que eu falei: meu nome é Rodrigo Sonsino -> MEMORIA_EDITAR|seu nome é Rodrigo Sonsino
```

`parse_mutation_output()`: o ramo que extrai `content` passa a incluir os três `*_EDITAR` junto
de `*_CRIAR`/`MEMORIA_GUARDAR`:

```python
if action in ("LEMBRETE_CRIAR", "NOTA_CRIAR", "MEMORIA_GUARDAR",
              "LEMBRETE_EDITAR", "NOTA_EDITAR", "MEMORIA_EDITAR"):
    if not content or len(content) > MAX_MUTATION_CONTENT_CHARS:
        return ("NENHUMA", None)
    return (action, content)
```

### 4.4 `MUTATION_GATE` (`mutatingTools.ts`) — radicais específicos, não genéricos

Seguindo a lição da própria Fase 7 (radical solto `grav` quase gerou falso positivo com
"gravidade"/"gravitação" — o achado acabou sendo refutado na auditoria de código, mas o cuidado
continua válido): adicionar formas verbais específicas de "editar"/"trocar"/"corrigir", não
radicais soltos que poderiam casar com palavras não relacionadas (`mud` casaria com "mudança",
"mudou de vida" — comum em conversas de Teologia — por isso não entra):

```ts
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso|registr|memor|grava|grave|gravou|gravand|gravar|edita|editar|edite|troca|trocar|troque|corrige|corrigir|corrija)\w*\b/;
```

## 5. Arquivos afetados

```
src/shared/voiceProtocol.ts               MUTATION_NAMES ganha LEMBRETE_EDITAR/NOTA_EDITAR/MEMORIA_EDITAR
src/backend/tools/mutatingTools.ts        3 novos ramos preview()/execute() (um por classe);
                                           MUTATION_GATE ganha edita/troca/corrige (formas verbais)
scripts/worker/worker.py                  MUTATION_NAMES, parse_mutation_output() (extração de
                                           conteúdo pros 3 *_EDITAR), DETECT_MUTATION_SYSTEM_PROMPT
                                           (cabeçalho E corpo — não esquecer o cabeçalho, achado
                                           da rodada 2 da Fase 7)
scripts/worker/test_mutation_parser.py    casos novos para os 3 *_EDITAR
src/backend/__tests__/mutatingTools.test.ts  testes novos para os 3 ramos EDITAR (item mais
                                           recente atualizado, id/createdAt preservados, dueAt/
                                           notifiedAt preservados sem tocar no scheduler para
                                           LembreteTool, store vazio)
src/backend/__tests__/voice.test.ts       teste de integração: editar um lembrete agendado não
                                           duplica nem cancela o timer no ReminderScheduler
```

`src/backend/voice/sessionManager.ts` e `src/backend/voice/voiceRuntime.ts` **não mudam** —
diferente das Fases 6/7, esta fase não adiciona nenhuma dependência nova ao construtor de
`SessionManager` nem à assinatura de `createMutatingTools()`, então não há blast radius de call
sites pra gerenciar.

## 6. Critérios de aceite (H1..H7)

- **H1** — `LEMBRETE_EDITAR`/`NOTA_EDITAR`/`MEMORIA_EDITAR`: cada um substitui só o `text` do
  item mais recente, preservando `id`/`createdAt` (e `dueAt`/`notifiedAt` para lembretes).
- **H2** — Store vazio: cada `*_EDITAR` retorna mensagem honesta ("Não há nenhum X para editar.")
  sem lançar exceção não tratada.
- **H3** — Lembrete agendado editado: o `ReminderScheduler` não precisa de nenhuma chamada nova
  (`schedule()`/`cancel()`) — o timer original continua ativo com o `id` original, e quando
  disparar lê o texto atualizado do disco (teste de integração provando isso, não só lendo o
  código).
- **H4** — Confirmação de voz: as três frases de confirmação ("Posso trocar...") não são vetadas
  por `NEGATION_MARKERS`/`hasAffirmativeMarker()` — teste de regressão direto, mesmo padrão do H4
  da Fase 7.
- **H5** — **H-editar-mutação** (mede a extensão do worker contra uma amostra hold-out real,
  mesmo protocolo de congelamento das fases anteriores: commitar a implementação antes de pedir a
  amostra): cobertura mínima a definir na auditoria, sugestão de partida ≥80%, com ênfase em
  distinguir `EDITAR` de `CRIAR` (a colisão nomeada em §4.3). Não passar não bloqueia a fase —
  mesma disciplina de honestidade de todas as anteriores.
- **H6** — Regressão: suíte completa das Fases 1-7 passa sem alteração de comportamento.
- **H7** — Verificação manual com áudio real: criar um lembrete, editá-lo por voz, confirmar que
  o texto mudou e (se havia horário) a notificação ainda dispara no horário certo com o texto
  novo.

## 7. Riscos

- **Colisão `EDITAR` vs. `CRIAR`** (§4.3) — risco central da fase, nomeado explicitamente, mesma
  categoria de risco que `MEMORIA_GUARDAR` vs. `LEMBRETE_CRIAR` foi na Fase 7. H5 mede antes de
  aceitar como resolvido.
- **Ambiguidade genuína em português**: "troca isso" pode significar editar OU, em outro
  contexto, poderia soar como um pedido de nova ação — mitigado pelos exemplos contrastivos, mas
  não eliminável por completo (mesma honestidade que a Fase 7 já aplicou ao seu próprio risco
  central).
- **`MUTATION_GATE` com formas verbais específicas, não radicais soltos** (§4.4) — decisão
  deliberadamente mais conservadora que a primeira tentativa da Fase 7, aprendendo com o quase-
  incidente do radical `grav`.

## 8. Rastreabilidade

- Escopo combinado com o usuário: duas rodadas de `AskUserQuestion`, 2026-09-27 (§0).
- Precedente de arquitetura reaproveitado: `docs/phase-5c-v9.md` (confirmação de três camadas),
  `docs/phase-7-v2.md` §4.3/§4.4 (padrão de extensão de `MUTATION_NAMES`/`parse_mutation_output`/
  `DETECT_MUTATION_SYSTEM_PROMPT`, incluindo a lição de reescrever o cabeçalho, não só o corpo).
- Precedente do risco de `MUTATION_GATE` com radical solto: `docs/audits/phase-7-codigo-hermes-2026-09-26.log`
  (achado sobre `grav`/"gravitação", refutado após verificação, mas motivou a cautela de §4.4
  aqui).
