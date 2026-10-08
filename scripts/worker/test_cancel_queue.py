"""Fase V, fatia 1 (docs/phase-vision-v3.md §5.1, HV.5): o cancelamento de um turno alcança comandos AINDA NA FILA do worker e o
intervalo entre sair da fila e virar `_current`. Sem isso, a geração (ou a intenção em nuvem) de um turno já cancelado ainda
chamava o Gemini. Rodar: .runtime/.venv/bin/python3 scripts/worker/test_cancel_queue.py"""
import os
import sys
import threading
import time
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402

worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]
EVENTS = []
worker.emit = lambda ev: EVENTS.append(ev)  # type: ignore[assignment]
os.environ["GEMINI_API_KEY"] = "chave-sintetica"
os.environ.pop("RODRIGO_CLOUD", None)
os.environ.pop("RODRIGO_CLOUD_INTENT", None)
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print(f"[FALHOU] {name} {extra}")


class Client:
    def __init__(self):
        self.calls = 0
        self.models = SimpleNamespace(generate_content_stream=self._stream, generate_content=self._content)

    def _stream(self, model, contents, config):
        self.calls += 1
        return iter([SimpleNamespace(text="Uma frase. ")])

    def _content(self, **kw):
        self.calls += 1
        return SimpleNamespace(text='{"intent": "NENHUMA", "content": null}')


FAKE_TYPES = SimpleNamespace(GenerateContentConfig=lambda **kw: kw, ThinkingConfig=lambda **kw: kw)


def make():
    w = worker.Worker()
    c = Client()
    w._gemini_client = c
    w._genai = SimpleNamespace(types=FAKE_TYPES)
    w._gemini_client_for = lambda genai, t: c
    w._intent_client = c
    w._intent_genai = SimpleNamespace(types=FAKE_TYPES)
    return w, c


def gen_msg(turn):
    return {"cmd": "generate", "reqId": f"g-{turn}", "turnId": turn, "epoch": 1,
            "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "oi"}]}


# 1) controle positivo: turno NÃO cancelado gera normalmente (o fake é chamado)
w, c = make()
EVENTS.clear()
w.handle_generate(gen_msg("vivo"))
check("controle: turno vivo chama o Gemini e conclui", c.calls == 1 and EVENTS[-1]["event"] == "done", str(EVENTS))

# 2) corrida: o cancel chega DEPOIS de o comando sair da fila e ANTES de virar _current
w, c = make()
EVENTS.clear()
w.handle_cancel({"cmd": "cancel", "turnId": "T1"})
EVENTS.clear()
w.handle_generate(gen_msg("T1"))
check("cancel antes de virar _current: zero chamada ao Gemini", c.calls == 0, f"calls={c.calls}")
check("cancel antes de virar _current: sem 'done' nem frase", not any(e["event"] in ("done", "sentence") for e in EVENTS), str(EVENTS))

# 3) comando AINDA NA FILA quando o turno é cancelado: o work_loop descarta sem executar
w, c = make()
invoked = []
real_handle_generate = w.handle_generate
w.handle_generate = lambda m: (invoked.append(m["turnId"]), real_handle_generate(m))  # registra se o handler chegou a rodar
w.handle_cancel({"cmd": "cancel", "turnId": "T2"})
EVENTS.clear()
w.work_queue.put_nowait(gen_msg("T2"))
th = threading.Thread(target=w.work_loop, daemon=True)
th.start()
deadline = time.monotonic() + 2
while time.monotonic() < deadline and not w.work_queue.empty():
    time.sleep(0.02)
time.sleep(0.2)
check("comando enfileirado de turno cancelado: descartado, zero chamada", c.calls == 0 and w.work_queue.empty(), f"calls={c.calls}")
check("comando enfileirado de turno cancelado: o handler NEM roda (descarte no work_loop, não só a barreira seguinte)", "T2" not in invoked, str(invoked))
# o mesmo loop continua servindo turnos vivos
w.work_queue.put_nowait(gen_msg("T3"))
deadline = time.monotonic() + 2
while time.monotonic() < deadline and c.calls == 0:
    time.sleep(0.02)
check("o work_loop segue vivo e atende o próximo turno", c.calls == 1)

# 4) intenção em nuvem de turno cancelado: nada sai
w, c = make()
w.handle_cancel({"cmd": "cancel", "turnId": "T4"})
EVENTS.clear()
w.handle_detect_intent({"cmd": "detect_intent", "reqId": "i", "turnId": "T4", "text": "me lembra amanhã"})
check("detect_intent de turno cancelado: zero chamada", c.calls == 0, f"calls={c.calls}")

# 5) memória limitada: só os 64 turnos cancelados mais recentes
w, _ = make()
for i in range(100):
    w.handle_cancel({"cmd": "cancel", "turnId": f"x{i}"})
check("conjunto de cancelados limitado a 64", len(w._cancelled_turns) == 64 and "x99" in w._cancelled_turns and "x0" not in w._cancelled_turns)

print(f"{ok} ok, {fail} falhas")
sys.exit(1 if fail else 0)
