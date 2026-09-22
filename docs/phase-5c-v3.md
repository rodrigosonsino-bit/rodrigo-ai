# Fase 5c — Ações que mutam estado (lembretes e notas) — v3

Versão: v3
Data: 2026-09-22
Base: commit `01739f3`
Antecessora: v2 (REJEITADO — 2 achados ALTA novos, 6 média/baixa; os 8 achados da rodada 1 foram
confirmados corrigidos por execução real, exceto uma contradição introduzida na correção do 6).

---

## 0. Escopo — inalterado, ver v1 §0

---

## 1. A segunda rejeição, e os achados que esta versão corrige

`agy` / Gemini (rodada 2, `--mode plan`, com execução real de trechos de regex/parser) confirmou por
execução que os 8 achados da rodada 1 foram corrigidos — inclusive rodou `parse_mutation_output`
contra `|` dentro do conteúdo, vazio, e acima do teto, todos corretos. Achou 2 problemas novos ALTA
(um deles a própria correção da rodada 1 introduziu, na camada de palavra-chave; o outro é uma
lacuna que nenhuma rodada anterior tinha atacado, numa função **existente e compartilhada** do
projeto) e 6 média/baixa. Log completo:
`docs/audits/phase-5c-v2-agy-2026-09-22.log`.

| # | Achado | Gravidade | Resolvido em |
|---|---|---|---|
| 1 | `keywordConfirmation` (camada 0, introduzida na v2 para resolver o achado 3 da rodada 1) usa casamento de substring — "Isso tá errado" e "Pode esquecer" (recusas) casam em `CONFIRM_YES` e executam a mutação sem confirmação real; "Para mim está bom" (aprovação) casa em `CONFIRM_NO` | ALTA | §4.3, §6.3 |
| 2 | `synthesizeSentence` (`sessionManager.ts:393-400`, função existente da Fase 2, compartilhada por todo o projeto) engole qualquer falha de síntese — cancelamento ou erro real de TTS — sem distinguir os dois; `Promise.allSettled` resolve como sucesso mesmo se o áudio nunca saiu, e `pendingMutation` era gravado mesmo sem o usuário ter ouvido a pergunta | ALTA | §4.3, §6.3 (helper dedicado, sem tocar `synthesizeSentence`) |
| 3 | Contradição entre `IMutatingTool` (só recebe `content`) e o texto da v2 §6.4 (dizia que a ferramenta recebe o `kind` completo) — nenhuma das duas chamadas em §6.3 passava `kind` | MÉDIA | §6.1, §6.3 |
| 4 | `tool.preview(content)` chamado sem checar `null` de `selectMutatingToolByAction` — ferramenta ausente/indisponível derrubaria a sessão com `TypeError` | MÉDIA | §6.3 |
| 5 | `mightBeMutation` citado desde a v1 mas nunca especificado (regex, vocabulário, critério de aceite) | MÉDIA | §4.2 (reescrita com regex real), §7 |
| 6 | `jsonStore` sem injeção de diretório — testes automatizados escreveriam em `data/` real em vez de um diretório temporário isolado | MÉDIA | §6.6 (nova) |
| 7 | `MUTATION_FAILURE_TEXT`/`MUTATION_CANCELLED_TEXT` citadas mas sem texto literal definido | BAIXA | §6.3 |
| 8 | `max_tokens` de `detect_mutation` não especificado no worker | BAIXA | §6.2 |

**Achado informal, sem bloco `ACHADO` próprio no log mas presente na análise da Parte A (achados
1+2):** `pendingMutation` não tem expiração por tempo — um usuário que mudar de assunto minutos
depois de ouvir a pergunta teria a fala seguinte tratada como confirmação. Corrigido por precaução
em §4.3/§6.3 (TTL de 60s), mesmo sem ter virado achado formal.

Nenhum achado atacou §2 (Premissa) ou §3 (Escopo) — inalterados.

---

## 2. Premissa da fase — inalterada, ver v1 §2

---

## 3. Escopo — inalterado, ver v1 §3

---

## 4. Decisões de projeto

### 4.1 `detect_mutation` — inalterado quanto ao parser (v2 §4.1, confirmado correto por execução); `max_tokens` especificado (achado 8)

`parse_mutation_output` permanece exatamente como na v2 (a rodada 2 rodou de verdade contra `|` no
conteúdo, vazio, e acima do teto — todos corretos). Único acréscimo: `handle_detect_mutation()`
chama `stream_generate(..., max_tokens=96, ...)` — folga sobre `MAX_MUTATION_CONTENT_CHARS=200`
(~200 caracteres em português ficam abaixo de 96 tokens na prática, mas a ação (`LEMBRETE_CRIAR|`)
também consome tokens; 96 é generoso o bastante sem abrir espaço para o modelo divagar).

### 4.2 Filtro permissivo — especificado (achado 5)

A v1/v2 descreviam a decisão ("lista maior de verbos de escrita/memória") sem nunca mostrar a
lista. Rascunho, a refinar se a auditoria seguinte achar cobertura insuficiente:

```ts
const MUTATION_GATE =
  /\b(lembr|anot|guard|escrev|salv|apag|esquec|cancel|nota|lembrete|aviso|tarefa|compromisso)\w*\b/;
```

Prefixos de radical (`lembr`, `anot`, `guard`...), não palavras inteiras — cobre conjugações
(lembra, lembrar, lembrei, lembrete) sem precisar listar cada forma verbal, mesma técnica que a 5b
usou implicitamente ao incluir `dia|dias` (plural) na `TIME_GATE`. Mesma normalização de
`mightBeTemporal` (minúsculas, sem acento). Critério de aceite equivalente ao H1 da 5b, em §7.

### 4.3 Confirmação — camada 0 reescrita como whitelist exata (achado 1); gravação de `pendingMutation` condicionada a entrega real da síntese (achado 2); TTL adicionado

**Achado 1 (ALTA) — por que o desenho anterior falhava, e por que este não repete o erro:** a v2
testava se **qualquer palavra** da frase casava com um conjunto de afirmação/negação — "isso",
"pode", "vai", "para" são comuns demais e aparecem em frases que significam o oposto do que a
palavra isolada sugere. **Correção:** a camada 0 deixa de fazer busca de substring e passa a ser uma
whitelist de **enunciados inteiros e curtos**, ancorada do início ao fim — se a frase inteira
(normalizada) não for exatamente uma dessas, cai para a camada 1 (LLM), nunca decide por parecença:

```ts
const CONFIRM_YES_EXACT = new Set([
  'sim', 'claro', 'confirmo', 'certo', 'exato', 'exatamente', 'positivo', 'isso mesmo',
  'pode confirmar', 'com certeza'
]);
const CONFIRM_NO_EXACT = new Set([
  'nao', 'cancela', 'jamais', 'nunca', 'negativo', 'deixa pra la', 'esquece isso', 'nao quero'
]);

/** Camada 0 de §4.3 — só decide sobre o ENUNCIADO INTEIRO normalizado, nunca por substring.
 * "Isso tá errado" e "Pode esquecer" não casam em nenhum conjunto (correto — vão pra
 * camada 1). "Cancela isso por favor" também não casa (tem palavras extras) — mesma
 * segurança: melhor gastar uma inferência do que arriscar um falso positivo. */
function keywordConfirmation(transcript: string): 'SIM' | 'NAO' | null {
  const n = normalize(transcript).replace(/[.!?]+$/, '').trim(); // mesma normalização da 5b
  if (CONFIRM_YES_EXACT.has(n)) return 'SIM';
  if (CONFIRM_NO_EXACT.has(n)) return 'NAO';
  return null;
}
```

Verificado manualmente contra os quatro casos que derrubaram a v2: `"Isso tá errado"` → `null`
(correto, vai pra camada 1); `"Pode esquecer"` → `null` (correto); `"Para mim está bom"` → `null`
(correto — antes dava `NAO` errado); `"Sim"`/`"Não"`/`"Cancela"` → decidem na camada 0, sem
inferência, como antes.

**Achado 2 (ALTA) — gravação condicionada à entrega real:** `synthesizeSentence` (Fase 2,
`sessionManager.ts:393-400`) engole qualquer falha — cancelamento ou erro real de TTS — porque isso
é seguro para o caminho normal (nunca há estado pendente em jogo além do turno atual). Não é seguro
aqui. **Em vez de alterar `synthesizeSentence`** (função compartilhada por toda a base, mudar sua
semântica arrisca todas as fases anteriores por um problema que só a 5c tem), a pergunta de
confirmação usa um helper dedicado que devolve se a entrega realmente aconteceu — ver pseudocódigo
completo em §6.3. `pendingMutation` só é gravado se esse helper retornar `true`.

**TTL de 60s, adicionado por precaução (achado informal §1):**

```ts
interface PendingMutation {
  kind: MutationName;
  content: string | null;
  askedAtTurnId: string;
  askedAt: number; // Date.now() no momento em que a pergunta foi confirmadamente entregue
}

const PENDING_MUTATION_TTL_MS = 60_000;
```

Ao consumir `pendingMutation` no turno seguinte, se `Date.now() - pendingMutation.askedAt >
PENDING_MUTATION_TTL_MS`, trata como expirado: limpa sem executar nada e segue para o caminho
normal, como se não houvesse pending — o usuário que demorou a responder não tem uma fala não
relacionada interpretada como confirmação.

### 4.4 Execução — inalterada, ver v1 §4.4

### 4.5 Armazenamento — inalterado quanto ao formato; injeção de diretório em §6.6 (achado 6)

---

## 5. Arquivos afetados

Mesma lista da v2, com ajustes:

- `src/backend/storage/jsonStore.ts` — construtor recebe `baseDir: string` **obrigatório** (achado
  6), mesmo padrão de `AudioStore` (`audioStore.ts:14-16`) — não é opcional com default, é injetado
  por quem constrói.
- `src/backend/voice/voiceRuntime.ts` — passa o `baseDir` real (`data/`, resolvido a partir da raiz
  do projeto) ao construir `jsonStore`; os testes (`mutatingTools.test.ts`, `storage.test.ts`)
  passam um diretório de `fs.mkdtempSync`, nunca `data/` real.
- `src/shared/voiceProtocol.ts` — além do já listado, `MUTATION_FAILURE_TEXT`,
  `MUTATION_CANCELLED_TEXT` com texto literal (achado 7), `PENDING_MUTATION_TTL_MS`.
- `src/backend/tools/mutatingTools.ts` — `IMutatingTool` corrigida (achado 3, ver §6.1).

---

## 6. Pseudocódigo

Seções inalteradas por qualquer achado (`worker.py` prompts em si, `parse_mutation_output`,
`selectMutatingToolByAction` quanto à derivação de prefixo) permanecem como na v2, citadas por
referência.

### 6.1 `IMutatingTool` — corrigida (achado 3)

```ts
export interface IMutatingTool {
  readonly name: string; // 'LEMBRETE' | 'NOTA'
  readonly description: string;
  isAvailable(): boolean;
  /** Recebe o kind completo (ex.: 'LEMBRETE_CRIAR') — a ferramenta decide internamente
   * qual das duas ações realizar. Corrige achado 3: a v2 dizia isso em prosa mas a
   * interface só tinha `content`. */
  preview(kind: MutationName, content: string | null): string;
  execute(kind: MutationName, content: string | null): string;
}
```

### 6.2 `worker.py` — `max_tokens` especificado (achado 8); `parse_confirmation_output` sem código morto

```python
# handle_detect_mutation(): stream_generate(..., max_tokens=96, ...) — achado 8.

def parse_confirmation_output(raw: str) -> str:
    """Função PURA. Formato inesperado degrada para NAO — fail closed.
    (Achado da rodada 2, observação menor: a v2 tinha YES_WORDS/NO_WORDS aqui, nunca
    usados pela função — removidos. Essa semântica pertence à camada 0, em Node,
    keywordConfirmation, não ao parser da saída do LLM.)"""
    normalized = (raw or "").strip().upper().strip(".!? \n")
    return "SIM" if normalized == "SIM" else "NAO"
```

### 6.3 `sessionManager.ts` — camada 0 reescrita (achado 1), gravação condicionada (achado 2), interface corrigida (achado 3), guarda de `null` (achado 4), textos literais (achado 7), TTL

```ts
// Ver §4.3 para keywordConfirmation, CONFIRM_YES_EXACT/CONFIRM_NO_EXACT, PendingMutation com askedAt.

if (session.pendingMutation) {
  const expired = Date.now() - session.pendingMutation.askedAt > PENDING_MUTATION_TTL_MS;
  if (expired) {
    session.pendingMutation = null;
    // segue para o caminho normal abaixo, como se não houvesse pending
  } else {
    let confirmed = keywordConfirmation(transcript); // camada 0, whitelist exata (§4.3)
    if (confirmed === null) {
      try {
        confirmed = await this.engine.detectConfirmation(turn.turnId, turn.epoch, transcript);
      } catch {
        confirmed = 'NAO'; // fail closed
      }
    }
    if (session.activeTurn !== turn) return;

    const mutation = session.pendingMutation;
    session.pendingMutation = null;

    let text: string;
    if (confirmed === 'SIM') {
      const tool = selectMutatingToolByAction(mutation.kind, this.mutatingTools);
      if (!tool) {
        text = MUTATION_FAILURE_TEXT; // achado 4 — nunca chama .execute() em null
      } else {
        try {
          text = tool.execute(mutation.kind, mutation.content); // achado 3 — kind completo
        } catch {
          text = MUTATION_FAILURE_TEXT; // achado 7 — texto literal definido em voiceProtocol.ts
        }
      }
    } else {
      text = MUTATION_CANCELLED_TEXT; // achado 7
    }

    // fala `text`, turn_done, state: ouvindo — mesmo encerramento da 5b
    return;
  }
}

// filtro de mutação (só chega aqui sem pending, ou com pending expirado):
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
    if (!tool) {
      // achado 4 — ferramenta ausente/indisponível: não trava a sessão, cai no caminho normal
    } else {
      const question = tool.preview(action, content); // achado 3 — kind completo

      this.emit(session, { type: 'routing', turnId: turn.turnId, label: 'GERAL', handled: true });
      this.emit(session, { type: 'state', state: 'falando' });

      // Achado 2 (ALTA) — helper dedicado, NÃO synthesizeSentence (Fase 2), porque aqui
      // precisamos saber se a entrega realmente aconteceu antes de gravar pendingMutation.
      const delivered = await this.synthesizeConfirmationQuestion(
        session, turn, cleanTextForSpeech(question)
      );

      if (session.activeTurn === turn) {
        if (delivered) {
          session.pendingMutation = {
            kind: action, content, askedAtTurnId: turn.turnId, askedAt: Date.now()
          };
        }
        // delivered === false: síntese falhou (não cancelamento — session.activeTurn === turn
        // ainda é verdade) — encerra o turno SEM gravar pendingMutation. O usuário não ouviu
        // nada; não há nada pendente para responder.
        this.emit(session, { type: 'turn_done', turnId: turn.turnId });
        this.emit(session, { type: 'state', state: 'ouvindo' });
        session.activeTurn = null;
      }
      return;
    }
  }
}

// filtro de ferramenta de leitura (Fase 5b), depois classify normal — inalterados
```

Helper novo, dedicado (achado 2 — não reusa nem modifica `synthesizeSentence`):

```ts
/** Variante de synthesizeSentence (Fase 2) para a pergunta de confirmação de mutação: ao
 * contrário da original, esta PRECISA distinguir sucesso de falha, porque pendingMutation só
 * pode ser gravado se o usuário de fato ouviu a pergunta. synthesizeSentence engole ambos os
 * casos (cancelamento e erro real de TTS) de propósito — correto para o caminho normal, onde
 * nunca há estado pendente em jogo; não aqui. */
private async synthesizeConfirmationQuestion(
  session: Session, turn: ActiveTurn, text: string
): Promise<boolean> {
  const { audioId, filePath } = this.audioStore.newOutputPath(session.id);
  try {
    await this.ttsProvider.synthesize(text, filePath, turn.abortController.signal);
  } catch {
    return false; // cancelado OU falhou — de qualquer forma, pergunta não foi entregue
  }
  if (session.activeTurn !== turn) return false; // superado enquanto sintetizava
  turn.expectedSentences.add(0);
  this.emit(session, {
    type: 'sentence_audio_ready', turnId: turn.turnId, sentenceIndex: 0, audioId, text
  });
  return true;
}
```

### 6.4 `selectMutatingToolByAction` — inalterada, ver v2 §6.4

### 6.5 `mlxWorkerEngine.ts` — inalterada, ver v2 §6.5

### 6.6 `jsonStore.ts` — injeção de diretório (achado 6, nova)

```ts
export class JsonStore<T> {
  private readonly filePath: string;

  /** baseDir é OBRIGATÓRIO — mesmo padrão de AudioStore (audioStore.ts:14-16). Produção
   * recebe data/ real (voiceRuntime.ts); testes recebem fs.mkdtempSync(), nunca escrevem
   * no diretório real do projeto (achado 6 da rodada 2). */
  constructor(baseDir: string, fileName: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, fileName);
  }

  read(): { items: T[] } {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch {
      return { items: [] }; // arquivo ausente no início — v1 §7, inalterado
    }
  }

  write(data: { items: T[] }): void {
    const tmp = `${this.filePath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath); // atômico no mesmo filesystem — v1 §4.5, inalterado
  }
}
```

`LembreteTool`/`NotaTool` recebem `JsonStore` já construído (injeção de dependência, não constroem
o próprio caminho) — `voiceRuntime.ts` decide o `baseDir` uma vez, `path.join(projectRoot, 'data')`.

---

## 7. Critérios de aceite

Automatizados — lista da v2 §7, mais:

- `keywordConfirmation`: os quatro casos que derrubaram a v2 (`"Isso tá errado"`,
  `"Pode esquecer"`, `"Para mim está bom"` → `null`; `"Cancela isso por favor"` → `null`) e os
  casos que devem continuar decidindo na camada 0 (`"Sim"`, `"Não"`, `"Cancela"`, `"Claro"`).
- **Teste de regressão direto do achado 2:** `FakeVoiceEngine`/fake de TTS configurado para lançar
  na síntese da pergunta de confirmação — turno termina **sem** `pendingMutation` gravado, e sem
  crash da sessão.
- `mightBeMutation` (`MUTATION_GATE`, §4.2): H-equivalente de H1 da 5b — cobre os verbos/radicais
  listados, não dispara em frases de domínio (Teologia/Virtologia) sem intenção de mutação.
- `jsonStore`: instanciado com `fs.mkdtempSync()` em todos os testes — nenhum teste automatizado
  escreve em `data/` real (achado 6).
- `selectMutatingToolByAction` retornando `null` não derruba a sessão — cai no caminho normal
  (achado 4).
- Nenhuma regressão em nenhum teste das fases 1-5b.

Manuais, com MLX real — inalterado da v2 §7 (protocolo de congelamento próprio, H-equivalente de
cobertura de detecção de mutação e de confirmação medidos separadamente).

---

## 8. Riscos

Tabela da v2 §8, com uma linha atualizada e uma nova:

| Risco | Prob. | Mitigação |
|---|---|---|
| Camada 0 de confirmação decidir errado por parecença de substring (achado 1) | Baixa agora | Whitelist exata e ancorada ao enunciado inteiro — qualquer coisa fora da lista cai para o LLM, nunca decide por semelhança |
| Estado órfão por falha silenciosa de síntese (achado 2) | Baixa agora | Helper dedicado que reporta entrega real; `pendingMutation` condicionado a `delivered === true` |
| `jsonStore` sem isolamento em teste escrever em dado real do usuário (achado 6) | Baixa agora | `baseDir` obrigatório no construtor, mesmo padrão já usado por `AudioStore` |

Demais linhas da v2 inalteradas.

---

## 9. Rastreabilidade

- v1 (REJEITADO, Hermes), v2 (REJEITADO, agy), v3 (esta).
- Segue para rodada 3 — por rotação, Codex (ainda não julgou nenhuma versão desta fase; Hermes e
  agy já julgaram uma cada).
- Sem implementação até aprovação.
