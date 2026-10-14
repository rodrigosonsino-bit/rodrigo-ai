"""T2: os comandos file_read/file_write do worker real, pelo protocolo NDJSON de stdio (sem carregar modelos).
Rodar: .runtime/.venv/bin/python3 scripts/worker/test_worker_file_ipc.py"""
import base64, json, os, subprocess, sys, tempfile, time

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.dirname(os.path.dirname(here))
tmp = os.path.realpath(tempfile.mkdtemp(prefix="wipc-"))
open(os.path.join(tmp, "ok.txt"), "wb").write(b"conteudo")
open(os.path.join(tmp, ".env"), "wb").write(b"SEGREDO-FALSO")

env = dict(os.environ, RODRIGO_FILE_ROOTS=tmp)
# Importa só as funções puras do worker (sem Worker()/modelos): roda um mini-servidor que usa os handlers reais.
code = r'''
import sys, json, threading
sys.path.insert(0, %r)
import worker as w
class Stub(w.Worker if False else object): pass
wk = w.Worker.__new__(w.Worker)
wk._file_pool = w.SynthPool(2)
for line in sys.stdin:
    m = json.loads(line)
    (wk._file_pool.submit(wk.handle_file_read, m) if m["cmd"] == "file_read" else wk._file_pool.submit(wk.handle_file_write, m))
import time; time.sleep(1.0)
''' % here
p = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
def send(m): p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
send({"cmd": "file_read", "reqId": "a", "path": f"{tmp}/ok.txt"})
send({"cmd": "file_read", "reqId": "b", "path": f"{tmp}/.env"})
send({"cmd": "file_read", "reqId": "c", "path": "/etc/hosts"})
send({"cmd": "file_write", "reqId": "d", "path": f"{tmp}/novo.txt", "dataB64": base64.b64encode(b"dados").decode()})
send({"cmd": "file_write", "reqId": "e", "path": f"{tmp}/.env", "dataB64": base64.b64encode(b"X").decode()})
send({"cmd": "file_write", "reqId": "f", "path": f"{tmp}/z.txt", "dataB64": "@@@nao-base64"})
send({"cmd": "file_read", "reqId": 7, "path": f"{tmp}/ok.txt"})
p.stdin.close()
out = {}
for line in p.stdout:
    try: ev = json.loads(line)
    except Exception: continue
    if ev.get("event") == "file_result": out[ev["reqId"]] = ev
p.wait(timeout=10)
assert out["a"]["ok"] and base64.b64decode(out["a"]["bytes_b64"]) == b"conteudo", out["a"]
assert out["b"] == {"event": "file_result", "reqId": "b", "ok": False, "reason": "sensitive"}, out["b"]
assert out["c"]["reason"] == "bad_request", out["c"]  # fora das raízes
assert out["d"]["ok"] and open(f"{tmp}/novo.txt", "rb").read() == b"dados"
assert out["e"]["reason"] == "sensitive" and open(f"{tmp}/.env", "rb").read() == b"SEGREDO-FALSO"
assert out["f"]["reason"] == "bad_request"
assert out[7]["reason"] == "bad_request"
for k, v in out.items():
    assert "SEGREDO" not in json.dumps(v), "o conteúdo sensível nunca aparece na resposta"
print("ok: test_worker_file_ipc")
