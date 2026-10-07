"""Fase 12 §2.5: regra de RODRIGO_GEMINI_BASE_URL no worker = a mesma do Node (mesmos casos em
src/backend/__tests__/fixtures/gemini-base-url-cases.json) + chave sintética + redirect desligado.
Rodar: python3 scripts/worker/test_gemini_endpoint.py"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402

worker.log_diag = lambda *_a, **_k: None  # type: ignore[assignment]
CASES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "backend", "__tests__", "fixtures", "gemini-base-url-cases.json"), encoding="utf-8"))["cases"]
assert len(CASES) >= 40

for c in CASES:
    got = worker.parse_gemini_base_url(c["input"])
    if c["accept"]:
        assert got == c["input"], f"deveria aceitar {c['input']!r}, deu {got!r}"
    else:
        assert got is None, f"deveria REJEITAR {c['input']!r}, aceitou {got!r}"

REAL = "AIzaSyD-CHAVE-REAL-SINTETICA-0123456789"
base = {"GEMINI_API_KEY": REAL}

# sem a variável: chave real, endpoint padrão
assert worker.resolve_gemini_endpoint(dict(base)) == (REAL, None)
# variável SEM RODRIGO_TEST=1: ignorada (chave real, endpoint padrão) — e nunca usa o host informado
assert worker.resolve_gemini_endpoint({**base, "RODRIGO_GEMINI_BASE_URL": "http://127.0.0.1:9000"}) == (REAL, None)
# modo de teste + URL válida: chave SINTÉTICA, nunca a real
key, url = worker.resolve_gemini_endpoint({**base, "RODRIGO_TEST": "1", "RODRIGO_GEMINI_BASE_URL": "http://127.0.0.1:9000"})
assert key == "test-dummy-key" and url == "http://127.0.0.1:9000" and REAL not in (key, url)
# modo de teste + URL inválida: RECUSA (nunca cai no endpoint real com a chave real)
for bad in ["http://evil.com:9000", "http://localhost:9000", "http://127.0.0.1@evil.com:9000", " "]:
    try:
        worker.resolve_gemini_endpoint({**base, "RODRIGO_TEST": "1", "RODRIGO_GEMINI_BASE_URL": bad})
    except RuntimeError:
        continue
    raise AssertionError(f"modo de teste com URL inválida {bad!r} deveria recusar")

# o ÚNICO ponto de criação de cliente: redirect desligado e base_url/chave vindas da regra acima
try:
    import httpx  # noqa: F401  (só existe no venv do worker: .runtime/.venv/bin/python3)
    HAVE_HTTPX = True
except ImportError:
    HAVE_HTTPX = False
    print("AVISO: httpx ausente neste Python — trecho do cliente PULADO (rode com .runtime/.venv/bin/python3)")


class FakeGenai:
    class types:  # noqa: N801
        class HttpOptions:
            def __init__(self, **kw):
                self.kw = kw

    class Client:
        def __init__(self, api_key, http_options):
            self.api_key, self.http_options = api_key, http_options

if HAVE_HTTPX:
    os.environ.update({"GEMINI_API_KEY": REAL, "RODRIGO_TEST": "1", "RODRIGO_GEMINI_BASE_URL": "http://127.0.0.1:9000"})
    cl = worker.build_gemini_client(FakeGenai, 20_000)
    assert cl.api_key == "test-dummy-key"
    assert cl.http_options.kw["base_url"] == "http://127.0.0.1:9000" and cl.http_options.kw["timeout"] == 20_000
    assert cl.http_options.kw["httpx_client"].follow_redirects is False, "redirect tem que estar DESLIGADO"
    os.environ.pop("RODRIGO_TEST"); os.environ.pop("RODRIGO_GEMINI_BASE_URL")
    cl = worker.build_gemini_client(FakeGenai, 10_000)
    assert cl.api_key == REAL and "base_url" not in cl.http_options.kw
    assert cl.http_options.kw["httpx_client"].follow_redirects is False, "redirect desligado TAMBÉM em produção"

# estrutural: só existe UM ponto que cria genai.Client no worker
src = open(os.path.join(os.path.dirname(__file__), "worker.py"), encoding="utf-8").read()
assert src.count("genai.Client(") == 1, src.count("genai.Client(")

print("ok: test_gemini_endpoint")
