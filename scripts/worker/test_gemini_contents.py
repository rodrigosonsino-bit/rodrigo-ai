#!/usr/bin/env python3
"""
Testes standalone para a Fase 10a (integração com Gemini):
- to_gemini_contents() (§4.2, H1):
  * Coalescing de papéis consecutivos (ex.: 3 assistant seguidos de markPlayed())
  * Separação de system prompt de qualquer posição
  * Descarte de prefixo não-user
  * Guard explícito de ValueError quando contents ficaria vazio
- Worker boot sem GEMINI_API_KEY (§4.3, H9):
  * Worker instancia normalmente sem crash (lazy init, nunca eager)
  * handle_generate() emite "error" honesto sem derrubar o processo
- handle_generate() com streaming simulado (§4.3, H2, H3, H4):
  * Múltiplas frases emitidas incrementalmente (H2)
  * Loop de repetição detectado emite "done" incondicionalmente (H3)
  * Cancelamento para de consumir stream sem erro nem eventos espúrios (H4)

Rodar com: .runtime/.venv/bin/python3 scripts/worker/test_gemini_contents.py
"""
import os
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent))

import worker  # noqa: E402
from worker import Worker, to_gemini_contents  # noqa: E402

FAILURES = 0


def check(description: str, condition: bool, extra: str = "") -> None:
    global FAILURES
    status = "OK" if condition else "FALHOU"
    if not condition:
        FAILURES += 1
    msg = f"[{status}] {description}"
    if extra:
        msg += f" -> {extra}"
    print(msg)


class ChunkMock:
    def __init__(self, text: str) -> None:
        self.text = text


def main() -> None:
    print("=== Testes de to_gemini_contents() (H1) ===")

    # 1. Histórico real com 3 mensagens assistant consecutivas (markPlayed() real)
    msgs_mark_played = [
        {"role": "system", "content": "Você é o Rodrigo AI."},
        {"role": "user", "content": "Explique a virtude da aceitação."},
        {"role": "assistant", "content": "Na Virtologia, a aceitação é a prática de acolher ativamente o passado."},
        {"role": "assistant", "content": "Isso é diferente do mero conformismo passivo."},
        {"role": "assistant", "content": "Ela liberta a energia psicológica para a ação no presente."},
        {"role": "user", "content": "Como posso aplicar isso hoje?"},
    ]
    sys_inst, contents = to_gemini_contents(msgs_mark_played)
    check("system prompt extraído corretamente", sys_inst == "Você é o Rodrigo AI.", f"sys_inst={sys_inst!r}")
    check("número de contents após coalescing é 3 (user, model, user)", len(contents) == 3, f"len={len(contents)}")
    check("primeiro content é user", contents[0]["role"] == "user")
    check("segundo content é model fundido com 3 partes",
          contents[1]["role"] == "model" and len(contents[1]["parts"]) == 3,
          f"parts={len(contents[1]['parts'])}")
    check("terceiro content é user", contents[2]["role"] == "user")

    # 2. Coalescing de múltiplos user seguidos
    msgs_users = [
        {"role": "user", "content": "Primeira frase do usuário."},
        {"role": "user", "content": "Segunda frase do usuário sem resposta no meio."},
        {"role": "assistant", "content": "Resposta única."},
    ]
    _, contents_u = to_gemini_contents(msgs_users)
    check("consecutive user fundidos em 1 content com 2 partes",
          len(contents_u) == 2 and contents_u[0]["role"] == "user" and len(contents_u[0]["parts"]) == 2,
          f"len={len(contents_u)}, parts={len(contents_u[0]['parts'])}")

    # 3. System prompt em qualquer posição e múltiplos prompts unidos com \n\n
    msgs_sys_middle = [
        {"role": "user", "content": "Pergunta inicial."},
        {"role": "system", "content": "Regra A."},
        {"role": "assistant", "content": "Resposta inicial."},
        {"role": "system", "content": "Regra B."},
    ]
    sys_inst2, contents_sm = to_gemini_contents(msgs_sys_middle)
    check("system prompts múltiplos em posições arbitrárias unidos por \\n\\n",
          sys_inst2 == "Regra A.\n\nRegra B.",
          f"sys_inst2={sys_inst2!r}")
    check("nenhuma mensagem system sobrou em contents",
          all(c["role"] in ("user", "model") for c in contents_sm))

    # 4. Descarte de prefixo não-user (histórico que inicia com assistant/model)
    msgs_lead_model = [
        {"role": "assistant", "content": "Mensagem órfã inicial do modelo."},
        {"role": "user", "content": "Pergunta real do usuário."},
        {"role": "assistant", "content": "Resposta."},
    ]
    _, contents_lm = to_gemini_contents(msgs_lead_model)
    check("prefixo model descartado, primeiro content é user",
          contents_lm[0]["role"] == "user" and contents_lm[0]["parts"][0]["text"] == "Pergunta real do usuário.",
          f"first_role={contents_lm[0]['role']!r}")

    # 5. Guard explícito de ValueError se não houver nenhuma mensagem user (achado MÉDIA da rodada 2)
    raised_empty_user = False
    try:
        to_gemini_contents([
            {"role": "system", "content": "Apenas sistema."},
            {"role": "assistant", "content": "Apenas assistente."},
        ])
    except ValueError as e:
        raised_empty_user = True
        check("ValueError explícito lançado quando histórico não contém mensagem user",
              "histórico não contém nenhuma mensagem 'user'" in str(e),
              f"msg={e}")
    check("ValueError foi de fato levantado para histórico sem user", raised_empty_user)

    # 6. Histórico completamente vazio levanta ValueError
    raised_empty_all = False
    try:
        to_gemini_contents([])
    except ValueError:
        raised_empty_all = True
    check("ValueError levantado para histórico vazio []", raised_empty_all)

    print()
    print("=== Testes de Boot e Resiliência sem GEMINI_API_KEY (H9) ===")

    # Salva e remove chave de API do ambiente
    old_key = os.environ.get("GEMINI_API_KEY")
    if "GEMINI_API_KEY" in os.environ:
        del os.environ["GEMINI_API_KEY"]

    try:
        # H9: Worker DEVE instanciar sem crash e sem tentar conectar ao Gemini
        w = Worker()
        check("Worker instancia com sucesso sem GEMINI_API_KEY", True)
        check("self._gemini_client é None no __init__ (lazy)", w._gemini_client is None)
        check("self._current é None no __init__", w._current is None)

        # handle_cancel() não falha
        w.handle_cancel({"turnId": "turn-test"})
        check("handle_cancel() funciona normalmente sem GEMINI_API_KEY", True)

        # handle_generate() deve falhar honestamente com evento 'error', sem derrubar processo
        emitted_events: list[dict[str, Any]] = []
        original_emit = worker.emit
        worker.emit = lambda ev: emitted_events.append(ev)

        try:
            w.handle_generate({
                "reqId": "req-1",
                "turnId": "turn-1",
                "epoch": 1,
                "messages": msgs_mark_played,
            })
            check("handle_generate() emite exatamente 1 evento sem a chave", len(emitted_events) == 1, f"len={len(emitted_events)}")
            check("evento emitido é de erro", emitted_events[0].get("event") == "error")
            check("mensagem de erro honesta sobre geração Gemini",
                  emitted_events[0].get("message") == "Falha ao gerar resposta via Gemini.")
            check("_current é limpo no finally após erro", w._current is None)
        finally:
            worker.emit = original_emit

    finally:
        if old_key is not None:
            os.environ["GEMINI_API_KEY"] = old_key

    print()
    print("=== Testes de Streaming, Loop de Repetição e Cancelamento (H2, H3, H4) ===")

    # Teste H2: streaming de múltiplas frases
    w2 = Worker()
    mock_client = MagicMock()
    w2._gemini_client = mock_client
    w2._genai = MagicMock()
    os.environ["GEMINI_API_KEY"] = "fake-key-for-test"

    chunks_h2 = [
        ChunkMock("Primeira frase longa da resposta aqui. "),
        ChunkMock("Segunda frase complementando o pensamento. "),
        ChunkMock("Terceira e última frase de conclusão."),
    ]
    mock_client.models.generate_content_stream.return_value = iter(chunks_h2)

    events_h2: list[dict[str, Any]] = []
    original_emit = worker.emit
    worker.emit = lambda ev: events_h2.append(ev)
    try:
        w2.handle_generate({
            "reqId": "req-h2",
            "turnId": "turn-h2",
            "epoch": 1,
            "messages": msgs_mark_played,
        })
        sentence_events = [e for e in events_h2 if e.get("event") == "sentence"]
        done_events = [e for e in events_h2 if e.get("event") == "done"]
        check("múltiplas frases emitidas no streaming (H2)", len(sentence_events) == 3, f"count={len(sentence_events)}")
        check("índices sequenciais 0, 1, 2", [e["index"] for e in sentence_events] == [0, 1, 2])
        check("evento done emitido ao final", len(done_events) == 1)
        check("_current é liberado no final da geração bem sucedida", w2._current is None)
    finally:
        worker.emit = original_emit

    # Teste H3: loop de repetição detectado emite done incondicionalmente (achado 2, CRÍTICA da rodada 1)
    w3 = Worker()
    mock_client3 = MagicMock()
    w3._gemini_client = mock_client3
    w3._genai = MagicMock()

    repetitive_chunks = [
        ChunkMock("Esta é uma frase de conteúdo suficiente para teste de loop. "),
        ChunkMock("Esta é uma frase de conteúdo suficiente para teste de loop. "),
        ChunkMock("Esta é uma frase de conteúdo suficiente para teste de loop. "),
    ]
    mock_client3.models.generate_content_stream.return_value = iter(repetitive_chunks)

    events_h3: list[dict[str, Any]] = []
    worker.emit = lambda ev: events_h3.append(ev)
    try:
        w3.handle_generate({
            "reqId": "req-h3",
            "turnId": "turn-h3",
            "epoch": 1,
            "messages": msgs_mark_played,
        })
        done_events_h3 = [e for e in events_h3 if e.get("event") == "done"]
        check("done emitido incondicionalmente mesmo quando loop_detected=True (H3)",
              len(done_events_h3) == 1,
              f"done_count={len(done_events_h3)}")
        sentences_h3 = [e for e in events_h3 if e.get("event") == "sentence"]
        check("apenas 1 frase emitida antes do corte por repetição", len(sentences_h3) == 1, f"sentences={len(sentences_h3)}")
    finally:
        worker.emit = original_emit

    # Teste H4: cancelamento no meio do stream para de consumir iterador
    w4 = Worker()
    mock_client4 = MagicMock()
    w4._gemini_client = mock_client4
    w4._genai = MagicMock()

    consumed_count = 0

    def canceling_stream():
        nonlocal consumed_count
        yield ChunkMock("Primeira frase falada pelo assistente. ")
        consumed_count += 1
        # Simula cancelamento pelo cliente (ex. barge-in)
        with w4._current_lock:
            if w4._current:
                w4._current.cancel_event.set()
        yield ChunkMock("Segunda frase que não deve ser emitida.")
        consumed_count += 1
        yield ChunkMock("Terceira frase ignorada.")
        consumed_count += 1

    mock_client4.models.generate_content_stream.return_value = canceling_stream()

    events_h4: list[dict[str, Any]] = []
    worker.emit = lambda ev: events_h4.append(ev)
    try:
        w4.handle_generate({
            "reqId": "req-h4",
            "turnId": "turn-h4",
            "epoch": 1,
            "messages": msgs_mark_played,
        })
        check("consumo do stream parou após cancel_event ser setado (H4)",
              consumed_count < 3,  # interrompeu antes de consumir o terceiro chunk
              f"consumed_count={consumed_count}")
        sentences_h4 = [e for e in events_h4 if e.get("event") == "sentence"]
        done_events_h4 = [e for e in events_h4 if e.get("event") == "done"]
        check("somente primeira frase emitida antes do cancelamento", len(sentences_h4) == 1)
        check("evento done NÃO é emitido quando cancelado", len(done_events_h4) == 0)
        check("nenhum evento de erro foi emitido durante cancelamento",
              not any(e.get("event") == "error" for e in events_h4))
        check("_current é liberado no finally do turno cancelado", w4._current is None)
    finally:
        worker.emit = original_emit
        if old_key is not None:
            os.environ["GEMINI_API_KEY"] = old_key
        elif "GEMINI_API_KEY" in os.environ:
            del os.environ["GEMINI_API_KEY"]

    print()
    if FAILURES:
        print(f"ATENÇÃO: {FAILURES} teste(s) falharam!")
        sys.exit(1)
    print("Todos os testes da Fase 10a (Gemini) passaram com sucesso!")


if __name__ == "__main__":
    main()
