# Correção: loop de repetição de frase na geração de voz — v2

Data 2026-09-15. Revisão da v1 após auditoria adversarial (Antigravity CLI `agy` 1.2.2, modo plan, effort high) — v1 **BLOQUEADA** por 1 achado de gravidade alta e 1 médio (mais 1 baixo). Este documento corrige os 3. Log completo: `docs/audits/fix-repetition-loop-audit-result-v1-agy.log`.

## Objetivo e definição de pronto (inalterado da v1)

Cortar a geração de forma determinística assim que uma frase repetir quase-verbatim uma frase já emitida no mesmo turno — tratando isso como fim natural da resposta, nunca como erro. "Pronto" exige: teste automatizado da função de detecção com os casos reais já observados (positivos e negativos), verificação com áudio real de que o corte acontece de fato, e confirmação de que nenhuma repetição curta e legítima é cortada incorretamente.

## Correções da v1 (achado → resolução)

**Achado 1 (alto) — a métrica de trigramas com Jaccard ≥ 0.75 falha no próprio caso de teste do plano.** Verificado matematicamente e reproduzido rodando Python de verdade: `"...você multiplica 850 por 0,17."` vs `"...multiplica 850 por 0,17."` (só a palavra "você" removida, no meio de uma frase de 11 palavras) dá Jaccard de trigramas = 6/11 ≈ 0,545 — abaixo do limiar, um falso negativo exatamente no caso que o plano usava como exemplo positivo. O auditor generalizou: para qualquer frase de W palavras com uma alteração/omissão interna, o Jaccard de trigramas só bate ≥0,75 se W ≥ 17 — a maioria das frases faladas (6-15 palavras) nunca atingiria isso. **Resolução**: troca de métrica. Em vez de Jaccard de trigramas, usa `difflib.SequenceMatcher(None, a, b).ratio()` (biblioteca padrão do Python, sem dependência nova) sobre o texto normalizado inteiro — essa métrica é sensível a edições localizadas sem penalizar despropositadamente frases longas. Recalculado com Python real: o mesmo par de frases dá `0,949` (bem acima do novo limiar, mantido em `0,75`); os pares repetidos reais da Fase 4 (ex. duas variações do parágrafo de Hebreus 5 geradas em execuções diferentes) dão `0,690` — abaixo do limiar, corretamente NÃO tratado como duplicata dentro do mesmo turno, já que são frases de turnos/execuções diferentes, não uma repetição real dentro da mesma resposta.

**Achado 2 (médio) — o texto residual (`leftover`) ao fim do streaming nunca passava pela detecção.** Se a geração for cortada por `MAX_TURN_TOKENS` (não pela detecção de loop) bem no meio de uma frase que já é uma repetição, esse texto vazaria para o TTS sem checagem — o mesmo defeito que a correção existe para evitar, só que pela porta dos fundos. **Resolução**: o bloco de emissão do `leftover` agora também chama `_is_near_duplicate_sentence()` antes de emitir.

**Achado 3 (baixo) — contagem de palavras errada no exemplo do plano.** `"Isso é senso comum."` tem 4 palavras após normalização (`isso`, `é`, `senso`, `comum`), não 3 como a v1 afirmava. **Resolução**: nota corrigida; o exemplo do limite mínimo de 3 palavras agora usa `"Deus é amor."` (exatamente 3 palavras), sugestão do próprio auditor.

## Decisão de projeto (atualizada)

**Detecção por `difflib.SequenceMatcher.ratio()` sobre o texto normalizado inteiro, limiar `0.75`** — não trigramas/Jaccard (ver Achado 1). `SequenceMatcher` mede a proporção de caracteres em comum considerando a maior subsequência comum recursivamente; ao contrário de Jaccard de trigramas, uma edição pontual no meio de uma frase longa não derruba a pontuação artificialmente.

**Frases com menos de 3 palavras nunca disparam a detecção** (inalterado da v1) — curtas demais para julgar com confiança sem risco de falso positivo em respostas legítimas.

**Corta no primeiro par de frases quase-duplicadas** (inalterado da v1) — simplicidade determinística, sem "segunda chance".

**O texto residual (`leftover`) ao fim do streaming também passa pela mesma checagem** (novo, Achado 2) — a garantia de "nenhuma frase quase-duplicada chega ao TTS" agora vale para os dois caminhos de emissão (durante o streaming e no residual final), não só um deles.

**Limitação aceita, documentada e não escondida** (inalterada da v1): um loop que começa com uma frase muito curta (< 3 palavras) repetida várias vezes antes de qualquer frase mais longa aparecer não é cortado pela regra sozinha — aceito pelo mesmo motivo da v1 (risco de falso positivo em respostas curtas legítimas, que são a maioria do uso normal).

## Arquitetura

### `scripts/worker/worker.py` — novas funções (perto de `find_sentence_boundary`)
```python
import difflib

_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def _normalize_for_dedup(text: str) -> str:
    """Normaliza uma frase para comparação de repetição: minúsculas, só palavras, espaços únicos."""
    words = _WORD_RE.findall(text.lower())
    return " ".join(words)


def _is_near_duplicate_sentence(
    candidate: str, previously_emitted: list[str], threshold: float = 0.75
) -> bool:
    """
    True se `candidate` repete quase-verbatim (difflib.SequenceMatcher.ratio() >= threshold)
    alguma frase já emitida neste turno (`previously_emitted`, já normalizada). Frases com
    menos de 3 palavras nunca disparam — curtas demais para julgar com confiança sem risco de
    falso positivo em respostas curtas legítimas (a maioria do uso normal). SequenceMatcher (não
    Jaccard de trigramas — ver auditoria v1) porque uma única palavra alterada/removida no meio
    de uma frase não deve derrubar artificialmente a pontuação de similaridade.
    """
    candidate_norm = _normalize_for_dedup(candidate)
    if len(candidate_norm.split()) < 3:
        return False

    for prev_norm in previously_emitted:
        if len(prev_norm.split()) < 3:
            continue
        ratio = difflib.SequenceMatcher(None, candidate_norm, prev_norm).ratio()
        if ratio >= threshold:
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
                        # NOVO — Correção do loop de repetição (achado fora de escopo da Fase 4,
                        # ver docs/implementation-phase-4.md e docs/fix-generation-repetition-loop-v2.md):
                        # trata uma frase quase-duplicada como fim natural da resposta, não como erro.
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
                # Correção do Achado 2 (auditoria v1): o residual também passa pela detecção —
                # sem isso, um corte por MAX_TURN_TOKENS no meio de uma repetição vazaria a
                # frase duplicada pela "porta dos fundos", contornando a correção acima.
                if not loop_detected:
                    leftover = buffer.strip()
                    if leftover and not _is_near_duplicate_sentence(leftover, emitted_normalized):
                        emit({
                            "event": "sentence",
                            "reqId": req_id,
                            "turnId": turn_id,
                            "index": sentence_index,
                            "text": leftover,
                        })
                emit({"event": "done", "reqId": req_id, "turnId": turn_id})
```
Nenhuma outra parte de `handle_generate()` muda. Nenhum outro arquivo é tocado — confirmado pela auditoria v1 (Achado 4/5): emitir `done` normalmente após um corte por repetição é seguro do lado Node sem nenhuma mudança em `sessionManager.ts`/`mlxWorkerEngine.ts` — o turno simplesmente termina com menos frases do que teria, o histórico da conversa só recebe o que o cliente confirma ter reproduzido (`markPlayed()`), e a frase cortada nunca chega a esse ponto porque nunca foi emitida.

## Testes

### Novo: `scripts/worker/test_repetition_detector.py` (script standalone, sem framework)
Importa `_normalize_for_dedup` e `_is_near_duplicate_sentence` de `worker.py` (funções puras, sem dependência de MLX carregado). Casos (recalculados com `difflib.SequenceMatcher`, valores reais medidos em Python):

- **Positivo (variação leve, o caso que quebrou a v1)**: `"Para calcular 17% de 850, você multiplica 850 por 0,17."` vs `"Para calcular 17% de 850, multiplica 850 por 0,17."` → `ratio ≈ 0,949` → `True`.
- **Positivo (repetição exata, frase real da Fase 4)**: `"Isso é senso comum."` repetida literalmente → `ratio = 1,0` → `True`.
- **Positivo (frase longa, variação real de execução, Teologia)**: as duas variações do parágrafo de Hebreus 5 observadas em execuções diferentes na Fase 4 → usado aqui como **negativo** de propósito (ver abaixo), não positivo — são frases de turnos diferentes, com `ratio ≈ 0,690` (abaixo do limiar), o que é o comportamento correto.
- **Positivo (piso de 3 palavras — a checagem `< 3` não exclui exatamente 3)**: `"Deus é amor."` vs `"Deus é amor."` → 3 palavras, não cai no escape (`3 < 3` é `False`), comparado normalmente → `ratio = 1,0` → `True`.
- **Negativo (frases curtas demais, abaixo do piso — nunca disparam mesmo sendo idênticas)**: `"Entendo."` vs `"Entendo."` → `False` (1 palavra); `"Sem dúvida."` vs `"Sem dúvida."` → `False` (2 palavras).
- **Negativo (mesmo tema, conteúdo realmente diferente, mesmo turno hipotético)**: `"Na Virtologia, a aceitação é a prática de acolher ativamente o que não pode ser mudado no passado."` vs `"É diferente do conformismo."` → `ratio ≈ 0,28` → `False`.
- **Negativo (primeira ocorrência, lista vazia)**: qualquer frase contra `previously_emitted = []` → `False`.

### Verificação com áudio real (evidência qualitativa, mesmo padrão da Fase 4)
Reexecutar os 6 casos da matriz de `docs/audits/phase-4-c6-matrix-result.json` (mesmo servidor real, mesmo `matrix-c6.mjs`) e confirmar: nenhuma resposta falada contém uma frase quase-duplicada da anterior; casos que antes loopavam agora terminam mais curtos, com `done` recebido normalmente. Resultado salvo em `docs/audits/fix-repetition-loop-c6-rerun.json`.

## Critérios de aceite
- **C1** `test_repetition_detector.py` roda com `.runtime/.venv/bin/python3` e todos os casos passam (positivos detectam, negativos não disparam falso positivo) — incluindo o caso de variação leve que quebrava a v1.
- **C2** `npm run typecheck && npm run build && npm test` sem regressão.
- **C3** Verificação com áudio real: nenhuma frase quase-duplicada chega ao TTS nos 6 casos da matriz reexecutada, incluindo no caminho do `leftover` (Achado 2) — turnos cortados terminam com `done`, não com `error`.
- **C4** Nenhuma resposta legítima curta (ex.: "17% de 850 é igual a 144,5.") é afetada — mesmo comportamento de antes para respostas sem repetição.

## Sequência
1. Reauditoria desta v2, focada em confirmar que os 3 achados da v1 foram resolvidos sem regressão nova.
2. Implementação: as duas funções novas + o trecho modificado de `handle_generate()` em `scripts/worker/worker.py`.
3. `test_repetition_detector.py` (C1) rodado e evidenciado.
4. Regressão da suíte TypeScript (C2).
5. Verificação com áudio real reexecutando a matriz da Fase 4 (C3, C4), evidência salva.
6. Atualizar `docs/implementation-phase-4.md` §6 apontando para este documento como resolvido, com a evidência da reexecução.

## Resultado real da verificação (2026-09-15) — inclui uma correção de rota sobre a própria evidência

C1 e C2 confirmados exatamente como planejado (8/8 casos do teste standalone, 39/39 testes TypeScript, sem regressão).

**C3/C4 tiveram um desvio importante do plano**: ao reexecutar a matriz de 6 casos para confirmar o corte de loop, descobri que `matrix-c6.mjs` (o script citado no plano acima, usado desde a Fase 4) tinha um bug de polling — o loop de leitura de eventos SSE reprocessava o mesmo intervalo a cada 50ms sem avançar um cursor, duplicando cada frase já emitida a cada tick até o turno terminar. Esse bug, não o modelo, era a causa de boa parte (possivelmente toda) da repetição severa relatada na Fase 4. Corrigido o script e reexecutada a matriz 3 vezes (18 gerações reais): **zero repetição genuína em qualquer caso**, e por consequência **o detector desta correção nunca precisou disparar** nessas 18 gerações (nenhum "Loop de repetição detectado" no log do worker).

Isso não invalida esta correção — o detector é uma rede de segurança de baixo risco, corretamente implementada e testada (C1), que permanece em produção para o caso raro (ou talvez nunca observado em uso normal) de um loop real acontecer. Mas invalida a premissa de que havia loops frequentes disponíveis para observar no dia a dia — a melhor evidência real hoje (esta reexecução + a investigação de amostragem independente de 72 gerações, ambas 0 loops) é de que o evento é raro ou inexistente nas condições normais de uso. Evidência completa: `docs/audits/fix-repetition-loop-c6-rerun.json` e os 3 logs brutos correspondentes em `docs/audits/`.

**Critérios de aceite — status final**: C1 ✅, C2 ✅, C3 ✅ (nenhuma frase quase-duplicada chegou ao TTS — porque nenhuma ocorreu, não porque o corte precisou agir), C4 ✅ (respostas curtas legítimas inalteradas).
