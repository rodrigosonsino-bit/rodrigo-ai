# Correção: loop de repetição de frase na geração de voz — v1

Data 2026-09-15. Corrige um achado fora de escopo registrado no relatório da Fase 4 (`docs/implementation-phase-4.md`, seções 3.5 e 6): sem penalidade de repetição, o modelo local (`Qwen3-4B-Instruct-2507-4bit`) às vezes repete a mesma frase dezenas de vezes antes de variar, mais visível em respostas discursivas longas (Teologia/Virtologia) do que nas perguntas curtas testadas nas Fases 2-3.

## Objetivo e definição de pronto

Cortar a geração de forma determinística assim que uma frase repetir quase-verbatim uma frase já emitida no mesmo turno — tratando isso como fim natural da resposta (equivalente a atingir `MAX_TURN_TOKENS`), nunca como erro. "Pronto" exige: teste automatizado da função de detecção com os casos reais já observados (positivos e negativos), verificação com áudio real de que o corte acontece de fato durante um turno (não só em teoria), e confirmação de que nenhum caso legítimo de repetição curta e intencional (ex.: "Sim, sim!" enfático) é cortado incorretamente.

## Por que abandonar o ajuste de amostragem em vez de continuar

72 gerações reais coletadas na investigação desta tarefa não reproduziram nenhum loop — taxa de ocorrência baixa demais para comparar `repetition_penalty`/`repetition_context_size` com significância estatística (o que já foi tentado na Fase 4: `1.3` vs `1.4` não mostrou tendência real, só ruído de amostragem com `temp=0.7`). Continuar variando parâmetros de amostragem não é uma estratégia que converge — depende de reproduzir um evento raro para cada comparação. A correção abaixo resolve o **sintoma** de forma garantida e testável sinteticamente, independente da causa raiz probabilística (que fica documentada como não totalmente compreendida, não escondida).

## Decisão de projeto

**Detecção por sobreposição de trigramas de palavras (Jaccard), não por igualdade exata.** Os exemplos reais observados (`docs/audits/phase-4-c6-matrix-result.json`) mostram tanto repetição exata (ex.: "Isso é senso comum." repetido literalmente) quanto quase-exata com pequena variação (ex.: "você multiplica 850 por 0,17" vs "multiplica 850 por 0,17"). Igualdade de string exata perderia o segundo caso; um limiar de similaridade (`0.75` de sobreposição de trigramas) cobre os dois sem exigir bibliotecas externas.

**Frases com menos de 3 palavras nunca disparam a detecção.** Frases curtas ("Sim.", "Entendo.") têm poucos trigramas (ou nenhum) para comparar com confiança, e podem legitimamente aparecer mais de uma vez numa resposta sem ser um loop patológico — o risco de falso positivo é maior que o benefício de cortar cedo nesses casos. (Nota: o caso real "Entendo." repetido 12x na Fase 4 tinha 1 palavra e não seria pego por esta regra isoladamente — mas nesse mesmo turno as frases longas que vieram depois, quase-idênticas entre si, seriam detectadas e cortariam o turno de qualquer forma antes de acumular muito mais repetição. Ver "Limitação aceita" abaixo.)

**Corta no primeiro par de frases quase-duplicadas, sem tentativas de "dar mais uma chance".** Simplicidade determinística: assim que uma frase nova bate o limiar contra qualquer frase já emitida neste turno, a geração para ali. Não emite a frase duplicada, não emite o restante do buffer, emite `done` normalmente (não `error`) — o cliente recebe uma resposta mais curta, nunca uma resposta quebrada ou um erro visível.

**Limitação aceita, documentada e não escondida**: um loop que começa com uma frase muito curta (< 3 palavras) repetida várias vezes antes de qualquer frase longa aparecer não é cortado pela regra de trigramas sozinha. Isso é aceito porque: (a) nos casos reais observados, frases curtas repetidas eram sempre seguidas de frases mais longas que a regra pega; (b) a alternativa (detectar repetição de frases curtas também) tem risco real de falso positivo em respostas curtas legítimas, que são a maioria do uso normal (ver benchmark da Fase 3/4: perguntas cotidianas geram respostas de 1 frase). Se isso se mostrar insuficiente no uso real, é trabalho de uma iteração futura, não desta correção.

## Arquitetura

### `scripts/worker/worker.py` — novas funções (perto de `find_sentence_boundary`)
```python
_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def _normalize_for_dedup(text: str) -> str:
    """Normaliza uma frase para comparação de repetição: minúsculas, só palavras, espaços únicos."""
    words = _WORD_RE.findall(text.lower())
    return " ".join(words)


def _word_trigrams(normalized_text: str) -> set[tuple[str, str, str]]:
    words = normalized_text.split()
    if len(words) < 3:
        return set()
    return {tuple(words[i:i + 3]) for i in range(len(words) - 2)}


def _is_near_duplicate_sentence(
    candidate: str, previously_emitted: list[str], threshold: float = 0.75
) -> bool:
    """
    True se `candidate` repete quase-verbatim (Jaccard de trigramas de palavras >= threshold)
    alguma frase já emitida neste turno (`previously_emitted`, texto normalizado). Frases com
    menos de 3 palavras nunca disparam (curtas demais para julgar com confiança — ver decisão
    de projeto no plano desta correção).
    """
    candidate_norm = _normalize_for_dedup(candidate)
    candidate_trigrams = _word_trigrams(candidate_norm)
    if not candidate_trigrams:
        return False

    for prev_norm in previously_emitted:
        prev_trigrams = _word_trigrams(prev_norm)
        if not prev_trigrams:
            continue
        overlap = len(candidate_trigrams & prev_trigrams) / len(candidate_trigrams | prev_trigrams)
        if overlap >= threshold:
            return True
    return False
```

### `scripts/worker/worker.py` — `handle_generate()` (trecho do loop de streaming, mudanças completas)
```python
            buffer = ""
            sentence_index = 0
            token_count = 0
            emitted_normalized: list[str] = []  # NOVO — histórico de frases deste turno p/ detecção
            loop_detected = False  # NOVO

            for response in stream_generate(
                self._llm,
                self._llm_tokenizer,
                prompt,
                max_tokens=MAX_TURN_TOKENS,
                sampler=sampler,
                logits_processors=logits_processors,
            ):
                if handle.cancel_event.is_set():
                    log_diag(f"Geração cancelada (turnId={turn_id}) — descartando sem mx.eval().")
                    break

                buffer += response.text
                token_count += 1

                boundary = find_sentence_boundary(buffer)
                while boundary is not None:
                    sentence = buffer[:boundary].strip()
                    buffer = buffer[boundary:]
                    if sentence:
                        # NOVO — Correção do loop de repetição (fora do escopo da Fase 4,
                        # achado real na verificação com áudio, ver docs/implementation-phase-4.md
                        # e docs/fix-generation-repetition-loop-v1.md): trata uma frase
                        # quase-duplicada como fim natural da resposta, não como erro.
                        if _is_near_duplicate_sentence(sentence, emitted_normalized):
                            log_diag(
                                f"Loop de repetição detectado (turnId={turn_id}, "
                                f"frase {sentence_index}) — encerrando geração aqui."
                            )
                            loop_detected = True
                            break
                        emit({
                            "event": "sentence",
                            "reqId": req_id,
                            "turnId": turn_id,
                            "index": sentence_index,
                            "text": sentence,
                        })
                        emitted_normalized.append(_normalize_for_dedup(sentence))
                        sentence_index += 1
                    boundary = find_sentence_boundary(buffer)

                if loop_detected:
                    break

                if token_count >= MAX_TURN_TOKENS:
                    break

            if not handle.cancel_event.is_set():
                # NOVO: se o loop foi cortado por repetição, não emite o texto restante no
                # buffer (é justamente a frase duplicada, ou continuação dela) — o turno
                # termina aqui, silenciosamente mais curto, nunca como erro.
                if not loop_detected:
                    leftover = buffer.strip()
                    if leftover:
                        emit({
                            "event": "sentence",
                            "reqId": req_id,
                            "turnId": turn_id,
                            "index": sentence_index,
                            "text": leftover,
                        })
                emit({"event": "done", "reqId": req_id, "turnId": turn_id})
```
Nenhuma outra parte de `handle_generate()` muda (tratamento de exceção, `finally`, cancelamento). Nenhum outro arquivo é tocado — isso é uma correção isolada ao worker Python; o protocolo NDJSON, `MlxWorkerEngine` (Node) e `SessionManager` não precisam saber que um turno terminou "naturalmente" ou "por corte de repetição" — ambos os casos já são o mesmo evento `done` seguido de nenhum evento `sentence` a mais, comportamento que o lado Node já trata corretamente hoje (turno termina, `turn_done` é emitido).

## Testes

### Novo: `scripts/worker/test_repetition_detector.py` (script standalone, sem framework — mesmo estilo de `scripts/bench-voice.mjs`: roda com `assert`, não faz parte de `npm test`)
Importa `_normalize_for_dedup` e `_is_near_duplicate_sentence` de `worker.py` (o arquivo já é executável como módulo Python puro para essas duas funções — não requer MLX carregado). Casos, incluindo os reais observados na Fase 4:

- **Positivo (deve detectar)**: `"Isso é senso comum."` repetida literalmente uma segunda vez → `True`. *(Nota: por ter só 3 palavras, é o caso limite mínimo que a regra ainda pega — abaixo disso, ex. "Entendo.", a regra intencionalmente não dispara, ver "Limitação aceita" no plano.)*
- **Positivo (variação leve)**: `"Para calcular 17% de 850, você multiplica 850 por 0,17."` vs `"Para calcular 17% de 850, multiplica 850 por 0,17."` (uma palavra a menos) → `True`.
- **Positivo (frase longa, Teologia real)**: as duas variações do capítulo de Hebreus 5 observadas em `docs/audits/phase-4-c6-matrix-result.json` → `True`.
- **Negativo (frases curtas demais, não deve disparar mesmo sendo idênticas)**: `"Entendo."` vs `"Entendo."` → `False` (menos de 3 palavras).
- **Negativo (mesmo tema, conteúdo realmente diferente)**: duas frases sobre Aceitação na Virtologia com o mesmo vocabulário mas afirmando coisas diferentes (ex. a definição vs. a distinção com conformismo, do prompt real do agente) → `False`.
- **Negativo (primeira ocorrência, lista vazia)**: qualquer frase contra `previously_emitted = []` → `False`.

### Verificação com áudio real (evidência qualitativa, mesmo padrão da Fase 4)
Reexecutar os 6 casos da matriz de `docs/audits/phase-4-c6-matrix-result.json` (mesmo servidor real, mesmo `matrix-c6.mjs`) e confirmar: nenhuma resposta falada contém uma frase quase-duplicada da anterior; casos que antes loopavam agora terminam mais curtos, com `done` recebido normalmente (sem erro no cliente). Resultado salvo em `docs/audits/fix-repetition-loop-c6-rerun.json`.

## Critérios de aceite
- **C1** `test_repetition_detector.py` roda com `.runtime/.venv/bin/python3` e todos os casos passam (positivos detectam, negativos não disparam falso positivo).
- **C2** `npm run typecheck && npm run build && npm test` sem regressão (esta correção não toca em TypeScript, mas a suíte completa deve continuar passando).
- **C3** Verificação com áudio real: nenhuma frase quase-duplicada chega ao TTS nos 6 casos da matriz reexecutada; turnos cortados terminam com `done`, não com `error`.
- **C4** Nenhuma resposta legítima curta (ex.: "17% de 850 é igual a 144,5.") é afetada — mesmo comportamento de antes para respostas sem repetição.

## Sequência
1. Auditoria adversarial deste plano (Codex CLI e/ou Antigravity CLI, modo read-only/plan) — só implementar depois de aprovado sem achados de gravidade alta pendentes.
2. Implementação: as duas funções novas + o trecho modificado de `handle_generate()` em `scripts/worker/worker.py`.
3. `test_repetition_detector.py` (C1) rodado e evidenciado.
4. Regressão da suíte TypeScript (C2).
5. Verificação com áudio real reexecutando a matriz da Fase 4 (C3, C4), evidência salva.
6. Atualizar `docs/implementation-phase-4.md` §6 (achado fora de escopo) apontando para este documento como resolvido, com a evidência da reexecução.
