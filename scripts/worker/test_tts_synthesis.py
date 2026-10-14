"""Fase 13a (docs/phase-13a-v3.md §4.2, H13a.5/.8/.13/.16): TTS Gemini no worker. Rodar:
.runtime/.venv/bin/python3 scripts/worker/test_tts_synthesis.py"""
import io
import os
import sys
import tempfile
import threading
import time
import wave
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import tempfile as _tf_roots  # noqa: E402
os.environ.setdefault("RODRIGO_FILE_ROOTS", _tf_roots.gettempdir())  # T2: o Node informa as raízes permitidas; o teste usa o diretório temporário
import worker  # noqa: E402

worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]
ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
    else:
        fail += 1
        print(f"[FALHOU] {name} {extra}")


def tone_pcm(amp_dbfs, seconds=1.0, rate=24000, pad_silence_s=0.0):
    t = np.arange(int(seconds * rate)) / rate
    a = 10 ** (amp_dbfs / 20.0) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)  # amp_dbfs = RMS da senoide
    pad = np.zeros(int(pad_silence_s * rate))
    full = np.concatenate([pad, a, pad])
    return (np.clip(np.round(full * 32768), -32768, 32767).astype("<i2")).tobytes()


def rms_db(pcm):
    a = np.frombuffer(pcm, dtype="<i2").astype(np.float64) / 32768.0
    return worker._rms_dbfs_gated(a)


# --- normalização (H13a.5): ganho -> limitador -> medida; gate de silêncio; teto ±9 dB ---
for src in (-25.0, -20.0, -16.0, -12.0):
    out, st = worker.normalize_pcm16(tone_pcm(src))
    check(f"RMS {src} dBFS vai para -17 (±0,3 dB)", abs(rms_db(out) + 17.0) <= 0.3, f"saiu {rms_db(out)}")
    check(f"{src}: não saturou o teto", st["saturated"] is False)

out, st = worker.normalize_pcm16(tone_pcm(-40.0))
check("muito baixo (-40): ganho limitado a +9 dB e marcado como saturado", st["saturated"] is True and abs(st["gainDb"] - 9.0) < 0.01, str(st))
check("saturado: RMS de saída fica acima da entrada mas abaixo do alvo", -40.0 < rms_db(out) < -17.0)

out, st = worker.normalize_pcm16(tone_pcm(-3.0))
check("muito alto (-3): ganho limitado a -9 dB, marcado como saturado", st["saturated"] is True and abs(st["gainDb"] + 9.0) < 0.01, str(st))

# gate: muito silêncio ao redor não muda o ganho calculado (a medida só olha amostras acima de -50 dBFS)
a_core, st_core = worker.normalize_pcm16(tone_pcm(-22.0))
a_pad, st_pad = worker.normalize_pcm16(tone_pcm(-22.0, pad_silence_s=3.0))
check("gate de silêncio: o mesmo ganho com ou sem padding de silêncio", abs(st_core["gainDb"] - st_pad["gainDb"]) < 0.05, f"{st_core} {st_pad}")

# só silêncio / quase nada: não mexe (sem fala medível)
sil = np.zeros(24000, dtype="<i2").tobytes()
out, st = worker.normalize_pcm16(sil)
check("só silêncio: devolve o mesmo áudio, sem ganho", out == sil and st["gainDb"] == 0.0)
out, st = worker.normalize_pcm16(b"")
check("áudio vazio: não quebra", out == b"")

# pico: limitador escala a frase inteira (sem corte) e o pico final respeita -1 dBFS
spiky = np.zeros(24000)
spiky[1000] = 0.99
spiky[5000:12000] = 0.02 * np.sin(np.arange(7000) * 0.3)
pcm = (np.round(spiky * 32768)).astype("<i2").tobytes()
out, st = worker.normalize_pcm16(pcm)
peak = np.max(np.abs(np.frombuffer(out, dtype="<i2"))) / 32768.0
check("limitador: pico <= -1 dBFS", peak <= 10 ** (-1.0 / 20) + 1e-3, f"pico {peak}")
check("limitador: marca 'limited'", st["limited"] is True)
check("saída tem o mesmo número de amostras da entrada", len(out) == len(pcm))

# --- WAV atômico ---
with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "out-x.wav")
    pcm = tone_pcm(-17.0, seconds=0.5)
    worker.write_wav_atomic(path, pcm, 24000)
    with wave.open(path, "rb") as w:
        check("WAV: mono, 16 bits, 24 kHz, frames corretos",
              (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 24000, len(pcm) // 2))
    check("WAV: nenhum .part sobra", not os.path.exists(path + ".part"))
    bad = os.path.join(d, "nao-existe", "x.wav")
    try:
        worker.write_wav_atomic(bad, pcm, 24000)
        check("WAV em diretório inexistente lança", False)
    except OSError:
        check("WAV em diretório inexistente lança", True)
    check("falha na escrita: nenhum arquivo parcial", not os.path.exists(bad) and not os.path.exists(bad + ".part"))


# --- classificação de erros (H13a.8) ---
class APIError(Exception):
    def __init__(self, code, details=None, msg=None):
        super().__init__(msg or f"{code} erro simulado")
        self.code = code
        self.details = details


class ServerError(APIError):
    pass


class ClientError(APIError):
    pass


class ReadTimeout(Exception):
    pass


ReadTimeout.__mro__  # noqa: B018
TimeoutException = type("TimeoutException", (Exception,), {})
ReadTimeout = type("ReadTimeout", (TimeoutException,), {})
TransportError = type("TransportError", (Exception,), {})
ConnectError = type("ConnectError", (TransportError,), {})


def err429(quota_id, retry="11s"):
    items = []
    if quota_id is not None:
        items.append({"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": [{"quotaId": quota_id}]})
    if retry is not None:
        items.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry})
    return ClientError(429, {"error": {"code": 429, "details": items}})


r = worker.classify_tts_error(err429("GenerateRequestsPerMinutePerProjectPerModel", "11s"))
check("429 por minuto", r["kind"] == "rate_limited" and r["scope"] == "minute" and r["retryAfterMs"] == 11000, str(r))
r = worker.classify_tts_error(err429("GenerateRequestsPerDayPerProjectPerModel", "3600.5s"))
check("429 por dia", r["scope"] == "day" and r["retryAfterMs"] == 3600500, str(r))
r = worker.classify_tts_error(err429("AlgumaCotaNova", None))
check("429 com quotaId desconhecido => scope unknown, sem retryAfterMs", r["scope"] == "unknown" and "retryAfterMs" not in r, str(r))
r = worker.classify_tts_error(err429(None, "30s"))
check("429 sem quotaId, só retryDelay", r["scope"] == "unknown" and r["retryAfterMs"] == 30000, str(r))
r = worker.classify_tts_error(ClientError(429, None, "429 RESOURCE_EXHAUSTED ... quotaId: 'GenerateRequestsPerDayPerProjectPerModel' ... Please retry in 21.31s."))
check("429 sem details estruturados: lê do texto", r["scope"] == "day" and r["retryAfterMs"] == 21310, str(r))
check("o corpo bruto nunca vai no resultado", "message" not in r and "details" not in r)
for code, kind in [(400, "client_error"), (401, "client_error"), (403, "client_error"), (404, "not_found")]:
    check(f"{code} -> {kind}", worker.classify_tts_error(ClientError(code))["kind"] == kind)
check("503 -> server", worker.classify_tts_error(ServerError(503))["kind"] == "server")
check("timeout httpx -> timeout", worker.classify_tts_error(ReadTimeout("t"))["kind"] == "timeout")
check("transporte -> transport", worker.classify_tts_error(ConnectError("x"))["kind"] == "transport")
check("erro qualquer -> error", worker.classify_tts_error(ValueError("x"))["kind"] == "error")


# --- síntese ponta a ponta com cliente falso ---
class FakeTypes:
    class _Box:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    GenerateContentConfig = _Box
    SpeechConfig = _Box
    VoiceConfig = _Box
    PrebuiltVoiceConfig = _Box


def audio_chunk(pcm, mime="audio/L16;codec=pcm;rate=24000", usage=None):
    part = SimpleNamespace(inline_data=SimpleNamespace(data=pcm, mime_type=mime))
    return SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[part]))], usage_metadata=usage)


class FakeClient:
    def __init__(self, behavior):
        self.behavior = behavior
        self.calls = []
        self.models = SimpleNamespace(generate_content_stream=self._gen)

    def _gen(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        b = self.behavior
        if isinstance(b, BaseException):
            raise b
        return b() if callable(b) else iter(b)


EVENTS = []
worker.emit = lambda e: EVENTS.append(e)  # type: ignore[assignment]
os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste"
os.environ.pop("RODRIGO_CLOUD", None)
os.environ.pop("RODRIGO_CLOUD_TTS", None)


def make_worker(behavior):
    w = worker.Worker()
    w._gemini_client = FakeClient(behavior)
    w._genai = SimpleNamespace(types=FakeTypes)
    return w


_N = [0]


def run(w, tmpdir, **over):
    EVENTS.clear()
    _N[0] += 1
    out = os.path.join(tmpdir, f"out-{_N[0]}.wav")  # caminho único por chamada (nada herdado de um teste anterior)
    msg = {"cmd": "synthesize", "reqId": "r1", "turnId": "t1", "text": "Olá, tudo bem?", "outPath": out, "deadlineMs": 4000}
    msg.update(over)
    w.handle_synthesize(msg)
    ev = [e for e in EVENTS if e.get("event") == "synth_result"]
    return (ev[-1] if ev else None), msg["outPath"]


with tempfile.TemporaryDirectory() as d:
    pcm = tone_pcm(-24.0, seconds=0.6)
    chunks = [audio_chunk(pcm[: len(pcm) // 2]), audio_chunk(pcm[len(pcm) // 2:], usage=SimpleNamespace(prompt_token_count=9, candidates_token_count=15))]
    w = make_worker(chunks)
    res, path = run(w, d)
    check("síntese ok", res is not None and res["ok"] is True, str(res))
    check("WAV final existe, sem .part", os.path.exists(path) and not os.path.exists(path + ".part"))
    with wave.open(path, "rb") as wf:
        got = np.frombuffer(wf.readframes(wf.getnframes()), dtype="<i2").tobytes()
    check("áudio gravado foi normalizado para -17 dBFS (±0,3)", abs(rms_db(got) + 17.0) <= 0.3, f"{rms_db(got)}")
    call = w._gemini_client.calls[0]
    check("modelo padrão = gemini-3.8-flash-lite-tts", call["model"] == "gemini-3.8-flash-lite-tts")
    check("só o TEXTO da frase vai ao modelo (sem prefixo de estilo)", call["contents"] == "Olá, tudo bem?")
    check("sem system_instruction na configuração", not hasattr(call["config"], "system_instruction"))
    check("voz padrão Charon", call["config"].speech_config.voice_config.prebuilt_voice_config.voice_name == "Charon")
    check("tokens reportados", res["tokensIn"] == 9 and res["tokensOut"] == 15)
    check("duração reportada ~0,6 s", abs(res["seconds"] - 0.6) < 0.05, str(res))

    res, _ = run(make_worker(chunks), d, model="gemini-x", voice="Kore")
    check("modelo e voz configuráveis por pedido", res["ok"] is True)

    # 429: resultado estruturado, nenhum arquivo
    out_err = os.path.join(d, "e.wav")
    res, _ = run(make_worker(err429("GenerateRequestsPerMinutePerProjectPerModel", "11s")), d, outPath=out_err)
    check("429 vira synth_result não-ok com escopo e retryAfterMs", res["ok"] is False and res["kind"] == "rate_limited" and res["scope"] == "minute")
    check("429: nenhum arquivo nem .part", not os.path.exists(out_err) and not os.path.exists(out_err + ".part"))

    res, _ = run(make_worker(ServerError(503)), d)
    check("503 -> kind server", res["kind"] == "server")

    # formato inesperado e vazio
    res, _ = run(make_worker([audio_chunk(b"\x00\x01" * 2000, mime="audio/mpeg")]), d)
    check("formato de áudio inesperado vira erro (nada gravado)", res["ok"] is False and res["kind"] == "error")
    res, _ = run(make_worker([SimpleNamespace(candidates=[], usage_metadata=None)]), d)
    check("sem áudio -> kind empty", res["kind"] == "empty")

    # entrada inválida
    res, _ = run(make_worker(chunks), d, text="   ")
    check("texto vazio -> client_error 400", res["kind"] == "client_error" and res["status"] == 400)
    res, _ = run(make_worker(chunks), d, outPath="relativo.wav")
    check("caminho relativo é recusado", res["kind"] == "client_error")

    # mestre / canal desligados: nenhuma chamada ao cliente
    for var in ("RODRIGO_CLOUD", "RODRIGO_CLOUD_TTS"):
        os.environ[var] = "0"
        wd = make_worker(chunks)
        res, _ = run(wd, d)
        check(f"{var}=0: desligado, sem chamada", res["kind"] == "disabled" and wd._gemini_client.calls == [])
        os.environ.pop(var)
    saved = os.environ.pop("GEMINI_API_KEY")
    res, _ = run(make_worker(chunks), d)
    check("sem chave: client_error sem chamar a rede", res["kind"] == "client_error" and res.get("reason") == "no_key")
    os.environ["GEMINI_API_KEY"] = saved

    # prazo local: o cliente bloqueia mais que o prazo
    release = threading.Event()

    def slow():
        release.wait(5)
        return iter(chunks)

    t0 = time.monotonic()
    res, p = run(make_worker(slow), d, deadlineMs=1000)
    el = time.monotonic() - t0
    check("prazo local estourado -> timeout local em ~1 s", res["kind"] == "timeout" and res.get("local") is True and 0.9 <= el < 2.5, f"{res} {el}")
    release.set()
    time.sleep(0.4)
    check("timeout local: a thread interna não grava arquivo depois", not os.path.exists(p) and not os.path.exists(p + ".part"))

    # cancelamento por turno enquanto sintetiza
    gate = threading.Event()

    def blocked():
        gate.wait(5)
        return iter(chunks)

    wc = make_worker(blocked)
    holder = {}

    def go():
        holder["res"], holder["p"] = run(wc, d, turnId="turno-A", reqId="rA")

    th = threading.Thread(target=go)
    th.start()
    time.sleep(0.3)
    EVENTS_BEFORE = len(EVENTS)
    wc.handle_cancel({"cmd": "cancel", "turnId": "turno-A"})
    th.join(3)
    gate.set()
    check("cancelamento do turno cancela a síntese em curso", holder["res"]["kind"] == "cancelled", str(holder.get("res")))
    check("cancelado: nenhum WAV", not os.path.exists(holder["p"]))

    # cancel_synth por reqId e idempotência
    wd = make_worker(blocked)
    gate.clear()
    th = threading.Thread(target=lambda: holder.update(zip(("res", "p"), run(wd, d, reqId="rB", turnId="turno-B"))))
    th.start()
    time.sleep(0.3)
    wd.handle_cancel_synth({"cmd": "cancel_synth", "reqId": "rB"})
    th.join(3)
    gate.set()
    check("cancel_synth por reqId cancela só aquela", holder["res"]["kind"] == "cancelled")
    EVENTS.clear()
    wd.handle_cancel_synth({"cmd": "cancel_synth", "reqId": "desconhecido"})
    wd.handle_cancel_synth({"cmd": "cancel_synth", "reqId": "rB"})
    check("cancel_synth de reqId desconhecido ou já terminado: no-op com ack, sem erro",
          [e["event"] for e in EVENTS] == ["cancelled", "cancelled"])
    # cancelar OUTRO turno não pode afetar uma síntese em curso (antes era uma asserção vazia, auditoria F13a achado 7)
    gate.clear()
    th = threading.Thread(target=lambda: holder.update(zip(("res", "p"), run(wd, d, reqId="rC", turnId="turno-C"))))
    th.start()
    time.sleep(0.3)
    wd.handle_cancel({"cmd": "cancel", "turnId": "outro-turno"})
    gate.set()
    th.join(3)
    check("cancelar OUTRO turno não afeta a síntese em curso", holder["res"] is not None and holder["res"].get("ok") is True, str(holder.get("res")))

    # pedido ainda NA FILA do pool (registrado no despacho) é alcançado pelo cancelamento: nada vai à rede (achado 1)
    calls_before = [0]
    we = make_worker(chunks)
    real_call = we._tts_call
    def counting_call(*a, **k):
        calls_before[0] += 1
        return real_call(*a, **k)
    we._tts_call = counting_call
    queued = {"cmd": "synthesize", "reqId": "rQ", "turnId": "turno-Q", "text": "Olá.", "outPath": os.path.join(d, "q.wav"), "deadlineMs": 4000}
    we.register_synth(queued)  # o que o despacho faz antes de enfileirar
    we.handle_cancel({"cmd": "cancel", "turnId": "turno-Q"})
    EVENTS.clear()
    we.handle_synthesize(queued)  # a thread do pool pega o item depois do cancelamento
    resq = next((e for e in EVENTS if e.get("event") == "synth_result"), None)
    check("síntese enfileirada e cancelada: resultado 'cancelled', zero chamada de rede, sem WAV",
          resq is not None and resq.get("kind") == "cancelled" and calls_before[0] == 0 and not os.path.exists(queued["outPath"]), str(resq))

# --- H13a.13: synthesize NÃO passa por work_queue/work_loop ---
with tempfile.TemporaryDirectory() as d:
    w = make_worker([audio_chunk(tone_pcm(-20.0, seconds=0.3))])
    w.work_queue.put({"cmd": "generate", "reqId": "gen-em-andamento"})  # a fila de tamanho 1 está ocupada pela geração
    EVENTS.clear()
    out = os.path.join(d, "out-q.wav")
    lines = io.StringIO('{"cmd":"synthesize","reqId":"rq","turnId":"tq","text":"Oi.","outPath":%s,"deadlineMs":4000}\n' % __import__("json").dumps(out))
    real_stdin, real_exit = sys.stdin, worker.os._exit
    sys.stdin = lines
    worker.os._exit = lambda _c: None  # type: ignore[assignment]
    try:
        w.stdin_reader_loop()
    finally:
        sys.stdin = real_stdin
        worker.os._exit = real_exit
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not any(e.get("event") == "synth_result" for e in EVENTS):
        time.sleep(0.05)
    res = next((e for e in EVENTS if e.get("event") == "synth_result"), None)
    check("síntese concluída enquanto a geração ocupa a fila de tamanho 1", res is not None and res["ok"] is True, str(res))
    check("a geração em andamento NÃO foi descartada da fila", w.work_queue.qsize() == 1 and w.work_queue.get_nowait()["reqId"] == "gen-em-andamento")

# --- H13a.16: duas sínteses simultâneas, pool de threads daemon ---
check("pool: workers são daemon", all(t.daemon for t in threading.enumerate() if t.name.startswith("synth-")))
check("pool tem 2 workers (threads reais, não só a constante)",
      sum(1 for t in threading.enumerate() if t.name.startswith("synth-") and t.name != "synth-call") >= worker.TTS_POOL_WORKERS == 2)
check("HTTP do TTS >= 10 s (piso do Google)", worker.TTS_HTTP_TIMEOUT_MS >= 10_000)

print(f"{ok} ok, {fail} falhas")
sys.exit(1 if fail else 0)
