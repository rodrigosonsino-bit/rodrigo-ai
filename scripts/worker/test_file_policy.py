"""T2: política de arquivos sensíveis. Rodar: .runtime/.venv/bin/python3 scripts/worker/test_file_policy.py
Cada barreira tem teste próprio; as duas camadas de abertura (O_NOFOLLOW e classificação do descritor) são exercidas
UMA DE CADA VEZ pelos ganchos de teste e, juntas desligadas, o teste tem de VAZAR (prova de mutação)."""
import os
import sys
import tempfile

os.environ["RODRIGO_FILE_POLICY_TEST"] = "1"
sys.path.insert(0, os.path.dirname(__file__))
import file_policy as fp  # noqa: E402

SECRET = b"SEGREDO-FALSO-123"
tmp = os.path.realpath(tempfile.mkdtemp(prefix="fpol-"))
repo = os.path.join(tmp, "repo")
os.makedirs(os.path.join(repo, "sub"))
os.makedirs(os.path.join(repo, "data"))
os.makedirs(os.path.join(repo, ".runtime"))
def w(p, b=b"x"):
    with open(p, "wb") as f: f.write(b)
w(os.path.join(repo, ".env"), SECRET)
w(os.path.join(repo, ".env.example"), b"EXEMPLO=1")
w(os.path.join(repo, "sub", "ok.txt"), b"ola")
w(os.path.join(repo, "data", "notas.json"), b"{}")
w(os.path.join(repo, ".runtime", "cacert.pem"), b"publico")
w(os.path.join(repo, "sub", "chave.pem"), SECRET)

policy = {"name_deny_globs": [".env", ".env.*", "*.pem", "credentials.json"], "name_allow": [".env.example"],
          "exclude_dirs_for_name_rules": [".runtime"], "deny_paths_in_repo": ["data"], "deny_paths_outside_repo": []}
P = fp.FilePolicy(policy, repo, [repo])
def reset_hooks():
    fp.TEST_HOOKS.update(between_components=None, disable_nofollow=False, disable_classify=False)

# 1) classificação por nome, com exclusões
assert P.read(f"{repo}/sub/ok.txt")["data"] == b"ola"
assert P.read(f"{repo}/.env")["reason"] == "sensitive"
assert P.read(f"{repo}/sub/chave.pem")["reason"] == "sensitive"
assert P.read(f"{repo}/.env.example")["ok"], ".env.example é exceção declarada"
assert P.read(f"{repo}/.runtime/cacert.pem")["ok"], ".runtime/** fica fora das regras de nome"
assert P.read(f"{repo}/data/notas.json")["reason"] == "sensitive", "pasta de dados inteira é sensível"

# 2) entradas inválidas e raízes
assert P.read("relativo/x")["reason"] == "bad_request"
assert P.read(f"{tmp}/fora.txt")["reason"] == "bad_request", "fora das raízes permitidas"
assert P.read(f"{repo}/sub/../.env")["reason"] in ("bad_request", "sensitive")
assert P.read(f"{repo}/nao-existe.txt")["reason"] == "not_found"
assert P.read(f"{repo}/sub/ok.txt", max_bytes=1)["reason"] == "too_large"

# 3) symlink final para .env: recusa (camada 1) e não lê
os.symlink(f"{repo}/.env", f"{repo}/sub/link-env.txt")
r = P.read(f"{repo}/sub/link-env.txt"); assert not r["ok"] and r["reason"] == "symlink", r

# 4) hard link com nome inofensivo: só o inode pega
os.link(f"{repo}/.env", f"{repo}/sub/inofensivo.txt")
P.reload_inodes()
r = P.read(f"{repo}/sub/inofensivo.txt"); assert not r["ok"] and r["reason"] == "sensitive", r

# 5) camadas independentes: cada uma sozinha ainda recusa; as duas desligadas VAZAM (prova de mutação)
fp.TEST_HOOKS["disable_classify"] = True
r = P.read(f"{repo}/sub/link-env.txt"); assert r["reason"] == "symlink", "camada 1 sozinha recusa (ELOOP)"
reset_hooks()
fp.TEST_HOOKS["disable_nofollow"] = True
r = P.read(f"{repo}/sub/link-env.txt"); assert r["reason"] == "sensitive", "camada 2 sozinha recusa pelo nome do alvo"
fp.TEST_HOOKS["disable_classify"] = True
r = P.read(f"{repo}/sub/link-env.txt"); assert r["ok"] and r["data"] == SECRET, "com as DUAS camadas desligadas o teste tem de vazar"
reset_hooks()

# 6) TOCTOU: troca do diretório pai por symlink entre a abertura de um componente e a do seguinte
os.makedirs(f"{repo}/sub/pai/filho"); w(f"{repo}/sub/pai/filho/x.txt", b"comum")
os.makedirs(f"{repo}/alvo"); w(f"{repo}/alvo/x.txt", SECRET)
def swap_parent(fd, part):
    if part == "filho":
        os.rename(f"{repo}/sub/pai/filho", f"{repo}/sub/pai/filho-velho")
        os.symlink(f"{repo}/alvo", f"{repo}/sub/pai/filho")
fp.TEST_HOOKS["between_components"] = swap_parent
r = P.read(f"{repo}/sub/pai/filho/x.txt")
assert not r["ok"] and r.get("data") is None and r["reason"] in ("symlink", "not_found"), r
reset_hooks()
os.unlink(f"{repo}/sub/pai/filho"); os.rename(f"{repo}/sub/pai/filho-velho", f"{repo}/sub/pai/filho")
# controle positivo (fixture só do teste): check-then-open ingênuo LÊ o segredo sob a mesma troca
def naive_read(path):
    if os.path.basename(os.path.dirname(path)) and "alvo" in os.path.realpath(path): return None
    swap_parent(0, "filho")
    with open(path, "rb") as f: return f.read()
got = naive_read(f"{repo}/sub/pai/filho/x.txt")
assert got == SECRET, "o harness precisa ENXERGAR a corrida (controle positivo)"
os.unlink(f"{repo}/sub/pai/filho"); os.rename(f"{repo}/sub/pai/filho-velho", f"{repo}/sub/pai/filho")

# 7) escrita
r = P.write(f"{repo}/sub/novo.txt", b"dados")
assert r["ok"] and r["bytes_written"] == 5 and open(f"{repo}/sub/novo.txt", "rb").read() == b"dados"
import hashlib; assert r["sha256"] == hashlib.sha256(b"dados").hexdigest()
assert P.write(f"{repo}/sub/novo.txt", b"v2")["ok"] and open(f"{repo}/sub/novo.txt", "rb").read() == b"v2"
assert not [n for n in os.listdir(f"{repo}/sub") if n.endswith(".tmp")], "nenhum temporário deixado"
r = P.write(f"{repo}/sub/grande.txt", b"x" * 300000); assert r["reason"] == "too_large"
# destino final sensível que NÃO existe: o nome decide, nenhum arquivo é criado
r = P.write(f"{repo}/sub/.env", b"novo"); assert r["reason"] == "sensitive" and not os.path.exists(f"{repo}/sub/.env")
r = P.write(f"{repo}/sub/novo.pem", b"k"); assert r["reason"] == "sensitive" and not os.path.exists(f"{repo}/sub/novo.pem")
# destino que é symlink para o .env: recusa e NÃO trunca o segredo
r = P.write(f"{repo}/sub/link-env.txt", b"X"); assert r["reason"] == "symlink"
assert open(f"{repo}/.env", "rb").read() == SECRET, "o alvo do symlink não pode ser truncado"
# destino existente cujo inode é sensível (hard link): recusa
r = P.write(f"{repo}/sub/inofensivo.txt", b"X"); assert r["reason"] == "sensitive"
assert open(f"{repo}/.env", "rb").read() == SECRET
# diretório pai que é symlink: recusa
os.symlink(f"{repo}/alvo", f"{repo}/sub/pai-link")
r = P.write(f"{repo}/sub/pai-link/y.txt", b"X"); assert r["reason"] == "symlink" and not os.path.exists(f"{repo}/alvo/y.txt")
# pasta de dados
assert P.write(f"{repo}/data/nota.json", b"{}")["reason"] == "sensitive"

# 8) check_readable / check_writable (para dependências que abrem sozinhas)
assert P.check_readable(f"{repo}/sub/ok.txt")["ok"]
assert not P.check_readable(f"{repo}/.env")["ok"]
assert not P.check_readable(f"{repo}/sub/link-env.txt")["ok"]
assert P.check_writable(f"{repo}/sub/saida.wav")["ok"]
assert P.check_writable(f"{repo}/sub/.env")["reason"] == "sensitive"

# 9) raiz extra (fora do repositório): hard link para .env lá também é pego pelo inode
extra = os.path.join(tmp, "extra"); os.makedirs(extra)
w(os.path.join(extra, ".env"), SECRET); os.link(os.path.join(extra, ".env"), os.path.join(extra, "inofensivo.txt"))
P2 = fp.FilePolicy(policy, repo, [repo, extra])
assert P2.read(os.path.join(extra, "inofensivo.txt"))["reason"] == "sensitive"
assert P2.write(os.path.join(extra, "inofensivo.txt"), b"X")["reason"] == "sensitive"
assert open(os.path.join(extra, ".env"), "rb").read() == SECRET

# 10) auditoria do Codex, achado 3: o macOS é case-insensitive; variantes de caixa/Unicode dos nomes sensíveis são sensíveis
for nome in [".ENV", ".Env", "CREDENTIALS.JSON", "Chave.PEM"]:
    pth = os.path.join(repo, "sub", nome)
    w(pth, SECRET)
    assert P.read(pth)["reason"] == "sensitive", nome
    os.makedirs(os.path.join(repo, "sub", "n"), exist_ok=True)
    assert P.write(os.path.join(repo, "sub", "n", nome), b"X")["reason"] == "sensitive", "escrita " + nome
    assert not os.path.exists(os.path.join(repo, "sub", "n", nome)), "destino sensível inexistente não é criado"
w(os.path.join(repo, ".ENV.EXAMPLE"), b"ok"); assert P.read(os.path.join(repo, ".ENV.EXAMPLE"))["ok"], "a exceção .env.example também vale em outra caixa"
w(os.path.join(repo, "DATA", "x.json") if os.makedirs(os.path.join(repo, "DATA"), exist_ok=True) is None else "", b"{}")
assert P.read(os.path.join(repo, "DATA", "x.json"))["reason"] == "sensitive", "pasta de dados em outra caixa"

# 11) achado 1: hard link criado DEPOIS da carga (o inventário de inodes ficou velho) é pego pela re-varredura sob demanda
novo = os.path.join(repo, "sub", ".env.tarde"); w(novo, SECRET)   # sensível criado depois da carga
os.link(novo, os.path.join(repo, "sub", "tardio.txt"))
r = P.read(os.path.join(repo, "sub", "tardio.txt")); assert r["reason"] == "sensitive", r
# ... e se a varredura estourou o limite, a recusa é a resposta (falha fechada): nlink>1 não comprovável => sensível
old = fp._MAX_INODE_WALK; fp._MAX_INODE_WALK = 1
try:
    P3 = fp.FilePolicy(policy, repo, [repo])
    assert P3.inode_scan_truncated
    outro = os.path.join(repo, "sub", "comum.txt"); w(outro, b"x"); os.link(outro, os.path.join(repo, "sub", "comum-link.txt"))
    assert P3.read(os.path.join(repo, "sub", "comum-link.txt"))["reason"] == "sensitive", "varredura truncada + hard link => recusa"
    assert P3.read(os.path.join(repo, "sub", "ok.txt"))["ok"], "arquivo com um nome só segue lido normalmente"
finally:
    fp._MAX_INODE_WALK = old

print("ok: test_file_policy")
