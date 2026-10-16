"""Visão LOCAL da tela (regressão 2026-10-15): dois defeitos reais que deixavam a resposta em
"SCREEN_NOT_READY_TEXT" ("Ainda estou aprendendo a enxergar a tela") mesmo com captura válida:
1) stdin_reader_loop não enfileirava describe_screen ("Comando desconhecido ignorado",
   o turno morria no timeout de 90 s). Mutação: remover de QUEUED_COMMANDS reprova.
2) mlx_vlm.generate(model, processor, image, prompt) com argumentos posicionais trocados
   (assinatura: prompt 3º, image 4º) => "Failed to load image". Mutação: voltar a
   posicionais reprova. A chamada precisa ser por palavra-chave e o texto sai de .text.
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_worker_vision_local.py"""
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

# 1) despacho: todo comando do work_loop precisa estar na fila do stdin_reader_loop
assert "describe_screen" in worker.QUEUED_COMMANDS, "describe_screen precisa estar em QUEUED_COMMANDS"

CALLS: list = []


def run_local():
    os.environ["RODRIGO_CLOUD"] = "1"
    os.environ.pop("RODRIGO_CLOUD_VISION", None)  # padrão desligado: caminho local
    os.environ.pop("GEMINI_API_KEY", None)
    CALLS.clear()

    fake_vlm = _pytypes.ModuleType("mlx_vlm")
    fake_processor = SimpleNamespace(
        apply_chat_template=lambda msgs, add_generation_prompt=True:
            "PROMPT-FORMATADO " + str(msgs))
    fake_vlm.load = lambda _model_id: (object(), fake_processor)  # type: ignore[attr-defined]

    def fake_generate(model, processor, **kw):  # noqa: ANN001, ANN202
        CALLS.append({"prompt": kw.get("prompt"), "image": kw.get("image"),
                      "n_positional": 2})
        assert model is not None and processor is fake_processor
        return SimpleNamespace(text="  descricao local de teste  ")

    fake_vlm.generate = fake_generate  # type: ignore[attr-defined]
    saved = sys.modules.get("mlx_vlm")
    sys.modules["mlx_vlm"] = fake_vlm
    events: list = []
    worker.emit = lambda ev: events.append(ev)
    worker.log_diag = lambda *_a, **_k: None
    stub = SimpleNamespace(
        _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
        _gemini_client_for=lambda *a: (_ for _ in ()).throw(AssertionError("nuvem nao pode ser tocada")),
        _turn_cancelled=lambda _t: False, _vlm_model=None, _mx=None,
    )
    stub._set_current = lambda h: worker.Worker._set_current(stub, h)
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", dir=tempfile.gettempdir()) as img:
            img.write(b"\xff\xd8\xff\xe0 jpeg de teste")
            img.flush()
            worker.Worker.handle_describe_screen(stub, {
                "reqId": "r", "turnId": "t", "epoch": 1, "imagePath": img.name,
                "question": "o que tem na tela", "cloudAuthorized": False})
            image_used = img.name
    finally:
        if saved is None:
            sys.modules.pop("mlx_vlm", None)
        else:
            sys.modules["mlx_vlm"] = saved
    return events, image_used


events, image_used = run_local()
assert not any(e.get("event") == "screen_sent" for e in events), "caminho local: nada sai a nuvem"
assert len(CALLS) == 1, f"generate precisa ser chamado 1 vez: {CALLS}"
assert CALLS[0]["image"] == image_used, f"image precisa ser o caminho do quadro: {CALLS}"
assert isinstance(CALLS[0]["prompt"], str) and "tela" in CALLS[0]["prompt"].lower(), \
    f"prompt precisa ser o template com a pergunta: {CALLS}"
desc = [e for e in events if e.get("event") == "screen_description"]
assert desc and desc[0].get("text") == "descricao local de teste", f"texto precisa sair de .text: {events}"
assert desc[0].get("engine") == "local", events
print("ok: test_worker_vision_local")
