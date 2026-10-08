"""Plano B da geração (2026-10-07): se o gemini-flash-latest falhar ANTES de qualquer frase ser dita, tenta o
gemini-3.5-flash-lite com as MESMAS mensagens; depois de uma frase dita nunca recomeça. Rodar:
.runtime/.venv/bin/python3 scripts/worker/test_generation_fallback.py"""
import os
import sys
import threading
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
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


# --- classes de erro com os MESMOS nomes dos reais (o código decide pelo nome da classe / .code) ---
class APIError(Exception):
    def __init__(self, code):
        super().__init__(f"{code} erro simulado")
        self.code = code


class ServerError(APIError):
    pass


class ClientError(APIError):
    pass


class TimeoutException(Exception):
    pass


class ReadTimeout(TimeoutException):
    pass


class TransportError(Exception):
    pass


# --- should_fallback: onde OUTRO modelo pode ajudar ---
for exc, want, why in [
    (ServerError(503), True, "503 sobrecarga"),
    (ServerError(500), True, "500"),
    (ClientError(404), True, "404 alias sumiu"),
    (ClientError(429), True, "429 cota do modelo"),
    (ClientError(400), False, "400 requisição inválida: igual em qualquer modelo"),
    (ClientError(401), False, "401 credencial"),
    (ClientError(403), False, "403 credencial"),
    (ReadTimeout("t"), True, "timeout de leitura (httpx)"),
    (TransportError("x"), True, "falha de transporte"),
    (ValueError("to_gemini_contents"), False, "erro de programação/entrada"),
    (RuntimeError("GEMINI_API_KEY ausente"), False, "chave ausente"),
]:
    check(f"should_fallback({why})", worker.should_fallback(exc) is want)

check("prazo do 1º modelo é CURTO (falhar rápido: no máximo 10 s)", worker.GENERATION_MODELS[0][1] <= 10_000)
check("modelos de geração: 1º flash-latest com prazo curto, 2º flash-lite com prazo longo",
      worker.GENERATION_MODELS[0][0] == "gemini-flash-latest" and worker.GENERATION_MODELS[1][0] == "gemini-3.5-flash-lite"
      and worker.GENERATION_MODELS[0][1] < worker.GENERATION_MODELS[1][1])


# --- laço de geração com cliente injetável ---
def chunk(text):
    return SimpleNamespace(text=text)


class Client:
    """models.generate_content_stream(model=...) -> comportamento por modelo."""

    def __init__(self, behavior):
        self.behavior = behavior
        self.calls = []
        self.models = SimpleNamespace(generate_content_stream=self._gen)

    def _gen(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents})
        b = self.behavior[model]
        if isinstance(b, BaseException):
            raise b
        return b() if callable(b) else iter(b)


STUB = {}


def run(behavior):
    events = []
    worker.emit = lambda ev: events.append(ev)  # type: ignore[assignment]
    os.environ["GEMINI_API_KEY"] = "chave-sintetica"
    os.environ.pop("RODRIGO_CLOUD", None)
    client = Client(behavior)
    stub = SimpleNamespace(_current_lock=threading.Lock(), _current=None, _gemini_client=client,
                           _genai=SimpleNamespace(types=SimpleNamespace(GenerateContentConfig=lambda **kw: kw)),
                           _gemini_client_for=lambda genai, t: client)
    STUB["stub"] = stub
    # histórico de VÁRIAS mensagens (usuário, assistente, usuário): o plano B tem de receber TODAS, não só a última
    worker.Worker.handle_generate(stub, {"reqId": "r", "turnId": "t", "epoch": 1, "messages": [
        {"role": "system", "content": "S"}, {"role": "user", "content": "primeira pergunta"},
        {"role": "assistant", "content": "primeira resposta"}, {"role": "user", "content": "segunda pergunta"}]})
    return events, client


P, F = "gemini-flash-latest", "gemini-3.5-flash-lite"
GOOD = [chunk("Resposta do plano B. "), chunk("Segunda frase.")]

# 1) 503 no principal => plano B responde, com as MESMAS mensagens; eventos normais
ev, cl = run({P: ServerError(503), F: GOOD})
check("503: usa os dois modelos, na ordem", [c["model"] for c in cl.calls] == [P, F], str(cl.calls))
check("503: as mesmas mensagens/contents vão ao plano B (fronteira de dados inalterada)", cl.calls[0]["contents"] == cl.calls[1]["contents"])
check("503: frases do plano B emitidas + done, sem erro", [e["event"] for e in ev] == ["sentence", "sentence", "done"], str(ev))

# 2) timeout, 404 e 429 também caem no plano B
for exc, nome in [(ReadTimeout("t"), "timeout"), (ClientError(404), "404"), (ClientError(429), "429")]:
    ev, cl = run({P: exc, F: GOOD})
    check(f"{nome}: cai no plano B e conclui", [e["event"] for e in ev][-1] == "done" and len(cl.calls) == 2)

# 3) 400/401/403 NÃO tentam de novo: uma chamada e erro honesto
for code in (400, 401, 403):
    ev, cl = run({P: ClientError(code), F: GOOD})
    check(f"{code}: NÃO tenta o plano B", len(cl.calls) == 1 and [e["event"] for e in ev] == ["error"], str(ev))

# 4) os dois falham => erro honesto, duas tentativas
ev, cl = run({P: ServerError(503), F: ServerError(503)})
check("os dois 503: erro honesto após 2 tentativas", len(cl.calls) == 2 and [e["event"] for e in ev] == ["error"], str(ev))


# 5) falha NO MEIO depois de uma frase já dita: NÃO recomeça (nunca duplica)
def broken():
    yield chunk("Primeira frase completa. ")
    yield chunk("Segunda ainda não termi")
    raise ServerError(503)


ev, cl = run({P: broken, F: GOOD})
sentences = [e["text"] for e in ev if e["event"] == "sentence"]
check("falha após frase dita: SEM plano B (1 chamada)", len(cl.calls) == 1, str(cl.calls))
check("falha após frase dita: erro honesto e só a frase já dita", sentences == ["Primeira frase completa."] and ev[-1]["event"] == "error", str(ev))

# 6) falha com texto PARCIAL mas nenhuma frase completa: pode usar o plano B e o parcial é descartado
def partial_then_503():
    yield chunk("texto sem pon")
    raise ServerError(503)


ev, cl = run({P: partial_then_503, F: GOOD})
check("parcial sem frase completa: plano B, sem resto do texto antigo", len(cl.calls) == 2 and "pon" not in str([e.get("text") for e in ev]), str(ev))

# 6b) CANCELAMENTO (barge-in) durante a falha do principal: nada de segunda tentativa
def cancel_then_503():
    STUB["stub"]._current.cancel_event.set()  # o usuário interrompeu
    raise ServerError(503)


ev, cl = run({P: cancel_then_503, F: GOOD})
check("cancelado durante a falha: SEM plano B (1 chamada)", len(cl.calls) == 1, str(cl.calls))
check("o plano B recebe o histórico COMPLETO (3 mensagens), não só a última",
      len(run({P: ServerError(503), F: GOOD})[1].calls[1]["contents"]) == 3)

# 7) sucesso no principal: o plano B nunca é tocado
ev, cl = run({P: GOOD, F: ServerError(500)})
check("sucesso no principal: 1 chamada, só o principal", [c["model"] for c in cl.calls] == [P] and ev[-1]["event"] == "done")

print(f"\n{ok} ok, {fail} falhas")
sys.exit(1 if fail else 0)
