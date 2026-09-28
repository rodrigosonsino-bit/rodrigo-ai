# Fase 10a — Provedor de geração em nuvem (Gemini) — v1

## 0. Escopo combinado com o usuário antes de escrever este plano

Esta é a única fase do projeto que pode quebrar a restrição central documentada em `CLAUDE.md`
("no paid API, no third-party service, no cloud inference") — e o próprio `CLAUDE.md` exige que
isso nunca aconteça "silenciosamente". Havia um documento de opção já registrado
(`docs/phase-10-option-typesafe-jev.md`, 2026-09-17) separando a Fase 10 em duas decisões
independentes — **10a (provedor de geração)** e **10b (classificador, Jev)** — sem implementar
nenhuma das duas. Cinco rodadas de `AskUserQuestion` (2026-09-28) resolveram as decisões que só o
usuário podia tomar, antes de escrever qualquer pseudocódigo:

1. **Qual das duas**: **10a** — provedor de geração. 10b (Jev/classificador) permanece só como
   opção registrada, não tratada aqui.
2. **Provedor**: **Google Gemini**.
3. **Local vs. nuvem**: **substituição completa** — não é uma variável de ambiente opcional tipo
   `TTS_ENGINE`; a partir desta fase, `generate()` sempre usa o Gemini, sem caminho de volta pro
   modelo local dentro do mesmo processo.
4. **Escopo exato dentro do pipeline**: confirmado explicitamente — **só `generate()` muda**.
   `transcribe()` (Whisper), `classify()`/`detectTool()`/`detectMutation()`/`detectConfirmation()`
   (Qwen3 local) e toda a síntese de voz (TTS) continuam 100% locais, sem rede, sem custo. Só a
   etapa que decide o que falar sai da máquina.
5. **Comportamento em falha do Gemini** (sem rede, sem cota, erro de API): **erro honesto,
   falado** — "não consegui pensar numa resposta agora", turno termina, **sem** cair pro Qwen3
   local como fallback (consistente com a decisão de substituição completa do item 3).
6. **Privacidade do prompt** (pergunta central, feita duas vezes pra garantir que a resposta
   refletia a pergunta real): o prompt de cada geração inclui o `knowledgeBlock` (Fase 5a — trechos
   de `docs/research/`, perfil teológico e Virtologia do usuário) e o `memoryBlock` (Fase 7 — fatos
   pessoais guardados) quando aplicáveis. **Confirmado explicitamente**: uma cópia desse prompt
   trafega até os servidores do Google a cada geração — os arquivos originais permanecem só na
   máquina do usuário, inalterados, nos dois casos; a decisão foi especificamente sobre a cópia via
   rede, não sobre retenção local. Usuário topou.
7. **Modelo**: **`gemini-flash-latest`** — mesmo alias já usado no `opencode.jsonc` desta máquina,
   evita ficar preso a uma versão descontinuada (`CLAUDE.md` global do usuário já documenta essa
   armadilha: "modelos versionados tipo `gemini-2.5-flash` saem de linha frequentemente").

## 1. Objetivo

O usuário fala com o Rodrigo; a transcrição (Whisper) e a classificação de intenção (Qwen3)
continuam exatamente como hoje, sem nenhuma mudança perceptível; mas a resposta falada agora é
gerada pelo Gemini (`gemini-flash-latest`) em vez do `Qwen3-4B-Instruct-2507-4bit` local —
streaming frase por frase pro TTS continua funcionando do mesmo jeito, sem regressão de latência
perceptível pro usuário.

**Critério de conclusão, em linguagem do roteiro**: uma pergunta discursiva de Teologia ou
Virtologia (o caso que motivou a Fase 10 existir — qualidade de geração em respostas longas) recebe
uma resposta do Gemini, streamada em frases conforme geradas, cada frase sintetizada e falada assim
que pronta — mesmo comportamento perceptível de hoje, motor diferente por trás.

## 2. A premissa da fase — arquitetura: trocar a fonte de tokens, não o protocolo

**Decisão de projeto central, que evita reescrever toda a infraestrutura de streaming/cancelamento
já auditada**: a troca acontece **dentro do worker Python** (`scripts/worker/worker.py`,
`handle_generate()`), não no lado Node. Hoje, `handle_generate()` itera sobre
`mlx_lm.generate.stream_generate()` (local, MLX), detecta limites de frase com
`find_sentence_boundary()`, emite `{"event": "sentence", ...}` por NDJSON, e finaliza com
`{"event": "done", ...}`. **Nada disso muda** — só a fonte do texto que entra no buffer.
`find_sentence_boundary()` (regras de abreviação, decimal, reticências, tamanho mínimo de chunk —
lógica não-trivial, já testada) e `_is_near_duplicate_sentence()` (proteção contra loop, Fase 4)
continuam exatamente como estão, aplicadas ao texto que vem do Gemini do mesmo jeito que hoje se
aplicam ao texto que vem do MLX local.

**Por que não implementar isso no lado Node** (`mlxWorkerEngine.ts`/`sessionManager.ts`): faria o
projeto manter DUAS implementações de detecção de limite de frase (uma em Python já testada, uma
nova em TypeScript) — risco real de divergência silenciosa entre elas, exatamente o tipo de
duplicação que a Fase 9 evitou deliberadamente pra `computeNextOccurrence()` (`docs/phase-9-v2.md`
§4.2). Manter a troca dentro do worker Python significa: zero mudança na interface `VoiceEngine`
(`engine.ts`), zero mudança em `MlxWorkerEngine`, zero mudança no protocolo NDJSON, zero mudança em
`sessionManager.ts` além do necessário pra falar o erro honesto (§4.4). O `Qwen3-4B` continua
carregado no worker o tempo todo — ele nunca deixa de existir, só para de ser chamado pra
`generate()`; `classify()`/`detectTool()`/`detectMutation()`/`detectConfirmation()` continuam
usando ele normalmente.

## 3. Escopo

**Dentro do escopo:**
- `handle_generate()` chama a API do Gemini (`gemini-flash-latest`, streaming) em vez de
  `mlx_lm.generate.stream_generate()` local.
- Conversão do formato de mensagens (`ConversationMessage[]`, `role: system/user/assistant`) pro
  formato do Gemini (`system_instruction` + `contents` com `role: user/model`).
- Cancelamento cooperativo do turno (`handle.cancel_event`) continua funcionando — precisa
  interromper o streaming do Gemini no meio, não só parar de processar depois.
- Timeout: reaproveita o mecanismo já existente no lado Node (`VOICE_LIMITS.TURN_TIMEOUT_MS`,
  `mlxWorkerEngine.ts`) — nenhuma mudança necessária ali, ele já mata o worker se a resposta
  demorar demais, independente de qual motor está gerando por trás.
- Erro honesto falado quando o Gemini falha (§4.4) — não um evento de erro silencioso (o
  comportamento de hoje do `catch` genérico em `sessionManager.ts:640-649`, que emite `type:
  'error'` sem nunca sintetizar nada em voz — errado pro caso de uso de voz, corrigido aqui).
- `GEMINI_API_KEY` como variável de ambiente — o worker já herda `process.env` inteiro do processo
  Node que o spawna (`mlxWorkerEngine.ts:118`, `...process.env` no spawn), então não precisa de
  nenhuma mudança de código pra passar a chave adiante, só documentação (`.env.example`,
  `docs/`).
- Atualização honesta de `README.md`/`CLAUDE.md` removendo a afirmação de "100% offline durante a
  conversa" — ela deixa de ser verdadeira a partir desta fase, e não pode continuar documentada
  como se fosse (mesma disciplina de honestidade de todas as fases anteriores, aplicada aqui à
  própria descrição da arquitetura, não só a critérios de aceite).

**Fora de escopo, mesmo que pareça natural:**
- Fase 10b (Jev pro classificador) — decisão separada, não tratada aqui (§0.1).
- Trocar `transcribe()`, `classify()`, `detectTool()`, `detectMutation()`, `detectConfirmation()`
  pro Gemini — só `generate()` muda (§0.4).
- Fallback automático pro Qwen3 local quando o Gemini falha — decisão explícita §0.5.
- Variável de ambiente pra alternar entre local e nuvem — decisão explícita §0.3 (substituição
  completa, não configurável).
- Filtrar `knowledgeBlock`/`memoryBlock` do prompt que vai pro Gemini — decisão explícita §0.6
  (usuário topou mandar tudo).
- Repetition penalty / parâmetros de amostragem locais (`repetition_penalty=1.3`,
  `repetition_context_size`) — específicos do MLX local, não se aplicam ao Gemini. A proteção
  contra loop que continua valendo é `_is_near_duplicate_sentence()` (pós-geração, agnóstica de
  motor) — mantida como rede de segurança barata, não removida.
- Mudar o modelo de classificação/ferramentas — Qwen3 continua fazendo isso, inalterado.

## 4. Decisões de projeto

### 4.1 Dependência nova (`voice-requirements.lock.txt`)

SDK oficial do Google pra Gemini (`google-genai`, o SDK atual recomendado — não o
`google-generativeai` legado). Adicionado ao lockfile do venv de voz, mesmo padrão de gestão de
dependência já usado pras outras libs MLX/Whisper.

### 4.2 Conversão de formato de mensagens

```python
# ConversationMessage[] chega como [{"role": "system", "content": "..."}, {"role": "user", ...}, ...]
# (sessionManager.ts:618 sempre bota o system prompt como messages[0])
def to_gemini_contents(messages: list[dict]) -> tuple[str, list[dict]]:
    """Separa o system prompt (sempre messages[0] pela convenção do Node) do resto,
    convertendo role 'assistant' -> 'model' (única diferença de nomenclatura do Gemini)."""
    system_instruction = messages[0]["content"] if messages and messages[0]["role"] == "system" else ""
    contents = [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
        for m in messages[1:]
    ]
    return system_instruction, contents
```

**Risco nomeado pro auditor**: esta função assume que `messages[0]` é sempre o system prompt —
verdade hoje (`sessionManager.ts:618`), mas é uma suposição sobre o chamador, não uma garantia do
tipo `ConversationMessage[]`. Se isso mudar no futuro sem atualizar aqui, o system prompt vazaria
pro `contents` como se fosse uma mensagem de usuário. Comentário no código apontando essa
dependência.

### 4.3 `handle_generate()` — troca da fonte de tokens, resto do pipeline intacto

```python
def handle_generate(self, msg: dict[str, Any]) -> None:
    req_id = msg["reqId"]; turn_id = msg["turnId"]; epoch = msg["epoch"]; messages = msg["messages"]

    handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
    with self._current_lock:
        self._current = handle

    try:
        system_instruction, contents = to_gemini_contents(messages)

        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])  # KeyError se ausente -> catch abaixo, erro honesto

        buffer = ""
        sentence_index = 0
        emitted_normalized: list[str] = []
        loop_detected = False

        stream = client.models.generate_content_stream(
            model="gemini-flash-latest",
            contents=contents,
            config=genai.types.GenerateContentConfig(system_instruction=system_instruction),
        )

        for chunk in stream:
            if handle.cancel_event.is_set():
                log_diag(f"Geração cancelada (turnId={turn_id}) — interrompendo stream do Gemini.")
                stream.close()  # nunca deixar a chamada de rede continuar depois do cancelamento
                break

            buffer += chunk.text or ""  # chunk.text pode vir vazio em chunks de metadado

            # DAQUI PRA BAIXO: EXATAMENTE o mesmo laço de find_sentence_boundary/emit/dedupe que
            # já existe em handle_generate() hoje (linhas ~668-690) — reaproveitado sem mudança,
            # só a origem de `buffer` mudou. Não duplicar essa lógica, só religar a mesma função
            # já testada contra o buffer alimentado pelo Gemini.
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

        if not handle.cancel_event.is_set() and not loop_detected:
            leftover = buffer.strip()
            if leftover and not _is_near_duplicate_sentence(leftover, emitted_normalized):
                emit({"event": "sentence", "reqId": req_id, "turnId": turn_id,
                      "index": sentence_index, "text": leftover})
            emit({"event": "done", "reqId": req_id, "turnId": turn_id})

    except Exception as exc:  # noqa: BLE001 — cobre KeyError (chave ausente), erro de rede,
                                # erro de cota/API do Gemini — todos tratados igual: erro honesto
        log_diag(f"Erro na geração via Gemini: {exc}\n{traceback.format_exc()}")
        emit({"event": "error", "reqId": req_id, "turnId": turn_id,
              "message": "Falha ao gerar resposta via Gemini."})
    finally:
        with self._current_lock:
            if self._current is handle:
                self._current = None
```

**Nenhuma mudança em `MAX_TURN_TOKENS`**: o SDK do Gemini não usa esse parâmetro (é específico do
laço de amostragem local do MLX) — o controle de tamanho de resposta fica a cargo do
`GenerateContentConfig` do Gemini se necessário, decisão de tuning fina deixada pra depois de medir
com uso real, não bloqueia esta fase (respostas do Gemini não têm o problema de loop que motivou
`MAX_TURN_TOKENS` em primeiro lugar).

### 4.4 Erro honesto **falado**, não só um evento silencioso (achado de UX nomeado explicitamente)

**Problema real no comportamento de hoje**: se `engine.generate()` rejeita (lança), o `catch`
genérico de `runTurn()` (`sessionManager.ts:640-649`) emite só `{ type: 'error', message }` — um
evento de texto na SSE, **nunca sintetizado em voz**. Pra uma interface de voz, isso significa o
usuário fica em silêncio total quando o Gemini falha — inconsistente com a decisão explícita do
usuário (§0.5: "fala algo tipo 'não consegui pensar numa resposta agora'"). Mesmo padrão já
resolvido pra mutações (`MUTATION_FAILURE_TEXT`, `voiceProtocol.ts:131`) — replicado aqui:

```ts
// voiceProtocol.ts — novo, ao lado de MUTATION_FAILURE_TEXT:
export const GENERATION_FAILURE_TEXT = 'Não consegui pensar numa resposta agora.';
```

```ts
// sessionManager.ts, runTurn() — o try/catch ao redor de engine.generate() precisa ser
// específico (não o catch genérico externo), pra sintetizar o erro em vez de só emitir
// um evento de texto:
try {
  await this.engine.generate(turn.turnId, turn.epoch, messagesForEngine, {
    onSentence: (rawText, index) => { /* inalterado */ }
  });
} catch (err) {
  if (session.activeTurn !== turn) throw err; // turno já superado, deixa o catch externo tratar
  const text = GENERATION_FAILURE_TEXT;
  turn.expectedSentences.add(0);
  turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, text, 0));
  // segue pro Promise.allSettled(turn.pendingSynthesis) e turn_done normalmente — o turno
  // termina como um turno bem-sucedido que falou uma frase de erro, não como state:'erro'.
}
```

**Decisão de projeto**: tratar a falha de geração como um turno que "termina falando uma frase de
erro" (como `MUTATION_FAILURE_TEXT` já faz), não como `state: 'erro'` — consistente com o resto do
projeto, e porque o usuário efetivamente ouve uma resposta (ainda que de falha), não fica esperando
em silêncio sem saber se o sistema travou ou só não respondeu.

### 4.5 `README.md`/`CLAUDE.md` — honestidade sobre a arquitetura, não só sobre critérios de aceite

**Parte obrigatória desta fase, não um detalhe de documentação**: `README.md` hoje afirma "Durante
a conversa/execução, o aplicativo opera 100% desconectado de serviços externos" — isso deixa de
ser verdade a partir desta fase. Reescrever pra descrever o estado real: STT/classificação/TTS
locais, geração de resposta via Gemini (rede, terceiro, custo por chamada). Mesma correção em
`CLAUDE.md` (raiz do projeto) — o parágrafo "Hard constraint carried across all phases" precisa ser
atualizado pra registrar que a Fase 10a mudou essa restrição, com data e decisão explícita do
usuário citada (mesmo padrão de honestidade que `docs/implementation-phase-5c.md` §10 já usa pra
registrar decisões de fechamento de fase).

## 5. Arquivos afetados

```
voice-requirements.lock.txt               nova dependência: google-genai
scripts/worker/worker.py                  handle_generate() troca a fonte de tokens (§4.3);
                                           to_gemini_contents() novo; import do SDK do Gemini
src/shared/voiceProtocol.ts               GENERATION_FAILURE_TEXT (§4.4)
src/backend/voice/sessionManager.ts       try/catch específico ao redor de engine.generate()
                                           fala o erro em vez de emitir evento silencioso (§4.4)
.env.example                              GEMINI_API_KEY documentada
README.md                                 remove a afirmação de "100% offline" durante a conversa,
                                           descreve o estado real (§4.5)
CLAUDE.md (raiz do projeto)                mesma correção de honestidade (§4.5)
scripts/worker/test_*.py e/ou              testes novos para to_gemini_contents() e o
src/backend/__tests__/                    tratamento de erro falado
```

`src/backend/voice/engine.ts`, `mlxWorkerEngine.ts` **não mudam** — a interface `VoiceEngine` e o
protocolo NDJSON continuam idênticos, confirmando a decisão de arquitetura do §2.

## 6. Critérios de aceite (H1..H8)

- **H1** — `to_gemini_contents()`: separa corretamente o system prompt de `messages[0]`, converte
  `assistant`→`model`, preserva `user` — testado com histórico de conversa real (múltiplos turnos).
- **H2** — Streaming: uma resposta longa e discursiva (simulando Teologia/Virtologia) emite
  múltiplos eventos `sentence` conforme o texto chega, não um único bloco no final — prova de que o
  streaming de verdade está conectado ao `find_sentence_boundary()` existente, não bufferizado
  inteiro antes de processar.
- **H3** — Cancelamento: um turno cancelado no meio do streaming do Gemini interrompe a chamada de
  rede (`stream.close()`) e não emite mais nenhum evento `sentence` depois do cancelamento — mesmo
  contrato de cancelamento cooperativo que `transcribe()`/`classify()` já têm.
- **H4** — Erro do Gemini (chave ausente, rede fora, erro de API simulado): emite o texto de
  `GENERATION_FAILURE_TEXT` **sintetizado em voz** (não só um evento de texto silencioso) — teste
  de integração via `sessionManager.ts`, não só leitura de código.
- **H5** — Regressão: `classify()`/`detectTool()`/`detectMutation()`/`detectConfirmation()`
  continuam idênticos, usando o Qwen3 local, sem nenhuma chamada ao Gemini.
- **H6** — Regressão: suíte completa das Fases 1-9 passa sem alteração de comportamento (as
  ferramentas de mutação, agendamento e memória não usam `generate()` para nada que dependa do
  Gemini especificamente — `preview()`/`execute()` são determinísticos, não geração de texto).
- **H7** — `README.md`/`CLAUDE.md` não afirmam mais "100% offline durante a conversa" — checagem
  textual simples de que a frase antiga não existe mais sem uma ressalva.
- **H8** — Verificação manual com áudio real e `GEMINI_API_KEY` de verdade configurada: uma
  pergunta discursiva de Teologia recebe resposta gerada pelo Gemini, streamada e falada
  normalmente, com latência dentro de uma faixa razoável (a medir — sem alvo numérico fixado nesta
  versão, já que a Fase 10a muda o gargalo de latência de "inferência local" pra "rede + inferência
  remota", um regime diferente do que os benchmarks de `bench:voice` mediram até aqui).

## 7. Riscos

- **Latência não medida ainda**: os benchmarks de `bench:voice` (mediana ~3,2s local) não dizem
  nada sobre o tempo de ida-e-volta de rede até o Gemini. H8 mede antes de considerar a fase
  "concluída" no sentido de qualidade de experiência, não só de funcionamento.
- **Custo por chamada**: cada turno de geração agora tem custo real de API — não medido nem
  orçado nesta versão do plano; decisão de monitorar consumo fica pro usuário depois de uso real,
  não bloqueia a implementação.
- **Dependência de rede pra qualquer resposta**: sem rede, todo turno termina em
  `GENERATION_FAILURE_TEXT` — decisão explícita do usuário (§0.3, §0.5), documentada como
  trade-off aceito, não como limitação escondida.
- **Prompt inclui conteúdo sensível do usuário** (perfil teológico, Virtologia, memórias pessoais)
  — decisão explícita e confirmada duas vezes (§0.6), não uma suposição minha.
- **`_is_near_duplicate_sentence()` como única rede de segurança contra repetição**: sem
  `repetition_penalty` (específico de amostragem local), a única proteção contra um modelo que
  repete é a detecção pós-geração — suficiente na prática porque modelos em nuvem de qualidade
  comercial raramente têm esse problema, mas não é uma garantia formal, é uma expectativa a
  confirmar com uso real (H8).

## 8. Rastreabilidade

- Documento de opção original: `docs/phase-10-option-typesafe-jev.md` (2026-09-17) — já separava
  10a de 10b; este plano implementa 10a, deixa 10b como estava (opção registrada, não implementada).
- Restrição central documentada: `README.md`, `CLAUDE.md` ("no paid API... never silently").
- Escopo combinado com o usuário: cinco rodadas de `AskUserQuestion`, 2026-09-28 (§0) — incluindo
  duas rodadas sobre a mesma pergunta de privacidade, pra garantir que a resposta refletia a
  pergunta real, não uma leitura errada da primeira tentativa.
- Precedente de honestidade documental: `docs/implementation-phase-5c.md` §10 (registro de decisão
  de fechamento de fase com data e citação literal do que foi combinado).
- Precedente de "não duplicar lógica já testada entre linguagens/camadas":
  `docs/phase-9-v2.md` §4.2 (`computeNextOccurrence()` compartilhada, não duas implementações).
