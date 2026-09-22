# Fase 5c — Ações que mutam estado (lembretes e notas) — v2

Versão: v2
Data: 2026-09-22
Base: commit `af8ceca`
Antecessora: v1 (REJEITADO, 1 achado ALTA — com uma segunda formulação do mesmo achado — e 6
média/baixa, todos de pseudocódigo incompleto).

---

## 0. Escopo — inalterado, ver v1 §0

Lembretes e notas na mesma fase; persistência em JSON local; confirmação falada obrigatória para
toda mutação. Decidido com o usuário antes da v1, não revisitado aqui.

---

## 1. A primeira rejeição, e os achados que esta versão corrige

Hermes (rodada 1, execução real contra o código atual + leitura do plano) aprovou o desenho geral
(três camadas, confirmação de dois turnos, escrita atômica) e rejeitou por um problema real de
ordenação de estado, mais seis lacunas de pseudocódigo. Log completo em
`docs/audits/phase-5c-v1-hermes-2026-09-22.log`.

| # | Achado | Gravidade | Resolvido em |
|---|---|---|---|
| 1 | `pendingMutation` gravado **antes** da síntese da pergunta de confirmação terminar; um barge-in nessa janela cancela o turno mas não limpa o pending — o turno seguinte trata qualquer fala como resposta a uma pergunta nunca ouvida | ALTA | §4.3, §6.3 |
| 2 (mesma raiz que #1, achado separado no log) | Ordem de gravação de `pendingMutation` vs. síntese não especificada | ALTA | §4.3, §6.3 |
| 3 | `detectConfirmation` proposto como chamada MLX inteira sem reconhecer que enfrenta o mesmo problema que deixou `detect_tool` em 75% (5b, H11) | MÉDIA | §4.3 (reescrita), §7 |
| 4 | Parser `AÇÃO\|conteúdo` não especificava o que fazer com `\|` dentro do próprio conteúdo do usuário | MÉDIA | §4.1, §6.2 |
| 5 | Nenhum limite de tamanho para o `content` extraído pelo LLM | MÉDIA | §4.1, §5 |
| 6 | `selectMutatingToolByAction`, citada no pseudocódigo, nunca definida | MÉDIA | §6.4 (nova) |
| 7 | Timeouts de `detect_mutation`/`detect_confirmation` sem valor nem tratamento especificado | MÉDIA | §5, §6.5 (nova) |
| 8 | `pendingMutation` não inicializado no construtor de `Session` | BAIXA | §6.3 |
| 9 | `parse_confirmation_output` sem pseudocódigo | BAIXA | §6.2 |

Nenhum achado atacou §1 (Objetivo), §2 (Premissa) ou §3 (Escopo) — permanecem como na v1, não
repetidos aqui.

---

## 2. Premissa da fase — inalterada, ver v1 §2

---

## 3. Escopo — inalterado, ver v1 §3

---

## 4. Decisões de projeto

### 4.1 `detect_mutation` — parser corrigido (achados 4 e 5)

Formato de saída continua `AÇÃO|conteúdo`, mas o parser agora é especificado, não só descrito:

```python
def parse_mutation_output(raw: str) -> tuple[str, str | None]:
    """Função PURA — testada em scripts/worker/test_mutation_parser.py.

    Acháados 4 e 5 da rodada 1: divide no PRIMEIRO '|' apenas (o conteúdo do usuário pode
    legitimamente conter o caractere '|'); conteúdo vazio, ausente, ou maior que
    MAX_MUTATION_CONTENT_CHARS degrada a ação inteira para NENHUMA — um lembrete truncado
    silenciosamente é pior que pedir para o usuário repetir mais curto.
    """
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
    return (action, None)  # *_APAGAR e NENHUMA nunca carregam conteúdo
```

`MAX_MUTATION_CONTENT_CHARS = 200` em `VOICE_LIMITS` (§5) — folga generosa sobre qualquer lembrete
ou nota falada em poucas frases, curto o bastante para a pergunta de confirmação não virar um
parágrafo lido em voz alta.

### 4.2 O filtro permissivo — inalterado, ver v1 §4.2

### 4.3 Confirmação — corrigida a ordem de gravação (achados 1, 2, 3)

**Correção do achado 1+2 (ALTA):** `pendingMutation` só é gravado **depois** que a pergunta de
confirmação terminou de ser sintetizada com sucesso e o turno ainda é o ativo — exatamente o mesmo
ponto onde o caminho normal decide se emite `turn_done` (`sessionManager.ts`, verificado contra
`session.activeTurn === turn` após `Promise.allSettled(turn.pendingSynthesis)`). Se o turno for
cancelado por barge-in antes disso — em qualquer ponto, incluindo no meio da síntese —
`pendingMutation` nunca é escrito, porque a escrita acontece depois do ponto de cancelamento, não
antes. Não existe janela onde uma pergunta não ouvida vire pending. Pseudocódigo completo em §6.3.

**Correção do achado 3 (MÉDIA) — honestidade sobre a dificuldade de `detectConfirmation`, e uma
camada extra que reduz o problema em vez de só reconhecê-lo:** a auditoria está certa que não há
motivo para supor que confirmação (2 categorias) seja mais fácil que `detect_tool` (3 categorias,
75% na 5b). A resposta não é só "reconhecer o risco" — é reduzir a superfície que precisa do LLM:

1. **Camada 0, palavra-chave, sem custo de inferência.** A grande maioria das confirmações reais
   usa um vocabulário fechado e curto: afirmativas ("sim", "pode", "isso", "exato", "claro",
   "beleza", "confirmo", "manda", "vai", "certo") e negativas ("não", "nao", "cancela", "deixa",
   "esquece", "para", "nunca", "jamais"). Se o texto casar com **um dos dois conjuntos e não o
   outro**, decide ali, sem chamar o modelo — mais rápido que a 5b inteira, porque nem inferência
   tem.
2. **Camada 1, `detectConfirmation` (LLM), só quando a camada 0 não decide** — casou os dois
   conjuntos, nenhum dos dois, ou o texto é longo/ambíguo demais para palavra-chave isolada
   resolver. Aqui sim vale o mesmo argumento da auditoria: é tão difícil quanto `detect_tool`, e
   **H-equivalente de cobertura é medido do mesmo jeito**, mesmo protocolo de congelamento, ver §7.
3. Formato inesperado ou timeout em qualquer camada degrada para `NAO` — fail closed, herdado da
   v1, ver riscos §8.

Isso não elimina o risco que o achado 3 apontou — só o desloca para os casos genuinamente ambíguos,
que são exatamente os que devem custar uma inferência, não os "sim"/"não" triviais que compõem a
maioria real de qualquer confirmação.

**Pending expira em uma tentativa; preempção limpa de graça — inalterado da v1.**

### 4.4 Execução — inalterada, ver v1 §4.4

### 4.5 Armazenamento — inalterado, ver v1 §4.5

---

## 5. Arquivos afetados

Mesma lista da v1, com três acréscimos:

- `src/shared/voiceProtocol.ts` — além de `MUTATION_NAMES`/`MutationName`, agora também
  `MAX_MUTATION_CONTENT_CHARS: 200` (achado 5), e `DETECT_MUTATION_TIMEOUT_MS: 10_000`,
  `DETECT_CONFIRMATION_TIMEOUT_MS: 10_000` **com valor definido** (achado 7 — a v1 só citava os
  nomes).
- `src/backend/tools/mutatingTools.ts` — ganha `selectMutatingToolByAction()` (achado 6, ver §6.4).
- `src/backend/voice/sessionManager.ts` — além do já listado na v1, a camada 0 de palavra-chave
  para confirmação (§4.3) mora aqui, no mesmo módulo do filtro permissivo de mutação — não no
  worker, porque não precisa do LLM.

---

## 6. Pseudocódigo

Seções não tocadas por nenhum achado (`voiceProtocol.ts` para `TOOL_NAMES`/`MUTATION_NAMES`, o
prompt `DETECT_MUTATION_SYSTEM_PROMPT`/`DETECT_CONFIRMATION_SYSTEM_PROMPT` em si — só o parser
mudou, não os prompts) permanecem como na v1 §6.1/§6.2, citadas por referência.

### 6.1 `IMutatingTool` — inalterado, ver v1 §6.1

### 6.2 `worker.py` — parsers corrigidos (achados 4, 5, 9)

`parse_mutation_output` — ver §4.1 para o código completo. `parse_confirmation_output`, ausente na
v1 (achado 9):

```python
YES_WORDS = {"SIM", "PODE", "ISSO", "EXATO", "CLARO", "BELEZA", "CONFIRMO", "MANDA", "VAI", "CERTO"}
NO_WORDS = {"NAO", "CANCELA", "DEIXA", "ESQUECE", "PARA", "NUNCA", "JAMAIS"}

def parse_confirmation_output(raw: str) -> str:
    """Função PURA. Formato inesperado degrada para NAO — fail closed em ação que muta
    estado (ao contrário de parse_tool_output, onde NENHUMA nunca perde dado)."""
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return "SIM" if normalized == "SIM" else "NAO"
```

Nota: este parser só processa a saída do **LLM** (`detectConfirmation`, camada 1 de §4.3) — a
camada 0 por palavra-chave roda inteiramente no Node, antes de qualquer chamada ao worker, e está
em §6.3, não aqui.

### 6.3 `sessionManager.ts` — ordem de gravação corrigida (achados 1, 2, 8) e camada 0 de confirmação (achado 3)

```ts
interface Session {
  // ... campos existentes ...
  pendingMutation: PendingMutation | null; // achado 8 — inicializado explicitamente abaixo
}

function createSession(/* ... */): Session {
  return {
    // ... campos existentes ...
    pendingMutation: null // achado 8
  };
}

const CONFIRM_YES = /\b(sim|pode|isso|exato|claro|beleza|confirmo|manda|vai|certo)\b/;
const CONFIRM_NO = /\b(nao|não|cancela|deixa|esquece|para|nunca|jamais)\b/;

/** Camada 0 de §4.3 — decide sem LLM quando o texto é inequívoco. null = ambíguo, chama a camada 1. */
function keywordConfirmation(transcript: string): 'SIM' | 'NAO' | null {
  const n = normalize(transcript); // mesma normalização de mightBeTemporal (5b)
  const yes = CONFIRM_YES.test(n);
  const no = CONFIRM_NO.test(n);
  if (yes && !no) return 'SIM';
  if (no && !yes) return 'NAO';
  return null; // nenhum dos dois, ou os dois — ambíguo, decide a camada 1
}
```

Dentro de `runTurn`, logo após a transcrição — **antes** do filtro de ferramenta de leitura da 5b:

```ts
if (session.pendingMutation) {
  let confirmed = keywordConfirmation(transcript); // camada 0, sem custo de inferência
  if (confirmed === null) {
    try {
      confirmed = await this.engine.detectConfirmation(turn.turnId, turn.epoch, transcript); // camada 1
    } catch {
      confirmed = 'NAO'; // timeout/erro do worker — fail closed, mesmo padrão da 5b (§4.4 da v1)
    }
  }
  if (session.activeTurn !== turn) return; // cancelado durante a camada 1

  const mutation = session.pendingMutation;
  session.pendingMutation = null;

  let text: string;
  if (confirmed === 'SIM') {
    const tool = selectMutatingToolByAction(mutation.kind, this.mutatingTools); // §6.4
    try {
      text = tool.execute(mutation.content);
    } catch {
      text = MUTATION_FAILURE_TEXT;
    }
  } else {
    text = MUTATION_CANCELLED_TEXT; // frase fixa de cancelamento
  }

  // fala `text`, turn_done, state: ouvindo — mesmo encerramento da 5b (v1 §4.5/§6.3)
  return;
}

// só chega aqui se NÃO havia confirmação pendente — filtro de mutação:
if (this.mutatingTools.length > 0 && mightBeMutation(transcript)) {
  let detected: [string, string | null] = ['NENHUMA', null];
  try {
    detected = await this.engine.detectMutation(turn.turnId, turn.epoch, transcript);
  } catch {
    detected = ['NENHUMA', null]; // falha na detecção cai no caminho normal, mesmo espírito da 5b
  }
  if (session.activeTurn !== turn) return;

  const [action, content] = detected;
  if (action !== 'NENHUMA') {
    const tool = selectMutatingToolByAction(action, this.mutatingTools);
    const question = tool.preview(content);

    this.emit(session, { type: 'routing', turnId: turn.turnId, label: 'GERAL', handled: true });
    this.emit(session, { type: 'state', state: 'falando' });
    turn.expectedSentences.add(0);
    turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, cleanTextForSpeech(question), 0));
    await Promise.allSettled(turn.pendingSynthesis);

    // ACHADOS 1+2 (ALTA) — pendingMutation só é gravado AQUI, depois da síntese ter
    // terminado e com o turno ainda ativo. Um barge-in a qualquer momento antes deste
    // ponto cancela o turno e nunca chega a esta linha — não há estado órfão possível.
    if (session.activeTurn === turn) {
      session.pendingMutation = { kind: action, content, askedAtTurnId: turn.turnId };
      this.emit(session, { type: 'turn_done', turnId: turn.turnId });
      this.emit(session, { type: 'state', state: 'ouvindo' });
      session.activeTurn = null;
    }
    return;
  }
}

// filtro de ferramenta de leitura (Fase 5b), depois classify normal — inalterados
```

### 6.4 `selectMutatingToolByAction` (achado 6, nova)

```ts
/** Deriva o prefixo da ação (LEMBRETE_/NOTA_) e encontra a MESMA instância que trata as duas
 * ações desse prefixo — LembreteTool.execute() sabe distinguir CRIAR de APAGAR pelo kind
 * completo que recebe, não precisa de uma instância por ação. */
export function selectMutatingToolByAction(
  kind: string,
  tools: readonly IMutatingTool[]
): IMutatingTool | null {
  const prefix = kind.split('_')[0]; // 'LEMBRETE' | 'NOTA'
  return tools.find((t) => t.name === prefix && t.isAvailable()) ?? null;
}
```

`LembreteTool.name = 'LEMBRETE'`, `NotaTool.name = 'NOTA'` — cada instância implementa `preview()`/
`execute()` recebendo o `kind` completo (`LEMBRETE_CRIAR`/`LEMBRETE_APAGAR`) para saber qual das
duas ações realizar internamente.

### 6.5 `mlxWorkerEngine.ts` — `detectMutation`/`detectConfirmation` (achado 7, valores e padrão explícitos)

Espelham `detectTool()` da 5b (`docs/phase-5b-v5.md` §6.4) linha a linha: mesmo `pending` Map, mesmo
timeout **sem** `this.child?.kill('SIGKILL')` (ambas são operações auxiliares e descartáveis, exato
raciocínio do achado 1 da rodada 4 da 5b — se o worker estiver de fato travado, a próxima operação
que **precisa** ser catastroficamente segura, `classify`/`generate`, é quem cuida disso). Valores:
`DETECT_MUTATION_TIMEOUT_MS: 10_000`, `DETECT_CONFIRMATION_TIMEOUT_MS: 10_000` — mesmo tamanho de
tarefa (uma ou poucas palavras) que `CLASSIFY_TIMEOUT_MS`/`DETECT_TOOL_TIMEOUT_MS`.

---

## 7. Critérios de aceite

Automatizados — mesma lista da v1 §7, mais:
- `parse_mutation_output`: conteúdo contendo `|`, conteúdo vazio, conteúdo acima de
  `MAX_MUTATION_CONTENT_CHARS` — todos degradam para `NENHUMA` (achados 4, 5).
- `keywordConfirmation`: cobre os dois conjuntos, retorna `null` quando nenhum ou os dois casam
  (achado 3, camada 0).
- `selectMutatingToolByAction`: `LEMBRETE_CRIAR`/`LEMBRETE_APAGAR` → mesma instância de
  `LembreteTool`; `NOTA_*` → `NotaTool`; ação desconhecida → `null` (achado 6).
- **Teste de regressão direto do achado 1:** turno que detecta mutação e é cancelado
  (`activeTurn !== turn`) **antes** de `pendingMutation` ser gravado — sessão termina com
  `pendingMutation === null`, nunca órfão.
- `pendingMutation: null` na criação de sessão (achado 8).

Manuais, com MLX real: mesmo protocolo de congelamento da v1 §7 — prompts (incluindo o de
confirmação) congelados por commit antes de qualquer amostra; **cobertura de confirmação medida
como H-equivalente próprio**, separado da cobertura de detecção de mutação (achado 3), porque são
duas capacidades diferentes com taxas de erro possivelmente diferentes.

---

## 8. Riscos

Tabela da v1 §8, com uma linha atualizada:

| Risco | Prob. | Mitigação |
|---|---|---|
| `detectConfirmation` (camada 1) herdar a mesma dificuldade que deixou `detect_tool` em 75% (achado 3) | Média — reconhecido, não eliminado | Camada 0 por palavra-chave resolve a maioria dos casos sem inferência nenhuma (§4.3); H-equivalente próprio medido antes de aprovar a fase |
| Estado órfão por barge-in durante a síntese da pergunta de confirmação (achados 1, 2) | Baixa agora | `pendingMutation` só é gravado depois da síntese confirmada + turno ainda ativo (§6.3) — corrigido por construção, não por checagem adicional |

Demais linhas da v1 (extração de conteúdo, escrita concorrente, filtro permissivo amplo, escopo
crescer) inalteradas.

---

## 9. Rastreabilidade

- v1 (REJEITADO, Hermes, rodada 1), v2 (esta).
- Segue para rodada 2 de auditoria — por rotação, um auditor diferente do que julgou a v1 (Hermes),
  já que a v1 não é a única rodada desta fase ainda: Codex ou agy, nenhum dos dois julgou este
  desenho ainda.
- Sem implementação até aprovação — mesmo processo da 5b.
