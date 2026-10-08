# Auditoria adversarial — Fase 13a (f13a-code.diff + f13a-tests.diff)

Auditor: Kimi K3 (leitura estática dos diffs; nenhuma execução). Só constam achados com evidência literal no diff.

---

## ACHADO 1 — Cancelamento (barge-in) não alcança síntese ENFILEIRADA no pool do worker

**EVIDÊNCIA** (`f13a-code.diff`, worker.py):

```
+                self._synth_pool.submit(self.handle_synthesize, msg)
```
e, dentro de `handle_synthesize` (que SÓ roda quando uma das 2 threads do pool pega o item da fila):
```
+        entry: dict[str, Any] = {"cancel": threading.Event(), "turn_id": msg.get("turnId")}
+        with self._synth_lock:
+            self._syntheses[req_id] = entry
```
Já `handle_cancel_synth` / `handle_cancel` só enxergam o que já está em `_syntheses`:
```
+        with self._synth_lock:
+            entry = self._syntheses.get(req_id)
+        if entry is not None:
+            entry["cancel"].set()
```

Com 2 sínteses em curso (pool cheio), a 3ª fica na fila interna do `SynthPool` **sem entrada em `_syntheses`**. Um `cancel_synth` (ou `cancel` do turno) nessa janela é no-op; quando a thread pega o item, a síntese roda inteira e chama o Google **depois** do barge-in. No Node, `finish()` já rodou (`settled`) e o `synth_result` tardio é descartado — o usuário não ouve nada errado, mas (a) a cota do Google é consumida por áudio morto, (b) a thread do pool fica ocupada com trabalho cancelado (até 12 s), atrasando sínteses válidas do turno novo. O comentário no código ("Idempotente: reqId já terminado ou **desconhecido** é no-op") trata o caso como benigno; não é, porque pedido enfileirado é comum (coalescência manda várias por turno) e barge-in é o caminho principal de cancelamento.

**GRAVIDADE: ALTA** — **CONFIANÇA: alta** (a fila é `queue.Queue()` ilimitada no `SynthPool.__init__`, confirmado no diff).
**AÇÃO:** registrar a entrada de cancelamento no despacho (`elif cmd == "synthesize"`), não dentro de `handle_synthesize`, e checar `cancel.is_set()` no início de `_synthesize` antes de chamar a rede.

---

## ACHADO 2 — Cota descontada por pedido NUNCA enviado ao Google (abort durante a espera pelo semáforo)

**EVIDÊNCIA** (`geminiVoiceProvider.ts`):

```
+    if (!(st.reservation?.take() ?? false) && !this.budget.tryTake()) {
+      st.mode = 'say';
```
`take()`/`tryTake()` executam `commitOne()` (grava em disco). Só **depois** disso:
```
+    await this.acquire(signal);
```
`acquire` rejeita com AbortError se o sinal abortar na fila (e há o caso `if (signal?.aborted) return onAbort();` já na entrada). Ou seja: pedido abortado antes de chegar ao `engine.synthesize` **já descontou do minuto/dia em disco**, contradizendo a regra documentada do próprio `ttsBudget.ts`: "todo pedido ENVIADO ao Google desconta... pedido bloqueado aqui não desconta". O teste "já abortado antes de começar: rejeita sem chamar o motor" (`geminiVoiceProvider.test.ts`) confere que o motor não é chamado, mas **não confere `budget.status().used`** — o desconto indevido passa despercebido pelos testes.

**GRAVIDADE: MÉDIA** (conservadora — nunca estoura a cota do Google; só a desperdiça e pode derrubar o turno para o `say` sem necessidade em cenário de aborts em rajada) — **CONFIANÇA: alta**.
**AÇÃO:** mover a tomada da cota para depois de `acquire()`, ou checar `signal?.aborted` antes de `take()` e reembolsar (`release`-like de 1) no caminho de abort do `acquire`.

---

## ACHADO 3 — Evicção do mapa de turnos (>16) libera reserva de turno ATIVO e permite reserva dupla

**EVIDÊNCIA** (`geminiVoiceProvider.ts`):

```
+    if (this.turns.size > 16) {
+      const oldest = this.turns.keys().next().value as string | undefined;
+      if (oldest !== undefined && oldest !== turnId) this.endTurn(oldest);
+    }
```
`endTurn` faz `st.reservation.release()` e remove a entrada. Se o turno mais antigo ainda está em execução (turno longo, ou processo que não finalizou ainda), sua reserva é estornada **enquanto frases dele ainda serão sintetizadas**; na próxima `synthesize` desse turno, `turnState()` não acha a entrada e cria **outra** com **nova reserva de 2** — double-booking por turno, e o modo/degrau do disjuntor (`st.mode='say'` por falha anterior) se perde, reabrindo o Gemini no meio de um turno já rebaixado. O teste associado ("o mapa de turnos não cresce sem limite") só confere `held <= 16*2`, não cobre o turno evictado em atividade.

**GRAVIDADE: MÉDIA** (só dispara com >16 turnos não encerrados simultâneos, mas nesse cenário corrói a reserva real e o disjuntor por turno) — **CONFIANÇA: alta no mecanismo, média na frequência**.
**AÇÃO:** evictar somente turnos sem reserva ativa (ou varrer do mais antigo ao mais novo até achar um inativo); nunca chamar `endTurn` do turno recém-evictado de forma silenciosa — logar.

---

## ACHADO 4 — Item pulado por prazo gera WAV órfão e áudioId morto

**EVIDÊNCIA** (`sessionManager.ts`):

```
+    const readyTimer = setTimeout(
+      () => this.resolveSynthesisItem(session, turn, seq, null, 'prazo de prontidão excedido'),
```
e
```
+    if (seq < turn.nextToEmit || turn.synthResults.has(seq)) return; // já resolvido (ex.: pulado por prazo)
```
Quando o timer dispara, o item é resolvido como `null` e a ordem de emissão avança; mas a síntese em curso **continua** e, ao terminar, o provedor já gravou o WAV em `filePath` (`const { audioId, filePath } = this.audioStore.newOutputPath(session.id)` já foi criado). O resultado tardio é descartado pelo guard acima — sem remoção do arquivo nem do registro no audioStore. O teste H13a.17 ("o item tardio nunca é emitido fora de ordem") confirma o descarte lógico, mas não remove o arquivo. A limpeza da Fase 12 dos `.part`/tmp mitiga no disco, mas o par (audioStore entry, WAV) fica órfão até lá.

**GRAVIDADE: BAIXA/MÉDIA** — **CONFIANÇA: alta**.
**AÇÃO:** no caminho de descarte tardio dentro de `synthesizeSentence` (ou no guard de `resolveSynthesisItem`), apagar `filePath` quando `produced && ` item já resolvido por prazo; documentar que a varredura é o backstop.

---

## ACHADO 5 — `isFirstOfTurn` usa `seq === 0`, mas `seq` conta TODAS as falas do turno (inclusive `say`/mutação)

**EVIDÊNCIA** (`sessionManager.ts`):

```
+      await this.ttsProvider.synthesize(text, filePath, turn.abortController.signal, {
+        turnId: turn.turnId,
+        kind,
+        isFirstOfTurn: seq === 0
```
`seq` é o contador global do turno (`const seq = turn.nextSeq; turn.nextSeq += 1;`), incrementado também para perguntas de mutação/ferramentas/falhas (`'local'`/`'dictated'`), que o próprio provedor desvia para o `say` (`GeminiVoiceProvider.synthesize`: `if (kind === 'dictated' && ...)` e fallback do `say` não usa o prazo). Consequência real: num turno cuja PRIMEIRA fala é uma pergunta de mutação (consome `seq` 0), a primeira frase que de fato vai ao Gemini chega com `isFirstOfTurn: false` e recebe `deadlineMs` de 12 s em vez do prazo curto de 8 s — exatamente o caso (primeira fala em nuvem do turno, usuário em silêncio) que o prazo curto foi criado para proteger. O inverso não ocorre (seq 0 sempre é de fato a primeira).

**GRAVIDADE: BAIXA** (latência pior, nenhuma falha funcional) — **CONFIANÇA: alta**.
**AÇÃO:** marcar `isFirstOfTurn` pelo primeiro item com destino potencial à nuvem do turno (ex.: `turn.generatedSeen === 0` no caminho gerado, ou flag pública que o GeminiVoiceProvider ignora para outros kinds).

---

## ACHADO 6 — Falha de configuração (`client_error`) derruba o turno atual para o `say` mas NÃO reclassifica turnos em curso

**EVIDÊNCIA** (`geminiVoiceProvider.ts`):

```
+    this.counters.failures += 1;
+    st.mode = 'say';
```
`st.mode='say'` vale só para ESTE turno. Mas outros turnos ativos (uma segunda aba/sessão compartilhando o processo e o mesmo `TtsBudget`) têm seu próprio `TurnState` e continuarão chamando o Gemini — que acabou de responder 401 — até cada um falhar individualmente e impostar `budget.block(...)` de novo (o `block` é idempotente por `Math.max`, então o efeito final é correto, mas há N chamadas desperdiçadas de cota e de latência antes). Não há leitura de `budget.status().blockedForMs` em `turnState`/`synthesize` além de `usable()` dentro de `reserve`/`tryTake` — espere: `reserve` chama `usable()` que honra `blockedUntil`, então o segundo turno JÁ cai em `say` via reserva negada. **Ao reler, o defeito se reduz a: o pedido em voo do turno B no instante da falha do turno A ainda vai ao Google.** Com `concurrency: 2` e multi-sessão, isso é no máximo um par de pedidos. **Rebaixo para informativo.**

**GRAVIDADE: BAIXA** — **CONFIANÇA: média** (depende de `turnState` ser chamado após o `block`, o que o diff suporta: `reserve` → `usable()` → `this.now() >= this.blockedUntil`).
**AÇÃO:** nenhuma urgente; opcionalmente checar `blockedForMs` antes do `take()` por simetria.

---

## ACHADO 7 — Teste vacuo

**EVIDÊNCIA** (`f13a-tests.diff`, `test_tts_synthesis.py`):

```
+    wd.handle_cancel({"cmd": "cancel", "turnId": "outro-turno"})
+    check("cancelar OUTRO turno não afeta sínteses (nenhuma em curso)", True)
```
`check(nome, True)` passa sempre. O nome admite "nenhuma em curso", ou seja, o teste só afirma que cancelar sem sínteses não quebra — e mesmo isso não é verificado (uma exceção no `handle_cancel` **falharia** o script por exceção, então até algo se prova, mas a asserção em si é vazia e não testa o título).

**GRAVIDADE: BAIXA** — **CONFIANÇA: total**.
**AÇÃO:** ou remover, ou transformar em asserção real (iniciar síntese de `turno-B`, cancelar `outro-turno`, verificar que a síntese de B COMPLETA com `ok: True`).

---

## ACHADO 8 — Teste vacuo (2)

**EVIDÊNCIA** (`f13a-tests.diff`, `test_tts_synthesis.py`):

```
+check("pool tem 2 workers", worker.TTS_POOL_WORKERS == 2)
```
Testa a constante, não o comportamento (as threads `synth-*` já são checadas como daemon no teste anterior com `threading.enumerate()`). Se alguém mudar o construtor para usar 1 thread ignorando a constante, o teste continua verde. (O teste H13a.16 de shutdown cobre parcialmente o pool real.)

**GRAVIDADE: BAIXA** — **CONFIANÇA: total**.
**AÇÃO:** substituir por contagem real de threads `synth-` ativas, ou remover.

---

## ACHADO 9 — Reserva atravessa a virada do dia (Los Angeles) sem revalidação

**EVIDÊNCIA** (`ttsBudget.ts`):

```
+  reserve(n: number): Reservation | null { ... this.held += n; ... }
+      take: () => { ... this.commitOne(); ... }
```
`commitOne` faz `this.sent.push(this.now()); this.dayCount += 1; this.writeDisk();` — mas `loadDisk()` (que faz o rollover do dia) só é chamado por `usable()`/`status()`. Uma reserva concedida às 23:59:59 (LA) pode ter seus `take()` executados depois da meia-noite LA: `this.day` ainda é o dia velho em memória até o próximo `loadDisk`, e o `writeDisk()` grava `{ day: diaVelho, count: ... }` **recriando o arquivo do dia anterior depois da virada** — na próxima leitura, `data.day === today` é falso e o contador de hoje zera (correto), mas os `take()`s foram contados no dia errado e o `sent` do minuto nunca revalida o dia. Efeito líquido: algumas unidades do dia novo somem do contador (subcontagem na borda da virada).

**GRAVIDADE: BAIXA** (janela de minutos por dia, subcontagem conservadora acaba corrigida pelo `Math.max` na próxima leitura só se o arquivo do dia novo existir... na verdade pior: `writeDisk` com `day` velho é descartado — a subcontagem fica) — **CONFIANÇA: média/alta** no mecanismo.
**AÇÃO:** chamar `loadDisk()` dentro de `commitOne()` (ou no início de `take()`), como já acontece em `usable()`.

---

## Verificações com resultado NEGATIVO (procurados e não confirmados)

- **Ordem de áudio / frase duplicada:** o seq/nextToEmit/Map em `resolveSynthesisItem` é consistente; guardas contra re-resolução e turno superado presentes (`if (seq < turn.nextToEmit || turn.synthResults.has(seq)) return;`, `session.activeTurn !== turn`). Não achei caminho de dupla emissão.
- **Vazamento de `.part`:** `write_wav_atomic` remove `.part` em qualquer exceção; timeout local retorna antes de `write_wav_atomic` (a thread interna é descartada sem escrever). Não confirmado.
- **Texto à nuvem com canal desligado:** o worker checa `RODRIGO_CLOUD`/`RODRIGO_CLOUD_TTS` (defesa em profundidade) e o Node recebe `RODRIGO_CLOUD_TTS: ttsCloudEffective(cfg)` — testado em egress com 0 conexões. Não confirmado.
- **Falha que não cai para o `say`:** `afterFailure` cobre todos os kinds, `endTurn` via `finally`. Não confirmado.
- **Timers órfãos:** `readyTimer` é limpo no `finally`-equivalente; `coalesce.timer` limpo em `flushCoalesce`; ambos `unref()`. Não confirmado.

---

## Verificação dos achados (Claude Opus 5.5, 2026-10-08, contra o código; nenhum achado aceito sem conferir)

Auditor: Kimi K3 (`opencode run -m nvidia/moonshotai/kimi-k3`), viu SÓ os diffs de código e testes do commit e617497 (sem docs/research, sem .env). O Hermes foi tentado antes e falhou sem achados ("allowance for chatting without signing in" — cota anônima da Nous).

| # | Veredito | Ação |
|---|---|---|
| 1 | CONFIRMADO no worker, mas gravidade rebaixada ALTA→BAIXA: o semáforo do Node (concorrência 2 = pool 2) já impede fila no worker numa sessão só; um pedido abortado na espera do Node nunca é enviado | Corrigido (registro no despacho + checagem antes da rede). Teste novo com prova de mutação |
| 2 | CONFIRMADO (cota descontada antes de obter a vaga) | Corrigido (desconta depois do acquire). Asserção nova `used == 2`, prova de mutação |
| 3 | Mecanismo real, mas fora de alcance prático (uma sessão por vez; turno sai do mapa ao terminar) | Não corrigido, registrado |
| 4 | CONFIRMADO (WAV de item pulado por prazo fica órfão até a limpeza da sessão) | Corrigido (apaga na hora). **Sem teste dedicado** |
| 5 | FALSO POSITIVO: em nenhum caminho uma fala local/ditada precede uma frase gerada no mesmo turno; seq 0 é sempre a primeira gerada | Nada |
| 6 | Informativo (o próprio auditor rebaixou) | Nada |
| 7 | CONFIRMADO (asserção `True`) | Substituído por teste real (síntese de outro turno conclui) |
| 8 | CONFIRMADO (testava a constante) | Conta threads reais |
| 9 | CONFIRMADO (envio após a virada do dia contado no dia antigo) | Corrigido (`loadDisk()` em `commitOne`). Teste novo, prova de mutação |
