"""Fase 12: redact()/safe_exc()/log_diag() do worker passam pelos MESMOS casos do espelho em TypeScript
(src/backend/__tests__/fixtures/redact-cases.json). Rodar: python3 scripts/worker/test_redact.py"""
import contextlib
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import worker  # noqa: E402

CASES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "backend", "__tests__", "fixtures", "redact-cases.json"), encoding="utf-8"))["cases"]
assert len(CASES) >= 20, "o arquivo de casos deve ter sido carregado"


def run_case(c):
    saved = os.environ.get("GEMINI_API_KEY")
    if "env" in c:
        os.environ["GEMINI_API_KEY"] = c["env"]
    else:
        os.environ.pop("GEMINI_API_KEY", None)
    try:
        return worker.redact(c["input"], tuple(c.get("extra", [])), c.get("maxLen"))
    finally:
        if saved is None:
            os.environ.pop("GEMINI_API_KEY", None)
        else:
            os.environ["GEMINI_API_KEY"] = saved


for c in CASES:
    out = run_case(c)
    for frag in c.get("notContain", []):
        assert frag not in out, f"[{c['name']}] vazou {frag!r}: {out!r}"
    for frag in c.get("contain", []):
        assert frag in out, f"[{c['name']}] sumiu texto legítimo {frag!r}: {out!r}"
    if c.get("unchanged"):
        assert out == c["input"], f"[{c['name']}] texto benigno alterado: {out!r}"
    if "endsWith" in c:
        assert out.endswith(c["endsWith"]), f"[{c['name']}] {out!r}"
    if "maxLength" in c:
        assert len(out) <= c["maxLength"], f"[{c['name']}] len={len(out)}"

# CONTROLE POSITIVO: sem redact (identidade) os casos de vazamento FALHARIAM — prova que o runner detecta.
leaky = [c for c in CASES if c.get("notContain")]
assert leaky, "deve haver casos de vazamento"
caught = 0
for c in leaky:
    ident = c["input"][: c["maxLen"]] if c.get("maxLen") else c["input"]
    if any(frag in ident for frag in c["notContain"]):
        caught += 1
assert caught == len(leaky), f"o runner só detectaria {caught}/{len(leaky)} vazamentos sem redact"

K = "AIzaSyD-SEGREDO-SINTETICO-0123456789abcd"

# safe_exc: mascara, trunca em 160, não carrega o corpo bruto e mostra arquivo:linha
try:
    raise RuntimeError("400 INVALID_ARGUMENT " + ("corpo " * 80) + f"?key={K}")
except RuntimeError as e:
    text = worker.safe_exc(e)
assert "SEGREDO" not in text and "AIza" not in text, text
assert text.startswith("RuntimeError: ") and "test_redact.py:" in text, text
assert len(text.split(" [")[0]) <= len("RuntimeError: ") + 160, len(text)

# log_diag: ponto único de saída — qualquer mensagem sai mascarada em stderr
buf = io.StringIO()
os.environ["GEMINI_API_KEY"] = "chave-sintetica-de-teste-9981"
try:
    with contextlib.redirect_stderr(buf):
        worker.log_diag(f"erro https://x/y?key={K} e chave-sintetica-de-teste-9981 fim")
finally:
    os.environ.pop("GEMINI_API_KEY", None)
logged = buf.getvalue()
assert logged.startswith("[worker] ") and "SEGREDO" not in logged and "9981" not in logged, logged
assert "fim" in logged

# CONTROLE POSITIVO do log_diag: um log_diag SEM redact vazaria (a mensagem original contém a chave)
assert "SEGREDO" in f"erro https://x/y?key={K}"

print("ok: test_redact")
