"""T1 (achado C1 da auditoria do agy): o worker aplica o guarda de saída à PERGUNTA que acompanha a imagem da tela antes de
chamar o Gemini. Limite declarado: a IMAGEM em si não é varrida (nenhum guarda de texto cobre pixels; por isso a visão é
opt-in e desligada por padrão). Controle positivo com o guarda em off; mutação: remover `guard_text(question)` reprova.
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_worker_vision_guard.py"""
import json
import os
import sys
import tempfile
import threading
import types as _pytypes
from collections import OrderedDict
from types import SimpleNamespace

os.environ.setdefault("RODRIGO_FILE_ROOTS", tempfile.gettempdir())  # T2: raízes permitidas para a leitura da imagem
sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402

CPF = "529.982.247-25"
SENT: list = []


class Rec:
    def __init__(self):
        self.models = SimpleNamespace(generate_content=self._gen)

    def _gen(self, **kw):
        SENT.append(kw)
        return SimpleNamespace(text="descricao de teste")


def run(mode):
    os.environ.update(RODRIGO_CLOUD="1", RODRIGO_CLOUD_VISION="1", GEMINI_API_KEY="chave-sintetica-de-teste")
    if mode is None:
        os.environ.pop("RODRIGO_OUTBOUND_GUARD", None)
    else:
        os.environ["RODRIGO_OUTBOUND_GUARD"] = mode
    SENT.clear()
    google_mod, genai_mod, types_mod = _pytypes.ModuleType("google"), _pytypes.ModuleType("google.genai"), _pytypes.ModuleType("google.genai.types")
    types_mod.Part = SimpleNamespace(from_bytes=lambda data, mime_type: ("img", len(data), mime_type))
    types_mod.GenerateContentConfig = lambda **kw: kw
    genai_mod.types = types_mod
    google_mod.genai = genai_mod
    saved = {k: sys.modules.get(k) for k in ("google", "google.genai", "google.genai.types")}
    sys.modules.update({"google": google_mod, "google.genai": genai_mod, "google.genai.types": types_mod})
    events: list = []
    worker.emit = lambda ev: events.append(ev)
    worker.log_diag = lambda *_a, **_k: None
    stub = SimpleNamespace(
        _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
        _gemini_client_for=lambda genai, timeout_ms: Rec(), _turn_cancelled=lambda _t: False, _vlm_model=None, _mx=None,
    )
    stub._set_current = lambda h: worker.Worker._set_current(stub, h)
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg") as img:
            img.write(b"\xff\xd8\xff\xe0 jpeg de teste"); img.flush()
            worker.Worker.handle_describe_screen(stub, {
                "reqId": "r", "turnId": "t", "epoch": 1, "imagePath": img.name,
                "question": f"o que tem na tela? meu cpf é {CPF}", "cloudAuthorized": True})
    finally:
        for k, v in saved.items():
            if v is None: sys.modules.pop(k, None)
            else: sys.modules[k] = v
    return events


def blob():
    return json.dumps(SENT, default=lambda o: getattr(o, "__dict__", str(o)), ensure_ascii=False)


run("off")
assert SENT and CPF in blob(), "controle positivo: com o guarda em off, a pergunta com CPF SAI junto com a imagem"
run(None)  # padrão: redact
assert SENT, "precondição: houve chamada ao Gemini"
assert CPF not in blob() and "[cpf omitido]" in blob(), "redact: o CPF da pergunta não pode sair"
run("block")
assert SENT == [], "block: nada vai ao Gemini (a descrição cai no caminho local)"
print("ok: test_worker_vision_guard")
