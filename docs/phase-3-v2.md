# Rodrigo AI Fase 3 v2 — Orquestrador (camada de decisão, sem especialistas ainda)
Data 2026-09-14. Revisão da v1 após auditoria adversarial (Codex CLI, `gpt-5.6-sol`, effort high — 3 subagentes independentes) — v1 REJEITADA por 3 achados de gravidade alta, 6 médios, 1 baixo. Este documento corrige os 10. Log completo: `docs/audits/phase-3-audit-result-v1.log`.

## Objetivo e definição de pronto (inalterado da v1)
Transformar a IA de voz da Fase 2 (aceita e em uso real) num orquestrador: antes de gerar a resposta falada, classificar a intenção do usuário numa de 4 categorias (`GERAL`, `TEOLOGIA`, `VIRTOLOGIA`, `AMBIGUO`) e expor essa decisão de forma inspecionável (evento SSE + indicador na UI). A Fase 4 (especialistas reais) não é implementada agora — toda categoria continua sendo respondida pelo LLM geral. "Pronto" exige classificação correta na matriz de casos abaixo (não só os 3 exemplos do roteiro), latência medida par-a-par contra a baseline da Fase 2, evento de roteamento visível e corretamente associado ao turno certo, cancelamento comprovadamente correto (não só "não trava no mock"), e nenhuma promessa de capacidade que não existe.

## Correções da v1 (achado → resolução)

**Achado 1 (alto) + Achado 2 (alto) — cancelamento órfão e fila que descarta sem resposta.** Redesenho: o Node **nunca espera confirmação do worker pra resolver uma Promise cancelada**. Quando `SessionManager` decide abandonar um turno, ele já sabe isso localmente (é quem decide) — então `MlxWorkerEngine.cancel(turnId)` resolve/rejeita IMEDIATAMENTE, no processo Node, qualquer `pending` (seja `PendingGenerate` ou o novo `PendingClassify`) cujo `turnId` corresponda, limpa o timer, remove de `pending`, e só DEPOIS tenta (best-effort, sem aguardar) avisar o worker via `{cmd:"cancel",turnId}` — que agora é só uma otimização de CPU (parar de gastar ciclos com um resultado que ninguém vai usar), nunca um requisito pra destravar o Node. Isso também resolve o Achado 2 por construção: se o worker processar um comando "fantasma" que o Node já cancelou, a resposta chega com um `reqId` que o Node já removeu de `pending` — `handleLine()` já tem `if (!pending) return;` e ignora silenciosamente. Corrige os dois lados (`generate` e `classify`) com o mesmo mecanismo — o auditor apontou corretamente que o defeito já existe hoje em `generate()` em produção; esta correção resolve ambos.

Timer por geração do worker: cada `spawnWorker()` incrementa `this.spawnGeneration`; todo timeout armado (de `generate`/`classify`) captura o valor de `spawnGeneration` vigente no momento, e só executa `this.child?.kill()` se `this.spawnGeneration` ainda for o mesmo — nunca mata uma instância nova do worker por causa de um timer de uma instância antiga.

**Achado 3 (alto) — `handled` sempre `true`.** Bug de lógica confirmado. Trocado para `handled: label === 'GERAL'` — sem `||`, sem `specialistAvailable`. Só `GERAL` tem handler real nesta fase; todo o resto é sempre `false`.

**Achado 4 (médio) — ordem de classify/routing/falando indefinida.** Ordem fixada explicitamente: `processando → transcript → classify (aguarda) → routing → falando → geração/áudio`. O estado só vira `falando` DEPOIS que a classificação termina e o evento `routing` já foi emitido — nunca antes. Sobre barge-in durante a classificação: a janela é curta (~300-500ms) e, como nada está tocando ainda (`falando` não começou), não existe "interrupção de fala da IA" nesse intervalo — o cenário relevante é o usuário reenviar áudio por impaciência, que já é tratado pela preempção de turno já existente em `submitAudio()` (cancela o turno anterior antes de criar o novo, independente de estado). C5 é redefinido para testar isso de forma que realmente prove o comportamento (ver Achado 5 abaixo), não só "não trava".

**Achado 5 (médio) — fake engine não prova cancelamento real.** `FakeVoiceEngine.classify()` ganha um modo controlado por barreira: um `Deferred` que o teste resolve manualmente, permitindo escrever `classify() não resolveu ainda → cancel(turnId) → assert que a Promise rejeita imediatamente (não "eventualmente", sincronamente após o cancel) → assert que pending/timer foram limpos`. Isso prova o mecanismo, não só a ausência de trava.

**Achado 6 (médio) — normalização confunde falha técnica com AMBIGUO.** Trocado: o rótulo só é aceito se, após `strip().upper().strip(".!?")`, for **exatamente igual** a um dos 4 valores de `CLASSIFICATION_LABELS` (comparação de igualdade total, não substring/`in`). Qualquer outra saída (vazia, truncada, com mais de um rótulo, fora do formato) emite `{"event":"error","reqId":...,"turnId":...,"message":"Falha ao classificar: formato de saída inesperado."}` — nunca vira `AMBIGUO` silenciosamente. `AMBIGUO` só acontece quando o modelo devolve literalmente a palavra `AMBIGUO`.

**Achado 7 (médio) — matriz de teste insuficiente.** Matriz versionada abaixo (seção "Matriz de classificação (C2)"), com positivos, negativos adjacentes e limitação documentada explicitamente: `classify()` recebe só o texto do turno atual, não o histórico da sessão — decisão por enunciado isolado, não contextual. Uma pergunta de acompanhamento tipo "E o versículo seguinte?" pode ser classificada incorretamente sem o contexto anterior; isso é uma limitação conhecida e aceita nesta fase, não um bug a esconder — registrada como "achado fora de escopo" pra uma Fase 3.1 futura se virar problema real de uso.

**Achado 8 (médio) — estimativa de latência não sustentada.** O plano não afirma mais "≤300-500ms" como fato. C3 (abaixo) exige medição par-a-par real (baseline Fase 2 vs. Fase 3, mesmo corpus de 10 perguntas, ≥10 turnos após aquecimento) antes de declarar o critério cumprido, cobrindo mediana E p95 (não só mediana).

**Achado 9 (médio) — transparência da UI não testável/não estável.** `turnId` preservado no callback do frontend; indicador "Agente: ..." é limpo/resetado a cada novo turno (`processando`), erro, fim de sessão ou preempção — nunca mostra o rótulo de um turno que não é mais o atual. C4 é escopado explicitamente a "conexão SSE contínua" (reconexão não reenvia eventos perdidos — mesma limitação já aceita da Fase 2, não uma regressão nova). Verificação manual da UI adicionada à sequência (mesmo padrão do teste humano da Fase 2).

**Achado 10 (baixo) — campos reservados prematuros.** `requiresConfirmation` e `secondaryLabels` **removidos** do contrato desta fase. Regras de confirmação e múltiplos agentes ficam pra quando a Fase 5/4 realmente precisar delas — nada de contrato inerte contraditório.

## Fatos e decisão (reafirmada da v1, com as correções acima)
Reaproveita o LLM já carregado (`Qwen3-4B-Instruct-2507-4bit`) — sem segundo modelo. Comando de protocolo dedicado `classify` no worker Python, separado de `generate`. `temp=0.0`, `max_tokens=8` (confirmado suficiente pelo auditor: GERAL=2 tokens, TEOLOGIA=4, VIRTOLOGIA=5, AMBIGUO=4, no tokenizer real — o risco não é tamanho, é desvio de formato, já coberto pela correção do Achado 6).

## Arquitetura

### Protocolo do worker (scripts/worker/worker.py)
```python
CLASSIFICATION_LABELS = frozenset({"GERAL", "TEOLOGIA", "VIRTOLOGIA", "AMBIGUO"})
CLASSIFICATION_SYSTEM_PROMPT = (
    "Você classifica uma frase do usuário em EXATAMENTE uma categoria. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: "
    "GERAL, TEOLOGIA, VIRTOLOGIA ou AMBIGUO.\n"
    "TEOLOGIA: perguntas sobre a Bíblia, exegese, doutrina cristã, sermões, teologia cristã.\n"
    "VIRTOLOGIA: perguntas sobre os conceitos e terminologia específicos da Virtologia "
    "(ex.: Aceitação no sentido técnico dessa área — não o sentido cotidiano da palavra).\n"
    "GERAL: qualquer outra coisa — matemática, conversa cotidiana, perguntas factuais gerais, "
    "pedidos de ação/ferramenta (ainda não implementados, tratar como GERAL).\n"
    "AMBIGUO: a frase pertence claramente a mais de uma categoria acima, ou não há "
    "contexto suficiente pra decidir com confiança."
)

def handle_classify(self, msg: dict[str, Any]) -> None:
    req_id = msg["reqId"]
    turn_id = msg["turnId"]
    epoch = msg["epoch"]
    text = msg["text"]

    handle = GenerationHandle(turn_id=turn_id, epoch=epoch)
    with self._current_lock:
        self._current = handle

    try:
        messages = [
            {"role": "system", "content": CLASSIFICATION_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ]
        prompt = self._llm_tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

        from mlx_lm.generate import stream_generate
        from mlx_lm.sample_utils import make_sampler

        sampler = make_sampler(temp=0.0)
        raw = ""
        for response in stream_generate(
            self._llm, self._llm_tokenizer, prompt, max_tokens=8, sampler=sampler
        ):
            if handle.cancel_event.is_set():
                log_diag(f"Classificação cancelada pelo worker (turnId={turn_id}) — Node já resolveu localmente.")
                return
            raw += response.text

        normalized = raw.strip().upper().strip(".!? \n")
        if normalized not in CLASSIFICATION_LABELS:
            log_diag(f"Saída de classificação fora do formato esperado (turnId={turn_id}).")
            emit({
                "event": "error", "reqId": req_id, "turnId": turn_id,
                "message": "Falha ao classificar: formato de saída inesperado."
            })
            return

        emit({"event": "classification", "reqId": req_id, "turnId": turn_id, "label": normalized})
    except Exception as exc:  # noqa: BLE001
        log_diag(f"Erro na classificação: {exc}\n{traceback.format_exc()}")
        emit({"event": "error", "reqId": req_id, "turnId": turn_id, "message": "Falha ao classificar a intenção."})
    finally:
        with self._current_lock:
            if self._current is handle:
                self._current = None
        if self._mx is not None:
            self._mx.clear_cache()
```
`stdin_reader_loop`: `cmd == "classify"` entra na mesma fila de trabalho que `transcribe`/`generate` (comportamento de fila já existente, inalterado — o Achado 2 é resolvido no lado Node, não precisa de mudança aqui). `work_loop`: adicionar `elif cmd == "classify": self.handle_classify(msg)`.

**Nota de correção retroativa (fora do escopo desta fase, mas no mesmo arquivo):** `handle_generate` mantém seu `break` silencioso em cancelamento — isso é seguro agora porque o Node não depende mais do worker emitir nada pra resolver a Promise (ver correção do Achado 1). Não precisa mudar `handle_generate` nesta fase; documentado aqui pra quem ler o código não estranhar a ausência de um evento terminal explícito de cancelamento vindo do worker.

### Node — `VoiceEngine` (src/backend/voice/engine.ts)
```typescript
export type OrchestratorLabel = 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'AMBIGUO';

export interface VoiceEngine {
  isReadySync(): boolean;
  waitUntilReady(timeoutMs: number): Promise<void>;
  transcribe(audioPath: string): Promise<string>;
  classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel>;
  generate(
    turnId: string, epoch: number, messages: ConversationMessage[], callbacks: GenerateCallbacks
  ): Promise<void>;
  cancel(turnId: string): void;
  shutdown(): Promise<void>;
}
```

### Node — `MlxWorkerEngine` (src/backend/voice/mlxWorkerEngine.ts) — mudanças completas
```typescript
const CLASSIFY_TIMEOUT_MS = 10_000;
const CLASSIFICATION_LABELS = new Set(['GERAL', 'TEOLOGIA', 'VIRTOLOGIA', 'AMBIGUO']);

interface PendingClassify {
  kind: 'classify';
  turnId: string;
  resolve: (label: OrchestratorLabel) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  spawnGeneration: number;
}
// Pending vira: type Pending = PendingTranscribe | PendingGenerate | PendingClassify;
// PendingGenerate ganha o mesmo campo `spawnGeneration: number`.

class MlxWorkerEngine implements VoiceEngine {
  private spawnGeneration = 0; // incrementado a cada spawnWorker()

  private spawnWorker(): void {
    this.spawnGeneration += 1;
    // ...resto do método igual ao já implementado...
  }

  async classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel> {
    const reqId = nextReqId();
    const spawnGeneration = this.spawnGeneration;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new VoiceEngineError(`Classificação do turno ${turnId} excedeu ${CLASSIFY_TIMEOUT_MS}ms.`));
        if (this.spawnGeneration === spawnGeneration) {
          this.child?.kill('SIGKILL'); // só mata a instância que ainda é a atual
        }
      }, CLASSIFY_TIMEOUT_MS);

      this.pending.set(reqId, { kind: 'classify', turnId, resolve, reject, timeout, spawnGeneration });

      try {
        this.writeCommand({ cmd: 'classify', reqId, turnId, epoch, text });
      } catch (err) {
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(err as Error);
      }
    });
  }

  cancel(turnId: string): void {
    // Resolve/rejeita localmente QUALQUER pending deste turnId, sem esperar o worker —
    // corrige Achados 1 e 2: o Node nunca fica preso esperando uma confirmação que pode
    // nunca chegar (comando descartado da fila, worker morto, etc.).
    for (const [reqId, pending] of this.pending) {
      if (pending.kind === 'transcribe') continue; // transcribe não carrega turnId hoje — fora de escopo
      if (pending.turnId !== turnId) continue;

      this.pending.delete(reqId);
      clearTimeout(pending.timeout);

      if (pending.kind === 'classify') {
        pending.reject(new VoiceEngineError(`Classificação do turno ${turnId} cancelada.`));
      } else {
        pending.resolve(); // generate() cancelado: resolve (não é erro) — turno já é abandonado pelo chamador
      }
    }

    try {
      this.writeCommand({ cmd: 'cancel', turnId }); // best-effort: só evita trabalho desperdiçado no worker
    } catch {
      // worker indisponível — sem problema, já resolvemos localmente acima
    }
  }

  private handleLine(line: string): void {
    // ...trecho existente inalterado até chegar no switch por evento...
    const pending = this.pending.get(reqId);
    if (!pending) return; // resultado de um reqId já cancelado/substituído — ignora (corrige Achado 2)

    if (event === 'classification' && pending.kind === 'classify') {
      this.pending.delete(reqId);
      clearTimeout(pending.timeout);
      const label = msg.label as string;
      if (!CLASSIFICATION_LABELS.has(label)) {
        pending.reject(new VoiceEngineError('Worker retornou rótulo de classificação inválido.'));
        return;
      }
      pending.resolve(label as OrchestratorLabel);
      return;
    }
    // 'error' já tratado genericamente pelo código existente — cobre classify também,
    // desde que o `pending.kind === 'classify'` também limpe o timeout (mesma lógica
    // já aplicada a 'generate' hoje, só estendida ao novo tipo).
  }
}
```

### Node — `FakeVoiceEngine` (src/backend/voice/fakeEngine.ts) — para testes
```typescript
export class FakeVoiceEngine implements VoiceEngine {
  // ...campos existentes...
  public classificationToReturn: OrchestratorLabel = 'GERAL';
  public classifyCalls: Array<{ turnId: string; text: string }> = [];
  private classifyGate: { turnId: string; resolve: () => void } | null = null;

  async classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel> {
    this.classifyCalls.push({ turnId, text });
    if (this.cancelledSetHas(turnId)) throw new Error('cancelado');

    await new Promise<void>((resolve) => {
      this.classifyGate = { turnId, resolve };
      // Se ninguém abrir a barreira manualmente (releaseClassifyGate), resolve sozinho
      // depois de classifySettleDelayMs (default 0) — mantém compatível com os testes
      // que não se importam com o timing fino.
      if (this.classifySettleDelayMs === 0) resolve();
      else setTimeout(resolve, this.classifySettleDelayMs);
    });

    if (this.cancelledSetHas(turnId)) throw new Error('cancelado');
    return this.classificationToReturn;
  }

  /** Usado por testes que precisam provar cancelamento síncrono real (Achado 5). */
  public classifySettleDelayMs = 0;
  public isClassifyPending(turnId: string): boolean {
    return this.classifyGate?.turnId === turnId;
  }

  cancel(turnId: string): void {
    this.cancelledSet.add(turnId);
    this.cancelledTurnIds.push(turnId);
    if (this.classifyGate?.turnId === turnId) {
      this.classifyGate.resolve(); // libera a barreira para a Promise rejeitar no próximo tick
      this.classifyGate = null;
    }
  }

  private cancelledSetHas(turnId: string): boolean {
    return this.cancelledSet.has(turnId);
  }
}
```

### Node — `SessionManager.runTurn()` (src/backend/voice/sessionManager.ts) — ordem corrigida
```typescript
private async runTurn(session: Session, turn: ActiveTurn, audioPath: string): Promise<void> {
  try {
    if (!this.engine.isReadySync()) {
      this.emit(session, { type: 'state', state: 'aquecendo' });
      await this.engine.waitUntilReady(VOICE_LIMITS.WARMUP_TIMEOUT_MS);
      if (session.activeTurn !== turn) return;
    }

    const transcript = await this.engine.transcribe(audioPath);
    if (session.activeTurn !== turn) return;

    this.emit(session, { type: 'transcript', turnId: turn.turnId, text: transcript });
    session.history.push({ role: 'user', content: transcript });
    this.trimHistory(session);

    // Correção do Achado 4: classifica ANTES de "falando" — estado continua "processando".
    let label: OrchestratorLabel;
    try {
      label = await this.engine.classify(turn.turnId, turn.epoch, transcript);
    } catch (err) {
      if (session.activeTurn !== turn) return; // cancelado — não é erro real, só encerra
      throw err; // erro real de classificação vira o mesmo tratamento de erro do turno (catch externo)
    }
    if (session.activeTurn !== turn) return;

    const handled = label === 'GERAL'; // Correção do Achado 3 — sem "|| !specialistAvailable"
    this.emit(session, { type: 'routing', turnId: turn.turnId, label, handled });

    this.emit(session, { type: 'state', state: 'falando' });

    const messagesForEngine: ConversationMessage[] = [
      { role: 'system', content: VOICE_SYSTEM_PROMPT },
      ...session.history
    ];

    await this.engine.generate(turn.turnId, turn.epoch, messagesForEngine, {
      onSentence: (rawText, index) => {
        if (session.activeTurn !== turn) return;
        const text = cleanTextForSpeech(rawText);
        if (!text) return;
        turn.expectedSentences.add(index);
        turn.pendingSynthesis.push(this.synthesizeSentence(session, turn, text, index));
      }
    });

    await Promise.allSettled(turn.pendingSynthesis);

    if (session.activeTurn === turn) {
      this.emit(session, { type: 'turn_done', turnId: turn.turnId });
      this.emit(session, { type: 'state', state: 'ouvindo' });
      session.activeTurn = null;
    }
  } catch (err) {
    if (session.activeTurn === turn) {
      this.emit(session, {
        type: 'error', turnId: turn.turnId,
        message: err instanceof Error ? err.message : 'Erro desconhecido.'
      });
      this.emit(session, { type: 'state', state: 'erro' });
      session.activeTurn = null;
    }
  }
}
```

### Contrato do evento (src/shared/voiceProtocol.ts) — sem os campos removidos (Achado 10)
```typescript
export interface RoutingEvent {
  type: 'routing';
  turnId: string;
  label: 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'AMBIGUO';
  handled: boolean;
}
// VoiceServerEvent ganha RoutingEvent na união.
```

### Frontend (src/frontend/voice.ts, main.ts) — correção do Achado 9
`handleServerEvent` para `'routing'`: chama `onRouting(turnId, label, handled)` (turnId preservado, não descartado). Em `main.ts`: elemento `#voice-agent-indicator` atualizado só se `turnId === currentDisplayedTurnId` (rastreado); resetado (texto vazio/"—") sempre que o estado vira `processando` de um NOVO turno, em `error`, e ao encerrar sessão. Texto exibido: `handled ? "Agente: Geral" : \`Classificado como: ${label} (especialista ainda não implementado — Fase 4)\``.

## Matriz de classificação (C2) — versionada antes da implementação
| # | Texto | Rótulo esperado | Por quê |
|---|---|---|---|
| 1 | "Quanto é 17% de 850?" | GERAL | Exemplo do roteiro original |
| 2 | "Faça uma análise exegética de Hebreus 5" | TEOLOGIA | Exemplo do roteiro original |
| 3 | "Explique a Aceitação dentro da Virtologia" | VIRTOLOGIA | Exemplo do roteiro original (cita o nome da área) |
| 4 | "O que a Bíblia diz sobre perdão no Salmo 51?" | TEOLOGIA | Positivo sem a palavra "teologia" |
| 5 | "Me explica o conceito de Aceitação nesse método que você usa" | VIRTOLOGIA | Positivo SEM citar "Virtologia" pelo nome — testa vocabulário, não keyword |
| 6 | "Preciso de mais aceitação da minha família ultimamente" | GERAL | Negativo adjacente — "aceitação" no sentido cotidiano, não técnico |
| 7 | "Bom dia! Como você está hoje?" | GERAL | Conversa cotidiana |
| 8 | "Isso é uma questão de teologia ou é só senso comum? Explica os dois lados" | AMBIGUO | Mistura explícita de categorias |
| 9 | "" (transcrição vazia — silêncio classificado por engano) | erro técnico (não AMBIGUO) | Robustez — ver Correção do Achado 6 |
**Limitação documentada (Achado 7):** classificação é por enunciado isolado — `classify()` não recebe `session.history`. Perguntas de acompanhamento sem contexto próprio (ex. "E o próximo?") podem classificar errado; registrado como possível trabalho futuro (Fase 3.1), não bloqueia esta fase.

## Critérios de aceite (substituem os da v1)
C1 Fase 1 e Fase 2 preservadas: `npm test` sem regressão, health/version inalterados, todos os critérios B1-B8 da Fase 2 continuam válidos.
C2 Os 9 casos da matriz acima classificados corretamente com o worker real (MLX), evidência registrada (não só mock).
C3 Latência: benchmark par-a-par real — mesmo corpus de 10 perguntas do `bench-voice.mjs` (a 1ª é aquecimento, restam 9 medidos — número já usado e validado no benchmark real da Fase 2, sem necessidade de inflar o corpus só para bater um "10" redondo), comparando baseline Fase 2 (sem classify) vs. Fase 3 (com classify) — mediana E p95 de "fim da fala → primeiro áudio" continuam dentro das metas já aceitas (≤4s/≤8s). Não aceito a hipótese de "300-500ms" sem essa medição. *(Nota pós-reaudit v2: o auditor sugeriu adicionar uma 11ª pergunta para chegar a ≥10 medidos; decisão consciente de manter 9 — sem justificativa estatística pra exigir exatamente 10 em vez do que já foi usado e validado.)*
C4 Evento `routing` chega ao cliente com `turnId` correto; UI mostra o rótulo certo pro turno certo e reseta corretamente em novo turno/erro/fim de sessão — escopado a conexão SSE contínua (reconexão não reenvia, mesma limitação já aceita da Fase 2). Verificação manual na UI real, registrada como evidência.
C5 Cancelamento comprovado com teste determinístico de barreira (não só "não trava"): `classify()` em andamento + `cancel(turnId)` → Promise rejeita no mesmo tick/imediatamente após, `pending` e timer limpos, nenhum reinício de worker decorrente. Sequência rápida de preempção (turno A classificando → turno B preempta → turno C preempta B antes de A terminar de ser limpo) testada explicitamente.
C6 Nenhuma capacidade nova prometida além de classificação + transparência — sem especialista real, ferramenta, ou memória entre sessões.

## Sequência
1 Reauditoria desta v2, focada em confirmar que os 10 achados da v1 foram resolvidos sem regressão nova (mesmo padrão da Fase 2: pedir verificação contra o código real, não confiar na tabela "achado → correção").
2 Implementação: worker.py (`classify`) → engine.ts/mlxWorkerEngine.ts/fakeEngine.ts (mecanismo de cancelamento corrigido) → sessionManager.ts (ordem corrigida) → voiceProtocol.ts (contrato sem campos prematuros) → frontend.
3 Testes automatizados (incluindo os de cancelamento com barreira) + os 9 casos de C2 com MLX real + benchmark par-a-par de C3.
4 Relatório de aceite (`docs/implementation-phase-3.md`), mesma matriz de critérios, evidências reais.
5 Aprovação de auditoria não é "pronto" — só implemento depois de aprovado, e só aceito a fase depois de C1-C6 confirmados com evidência real.
