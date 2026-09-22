# Fase 5c — Ações que mutam estado (lembretes e notas) — v4

Versão: v4
Data: 2026-09-22
Base: commit `7e0a15f`
Antecessora: v3 (REJEITADO — 2 achados ALTA, 4 MÉDIA, 3 BAIXA; confirmado por execução que os 8
achados da rodada 2 foram corrigidos, exceto um textos-literais que eu tinha declarado corrigido
sem de fato colocar o valor).

---

## 0. Escopo — inalterado, ver v1 §0

---

## 1. A terceira rejeição, e os achados que esta versão corrige

Codex (rodada 3, `-s read-only`, "a skill exigiu três pareceres independentes; os três
convergiram no bloqueio principal") achou o problema mais profundo desta fase até aqui — um erro
conceitual que as rodadas 1 e 2 não podiam ver porque a v3 tinha acabado de introduzir o próprio
mecanismo que continha o defeito. Log completo: `docs/audits/phase-5c-v3-codex-2026-09-22.log`.

| # | Achado | Gravidade | Resolvido em |
|---|---|---|---|
| 1 | `delivered === true` (helper da v3) prova que a síntese terminou e o evento SSE foi emitido — **não** que o usuário ouviu a pergunta. Cliente desconectado, falha de download/decode, ou áudio nunca reproduzido ainda dariam `pendingMutation` armado | ALTA | §4.3, §6.3 (reescrita — reusa `markPlayed()`) |
| 2 | `JsonStore.read()` tratava qualquer erro (JSON corrompido, permissão, I/O) como "arquivo vazio" — corrupção real viraria perda destrutiva na escrita seguinte | ALTA | §6.6 |
| 3 | Prompts de detecção continuavam rascunho com `# exemplos NOVOS aqui` desde a v1 — nada para auditar ou congelar de verdade | MÉDIA | §6.2 (prompts completos, pela primeira vez) |
| 4 | Critério de cobertura sem limiar numérico — a 5b tinha 80% explícito e terminou em 75%, sem aprovar; esta fase não tinha nem o número | MÉDIA | §7 |
| 5 | Feedback pós-mutação (sucesso/cancelamento) herda o mesmo caminho de síntese que engole falha — se não ouvido, o usuário pode repetir o comando e, no caso de `APAGAR`, remover outro item | MÉDIA | §8 (risco documentado, mitigação explicada — ver raciocínio abaixo) |
| 6 | TTL usava `Date.now()` (relógio civil, sensível a ajuste NTP/manual) e começava na emissão, não na reprodução confirmada | MÉDIA | §4.3, §6.3 (resolvido como efeito colateral do achado 1) |
| 7 | Textos literais de `MUTATION_FAILURE_TEXT`/`MUTATION_CANCELLED_TEXT` continuavam só referenciados por nome, não definidos — a v3 dizia "corrigido" sem ter colocado o valor | BAIXA | §6.3 |
| 8 | Whitelist exata da camada 0 é segura mas sub-cobre por desenho — não é bug, é trade-off | BAIXA | §8 (aceito explicitamente, sem ação) |
| 9 | `max_tokens=96` é estimativa; conteúdo truncado ainda seria sintaticamente aceito pelo parser | BAIXA | §6.2 |

Nenhum achado atacou §2 (Premissa) ou §3 (Escopo).

### Por que o achado 1 exigiu reabrir a arquitetura da confirmação, não só um ajuste

A v3 inventou um conceito novo — "entrega confirmada" — quando o projeto **já tem** o mecanismo
certo para exatamente este problema, usado desde a Fase 2 para a mesma pergunta ("o usuário
realmente ouviu isso?"): `markPlayed()` / `session.lastTurnId`, o que impede uma fala não ouvida de
entrar no histórico de conversa depois de um barge-in. `pendingMutation` precisa da mesma garantia,
pelo mesmo motivo, e a v4 usa o mesmo mecanismo em vez de reinventar um paralelo mais fraco.

---

## 2. Premissa da fase — inalterada, ver v1 §2

---

## 3. Escopo — inalterado, ver v1 §3

---

## 4. Decisões de projeto

### 4.1 a 4.2, 4.4 a 4.5 — inalteradas, ver v1/v2/v3

### 4.3 Confirmação — reescrita para se apoiar em `markPlayed()` (achados 1 e 6)

**A pergunta de confirmação não arma `pendingMutation` diretamente.** Ela arma um estado
intermediário, `session.armedMutation`, e só quando o **cliente confirma reprodução real** (o mesmo
`POST /api/voice/session/played` que já existe, chamado pelo frontend depois de tocar o áudio até o
fim) é que `armedMutation` vira `pendingMutation`, com `askedAt` marcado **nesse momento**, não na
emissão:

```ts
interface ArmedMutation {
  kind: MutationName;
  content: string | null;
  turnId: string; // usado por markPlayed() pra saber que ESTE turno era uma pergunta de mutação
}

interface PendingMutation {
  kind: MutationName;
  content: string | null;
  askedAtTurnId: string;
  askedAt: number; // performance.now() — monotônico, não Date.now() (achado 6)
}
```

Fluxo revisado:

1. **Turno N** — detecta `*_CRIAR`/`*_APAGAR`, sintetiza a pergunta pelo caminho **normal**
   (`synthesizeSentence`, sem helper especial — a v3 inventou um helper porque achava que precisava
   saber "entregou ou não"; não precisa mais, porque quem decide isso agora é `markPlayed()`, não a
   síntese). Antes de `turn_done`, grava `session.armedMutation = { kind, content, turnId:
   turn.turnId }`. **`pendingMutation` continua `null`.** Turno encerra normalmente.
2. **Cliente reproduz o áudio até o fim** (comportamento já existente, inalterado) e chama
   `/played`. `markPlayed()` — ver §6.3 — checa `turnId === session.armedMutation?.turnId` **depois**
   da checagem já existente `turnId === session.lastTurnId` (a mesma que protege o histórico contra
   barge-in). Se bater: promove `armedMutation` para `pendingMutation`, com `askedAt =
   performance.now()` — **este é o primeiro instante em que o sistema tem prova de que a pergunta
   foi ouvida.** Se o turno foi superado por barge-in antes do cliente terminar de tocar (ou nunca
   chegou a `/played`), `lastTurnId` já mudou e a checagem falha — `armedMutation` nunca é
   promovido, fica órfão e inofensivo (nunca executa nada; na pior hipótese, uma pergunta que
   ninguém vai responder, não uma mutação sem confirmação real).
3. **Turno N+1** — igual à v3, mas agora `pendingMutation.askedAt` é o instante de reprodução
   confirmada, não de emissão — o TTL mede o tempo certo.

**TTL corrigido (achado 6):** `PENDING_MUTATION_TTL_MS = 60_000`, comparação com `>=` (não `>`) —
exatamente 60.000ms conta como expirado, fechando a ambiguidade de limite que a rodada 3 apontou.
`performance.now()` em vez de `Date.now()` — imune a ajuste de relógio do sistema.

**Textos literais, desta vez de verdade no corpo do pseudocódigo, não só citados (achado 7):**

```ts
export const MUTATION_FAILURE_TEXT = 'Não consegui salvar isso agora.';
export const MUTATION_CANCELLED_TEXT = 'Tudo bem, não fiz nada.';
```

### Achado 5 (feedback pós-mutação) — por que não ganhou o mesmo tratamento do achado 1

A pergunta de confirmação **precisa** de prova de entrega porque uma mutação só pode acontecer
depois de confirmação real — é a garantia central da fase. A fala de **resultado** (sucesso ou
cancelamento) vem **depois** de `tool.execute()` já ter rodado (ou de ter decidido não rodar): a
mutação em si não depende de o usuário ouvir essa fala. O risco real, que a rodada 3 apontou
corretamente, é comportamental — se o usuário não ouvir "lembrete criado" e repetir o pedido,
cria/apaga de novo. Isso é um problema de **experiência**, não de **correção**: nenhuma mutação
acontece sem confirmação real (achado 1 garante isso); o pior caso do achado 5 é o usuário
inadvertidamente pedir a mesma coisa duas vezes, cada uma com sua própria pergunta de confirmação
própria — ele teria que confirmar de novo, e nesse segundo "sim" ele está, de fato, autorizando a
segunda mutação, ainda que por engano. **Decisão: aceitar o risco, documentado em §8, sem adicionar
idempotência nesta versão** — isso pediria rastrear identidade de pedido entre turnos
(deduplicação), uma capacidade nova, fora do escopo combinado com o usuário para esta fase (§0).
Registrado para revisão futura se o uso real mostrar que acontece.

---

## 5. Arquivos afetados

Mesma lista da v3, com ajustes:

- `src/backend/voice/sessionManager.ts` — `armedMutation` em `Session` (substitui o helper
  `synthesizeConfirmationQuestion` da v3, que deixa de existir); `markPlayed()` ganha a promoção de
  `armedMutation` para `pendingMutation`.
- `src/backend/storage/jsonStore.ts` — `read()` distingue `ENOENT` (vazio de verdade) de qualquer
  outro erro (propaga — achado 2).
- `scripts/worker/worker.py` — `DETECT_MUTATION_SYSTEM_PROMPT`/`DETECT_CONFIRMATION_SYSTEM_PROMPT`
  agora com texto completo (achado 3, ver §6.2); `handle_detect_mutation()` detecta truncamento
  (achado 9).

---

## 6. Pseudocódigo

### 6.1 `IMutatingTool` — inalterada, ver v3 §6.1

### 6.2 `worker.py` — prompts completos (achado 3) e detecção de truncamento (achado 9)

```python
DETECT_MUTATION_SYSTEM_PROMPT = (
    "Você decide se a frase do usuário pede para CRIAR ou APAGAR um LEMBRETE ou uma NOTA, ou "
    "NENHUMA das quatro. Responda em UMA LINHA: AÇÃO, ou AÇÃO|conteúdo para *_CRIAR (o texto "
    "exato do que deve ser lembrado/anotado, sem aspas, sem explicação extra).\n"
    "LEMBRETE_CRIAR: um compromisso, tarefa ou coisa temporária a fazer — 'lembra de', 'não "
    "deixa eu esquecer', 'anota aí que eu preciso', 'bota um lembrete pra'.\n"
    "NOTA_CRIAR: uma ideia, observação, ou texto livre pra guardar — 'guarda essa ideia', "
    "'escreve isso pra mim', 'salva essa observação', 'registra que'.\n"
    "LEMBRETE_APAGAR: pede pra apagar/cancelar o lembrete mais recente — 'apaga o lembrete', "
    "'cancela aquele lembrete', 'esquece o que eu pedi pra lembrar'.\n"
    "NOTA_APAGAR: pede pra apagar a nota mais recente — 'apaga essa nota', 'joga fora a "
    "anotação'.\n"
    "NENHUMA: todo o resto — perguntas, pedidos de informação, conversa comum, e qualquer "
    "menção a lembrar/anotar que não seja um pedido direto de ação (ex.: 'eu lembro que você "
    "me falou isso' é NENHUMA, é o usuário lembrando de algo, não pedindo pra você lembrar).\n"
    "Exemplos:\n"
    "Lembra de ligar pro dentista amanhã de manhã -> LEMBRETE_CRIAR|Ligar pro dentista amanhã de manhã\n"
    "Não deixa eu esquecer de pagar a conta de luz -> LEMBRETE_CRIAR|Pagar a conta de luz\n"
    "Guarda essa ideia: usar madeira de demolição no projeto -> NOTA_CRIAR|Usar madeira de demolição no projeto\n"
    "Escreve aí que a reunião de terça foi produtiva -> NOTA_CRIAR|A reunião de terça foi produtiva\n"
    "Apaga o lembrete que eu acabei de pedir -> LEMBRETE_APAGAR\n"
    "Cancela essa nota, joga fora -> NOTA_APAGAR\n"
    "Eu lembro que você me falou sobre isso semana passada -> NENHUMA\n"
    "Você consegue lembrar de coisas entre sessões? -> NENHUMA\n"
)

DETECT_CONFIRMATION_SYSTEM_PROMPT = (
    "O usuário acabou de ouvir uma pergunta perguntando se ele confirma uma ação (criar ou "
    "apagar algo). Responda em UMA PALAVRA: SIM se a resposta confirma a ação, NAO se nega, "
    "cancela, ou não é claramente uma confirmação.\n"
    "Exemplos:\n"
    "Isso mesmo, pode confirmar -> SIM\n"
    "Perfeito, é isso -> SIM\n"
    "Não, deixa pra lá -> NAO\n"
    "Melhor não, esquece -> NAO\n"
    "Na verdade eu quis dizer outra coisa -> NAO\n"
    "Isso aí tá errado -> NAO\n"
)


def parse_mutation_output(raw: str, truncated: bool) -> tuple[str, str | None]:
    """Função PURA — testada em scripts/worker/test_mutation_parser.py.

    `truncated` (achado 9): True quando a geração atingiu max_tokens sem terminar
    naturalmente — conteúdo pode estar cortado no meio de uma palavra, sintaticamente
    válido pro parser mas semanticamente incompleto. Degrada para NENHUMA nesse caso,
    mesma filosofia de "melhor pedir de novo do que gravar errado" do resto da fase.
    """
    if truncated:
        return ("NENHUMA", None)
    text = (raw or "").strip()
    sep = text.find("|")
    action = (text if sep == -1 else text[:sep]).strip().upper()
    content = None if sep == -1 else text[sep + 1:].strip()

    if action not in MUTATION_NAMES:
        return ("NENHUMA", None)
    if action in ("LEMBRETE_CRIAR", "NOTA_CRIAR"):
        if not content or len(content) > MAX_MUTATION_CONTENT_CHARS:
            return ("NENHUMA", None)
        return (action, content)
    return (action, None)
```

`handle_detect_mutation()` chama `stream_generate(..., max_tokens=96, ...)` e conta os tokens
emitidos no loop (mesmo padrão de contagem que `handle_generate()` já faz para
`repetition_context_size`); se o loop terminar por ter atingido `max_tokens` em vez de o modelo
parar sozinho, passa `truncated=True` para `parse_mutation_output`.

`parse_confirmation_output` — inalterada, ver v3 §6.2 (já sem código morto).

### 6.3 `sessionManager.ts` — `armedMutation`, `markPlayed()` estendido, TTL monotônico (achados 1, 6, 7)

```ts
interface Session {
  // ... campos existentes ...
  armedMutation: ArmedMutation | null; // pergunta feita, aguardando prova de reprodução
  pendingMutation: PendingMutation | null; // reprodução confirmada, aguardando sim/não
}

function createSession(/* ... */): Session {
  return {
    // ...
    armedMutation: null,
    pendingMutation: null
  };
}
```

No trecho de detecção de mutação, dentro de `runTurn` (substitui o bloco correspondente da v3):

```ts
if (this.mutatingTools.length > 0 && mightBeMutation(transcript)) {
  let detected: [string, string | null] = ['NENHUMA', null];
  try {
    detected = await this.engine.detectMutation(turn.turnId, turn.epoch, transcript);
  } catch {
    detected = ['NENHUMA', null];
  }
  if (session.activeTurn !== turn) return;

  const [action, content] = detected;
  if (action !== 'NENHUMA') {
    const tool = selectMutatingToolByAction(action, this.mutatingTools);
    if (tool) {
      const question = tool.preview(action, content);

      this.emit(session, { type: 'routing', turnId: turn.turnId, label: 'GERAL', handled: true });
      this.emit(session, { type: 'state', state: 'falando' });

      // Caminho normal de síntese (Fase 2) — não precisa mais de helper especial.
      // "Entregou ou não" deixou de ser decidido aqui; é decidido por markPlayed(), abaixo.
      turn.expectedSentences.add(0);
      turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, cleanTextForSpeech(question), 0));
      await Promise.allSettled(turn.pendingSynthesis);

      if (session.activeTurn === turn) {
        // Achado 1 (ALTA) — grava armedMutation, NUNCA pendingMutation diretamente.
        // A promoção só acontece em markPlayed(), com prova real de reprodução.
        session.armedMutation = { kind: action, content, turnId: turn.turnId };
        this.emit(session, { type: 'turn_done', turnId: turn.turnId });
        this.emit(session, { type: 'state', state: 'ouvindo' });
        session.activeTurn = null;
      }
      return;
    }
    // tool === null: ferramenta ausente/indisponível — cai no caminho normal abaixo (achado 4 da rodada 2)
  }
}
```

`markPlayed()` estendido (acréscimo ao método existente, `sessionManager.ts:413-424` — o corpo
atual não muda, só ganha um bloco novo ao final):

```ts
markPlayed(sessionId: string, token: string, turnId: string, text: string): boolean {
  const session = this.getAuthorized(sessionId, token);
  if (!session) return false;
  this.touch(session);

  if (turnId !== session.lastTurnId) return false; // inalterado — mesma guarda do histórico

  session.history.push({ role: 'assistant', content: text });
  this.trimHistory(session);

  // Achado 1 (ALTA) da rodada 3 — só agora, com reprodução confirmada pelo cliente, uma
  // pergunta de mutação vira mutação pendente de resposta. Nada antes deste ponto podia
  // ter certeza de que o usuário ouviu a pergunta.
  if (session.armedMutation && session.armedMutation.turnId === turnId) {
    session.pendingMutation = {
      kind: session.armedMutation.kind,
      content: session.armedMutation.content,
      askedAtTurnId: turnId,
      askedAt: performance.now() // achado 6 — monotônico, marcado na reprodução, não na emissão
    };
    session.armedMutation = null;
  }

  return true;
}
```

Consumo de `pendingMutation` no turno seguinte — igual à v3 §6.3, exceto a checagem de TTL, que
agora usa `performance.now()` e `>=`:

```ts
if (session.pendingMutation) {
  const expired = performance.now() - session.pendingMutation.askedAt >= PENDING_MUTATION_TTL_MS;
  if (expired) {
    session.pendingMutation = null;
    // segue para o caminho normal, como se não houvesse pending
  } else {
    // idêntico à v3 §6.3: keywordConfirmation -> detectConfirmation -> executa ou cancela
  }
}
```

### 6.4 `selectMutatingToolByAction` — inalterada, ver v2 §6.4

### 6.5 `mlxWorkerEngine.ts` — inalterada, ver v2 §6.5

### 6.6 `jsonStore.ts` — `read()` distingue ausência de corrupção (achado 2)

```ts
export class JsonStore<T> {
  private readonly filePath: string;

  constructor(baseDir: string, fileName: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, fileName);
  }

  read(): { items: T[] } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      // Achado 2 (ALTA) — só ausência de arquivo é "vazio de verdade". Qualquer outro
      // erro (permissão, I/O) propaga: fingir vazio aqui faria a próxima escrita
      // sobrescrever dado que só está temporariamente ilegível, não perdido.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] };
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Arquivo de dados corrompido (JSON inválido): ${this.filePath}`);
    }
    if (
      typeof parsed !== 'object' || parsed === null ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      throw new Error(`Arquivo de dados corrompido (formato inesperado): ${this.filePath}`);
    }
    return parsed as { items: T[] };
  }

  write(data: { items: T[] }): void {
    const tmp = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
```

`LembreteTool`/`NotaTool` já propagam exceção de `execute()` para `MUTATION_FAILURE_TEXT`
(`sessionManager.ts`, bloco de consumo de `pendingMutation`, inalterado desde a v3) — um `read()`
que lança por corrupção já cai nesse caminho existente sem nenhuma mudança adicional no chamador.

---

## 7. Critérios de aceite

Automatizados — lista da v3 §7, mais:

- **Teste de regressão direto do achado 1:** turno que arma `armedMutation` mas cujo `markPlayed()`
  correspondente nunca chega (simulando barge-in ou cliente que nunca reproduziu) — sessão termina
  com `pendingMutation === null` para sempre, não só até o próximo turno.
- `markPlayed()` com `turnId` que bate com `armedMutation.turnId` promove corretamente para
  `pendingMutation` com `askedAt` no momento da chamada; com `turnId` que não bate com
  `lastTurnId` (barge-in), rejeita antes de sequer olhar `armedMutation` — mesma guarda que já
  protege o histórico.
- `JsonStore.read()`: arquivo ausente → `{items: []}`; arquivo com JSON inválido → lança; arquivo
  com JSON válido mas sem `items` array → lança; erro de permissão simulado → lança (achado 2).
- `parse_mutation_output` com `truncated=True` → sempre `NENHUMA`, mesmo com formato
  sintaticamente válido (achado 9).
- TTL: 59.999ms → ainda válido; 60.000ms e 60.001ms → expirado (achado 6, fronteira fechada).

Manuais, com MLX real — protocolo de congelamento, **agora com prompts completos para congelar de
verdade (achado 3)**:

- **Limiares explícitos (achado 4):** H-mutação (detecção de intenção de criar/apagar) ≥80%, mesmo
  padrão de H11 da 5b. H-confirmação (sim/não) ≥90% de acerto geral, **e tolerância zero para falso
  `SIM` sobre uma negação clara na amostra medida** — qualquer caso onde o sistema executaria uma
  mutação que o usuário negou é reprovação automática da fase, independente da porcentagem global.
- Amostra nova, gerada de forma independente de quem escreveu os prompts (mesmo protocolo da 5b),
  cobrindo pedidos de lembrete/nota e respostas de confirmação/negação coloquiais — nunca
  reaproveitando frases de nenhum log de auditoria desta fase.

---

## 8. Riscos

Tabela da v3 §8, com uma linha resolvida e uma nova (achado 5, aceito e documentado):

| Risco | Prob. | Mitigação |
|---|---|---|
| `pendingMutation` armado sem prova real de que a pergunta foi ouvida (achado 1) | Baixa agora | Promoção só acontece em `markPlayed()`, mesmo mecanismo já usado para o histórico de conversa desde a Fase 2 |
| Corrupção de arquivo de dados sendo tratada como "vazio" e sobrescrita (achado 2) | Baixa agora | `JsonStore.read()` só trata `ENOENT` como vazio; qualquer outro erro propaga e bloqueia a escrita |
| **Aceito, não mitigado nesta versão:** feedback de sucesso/cancelamento não ouvido leva o usuário a repetir o comando, podendo criar duplicata ou apagar um segundo item (achado 5) | Baixa-Média | Fora de escopo da v1 — pediria deduplicação de pedido entre turnos, capacidade nova. Cada repetição ainda passa pela própria confirmação, então nada executa sem um "sim" explícito para aquela mutação específica |
| Whitelist de confirmação sub-cobre por desenho, custando latência em casos comuns (achado 8) | Aceito | Trade-off deliberado por segurança; não expandir até medir com amostra congelada |

Demais linhas das versões anteriores inalteradas.

---

## 9. Rastreabilidade

- v1 (Hermes, REJEITADO), v2 (agy, REJEITADO), v3 (Codex, REJEITADO), v4 (esta).
- Três fornecedores diferentes já auditaram esta fase, cada um achando um problema real que os
  anteriores não tinham coberto — mesmo padrão de convergência progressiva da Fase 5b.
- Segue para rodada 4 — por rotação, de volta ao início (Hermes, Codex, ou agy — os três já
  julgaram uma vez; a escolha agora é livre, mantendo só a regra de não fechar com o mesmo auditor
  de todas as rodadas).
- Sem implementação até aprovação.
