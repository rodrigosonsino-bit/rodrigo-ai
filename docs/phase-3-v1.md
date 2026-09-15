# Rodrigo AI Fase 3 v1 — Orquestrador (camada de decisão, sem especialistas ainda)
Data 2026-09-14. Continuação da Fase 2 aceita (`docs/implementation-phase-2.md`). Autor: Claude, nesta sessão.

## Objetivo e definição de pronto (Passo 0)
Transformar a IA de voz da Fase 2 (que só responde diretamente) num orquestrador: antes de gerar a resposta falada, o sistema classifica a intenção do usuário numa categoria (`GERAL`, `TEOLOGIA`, `VIRTOLOGIA` ou `AMBIGUO`, os mesmos rótulos do roteiro original) e expõe essa decisão de forma inspecionável (evento SSE + indicador na UI + log), sem inventar nem prometer capacidade que não existe. Como a Fase 4 (especialistas de verdade) ainda não foi construída, **toda categoria continua sendo respondida pelo mesmo LLM geral da Fase 2** — a Fase 3 entrega o mecanismo de decisão e sua explicabilidade, não novas respostas especializadas. "Pronto" = o classificador acerta os exemplos do roteiro original (`"Quanto é 17% de 850?"` → GERAL, `"Faça uma análise exegética de Hebreus 5"` → TEOLOGIA, `"Explique a Aceitação dentro da Virtologia"` → VIRTOLOGIA) mais casos ambíguos/adjacentes, sem quebrar nenhum critério B1-B8 já aceito da Fase 2, e sem adicionar latência que estoure a meta de B6 da Fase 2 (mediana ≤4s se mantém válida). Não implemento roteamento real para especialistas, ferramentas, ações que exigem confirmação real, nem memória persistente — isso é Fase 4, 5, 7/8 e 6 respectivamente. Não paro em "classificador funciona mas não está visível/auditável" — a explicabilidade faz parte do critério de pronto, não é opcional.

## Fatos e decisão já tomada (não é pergunta em aberto — audite esta decisão)
Reaproveita o LLM já carregado no worker (`Qwen3-4B-Instruct-2507-4bit`) para a classificação — não carrega um segundo modelo. Decisão: **novo comando de protocolo dedicado (`classify`) no worker Python**, separado de `generate` (Correção: usar o `generate` existente e filtrar a "frase" de classificação antes do TTS foi considerado e descartado — depende de heurística de segmentação de frase pra algo que não é fala, gera um evento `sentence_audio_ready` espúrio que precisaria ser suprimido manualmente, e mistura duas responsabilidades no mesmo pipeline). O comando `classify` roda no mesmo work_loop (fila de tamanho 1, mesma exclusão mútua de `generate`), usa o mesmo mecanismo de cancelamento cooperativo (`cancel_event` por turnId) e o mesmo `mx.set_cache_limit`/`mx.clear_cache` já em uso — não é um motor novo, é um modo de chamada mais curto e não-streaming do mesmo `stream_generate`.

## Arquitetura

### Protocolo do worker (scripts/worker/worker.py) — novo comando
Nó → Worker (stdin): `{"cmd":"classify","reqId":"...","turnId":"...","epoch":N,"text":"<transcrição do usuário>"}`.
Worker → Nó (stdout): `{"event":"classification","reqId":...,"turnId":...,"label":"GERAL"|"TEOLOGIA"|"VIRTOLOGIA"|"AMBIGUO"}` ou `{"event":"error","reqId":...,"turnId":...,"message":"..."}`.

Pseudocódigo completo do handler (adicionado ao `Worker` em `worker.py`, ao lado de `handle_transcribe`/`handle_generate`):
```python
CLASSIFICATION_LABELS = {"GERAL", "TEOLOGIA", "VIRTOLOGIA", "AMBIGUO"}
CLASSIFICATION_SYSTEM_PROMPT = (
    "Você classifica uma frase do usuário em EXATAMENTE uma categoria. "
    "Responda com UMA ÚNICA PALAVRA, sem pontuação, sem explicação: "
    "GERAL, TEOLOGIA, VIRTOLOGIA ou AMBIGUO.\n"
    "TEOLOGIA: perguntas sobre a Bíblia, exegese, doutrina cristã, sermões, teologia cristã.\n"
    "VIRTOLOGIA: perguntas sobre os conceitos e terminologia específicos da Virtologia "
    "(ex.: Aceitação, dentro do vocabulário próprio dessa área).\n"
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

        sampler = make_sampler(temp=0.0)  # determinístico — é uma classificação, não geração criativa
        raw = ""
        for response in stream_generate(
            self._llm, self._llm_tokenizer, prompt, max_tokens=8, sampler=sampler
        ):
            if handle.cancel_event.is_set():
                log_diag(f"Classificação cancelada (turnId={turn_id}).")
                return
            raw += response.text

        label = raw.strip().upper().strip(".!?")
        # Normalização defensiva: o LLM pode devolver variações (ex. "Geral.", "teologia")
        matched = next((l for l in CLASSIFICATION_LABELS if l in label), "AMBIGUO")

        emit({"event": "classification", "reqId": req_id, "turnId": turn_id, "label": matched})
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
No `stdin_reader_loop`, o `cmd == "classify"` entra na mesma fila (`work_queue`) que `transcribe`/`generate` (fila de tamanho 1, mesmo descarte de comando antigo se um novo chegar).
No `work_loop`, adicionar `elif cmd == "classify": self.handle_classify(msg)`.

### Node — `VoiceEngine` (src/backend/voice/engine.ts, mlxWorkerEngine.ts, fakeEngine.ts)
Novo método na interface:
```typescript
export type OrchestratorLabel = 'GERAL' | 'TEOLOGIA' | 'VIRTOLOGIA' | 'AMBIGUO';

export interface VoiceEngine {
  // ...métodos existentes inalterados...
  classify(turnId: string, epoch: number, text: string): Promise<OrchestratorLabel>;
}
```
`MlxWorkerEngine.classify()`: mesmo padrão de `transcribe()`/`generate()` — gera `reqId`, registra em `pending` (novo `PendingClassify` na união `Pending`), escreve `{cmd:"classify",...}`, resolve no evento `classification`, timeout de 10s (bem menor que os 60s de `generate()` — é uma chamada curta de 8 tokens; se estourar 10s é falha catastrófica igual às outras, worker reinicia).
`FakeVoiceEngine.classify()`: retorna um rótulo configurável via `this.classificationToReturn` (default `'GERAL'`), determinístico, sem depender de MLX — mantém B2 (testes nunca dependem de Python).

### Node — `SessionManager.runTurn()` (src/backend/voice/sessionManager.ts)
Depois do `transcript` e antes de montar `messagesForEngine` pro `generate()`:
```typescript
const label = await this.engine.classify(turn.turnId, turn.epoch, transcript);
if (session.activeTurn !== turn) return; // superado durante a classificação

const specialistAvailable = false; // Fase 4 ainda não implementada — nenhum rótulo tem handler real
this.emit(session, {
  type: 'routing',
  turnId: turn.turnId,
  label,
  handled: label === 'GERAL' || !specialistAvailable
});
```
Nenhuma ramificação de comportamento por enquanto — a geração da resposta continua sempre pelo caminho `GERAL` já existente da Fase 2, independente do rótulo. O evento `routing` é só informativo/auditável (satisfaz "explicar internamente para onde deveria ser encaminhada" sem fingir que o roteamento real acontece).

Campos de contrato reservados pra Fase 4+ (regras de "operações que exigem confirmação" e "pedidos que exigem vários agentes" do roteiro original) — declarados agora, inertes até terem consumidor real:
```typescript
export interface RoutingEvent {
  type: 'routing';
  turnId: string;
  label: OrchestratorLabel;
  handled: boolean;
  /** Reservado para Fase 5+ (ferramentas/ações) — sempre false nesta fase, nada é executável ainda. */
  requiresConfirmation?: boolean;
  /** Reservado para quando mais de um especialista real existir (Fase 4+) — sempre vazio nesta fase. */
  secondaryLabels?: OrchestratorLabel[];
}
```
Documentar em comentário no código que esses dois campos são scaffolding, não funcionalidade — evita a leitura errada de que "confirmação de operação" já existe.

### Frontend (src/frontend/voice.ts, main.ts, index.html)
Novo handler em `VoiceController.handleServerEvent` pro tipo `'routing'`: chama um novo callback `onRouting(label, handled)` passado no construtor. Em `main.ts`, um novo elemento `#voice-agent-indicator` (texto tipo "Agente: Geral") atualizado a cada evento `routing` — mostra o rótulo classificado mesmo sabendo que só GERAL tem handler real (texto honesto: se `handled === false`, mostrar "Classificado como: Teologia (especialista ainda não implementado — Fase 4)" em vez de fingir que foi atendido por um especialista).

## Critérios de aceite
C1 Fase 1 e Fase 2 preservadas: `npm test` continua 29/29 (ou mais, com os novos testes), health/version inalterados, nenhuma regressão nos critérios B1-B8 já aceitos.
C2 Classificação correta nos 3 exemplos do roteiro original + pelo menos 2 casos GERAL adicionais (matemática, conversa cotidiana) + pelo menos 1 caso AMBIGUO construído de propósito (frase que mistura teologia e conversa cotidiana) — testado com o worker real (MLX), não só mock, e registrado como evidência no relatório de aceite (mesmo padrão do smoke test real da Fase 2).
C3 Latência: a chamada de classificação (max_tokens=8, determinística) soma no máximo ~300-500ms ao início do turno — medir de verdade com timestamp antes/depois da chamada `classify()` e confirmar que a mediana de "fim da fala → primeiro áudio" da Fase 2 (B6, ≤4s) continua sendo respeitada com a classificação no caminho crítico.
C4 Evento `routing` chega ao cliente via SSE pra todo turno, com o rótulo correto e `handled` correto; UI mostra o rótulo classificado sem alegar que um especialista real respondeu quando não respondeu.
C5 Cancelamento: barge-in durante a classificação (antes do rótulo chegar) cancela cooperativamente igual à geração — testado com mock determinístico (`sentenceDelayMs`-like atraso configurável na `FakeVoiceEngine.classify`), sem depender de MLX.
C6 Nenhum comportamento novo é prometido ao usuário que não existe: não há resposta especializada real, não há execução de ferramenta, não há memória entre sessões — só classificação + transparência.

## Sequência
1 Auditoria adversarial desta v1 (Codex CLI e/ou Antigravity CLI, modo read-only/plan) antes de qualquer código.
2 Implementação: worker.py (`classify`) → engine.ts/mlxWorkerEngine.ts/fakeEngine.ts → sessionManager.ts → voiceProtocol.ts → frontend.
3 Testes automatizados (mock) + smoke test real com MLX (os 6 casos de C2) + medição de latência real (C3).
4 Relatório de aceite (`docs/implementation-phase-3.md`) com a mesma matriz de critérios, evidências reais, e o que ficou pendente (se algo precisar de validação humana, como aconteceu em B3/B5 da Fase 2).
5 Só considero a Fase 3 pronta com C1-C6 confirmados — aprovação de auditoria não é "pronto", é liberação pra implementar (mesma disciplina da Fase 2).
