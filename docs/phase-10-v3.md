# Fase 10a — Provedor de geração em nuvem (Gemini) — v3

Versão: v3
Data: 2026-09-28
Status: Rascunho, correções mecânicas da rodada 2 aplicadas — aguardando decisão do usuário
sobre nova rodada de auditoria vs. implementação direta.
Base: Corrige os 5 achados da rodada 2 (agy) sobre o v2 (`docs/audits/phase-10-v2-agy-rodada2-2026-09-28.log`,
veredito REJEITADO — 1 CRÍTICA, 1 ALTA, 1 MÉDIA, 2 BAIXA). Os 10 achados da rodada 1 permanecem
resolvidos como no v2 — a rodada 2 confirmou explicitamente 9 deles e apenas reabriu o achado 6
(cliente único) por uma consequência não percebida do próprio v2.

## 0. Escopo combinado com o usuário — inalterado da v1/v2

## 1. Objetivo — inalterado da v1/v2

## 2. A premissa da fase — inalterado da v1/v2

## 3. Escopo — inalterado da v1/v2

## 4. Decisões de projeto

### 4.1 Dependência nova — inalterado do v2 (achado 8 da rodada 1, confirmado resolvido na
rodada 2)

`google-genai` em `scripts/worker/requirements.in`.

### 4.2 Conversão de formato de mensagens — inalterado do v2, com um guard novo (achado novo
MÉDIA da rodada 2)

`to_gemini_contents()` idêntica ao v2 (coalescing de papéis, separação do system prompt por
papel), **mais uma validação explícita** para o caso em que o prefixo não-`user` esvazia
`contents` por completo (a rodada 2 confirmou que isso não acontece em runtime real — o último
item de `session.history` antes de `engine.generate()` é sempre `user`, `sessionManager.ts:376`
— mas pode acontecer em teste unitário sintético sem nenhuma mensagem `user`; enviar
`contents=[]` pro Gemini gera HTTP 400 sem nenhum erro semântico apontando a causa):

```python
def to_gemini_contents(messages: list[dict]) -> tuple[str, list[dict]]:
    """Separa o system prompt (identificado pelo papel 'system', em qualquer posição — não
    assume messages[0]) do resto, e consolida mensagens consecutivas do mesmo papel num único
    `content` com múltiplas `parts` — a API do Gemini exige alternância estrita user/model, e
    o histórico do Rodrigo grava cada frase falada como uma entrada 'assistant' separada
    (sessionManager.ts markPlayed()), então respostas de mais de uma frase e barge-ins geram
    sequências de papel repetido que precisam ser fundidas, não enviadas cruas."""
    system_parts = [m["content"] for m in messages if m["role"] == "system"]
    system_instruction = "\n\n".join(system_parts)

    non_system = [m for m in messages if m["role"] != "system"]

    contents: list[dict] = []
    for m in non_system:
        role = "model" if m["role"] == "assistant" else "user"
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].append({"text": m["content"]})
        else:
            contents.append({"role": role, "parts": [{"text": m["content"]}]})

    # A API do Gemini exige que o primeiro content seja 'user' — se o histórico (caso raro,
    # praticamente só em teste) começar com 'model', descarta esse prefixo em vez de mandar uma
    # requisição malformada.
    while contents and contents[0]["role"] != "user":
        contents.pop(0)

    # Achado novo MÉDIA (rodada 2): o pop acima pode esvaziar `contents` por completo (nenhuma
    # mensagem 'user' em todo o histórico) — na prática só ocorre em teste unitário sintético
    # (em runtime real o último item de session.history antes de generate() é sempre 'user',
    # sessionManager.ts:376), mas enviar contents=[] pro Gemini gera HTTP 400 sem nenhuma
    # indicação da causa real. Falha explícita e cedo, aqui, é mais barato de depurar.
    if not contents:
        raise ValueError(
            "to_gemini_contents: histórico não contém nenhuma mensagem 'user' — nada para "
            "enviar ao Gemini."
        )

    return system_instruction, contents
```

### 4.3 `handle_generate()` — corrigido (achado CRÍTICA reaberto e achado ALTA novo da rodada 2)

**Achado reaberto (CRÍTICA, confiança 100%, rodada 2)**: o v2 instanciava `self._gemini_client =
genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""), ...)` dentro do `__init__` do
`Worker`. A rodada 2 apontou, e eu confirmei lendo `scripts/worker/worker.py:327-336`, que:

1. No SDK `google-genai`, `genai.Client(api_key="")` levanta `ValueError: Missing key inputs
   argument!` imediatamente na construção — não é um erro adiado pra hora da chamada de rede.
2. `worker = Worker()` roda em `main()` (`scripts/worker/worker.py:787`) **fora de qualquer
   try/except**. Se o processo subir sem `GEMINI_API_KEY` no ambiente (primeiro boot antes do
   `.env` ser configurado, ambiente de teste, etc.), o worker inteiro aborta com traceback não
   capturado **antes de carregar Whisper e Qwen3 e antes de abrir a thread de stdin** — derruba
   STT e classificação, que deveriam continuar 100% locais e resilientes independente do Gemini.
3. Isso também contradiz o padrão real do próprio arquivo: `__init__` hoje só inicializa
   atributos como `None` (`self._llm = None`, `self._llm_tokenizer = None`, `self._stt = None`)
   — todo carregamento pesado acontece depois, em `load_models()`/sob demanda. O v2 quebrou essa
   convenção sem necessidade.

Corrigido com inicialização preguiçosa (*lazy*), seguindo o mesmo padrão já existente no arquivo
— o cliente só é construído na primeira chamada real de `handle_generate()`, depois que a
presença da chave já foi validada:

```python
class Worker:
    def __init__(self) -> None:
        self.work_queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=1)
        self._current: Optional[GenerationHandle] = None
        self._current_lock = threading.Lock()
        self._llm = None
        self._llm_tokenizer = None
        self._stt = None
        self._mx = None
        self._gemini_client = None  # lazy — ver handle_generate()


def handle_generate(self, msg: dict[str, Any]) -> None:
    req_id = msg["reqId"]; turn_id = msg["turnId"]; epoch = msg["epoch"]; messages = msg["messages"]

    handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
    with self._current_lock:
        self._current = handle

    try:
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY ausente — configure a variável de ambiente.")

        if self._gemini_client is None:
            # Achado CRÍTICA reaberto (rodada 2): import e construção tardios — nunca no
            # __init__ nem no topo do módulo (o mesmo padrão de lazy import que mlx.core/mlx_lm
            # já seguem hoje, achado novo BAIXA da rodada 2 também cobre isso). Se a chave
            # estiver ausente, o RuntimeError acima já interrompeu antes de chegar aqui — o
            # cliente nunca é construído com api_key vazia.
            from google import genai
            self._gemini_client = genai.Client(
                api_key=os.environ["GEMINI_API_KEY"],
                http_options=genai.types.HttpOptions(timeout=20_000),  # 20s — bem abaixo do
                # timeout de 60s do Node (VOICE_LIMITS.TURN_TIMEOUT_MS), pra que uma falha de
                # rede emita "error" NDJSON e libere o turno, em vez de deixar o Node matar o
                # worker inteiro com SIGKILL por uma causa que não é travamento de GPU.
            )

        system_instruction, contents = to_gemini_contents(messages)

        buffer = ""
        sentence_index = 0
        emitted_normalized: list[str] = []
        loop_detected = False

        stream = self._gemini_client.models.generate_content_stream(
            model="gemini-flash-latest",
            contents=contents,
            config=genai.types.GenerateContentConfig(
                system_instruction=system_instruction,
                max_output_tokens=MAX_TURN_TOKENS,  # Achado ALTA novo (rodada 2) — ver abaixo
            ),
        )

        for chunk in stream:
            if handle.cancel_event.is_set():
                log_diag(f"Geração cancelada (turnId={turn_id}) — parando de consumir o stream do Gemini.")
                break  # achado 3 (rodada 1) — sem stream.close(), método inexistente no SDK

            buffer += chunk.text or ""

            # EXATAMENTE o mesmo laço de find_sentence_boundary/emit/dedupe já existente e
            # testado — reaproveitado sem mudança, só a origem de `buffer` mudou:
            boundary = find_sentence_boundary(buffer)
            while boundary is not None:
                sentence = buffer[:boundary].strip()
                buffer = buffer[boundary:]
                if sentence:
                    if _is_near_duplicate_sentence(sentence, emitted_normalized):
                        loop_detected = True
                        break
                    emit({"event": "sentence", "reqId": req_id, "turnId": turn_id,
                          "index": sentence_index, "text": sentence})
                    emitted_normalized.append(_normalize_for_dedup(sentence))
                    sentence_index += 1
                boundary = find_sentence_boundary(buffer)
            if loop_detected:
                break

        if not handle.cancel_event.is_set():
            # Achado 2 (CRÍTICA, rodada 1): "done" é emitido INCONDICIONALMENTE aqui — um loop
            # detectado é fim natural da resposta, mesma semântica do código local hoje
            # (worker.py:699-713), não uma falha que deveria travar o protocolo NDJSON.
            if not loop_detected:
                leftover = buffer.strip()
                if leftover and not _is_near_duplicate_sentence(leftover, emitted_normalized):
                    emit({"event": "sentence", "reqId": req_id, "turnId": turn_id,
                          "index": sentence_index, "text": leftover})
            emit({"event": "done", "reqId": req_id, "turnId": turn_id})

    except Exception as exc:  # noqa: BLE001 — chave ausente, timeout de rede (20s, acima),
                                # erro de cota/API do Gemini, ValueError de to_gemini_contents —
                                # todos tratados igual: erro honesto
        log_diag(f"Erro na geração via Gemini: {exc}\n{traceback.format_exc()}")
        emit({"event": "error", "reqId": req_id, "turnId": turn_id,
              "message": "Falha ao gerar resposta via Gemini."})
    finally:
        with self._current_lock:
            if self._current is handle:
                self._current = None
```

**Achado novo (ALTA, confiança 95%, rodada 2) — `max_output_tokens` ausente**: o v2 afirmava
("`Nenhuma mudança em MAX_TURN_TOKENS` — inalterado da v1, específico do laço de amostragem
local, não se aplica ao Gemini") que a constante era exclusiva do laço local. **Isso é falso** —
confirmei lendo `scripts/worker/worker.py:206,644,656,696`: `MAX_TURN_TOKENS = 160` é hoje um
teto real de tamanho de resposta, ligado à segurança do pipeline de voz inteiro, não um detalhe
de amostragem MLX. Sem um teto equivalente do lado do Gemini, uma resposta anormalmente longa
(500-1000 tokens) geraria 15-25 frases sequenciais no TTS (`sessionManager.ts:628`), facilmente
estourando o timeout de 60s do Node (`VOICE_LIMITS.TURN_TIMEOUT_MS`) e derrubando o worker com
`SIGKILL` no meio de uma resposta real — o mesmo regime de falha catastrófica que o achado 2 da
rodada 1 já identificou para o caso do loop detectado, só que por um caminho diferente (resposta
longa em vez de repetição). Corrigido: `max_output_tokens=MAX_TURN_TOKENS` passado no
`GenerateContentConfig` (visível no bloco de código acima) — reaproveita a mesma constante já
usada no laço local, mantendo o teto simétrico entre os dois provedores.

**Achado novo (BAIXA, confiança 90%, rodada 2) — local do import de `google.genai`**: `worker.py`
importa bibliotecas externas pesadas (`mlx.core`, `mlx_lm`, `mlx_whisper`) de forma tardia,
dentro de métodos — isso permite que scripts de teste como `scripts/worker/test_repetition_detector.py`
importem funções puras de `worker.py` com o interpretador padrão, sem exigir o venv completo. Já
resolvido no bloco acima: `from google import genai` fica dentro do bloco `if self._gemini_client
is None:` de `handle_generate()`, nunca no topo do módulo — mesma convenção do resto do arquivo.

### 4.4 Erro honesto falado — inalterado do v2 (achados 4 ALTA e 10 BAIXA da rodada 1,
confirmados resolvidos na rodada 2)

```ts
// sessionManager.ts, runTurn() — try/catch específico ao redor de engine.generate():
try {
  await this.engine.generate(turn.turnId, turn.epoch, messagesForEngine, {
    onSentence: (rawText, index) => { /* inalterado */ }
  });
} catch (err) {
  if (session.activeTurn !== turn) return;

  if (turn.expectedSentences.size === 0) {
    const text = GENERATION_FAILURE_TEXT;
    turn.expectedSentences.add(0);
    turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, text, 0));
  } else {
    console.error(`[generate] Gemini falhou no meio do streaming (turnId=${turn.turnId}) — encerrando com o que já foi dito.`, err);
  }
  // segue pro Promise.allSettled(turn.pendingSynthesis) e turn_done normalmente, nos dois casos.
}
```

### 4.5 `README.md`/`CLAUDE.md` — inalterado da v1/v2

### 4.6 Métrica de latência do Gemini (achado novo BAIXA, rodada 2)

A rodada 2 apontou que a meta de H9 (ponta a ponta) mistura STT + classificação + rede + TTS,
dificultando diagnosticar se um estouro veio do Gemini ou de outra etapa. Registrar, em
`log_diag` (stderr, diagnóstico técnico — nunca no protocolo NDJSON stdout), o tempo até o
primeiro `chunk` recebido do Gemini (Time-to-First-Chunk), sem meta formal de aceite nova — é
instrumentação de diagnóstico, não um critério H adicional (evitar inflar o escopo por um achado
BAIXA):

```python
gemini_call_started = time.monotonic()
first_chunk_logged = False
for chunk in stream:
    if not first_chunk_logged:
        log_diag(f"Gemini TTFC: {time.monotonic() - gemini_call_started:.2f}s (turnId={turn_id})")
        first_chunk_logged = True
    ...
```

## 5. Arquivos afetados

```
scripts/worker/requirements.in            nova dependência: google-genai (achado 8, rodada 1)
scripts/worker/worker.py                  self._gemini_client = None no __init__, construído sob
                                           demanda em handle_generate() após validar a chave
                                           (achado CRÍTICA reaberto, rodada 2); import tardio de
                                           google.genai dentro do método, nunca no topo do módulo
                                           (achado BAIXA, rodada 2); max_output_tokens=
                                           MAX_TURN_TOKENS no GenerateContentConfig (achado ALTA,
                                           rodada 2); to_gemini_contents() com guard contra
                                           contents vazio (achado MÉDIA, rodada 2), coalescing de
                                           papéis e sem assumir posição fixa (achados 1, 5, rodada
                                           1); handle_generate() com emit("done") incondicional
                                           (achado 2, rodada 1), sem stream.close() inexistente
                                           (achado 3, rodada 1); log_diag de TTFC (achado BAIXA,
                                           rodada 2)
src/shared/voiceProtocol.ts               GENERATION_FAILURE_TEXT
src/backend/voice/sessionManager.ts       try/catch específico ao redor de engine.generate(),
                                           condicional a expectedSentences.size (achado 4, rodada
                                           1), return em vez de throw (achado 10, rodada 1)
.env.example                              GEMINI_API_KEY documentada
README.md                                 remove a afirmação de "100% offline" durante a conversa
CLAUDE.md (raiz do projeto)                mesma correção de honestidade
scripts/worker/test_*.py e/ou              testes novos para to_gemini_contents() (incluindo
src/backend/__tests__/                    coalescing de papéis consecutivos, o guard de contents
                                           vazio, e o worker não crashar no boot sem
                                           GEMINI_API_KEY — só handle_generate() deve falhar,
                                           STT/classificação continuam de pé) e o tratamento de
                                           erro falado condicional
```

`src/backend/voice/engine.ts`, `mlxWorkerEngine.ts` continuam sem mudança — confirmado pelas
auditorias das rodadas 1 e 2.

## 6. Critérios de aceite (H1..H10)

- **H1** — `to_gemini_contents()`: consolida mensagens consecutivas do mesmo papel num único
  `content` com múltiplas `parts`; separa o system prompt por papel, não por posição; garante que
  o primeiro `content` é sempre `user`; lança `ValueError` explícito se `contents` ficaria vazio.
  Teste específico simulando uma resposta de 3 frases (3 entradas `assistant` consecutivas no
  histórico, como `markPlayed()` produz de verdade) — prova direta de que o achado 1 (CRÍTICA,
  rodada 1) não se repete.
- **H2** — Streaming: resposta longa emite múltiplos eventos `sentence` conforme chega, não um
  bloco só no final.
- **H3** — Loop detectado durante geração via Gemini: `emit("done")` acontece de qualquer forma —
  teste de regressão direto provando que o achado 2 (CRÍTICA, rodada 1) não se repete (turno
  termina normalmente, sem timeout de 60s, sem `SIGKILL`).
- **H4** — Cancelamento: turno cancelado no meio do streaming para de consumir o iterador sem
  lançar `AttributeError` nem gerar evento de erro espúrio.
- **H5** — Erro do Gemini sem nenhuma frase ainda sintetizada: fala `GENERATION_FAILURE_TEXT`.
  Erro do Gemini **depois** de pelo menos uma frase sintetizada: turno termina com o que já foi
  dito, sem frase de erro colidindo de índice.
- **H6** — Timeout de rede (simulado, ex. 25s): emite `error` NDJSON dentro do timeout de 20s do
  cliente, sem que o worker inteiro seja morto com `SIGKILL` pelo timeout de 60s do Node.
- **H7** — Regressão: `classify()`/`detectTool()`/`detectMutation()`/`detectConfirmation()`
  continuam idênticos, 100% locais.
- **H8** — Regressão: suíte completa das Fases 1-9 passa sem alteração de comportamento.
- **H9** — Boot sem `GEMINI_API_KEY` no ambiente: o worker sobe normalmente, carrega Whisper e
  Qwen3, responde a `ping`/`transcribe`/`classify` normalmente — só `handle_generate()` emite
  `error` NDJSON honesto ao ser chamado. Teste de regressão direto provando que o achado CRÍTICA
  reaberto da rodada 2 não se repete (o processo nunca aborta no boot por falta da chave do
  Gemini).
- **H10** — Verificação manual com áudio real e `GEMINI_API_KEY` de verdade: pergunta discursiva
  de Teologia recebe resposta do Gemini, streamada e falada; meta provisória de latência
  **mediana ≤4,0s / p95 ≤8,0s de fim-de-fala até primeiro áudio**, mesmos alvos já usados pela
  Fase 2 pro pipeline local — não é garantia de que o regime de rede vai bater esse número, é o
  piso abaixo do qual a fase não é considerada regressão aceitável; se medir acima, registrar
  honestamente como gap conhecido, mesma disciplina das fases anteriores. Log de diagnóstico TTFC
  (`log_diag`, achado BAIXA rodada 2) conferido manualmente contra o total, sem meta formal.

## 7. Riscos — atualizados

- **Latência de rede** — meta provisória (H10), mesma da v2.
- **Custo por chamada** — inalterado, não orçado nesta versão, não bloqueia.
- **Dependência de rede pra qualquer resposta** — inalterado, trade-off aceito (§0).
- **Prompt inclui conteúdo sensível do usuário** — inalterado, confirmado duas vezes (§0.6).
- **Vazamento de conexão por client recriado a cada turno** — eliminado (cliente único, agora
  lazy em vez de eager, reutilizado entre turnos).
- **`SIGKILL` desproporcional por causa de rede lenta, não travamento de GPU** — mitigado com
  timeout de 20s no cliente, mas o timeout de 60s do Node continua existindo como último recurso.
- **Crash do worker inteiro no boot por falta de `GEMINI_API_KEY`** — eliminado (achado CRÍTICA
  reaberto da rodada 2): inicialização do cliente Gemini é preguiçosa, então STT e classificação
  (100% locais) continuam funcionando mesmo sem a chave configurada — só a geração de resposta
  falha, honestamente, com `error` NDJSON.
- **Resposta anormalmente longa do Gemini estourando o timeout de 60s do Node** — mitigado
  (achado ALTA da rodada 2): `max_output_tokens=MAX_TURN_TOKENS` no `GenerateContentConfig`,
  mesmo teto já usado no laço local.

## 8. Rastreabilidade

- Documento de opção original: `docs/phase-10-option-typesafe-jev.md`.
- Auditoria adversarial v1 (rodada 1, sobre `phase-10-v1.md`):
  `docs/audits/phase-10-v1-agy-rodada1-2026-09-28.log` (10 achados, REJEITADO — 2 CRÍTICA, 2 ALTA,
  3 MÉDIA, 3 BAIXA).
- Auditoria adversarial v2 (rodada 2, sobre `phase-10-v2.md`):
  `docs/audits/phase-10-v2-agy-rodada2-2026-09-28.log` (5 achados novos/reabertos, REJEITADO — 1
  CRÍTICA, 1 ALTA, 1 MÉDIA, 2 BAIXA; 9 dos 10 achados da rodada 1 confirmados resolvidos).
- Escopo combinado com o usuário: `docs/phase-10-v1.md` §0 (inalterado nesta v3).

## 9. Achados da rodada 2 (agy) e como foram resolvidos no v3

| # | Achado | Gravidade | Status na rodada 2 | Resolução no v3 | Seção |
|---|---|---|---|---|---|
| 1 | `to_gemini_contents()` — coalescing de papéis | CRÍTICA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.2 |
| 2 | `emit("done")` incondicional | CRÍTICA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.3 |
| 3 | `stream.close()` inexistente | ALTA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.3 |
| 4 | Erro condicional a `expectedSentences.size` | ALTA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.4 |
| 5 | System prompt por papel, não posição | MÉDIA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.2 |
| 6 | `genai.Client` eager no `__init__` com `api_key=""` crasha o boot sem a chave, derrubando STT/classificação locais | **CRÍTICA (novo, reabre achado 6 da rodada 1)** | **Resolução insuficiente** | Lazy init dentro de `handle_generate()`, após validar a chave; `__init__` volta a só inicializar `None`, mesmo padrão de `self._llm` | §4.3 |
| 7 | `max_output_tokens` ausente — resposta longa do Gemini pode estourar o timeout de 60s/`SIGKILL` do Node | **ALTA (novo)** | — | `max_output_tokens=MAX_TURN_TOKENS` no `GenerateContentConfig` | §4.3 |
| 8 | Timeout de 20s (`HttpOptions`) | ALTA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.3 |
| 9 | `to_gemini_contents()` pode retornar `contents=[]` se não houver nenhuma mensagem `user` (só ocorre em teste sintético) | **MÉDIA (novo)** | — | `ValueError` explícito quando `contents` ficaria vazio | §4.2 |
| 10 | `requirements.in` correto | BAIXA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.1 |
| 11 | `return` em vez de `throw` | BAIXA (rodada 1) | Confirmado resolvido | Inalterado do v2 | §4.4 |
| 12 | Import de `google.genai` deve ser tardio (dentro de método), nunca no topo do módulo — quebraria testes standalone de funções puras | **BAIXA (novo)** | — | Import dentro do bloco de inicialização lazy em `handle_generate()` | §4.3 |
| 13 | H9 (latência) sem métrica isolada de Time-to-First-Chunk do Gemini | **BAIXA (novo)** | — | `log_diag` de TTFC, instrumentação sem meta formal nova | §4.6 |
