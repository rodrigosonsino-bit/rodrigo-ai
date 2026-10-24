"""Conta de créditos/cota: cada chamada ao Gemini (geração, intenção, visão, TTS) emite UMA
linha `[uso]` no diagnóstico com modelo + tokens de entrada/saída (e raciocínio quando houver).
Só números — nunca texto da conversa. Mutação: remover qualquer chamada a log_usage reprova.
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_usage_log.py"""
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

LOG: list = []
worker.log_diag = lambda m: LOG.append(m)  # type: ignore[assignment]
worker.emit = lambda _ev: None  # type: ignore[assignment]
os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
os.environ.pop("RODRIGO_CLOUD", None)


def uso_lines():
    return [m for m in LOG if "[uso]" in m]


# 1) helper: formato e tolerância a None
LOG.clear()
worker.log_usage("geracao", "t1", "modelo-x", SimpleNamespace(
    prompt_token_count=100, candidates_token_count=20, thoughts_token_count=5))
assert uso_lines() == ["[uso] fonte=geracao turno=t1 modelo=modelo-x entrada=100 saida=20 raciocinio=5"], uso_lines()
LOG.clear()
worker.log_usage("tts", "t2", "modelo-y", None, extra="caracteres=14")
assert uso_lines() == ["[uso] fonte=tts turno=t2 modelo=modelo-y entrada=None saida=None caracteres=14"], uso_lines()

# 2) geração: stream com usage_metadata => linha [uso] fonte=geracao
LOG.clear()


def gen_chunk(text):
    return SimpleNamespace(
        text=text,
        candidates=[SimpleNamespace(finish_reason=SimpleNamespace(name="STOP"))],
        usage_metadata=SimpleNamespace(prompt_token_count=100, candidates_token_count=20,
                                        thoughts_token_count=5))


class GenClient:
    def __init__(self):
        self.models = SimpleNamespace(generate_content_stream=self._gen)

    def _gen(self, model, contents, config):
        return iter([gen_chunk("Resposta de teste. ")])


gen_stub = SimpleNamespace(
    _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
    _gemini_client=GenClient(),
    _genai=SimpleNamespace(types=SimpleNamespace(GenerateContentConfig=lambda **kw: kw,
                                                 ThinkingConfig=lambda **kw: kw)),
    _gemini_client_for=lambda genai, t: gen_stub._gemini_client)
gen_stub._set_current = lambda h: worker.Worker._set_current(gen_stub, h)
worker.Worker.handle_generate(gen_stub, {"reqId": "r", "turnId": "tg", "epoch": 1, "messages": [
    {"role": "user", "content": "oi"}]})
ul = uso_lines()
assert len(ul) == 1 and "fonte=geracao" in ul[0] and "turno=tg" in ul[0], ul
assert "modelo=gemini-flash-latest" in ul[0] and "entrada=100" in ul[0] and "saida=20" in ul[0] \
    and "raciocinio=5" in ul[0], ul

# 3) intenção em nuvem => linha [uso] fonte=intencao
LOG.clear()
os.environ["RODRIGO_CLOUD_INTENT"] = "1"
intent_resp = SimpleNamespace(
    text='{"intent": "HORA"}', model_version=None,
    usage_metadata=SimpleNamespace(prompt_token_count=50, candidates_token_count=8))
intent_stub = SimpleNamespace(
    _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
    _intent_client=SimpleNamespace(models=SimpleNamespace(
        generate_content=lambda **kw: intent_resp)),
    _intent_genai=SimpleNamespace(types=SimpleNamespace(GenerateContentConfig=lambda **kw: kw)),
    _turn_cancelled=lambda _t: False)
evs = []
worker.emit = lambda e: evs.append(e)  # type: ignore[assignment]
worker.Worker.handle_detect_intent(intent_stub, {"reqId": "r", "turnId": "ti", "text": "que horas são"})
assert any(e.get("event") == "intent_detection" and e.get("available") is True for e in evs), evs
ul = uso_lines()
assert len(ul) == 1 and "fonte=intencao" in ul[0] and "turno=ti" in ul[0], ul
assert "entrada=50" in ul[0] and "saida=8" in ul[0], ul
worker.emit = lambda _ev: None  # type: ignore[assignment]

# 4) visão em nuvem => linha [uso] fonte=visao com imagem=1 (e screen_sent emitido)
LOG.clear()
os.environ.update(RODRIGO_CLOUD="1", RODRIGO_CLOUD_VISION="1")
google_mod, genai_mod, types_mod = (_pytypes.ModuleType("google"), _pytypes.ModuleType("google.genai"),
                                    _pytypes.ModuleType("google.genai.types"))
types_mod.Part = SimpleNamespace(from_bytes=lambda data, mime_type: ("img", len(data), mime_type))
types_mod.GenerateContentConfig = lambda **kw: kw
genai_mod.types = types_mod
google_mod.genai = genai_mod
saved = {k: sys.modules.get(k) for k in ("google", "google.genai", "google.genai.types")}
sys.modules.update({"google": google_mod, "google.genai": genai_mod, "google.genai.types": types_mod})


class Rec:
    def __init__(self):
        self.models = SimpleNamespace(generate_content=self._gen)

    def _gen(self, **kw):
        return SimpleNamespace(text="descricao de teste", usage_metadata=SimpleNamespace(
            prompt_token_count=300, candidates_token_count=25))


try:
    vis_stub = SimpleNamespace(
        _current_lock=threading.Lock(), _current=None, _cancelled_turns=OrderedDict(),
        _gemini_client_for=lambda genai, timeout_ms: Rec(),
        _turn_cancelled=lambda _t: False, _vlm_model=None, _mx=None)
    vis_stub._set_current = lambda h: worker.Worker._set_current(vis_stub, h)
    with tempfile.NamedTemporaryFile(suffix=".jpg", dir=tempfile.gettempdir()) as img:
        img.write(b"\xff\xd8\xff\xe0 jpeg de teste")
        img.flush()
        worker.Worker.handle_describe_screen(vis_stub, {
            "reqId": "r", "turnId": "tv", "epoch": 1, "imagePath": img.name,
            "question": "com o gemini, o que tem na tela", "cloudAuthorized": True})
finally:
    for k, v in saved.items():
        if v is None:
            sys.modules.pop(k, None)
        else:
            sys.modules[k] = v
ul = uso_lines()
assert len(ul) == 1 and "fonte=visao" in ul[0] and "turno=tv" in ul[0], ul
assert "entrada=300" in ul[0] and "saida=25" in ul[0] and "imagem=1" in ul[0], ul

# 5) TTS => linha [uso] fonte=tts com caracteres (fala local não gera linha: sem chamada, sem custo)
LOG.clear()
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


def audio_chunk(pcm, usage=None):
    part = SimpleNamespace(inline_data=SimpleNamespace(data=pcm, mime_type="audio/L16;codec=pcm;rate=24000"))
    return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))],
                           usage_metadata=usage)


class FakeTtsClient:
    def __init__(self):
        self.models = SimpleNamespace(generate_content_stream=self._gen)

    def _gen(self, model, contents, config):
        return iter([audio_chunk(b"\x00\x01" * 12000,
                                 usage=SimpleNamespace(prompt_token_count=9, candidates_token_count=15))])


w = worker.Worker()
w._gemini_client = FakeTtsClient()
w._genai = SimpleNamespace(types=FakeTypes)
with tempfile.TemporaryDirectory() as d:
    out = os.path.join(d, "out.wav")
    w.handle_synthesize({"cmd": "synthesize", "reqId": "r1", "turnId": "tt",
                         "text": "Ol\u00e1, tudo bem?", "outPath": out, "deadlineMs": 8000})
ul = uso_lines()
assert len(ul) == 1 and "fonte=tts" in ul[0] and "turno=tt" in ul[0], ul
assert "entrada=9" in ul[0] and "saida=15" in ul[0] and "caracteres=14" in ul[0], ul

print("ok: test_usage_log")
