# Fase 10a — Provedor de geração em nuvem (Gemini) — v2

Versão: v2
Data: 2026-09-28
Status: Aguardando rodada 2 de auditoria adversarial
Base: Corrige os 10 achados da auditoria adversarial da rodada 1 sobre o v1
(`docs/audits/phase-10-v1-agy-rodada1-2026-09-28.log`, veredito REJEITADO — 2 CRÍTICA, 2 ALTA,
3 MÉDIA, 3 BAIXA).

## 0. Escopo combinado com o usuário — inalterado da v1

As sete decisões de §0 da v1 (qual sub-fase, provedor, substituição completa, escopo
transcribe/classify/TTS locais, erro honesto sem fallback, privacidade do prompt confirmada duas
vezes, modelo `gemini-flash-latest`) continuam valendo sem mudança — a rodada 1 auditou a
**execução técnica**, não essas decisões de produto.

## 1. Objetivo — inalterado da v1

## 2. A premissa da fase — inalterado da v1 (arquitetura: trocar a fonte de tokens dentro do
worker Python, não duplicar lógica de streaming/cancelamento em Node)

## 3. Escopo — inalterado da v1

## 4. Decisões de projeto

### 4.1 Dependência nova — corrigido o arquivo-alvo (achado 8, BAIXA)

**A v1 apontava pra `voice-requirements.lock.txt`, que é git-ignorado e regerado
automaticamente por `pip freeze` a cada `scripts/setup-voice.mjs`** — o arquivo versionado de
verdade é `scripts/worker/requirements.in`. `google-genai` (SDK atual recomendado, não o
`google-generativeai` legado) entra ali.

### 4.2 Conversão de formato de mensagens — corrigido (achados 1 CRÍTICA, 5 MÉDIA)

**Achado 1 (CRÍTICA, confiança 100%) — o mais grave da rodada 1**: a v1 assumia que o histórico
alterna `user`/`assistant` normalmente, mas `sessionManager.ts:684` (`markPlayed()`) grava **cada
frase falada como uma entrada `assistant` separada** — uma resposta de 3 frases gera 3 entradas
`assistant` consecutivas no histórico. A API do Gemini exige alternância estrita entre `user` e
`model`; papéis repetidos consecutivos retornam HTTP 400. Isso quebraria **qualquer resposta com
mais de uma frase**, ou seja, a maioria das conversas reais.

**Achado 5 (MÉDIA) — junto, porque a correção é a mesma função**: a v1 também assumia
`messages[0]` sempre é o system prompt e fatiava por posição fixa (`messages[1:]`) — se chamada
sem system prompt na posição 0, descarta silenciosamente a primeira mensagem real.

Corrigido com uma função que separa o system prompt por **papel**, não por posição, e consolida
(*coalesce*) mensagens consecutivas do mesmo papel num único `content` com múltiplas `parts`:

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

    return system_instruction, contents
```

### 4.3 `handle_generate()` — corrigido (achado 2 CRÍTICA, achado 3 ALTA, achado 6 MÉDIA, achado 7 MÉDIA)

**Achado 2 (CRÍTICA, confiança 100%)**: a v1 colocou `emit({"event": "done", ...})` **dentro** de
`if not loop_detected:` — divergindo do código real de hoje
(`scripts/worker/worker.py:699-713`), onde `done` é emitido **incondicionalmente** depois do
laço (um loop detectado é fim natural da resposta, não falha). Com o erro da v1, um loop
detectado nunca emitiria `done` nem `error` — o Node ficaria esperando até o timeout de 60s
(`VOICE_LIMITS.TURN_TIMEOUT_MS`) e mataria o worker com `SIGKILL`, derrubando toda a sessão de
voz (Whisper e Qwen3 precisariam recarregar). Corrigido: `done` volta pra fora do `if`.

**Achado 3 (ALTA, confiança 95%)**: `stream.close()` não existe no iterador retornado por
`generate_content_stream()` no SDK `google-genai` — chamar isso lançaria `AttributeError`,
capturado pelo `except` genérico, gerando um evento de erro espúrio em todo cancelamento/barge-in
normal. Removido — o `break` já é suficiente para parar de consumir o iterador; o SDK/cliente
HTTP libera a conexão quando o generator é descartado (comportamento padrão de generators
Python), sem chamada explícita.

**Achado 6 (MÉDIA)**: instanciar `genai.Client()` a **cada turno** dentro de `handle_generate()`
abre um novo pool de conexões HTTP sem fechar o anterior — o worker é um processo daemon
persistente, isso vaza recursos a cada geração ao longo de uma sessão longa. Corrigido:
instanciado **uma vez**, na inicialização do worker (mesmo padrão de `self._llm`/
`self._llm_tokenizer`, carregados uma vez no `__init__`/`load_models()`), reutilizado por todas
as chamadas de `generate()`.

**Achado 7 (MÉDIA)**: sem timeout de rede explícito no cliente do Gemini, uma conexão lenta (não
caída, só lenta) fica presa até o timeout de 60s do Node matar o worker inteiro com `SIGKILL` —
um regime de falha desproporcional pra um problema de rede transitório (o timeout de 60s existia
pra travamentos de GPU do MLX local, não pra latência de rede). Corrigido com timeout explícito
mais curto no próprio cliente HTTP do SDK, que emite `error` NDJSON sem precisar do `SIGKILL`
externo:

```python
class Worker:
    def __init__(self, ...):
        # ...inicialização existente do self._llm/self._llm_tokenizer...
        self._gemini_client = genai.Client(
            api_key=os.environ.get("GEMINI_API_KEY", ""),
            http_options=genai.types.HttpOptions(timeout=20_000),  # 20s — bem abaixo do
            # timeout de 60s do Node (VOICE_LIMITS.TURN_TIMEOUT_MS), pra que uma falha de rede
            # emita "error" NDJSON e libere o turno, em vez de deixar o Node matar o worker
            # inteiro com SIGKILL por uma causa que não é travamento de GPU.
        )

def handle_generate(self, msg: dict[str, Any]) -> None:
    req_id = msg["reqId"]; turn_id = msg["turnId"]; epoch = msg["epoch"]; messages = msg["messages"]

    handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
    with self._current_lock:
        self._current = handle

    try:
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY ausente — configure a variável de ambiente.")

        system_instruction, contents = to_gemini_contents(messages)

        buffer = ""
        sentence_index = 0
        emitted_normalized: list[str] = []
        loop_detected = False

        stream = self._gemini_client.models.generate_content_stream(
            model="gemini-flash-latest",
            contents=contents,
            config=genai.types.GenerateContentConfig(system_instruction=system_instruction),
        )

        for chunk in stream:
            if handle.cancel_event.is_set():
                log_diag(f"Geração cancelada (turnId={turn_id}) — parando de consumir o stream do Gemini.")
                break  # achado 3 — sem stream.close(), método inexistente no SDK

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
                                # erro de cota/API do Gemini — todos tratados igual: erro honesto
        log_diag(f"Erro na geração via Gemini: {exc}\n{traceback.format_exc()}")
        emit({"event": "error", "reqId": req_id, "turnId": turn_id,
              "message": "Falha ao gerar resposta via Gemini."})
    finally:
        with self._current_lock:
            if self._current is handle:
                self._current = None
```

**Nenhuma mudança em `MAX_TURN_TOKENS`** — inalterado da v1, específico do laço de amostragem
local, não se aplica ao Gemini.

### 4.4 Erro honesto falado — corrigido (achado 4 ALTA, achado 10 BAIXA)

**Achado 4 (ALTA, confiança 95%)**: a v1 sempre gravava a frase de erro com `index: 0` — se o
Gemini já tivesse emitido com sucesso a frase 0 (ou mais) antes de falhar no meio do streaming,
isso colide com o índice já usado na fila de reprodução do frontend
(`src/frontend/voice.ts:128`, `playbackQueue.sort((a, b) => a.sentenceIndex - b.sentenceIndex)`)
— o usuário ouviria o início de uma resposta real seguido de "Não consegui pensar numa resposta
agora." fora de ordem ou sobreposto. Corrigido: só fala o erro se **nenhuma frase ainda foi
sintetizada** neste turno; se já havia progresso real, o turno termina graciosamente com o que já
foi dito, sem a frase de erro contraditória por cima.

**Achado 10 (BAIXA)**: o comentário `// deixa o catch externo tratar` ao lado de `throw err`
estava errado — o catch externo de `runTurn()` (`sessionManager.ts:643`) só age quando
`session.activeTurn === turn`; se já não for o turno ativo, ele não faz nada mesmo. O padrão real
do arquivo pra esse caso (`sessionManager.ts:556`) é `return;`, não relançar. Corrigido:

```ts
// sessionManager.ts, runTurn() — try/catch específico ao redor de engine.generate():
try {
  await this.engine.generate(turn.turnId, turn.epoch, messagesForEngine, {
    onSentence: (rawText, index) => { /* inalterado */ }
  });
} catch (err) {
  // Achado 10 (BAIXA, rodada 1): mesmo padrão já usado em sessionManager.ts:556 — turno já
  // superado por barge-in simplesmente não faz nada aqui, não relança (o catch externo não
  // trataria de qualquer forma).
  if (session.activeTurn !== turn) return;

  // Achado 4 (ALTA, rodada 1): só fala o erro se NENHUMA frase deste turno já foi sintetizada
  // — senão colide o índice com frases já na fila do frontend e fala "não consegui pensar"
  // por cima de uma resposta que, na prática, já começou a acontecer.
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

### 4.5 `README.md`/`CLAUDE.md` — inalterado da v1 (§4.5, honestidade sobre "100% offline")

## 5. Arquivos afetados

```
scripts/worker/requirements.in            nova dependência: google-genai (achado 8 — arquivo
                                           correto, não voice-requirements.lock.txt)
scripts/worker/worker.py                  self._gemini_client instanciado uma vez no __init__
                                           (achado 6); handle_generate() troca a fonte de tokens
                                           com emit("done") incondicional (achado 2);
                                           to_gemini_contents() com coalescing de papéis e sem
                                           assumir posição fixa (achados 1, 5); timeout de rede
                                           de 20s no cliente (achado 7); sem stream.close()
                                           inexistente (achado 3)
src/shared/voiceProtocol.ts               GENERATION_FAILURE_TEXT
src/backend/voice/sessionManager.ts       try/catch específico ao redor de engine.generate(),
                                           condicional a expectedSentences.size (achado 4),
                                           return em vez de throw (achado 10)
.env.example                              GEMINI_API_KEY documentada
README.md                                 remove a afirmação de "100% offline" durante a conversa
CLAUDE.md (raiz do projeto)                mesma correção de honestidade
scripts/worker/test_*.py e/ou              testes novos para to_gemini_contents() (incluindo
src/backend/__tests__/                    coalescing de papéis consecutivos) e o tratamento de
                                           erro falado condicional
```

`src/backend/voice/engine.ts`, `mlxWorkerEngine.ts` continuam sem mudança — confirmado pela
auditoria (achado 6/verificação item 6 da rodada 1: nenhuma mudança de contrato necessária ali).

## 6. Critérios de aceite (H1..H9)

- **H1** — `to_gemini_contents()`: consolida mensagens consecutivas do mesmo papel num único
  `content` com múltiplas `parts`; separa o system prompt por papel, não por posição; garante que
  o primeiro `content` é sempre `user`. Teste específico simulando uma resposta de 3 frases
  (3 entradas `assistant` consecutivas no histórico, como `markPlayed()` produz de verdade) —
  prova direta de que o achado 1 (CRÍTICA) não se repete.
- **H2** — Streaming: resposta longa emite múltiplos eventos `sentence` conforme chega, não um
  bloco só no final.
- **H3** — Loop detectado durante geração via Gemini: `emit("done")` acontece de qualquer forma —
  teste de regressão direto provando que o achado 2 (CRÍTICA) não se repete (turno termina
  normalmente, sem timeout de 60s, sem `SIGKILL`).
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
- **H9** — Verificação manual com áudio real e `GEMINI_API_KEY` de verdade: pergunta discursiva de
  Teologia recebe resposta do Gemini, streamada e falada; meta provisória de latência (achado 9,
  BAIXA — a v1 não tinha nenhuma) **mediana ≤4,0s / p95 ≤8,0s de fim-de-fala até primeiro áudio**,
  mesmos alvos já usados pela Fase 2 pro pipeline local — não é garantia de que o regime de rede
  vai bater esse número, é o piso abaixo do qual a fase não é considerada regressão aceitável;
  se medir acima, registrar honestamente como gap conhecido, mesma disciplina das fases anteriores.

## 7. Riscos — atualizados

- **Latência de rede** — agora com meta provisória (H9), não mais sem nenhum número (achado 9
  corrigido).
- **Custo por chamada** — inalterado da v1, não orçado nesta versão, não bloqueia.
- **Dependência de rede pra qualquer resposta** — inalterado, trade-off aceito (§0).
- **Prompt inclui conteúdo sensível do usuário** — inalterado, confirmado duas vezes (§0.6).
- **Vazamento de conexão por client recriado a cada turno** — eliminado (achado 6, cliente único
  reutilizado).
- **`SIGKILL` desproporcional por causa de rede lenta, não travamento de GPU** — mitigado com
  timeout de 20s no cliente (achado 7), mas o timeout de 60s do Node continua existindo como
  último recurso — se o próprio timeout de 20s do cliente Python travar por algum motivo
  (biblioteca com bug, por exemplo), o SIGKILL de 60s ainda é a rede de segurança final.

## 8. Rastreabilidade

- Documento de opção original: `docs/phase-10-option-typesafe-jev.md`.
- Auditoria adversarial v1: `docs/audits/phase-10-v1-agy-rodada1-2026-09-28.log` (10 achados,
  REJEITADO — 2 CRÍTICA, 2 ALTA, 3 MÉDIA, 3 BAIXA).
- Escopo combinado com o usuário: `docs/phase-10-v1.md` §0 (inalterado nesta v2).

## 9. Achados da rodada 1 (agy) e como foram resolvidos

| # | Achado | Gravidade | Resolução no v2 | Seção |
|---|---|---|---|---|
| 1 | `to_gemini_contents()` gera papéis consecutivos (histórico grava cada frase como `assistant` separado) — HTTP 400 do Gemini em praticamente qualquer resposta real | CRÍTICA | Coalescing de mensagens consecutivas do mesmo papel num único `content` com múltiplas `parts` | §4.2 |
| 2 | `emit("done")` movido pra dentro de `if not loop_detected` — loop detectado nunca terminaria o protocolo, Node mata o worker com `SIGKILL` após 60s | CRÍTICA | `done` de volta pra fora do `if`, incondicional, igual ao código real hoje | §4.3 |
| 3 | `stream.close()` não existe no SDK `google-genai` — `AttributeError` em todo cancelamento normal | ALTA | Removido; `break` é suficiente | §4.3 |
| 4 | Erro no meio do streaming grava índice 0 fixo, colidindo com frases já sintetizadas e falando "não consegui pensar" por cima de resposta parcial real | ALTA | Só fala o erro se nenhuma frase ainda foi sintetizada; senão encerra com o que já foi dito | §4.4 |
| 5 | `to_gemini_contents()` assume `messages[0]` é sempre o system prompt por posição | MÉDIA | Separa por papel (`role == "system"`), não por índice | §4.2 |
| 6 | `genai.Client()` instanciado a cada turno, vazando pool de conexões num processo daemon persistente | MÉDIA | Cliente único, instanciado uma vez no `__init__`, reutilizado | §4.3 |
| 7 | Sem timeout de rede explícito — conexão lenta atinge o timeout de 60s do Node e mata o worker inteiro com `SIGKILL` | MÉDIA | Timeout de 20s no cliente HTTP do SDK, emite `error` NDJSON sem precisar do `SIGKILL` | §4.3 |
| 8 | Dependência apontada pro arquivo errado (`voice-requirements.lock.txt`, git-ignorado e regerado, em vez de `requirements.in`) | BAIXA | Corrigido para `scripts/worker/requirements.in` | §4.1 |
| 9 | H8 (agora H9) sem nenhuma meta numérica de latência, contradizendo o objetivo declarado de "sem regressão perceptível" | BAIXA | Meta provisória adicionada: mediana ≤4,0s / p95 ≤8,0s, mesmos alvos da Fase 2 | §6 |
| 10 | Comentário `// deixa o catch externo tratar` ao lado de `throw err` — o catch externo não trata nada nesse caso, o padrão real do arquivo é `return` | BAIXA | Corrigido para `return`, mesmo padrão de `sessionManager.ts:556` | §4.4 |
