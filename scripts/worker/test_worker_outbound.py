"""T1 (camada em profundidade): o worker aplica o guarda de saída ANTES de qualquer chamada ao Gemini (geração, intenção, voz e
pergunta da visão), caso o Node falhe ou seja contornado. Cliente falso registra o que "sairia". Controle positivo com o guarda em off.
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_worker_outbound.py"""
import json
import os
import sys
import threading
from collections import OrderedDict
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402

CPF = "529.982.247-25"
KEY = "AIzaSyD" + "x" * 32
worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]


class AnyTypes:
    """Módulo `types` falso permissivo: qualquer construtor (GenerateContentConfig, ThinkingConfig...) devolve um dict."""

    def __getattr__(self, name):
        return lambda **kw: kw


class Recorder:
    """Cliente Gemini falso: guarda o que seria enviado."""

    def __init__(self) -> None:
        self.sent: list = []
        outer = self

        class Models:
            def generate_content_stream(self, model=None, contents=None, config=None):
                outer.sent.append([contents, config])  # o prompt de sistema vai em config.system_instruction
                return iter([])

            def generate_content(self, model=None, contents=None, config=None):
                outer.sent.append([contents, config])
                raise RuntimeError("curto-circuito: resposta não interessa ao teste")

        self.models = Models()


def base_env(mode: str | None) -> None:
    os.environ["RODRIGO_CLOUD"] = "1"
    os.environ["RODRIGO_CLOUD_INTENT"] = "1"
    os.environ["RODRIGO_CLOUD_TTS"] = "1"
    os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
    if mode is None:
        os.environ.pop("RODRIGO_OUTBOUND_GUARD", None)
    else:
        os.environ["RODRIGO_OUTBOUND_GUARD"] = mode


def blob(obj) -> str:
    return json.dumps(obj, default=lambda o: getattr(o, "__dict__", str(o)), ensure_ascii=False)


# ---------- geração ----------
def run_generate(mode: str | None) -> tuple[Recorder, list[dict]]:
    base_env(mode)
    rec, events = Recorder(), []
    worker.emit = lambda ev: events.append(ev)  # type: ignore[assignment]
    stub = SimpleNamespace(
        _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(), _gemini_client=rec,
        _gemini_client_for=lambda genai, t: rec,
        _genai=SimpleNamespace(types=AnyTypes()),
    )
    stub._set_current = lambda h: worker.Worker._set_current(stub, h)
    msgs = [{"role": "system", "content": f"memória: a chave é {KEY}"}, {"role": "user", "content": f"meu cpf é {CPF}"}]
    worker.Worker.handle_generate(stub, {"reqId": "r", "turnId": "t", "epoch": 1, "messages": msgs})
    return rec, events


rec, ev = run_generate(None)  # padrão: redact
assert rec.sent, "precondição: houve chamada ao Gemini"
assert CPF not in blob(rec.sent) and KEY not in blob(rec.sent), "redact: nada sensível pode sair"
assert "[cpf omitido]" in blob(rec.sent)

rec, ev = run_generate("off")  # controle positivo
assert CPF in blob(rec.sent) and KEY in blob(rec.sent), "controle positivo: com off o segredo SAI"

rec, ev = run_generate("block")
assert rec.sent == [], "block: nenhuma chamada ao Gemini"
assert any(e.get("event") == "error" for e in ev), ev
assert CPF not in blob(ev) and KEY not in blob(ev), "o erro não ecoa o conteúdo"


# ---------- intenção ----------
def run_intent(mode: str | None) -> tuple[Recorder, list[dict]]:
    base_env(mode)
    rec, events = Recorder(), []
    worker.emit = lambda ev: events.append(ev)  # type: ignore[assignment]
    stub = SimpleNamespace(
        _cancelled_turns=OrderedDict(), _intent_client=rec,
        _intent_genai=SimpleNamespace(types=AnyTypes()),
    )
    stub._turn_cancelled = lambda tid: False
    worker.Worker.handle_detect_intent(stub, {"reqId": "r", "turnId": "t", "text": f"que horas são? meu cpf é {CPF}"})
    return rec, events


rec, ev = run_intent(None)
assert rec.sent and CPF not in blob(rec.sent), "intenção em redact: o CPF não pode sair"
rec, ev = run_intent("off")
assert CPF in blob(rec.sent), "controle positivo da intenção"
rec, ev = run_intent("block")
assert rec.sent == [] and any(e.get("event") == "intent_detection" and e.get("available") is False for e in ev), ev


# ---------- voz (TTS) ----------
def run_tts(mode: str | None) -> tuple[list[str], dict]:
    base_env(mode)
    seen: list[str] = []
    stub = SimpleNamespace()
    stub._tts_call = lambda model, voice, text, entry: (seen.append(text) or (b"", 24000, (0, 0)))
    out = worker.Worker._synthesize(stub, {"text": f"Anotei: o cpf é {CPF}, certo?", "outPath": "/tmp/x.wav"}, {"cancel": threading.Event()})
    return seen, out


seen, out = run_tts(None)
assert seen and CPF not in seen[0] and "[cpf omitido]" in seen[0], seen
seen, out = run_tts("off")
assert seen and CPF in seen[0], "controle positivo do TTS"
seen, out = run_tts("block")
assert seen == [] and out == {"ok": False, "kind": "disabled"}, (seen, out)

print("ok: test_worker_outbound")
