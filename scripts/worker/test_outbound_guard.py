"""T1: o guarda de saída do worker (Python) dá EXATAMENTE o mesmo resultado que a referência em TypeScript nos casos
compartilhados, e aplica os modos. Rodar: .runtime/.venv/bin/python3 scripts/worker/test_outbound_guard.py"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import outbound_guard as g  # noqa: E402

root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
with open(os.path.join(root, "src", "backend", "__tests__", "fixtures", "outbound-cases.json"), encoding="utf-8") as f:
    cases = json.load(f)["cases"]
assert len(cases) >= 20, "fixture compartilhada com poucos casos"

# 1) paridade com a referência TypeScript (modo redact)
fails = 0
for c in cases:
    out, findings, blocked = g.guard_text(c["text"], "redact")
    kinds = [x.kind for x in findings]
    if out != c["redacted"] or kinds != c["kinds"] or blocked:
        fails += 1
        print("DIVERGÊNCIA:", repr(c["text"])[:70], "->", repr(out)[:70], kinds, "esperado", repr(c["redacted"])[:70], c["kinds"])
assert fails == 0, f"{fails} divergência(s) entre Python e TypeScript"

# 2) modos
texto = "meu cpf é 529.982.247-25 e a chave AIzaSyD" + "x" * 32
assert g.guard_text(texto, "off") == (texto, [], False)
t, fs, b = g.guard_text(texto, "warn"); assert t == texto and len(fs) == 2 and b is False
t, fs, b = g.guard_text(texto, "block"); assert b is True and len(fs) == 2
t, fs, b = g.guard_text(texto, "redact"); assert "529.982.247-25" not in t and "[cpf omitido]" in t and b is False

# 3) mensagens: redact mascara todas; block lança citando só os TIPOS; off devolve igual (controle positivo)
msgs = [{"role": "system", "content": "memória: chave AIzaSyD" + "x" * 32}, {"role": "user", "content": "cpf 529.982.247-25"}, {"role": "assistant", "content": "anotado"}]
red = g.guard_messages(msgs, "redact")
blob = json.dumps(red, ensure_ascii=False)
assert "529.982.247-25" not in blob and "AIzaSyD" not in blob and red[2]["content"] == "anotado"
assert "AIzaSyD" in json.dumps(g.guard_messages(msgs, "off")), "controle positivo: com off o segredo SAI"
try:
    g.guard_messages(msgs, "block")
    raise AssertionError("block deveria lançar")
except g.OutboundBlocked as e:
    assert sorted(e.kinds) == ["api-key", "cpf"] and "529.982" not in str(e) and "AIzaSyD" not in str(e)

# 4) modo vem do ambiente; desconhecido => redact
os.environ["RODRIGO_OUTBOUND_GUARD"] = "block"; assert g.current_mode() == "block"
os.environ["RODRIGO_OUTBOUND_GUARD"] = "xyz"; assert g.current_mode() == "redact"
os.environ.pop("RODRIGO_OUTBOUND_GUARD"); assert g.current_mode() == "redact"

print(f"ok: test_outbound_guard ({len(cases)} casos de paridade)")
