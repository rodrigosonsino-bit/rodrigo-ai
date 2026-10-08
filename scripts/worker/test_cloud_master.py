"""Fase 12: o mestre RODRIGO_CLOUD=0 impede QUALQUER chamada ao Gemini no worker (defesa em profundidade,
mesmo que o Node peça). Rodar: python3 scripts/worker/test_cloud_master.py"""
import os
import sys
import threading
from collections import OrderedDict
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402


class Boom:
    """Sentinela: registra qualquer acesso (= tentativa de chamar o Gemini)."""
    touched = False

    def __getattr__(self, name):
        Boom.touched = True
        raise RuntimeError("Gemini foi tocado")


def run_generate(cloud: str) -> tuple[list[dict], bool]:
    os.environ["RODRIGO_CLOUD"] = cloud
    os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
    Boom.touched = False
    events: list[dict] = []
    worker.emit = lambda ev: events.append(ev)  # type: ignore[assignment]
    worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]
    boom = Boom()
    stub = SimpleNamespace(
        _current_lock=threading.Lock(),
        _current=None,
        _gemini_client=boom,
        _gemini_client_for=lambda genai, timeout_ms: boom,  # o cliente de geração agora vem por prazo (fallback)
        _genai=SimpleNamespace(types=SimpleNamespace(GenerateContentConfig=lambda **kw: kw)),
        _cancelled_turns=OrderedDict(),
    )
    stub._set_current = lambda h: worker.Worker._set_current(stub, h)
    msg = {"reqId": "r1", "turnId": "t1", "epoch": 1,
           "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "oi"}]}
    worker.Worker.handle_generate(stub, msg)
    return events, Boom.touched


# mestre desligado: erro honesto e o cliente Gemini NUNCA é tocado
ev, touched = run_generate("0")
assert touched is False, "RODRIGO_CLOUD=0 não pode tocar o cliente Gemini"
assert any(e.get("event") == "error" for e in ev), ev

# controle positivo: com o mestre ligado o cliente É tocado (prova que o teste detecta a chamada)
ev, touched = run_generate("1")
assert touched is True, "controle positivo: com RODRIGO_CLOUD=1 o cliente deve ser acionado"


def run_intent(cloud: str) -> list[str]:
    os.environ["RODRIGO_CLOUD"] = cloud
    os.environ.pop("RODRIGO_CLOUD_INTENT", None)
    os.environ.pop("GEMINI_API_KEY", None)  # sem chave: nunca chega a rede, mas o MOTIVO do log distingue o guarda
    logs: list[str] = []
    worker.emit = lambda ev: None  # type: ignore[assignment]
    worker.log_diag = lambda m, *a, **k: logs.append(str(m))  # type: ignore[assignment]
    worker.Worker.handle_detect_intent(SimpleNamespace(), {"reqId": "r", "turnId": "t", "text": "que horas são"})
    return logs


logs = run_intent("0")
assert any("RODRIGO_CLOUD=0" in m for m in logs), logs
logs = run_intent("1")
assert not any("RODRIGO_CLOUD=0" in m for m in logs), "controle positivo: com o mestre ligado o motivo é outro"
assert any("GEMINI_API_KEY ausente" in m for m in logs), logs

print("ok: test_cloud_master")
