"""Decisão 10: a visão em nuvem só envia a imagem da tela ao Gemini com RODRIGO_CLOUD_VISION=1 (opt-in) E com autorização falada
(cloudAuthorized). Desligada, o cliente Gemini NUNCA é tocado, nenhum byte de imagem sai e o evento screen_sent não é emitido.
O caminho local (modelo de visão) é substituído por um stub que falha de propósito: o teste nunca carrega nem baixa modelo.
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_cloud_vision.py"""
import os
import sys
import tempfile
import threading
from collections import OrderedDict
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402


class Boom:
    """Sentinela: qualquer acesso = tentativa de chamar o Gemini com a imagem."""
    touched = False

    def __getattr__(self, name):
        Boom.touched = True
        raise RuntimeError("Gemini foi tocado")


def stub_local_vision() -> None:
    def fail_load(*_a, **_k):
        raise RuntimeError("stub: modelo de visão local não é carregado em teste")
    sys.modules["mlx_vlm"] = SimpleNamespace(load=fail_load)  # type: ignore[assignment]


def run_screen(vision: str | None, master: str, authorized: bool) -> tuple[list[dict], bool]:
    os.environ["RODRIGO_CLOUD"] = master
    if vision is None:
        os.environ.pop("RODRIGO_CLOUD_VISION", None)
    else:
        os.environ["RODRIGO_CLOUD_VISION"] = vision
    os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
    Boom.touched = False
    events: list[dict] = []
    worker.emit = lambda ev: events.append(ev)  # type: ignore[assignment]
    worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]
    boom = Boom()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(b"\xff\xd8\xff\xe0" + b"IMAGEM-SINTETICA-DE-TESTE" + b"\xff\xd9")
        image_path = f.name
    try:
        stub = SimpleNamespace(
            _current_lock=threading.Lock(),
            _current=None,
            _cancelled_turns=OrderedDict(),
            _gemini_client_for=lambda genai, timeout_ms: boom,
            _vlm_model=None,
            _mx=None,
        )
        stub._set_current = lambda h: worker.Worker._set_current(stub, h)
        stub._turn_cancelled = lambda tid: False
        msg = {"reqId": "r1", "turnId": "t1", "epoch": 1, "imagePath": image_path,
               "question": "o que tem na tela", "cloudAuthorized": authorized}
        worker.Worker.handle_describe_screen(stub, msg)
    finally:
        os.unlink(image_path)
    return events, Boom.touched


stub_local_vision()

# 1) padrão (variável ausente) = DESLIGADO, mesmo com autorização falada e mestre ligado: a imagem NÃO sai
ev, touched = run_screen(None, "1", True)
assert touched is False, "visão desligada por padrão: o cliente Gemini não pode ser tocado"
assert not any(e.get("event") == "screen_sent" for e in ev), ev

# 2) explicitamente desligada
ev, touched = run_screen("0", "1", True)
assert touched is False and not any(e.get("event") == "screen_sent" for e in ev), ev

# 3) ligada, mas SEM autorização falada: a imagem não sai
ev, touched = run_screen("1", "1", False)
assert touched is False and not any(e.get("event") == "screen_sent" for e in ev), ev

# 4) ligada e autorizada, mas com o MESTRE desligado: a imagem não sai
ev, touched = run_screen("1", "0", True)
assert touched is False and not any(e.get("event") == "screen_sent" for e in ev), ev

# 5) controle positivo: ligada + autorizada + mestre ligado => o cliente É acionado e o aviso de envio é emitido
ev, touched = run_screen("1", "1", True)
assert touched is True, "controle positivo: com visão ligada e autorizada o cliente deve ser acionado"
assert any(e.get("event") == "screen_sent" for e in ev), ev

print("ok: test_cloud_vision")
