"""GET /api/usage depende destes campos: done/intent_detection/screen_description (nuvem) e
synth_result carregam `usage` SÓ COM NÚMEROS (+ model). Mutação: remover qualquer campo reprova.
Caminhos locais (visão local, say) NÃO emitem usage: sem chamada, sem custo.
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_usage_events.py"""
import os
import sys
import tempfile
import threading
import types as _pytypes
from collections import OrderedDict
from types import SimpleNamespace

os.environ.setdefault("RODRIGO_FILE_ROOTS", tempfile.gettempdir())
sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402

os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
os.environ.pop("RODRIGO_CLOUD", None)

EVENTS: list = []
worker.emit = lambda ev: EVENTS.append(ev)  # type: ignore[assignment]
worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]


def check(name, cond, detail=""):
    assert cond, f"{name} {detail}"
    print(f"  ok: {name}")


UMETA = SimpleNamespace(prompt_token_count=100, candidates_token_count=20, thoughts_token_count=5)

# --- geração: done carrega usage do último modelo usado ---
print("geracao:")
gen_stub = SimpleNamespace(
    _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
    _gemini_client=SimpleNamespace(),
    _genai=SimpleNamespace(types=SimpleNamespace(GenerateContentConfig=lambda **kw: kw,
                                                 ThinkingConfig=lambda **kw: kw)),
    _gemini_client_for=lambda genai, t: SimpleNamespace(models=SimpleNamespace(
        generate_content_stream=lambda model, contents, config: iter([
            SimpleNamespace(text="Resposta de teste. ",
                            candidates=[SimpleNamespace(finish_reason=SimpleNamespace(name="STOP"))],
                            usage_metadata=UMETA)]))))
gen_stub._set_current = lambda h: worker.Worker._set_current(gen_stub, h)
EVENTS.clear()
worker.Worker.handle_generate(gen_stub, {"reqId": "r", "turnId": "t", "epoch": 1, "messages": [
    {"role": "user", "content": "oi"}]})
done = [e for e in EVENTS if e.get("event") == "done"]
check("done emitido", len(done) == 1, str(EVENTS))
u = done[0].get("usage")
check("usage em done", isinstance(u, dict), str(done))
check("modelo/in/out/raciocinio", u.get("model") == "gemini-flash-latest" and u.get("in") == 100
      and u.get("out") == 20 and u.get("reasoning") == 5, str(u))

# --- intenção: intent_detection carrega usage ---
print("intencao:")
os.environ["RODRIGO_CLOUD_INTENT"] = "1"
intent_stub = SimpleNamespace(
    _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
    _intent_client=SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kw: SimpleNamespace(
        text='{"intent": "HORA"}', model_version=None, usage_metadata=UMETA))),
    _intent_genai=SimpleNamespace(types=SimpleNamespace(GenerateContentConfig=lambda **kw: kw)),
    _turn_cancelled=lambda _t: False)
EVENTS.clear()
worker.Worker.handle_detect_intent(intent_stub, {"reqId": "r", "turnId": "t", "text": "que horas são"})
det = [e for e in EVENTS if e.get("event") == "intent_detection" and e.get("available") is True]
check("intent available", len(det) == 1, str(EVENTS))
check("usage em intent", det[0].get("usage", {}).get("in") == 100, str(det))

# --- visão em nuvem: screen_description carrega usage + image ---
print("visao:")
os.environ.update(RODRIGO_CLOUD="1", RODRIGO_CLOUD_VISION="1")
google_mod, genai_mod, types_mod = (_pytypes.ModuleType("google"), _pytypes.ModuleType("google.genai"),
                                    _pytypes.ModuleType("google.genai.types"))
types_mod.Part = SimpleNamespace(from_bytes=lambda data, mime_type: ("img", len(data), mime_type))
types_mod.GenerateContentConfig = lambda **kw: kw
genai_mod.types = types_mod
google_mod.genai = genai_mod
saved = {k: sys.modules.get(k) for k in ("google", "google.genai", "google.genai.types")}
sys.modules.update({"google": google_mod, "google.genai": genai_mod, "google.genai.types": types_mod})
try:
    vis_stub = SimpleNamespace(
        _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
        _gemini_client_for=lambda genai, t: SimpleNamespace(models=SimpleNamespace(
            generate_content=lambda **kw: SimpleNamespace(text="descricao", usage_metadata=UMETA))),
        _turn_cancelled=lambda _t: False, _vlm_model=None, _mx=None)
    vis_stub._set_current = lambda h: worker.Worker._set_current(vis_stub, h)
    EVENTS.clear()
    with tempfile.NamedTemporaryFile(suffix=".jpg", dir=tempfile.gettempdir()) as img:
        img.write(b"\xff\xd8\xff\xe0 jpeg de teste")
        img.flush()
        worker.Worker.handle_describe_screen(vis_stub, {
            "reqId": "r", "turnId": "t", "epoch": 1, "imagePath": img.name,
            "question": "com o gemini, o que tem na tela", "cloudAuthorized": True})
finally:
    for k, v in saved.items():
        sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v)
desc = [e for e in EVENTS if e.get("event") == "screen_description" and e.get("engine") == "gemini"]
check("screen gemini", len(desc) == 1, str(EVENTS))
check("usage em screen", desc[0].get("usage", {}).get("image") == 1, str(desc))

# --- TTS: synth_result ecoa o modelo efetivo ---
print("tts:")
os.environ.pop("RODRIGO_CLOUD", None)
os.environ.pop("RODRIGO_CLOUD_TTS", None)


class FakeTypes:
    class _Box:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    GenerateContentConfig = _Box
    SpeechConfig = _Box
    VoiceConfig = _Box
    PrebuiltVoiceConfig = _Box


def audio_chunk(pcm):
    part = SimpleNamespace(inline_data=SimpleNamespace(data=pcm, mime_type="audio/L16;codec=pcm;rate=24000"))
    return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))],
                           usage_metadata=UMETA)


class FakeTtsClient:
    def __init__(self):
        self.models = SimpleNamespace(generate_content_stream=self._gen)

    def _gen(self, model, contents, config):
        return iter([audio_chunk(b"\x00\x01" * 12000)])


w = worker.Worker()
w._gemini_client = FakeTtsClient()
w._genai = SimpleNamespace(types=FakeTypes)
EVENTS.clear()
with tempfile.TemporaryDirectory() as d:
    out = os.path.join(d, "out.wav")
    w.handle_synthesize({"cmd": "synthesize", "reqId": "r1", "turnId": "t",
                         "text": "Olá, tudo bem?", "outPath": out, "deadlineMs": 8000})
syn = [e for e in EVENTS if e.get("event") == "synth_result"]
check("synth ok", syn and syn[0].get("ok") is True, str(syn))
check("modelo ecoado", syn[0].get("model") == "gemini-3.8-flash-lite-tts", str(syn))
check("tokens", syn[0].get("tokensIn") == 100 and syn[0].get("tokensOut") == 20, str(syn))

print("ok: test_usage_events")
