"""Fase 12: o mestre RODRIGO_CLOUD=0 impede QUALQUER chamada ao Gemini no worker (defesa em profundidade,
mesmo que o Node peça). Rodar: python3 scripts/worker/test_cloud_master.py"""
import os
import sys
import threading
from collections import OrderedDict
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import tempfile as _tf_roots  # noqa: E402
os.environ.setdefault("RODRIGO_FILE_ROOTS", _tf_roots.gettempdir())  # T2: o Node informa as raízes permitidas; o teste usa o diretório temporário
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


# --- Fase V: imagem da tela. RODRIGO_CLOUD_VISION desligado (PADRÃO) => a imagem NUNCA vai ao Gemini, mesmo com o mestre ligado
# e com a autorização falada. Ligado => vai (controle positivo). O Node repassa o valor já resolvido; o padrão do worker é "0".
import tempfile  # noqa: E402
import types as _pytypes  # noqa: E402


class Recorder:
    """Cliente Gemini falso que registra a chamada de geração (= a imagem saindo)."""
    sent = False

    def __init__(self):
        self.models = SimpleNamespace(generate_content=self._gen)

    def _gen(self, **_kw):
        Recorder.sent = True
        return SimpleNamespace(text="descricao de teste")


def run_describe_screen(vision_env, master: str = "1", authorized: bool = True) -> tuple[list[dict], bool]:
    os.environ["RODRIGO_CLOUD"] = master
    os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
    if vision_env is None:
        os.environ.pop("RODRIGO_CLOUD_VISION", None)
    else:
        os.environ["RODRIGO_CLOUD_VISION"] = vision_env
    Recorder.sent = False
    # google.genai pode não estar instalado onde o teste roda: módulos falsos mínimos
    google_mod = _pytypes.ModuleType("google")
    genai_mod = _pytypes.ModuleType("google.genai")
    types_mod = _pytypes.ModuleType("google.genai.types")
    types_mod.Part = SimpleNamespace(from_bytes=lambda data, mime_type: ("img", len(data), mime_type))  # type: ignore[attr-defined]
    genai_mod.types = types_mod  # type: ignore[attr-defined]
    google_mod.genai = genai_mod  # type: ignore[attr-defined]
    saved = {k: sys.modules.get(k) for k in ("google", "google.genai", "google.genai.types")}
    sys.modules.update({"google": google_mod, "google.genai": genai_mod, "google.genai.types": types_mod})
    events: list[dict] = []
    worker.emit = lambda ev: events.append(ev)  # type: ignore[assignment]
    worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]
    rec = Recorder()
    stub = SimpleNamespace(
        _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
        _gemini_client_for=lambda genai, timeout_ms: rec,
        _turn_cancelled=lambda _t: False,
        _vlm_model=None,
        _mx=None,
    )
    stub._set_current = lambda h: worker.Worker._set_current(stub, h)
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg") as img:
            img.write(b"\xff\xd8\xff\xe0 jpeg de teste")
            img.flush()
            worker.Worker.handle_describe_screen(stub, {
                "reqId": "r", "turnId": "t", "epoch": 1, "imagePath": img.name,
                "question": "o que tem na tela?", "cloudAuthorized": authorized})
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    return events, Recorder.sent


ev, sent = run_describe_screen(None)  # variável AUSENTE = padrão do worker
assert sent is False, "padrão (RODRIGO_CLOUD_VISION ausente): a imagem não pode ir ao Gemini"
assert not any(e.get("event") == "screen_sent" for e in ev), ev
ev, sent = run_describe_screen("0")
assert sent is False and not any(e.get("event") == "screen_sent" for e in ev), "RODRIGO_CLOUD_VISION=0"
ev, sent = run_describe_screen("1", master="0")
assert sent is False, "mestre desligado vence o canal de visão"
ev, sent = run_describe_screen("1", authorized=False)
assert sent is False, "sem autorização falada nada vai, mesmo com o canal ligado"
# controle positivo: canal ligado + mestre + autorização => a imagem É enviada (prova que o teste enxerga o envio)
ev, sent = run_describe_screen("1")
assert sent is True, "controle positivo: com o canal ligado, a imagem deve ser enviada"
assert any(e.get("event") == "screen_sent" for e in ev), ev
os.environ.pop("RODRIGO_CLOUD_VISION", None)

print("ok: test_cloud_master")
