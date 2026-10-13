import os, sys, fcntl, errno, tempfile, shutil, json, random, string

base = tempfile.mkdtemp(prefix="t2exp-")
DATA = os.path.join(base, "data", "dir"); SECRETD = os.path.join(base, "secret")
os.makedirs(DATA); os.makedirs(SECRETD)
SECRET = os.path.join(SECRETD, ".env"); NOTE = os.path.join(DATA, "note.txt")
def reset():
    for p in (NOTE, os.path.join(DATA, "link.txt")):
        try: os.unlink(p)
        except FileNotFoundError: pass
    if os.path.islink(DATA):
        os.unlink(DATA); os.makedirs(DATA)
    open(NOTE,"w").write("NOTA COMUM\n"); open(SECRET,"w").write("SEGREDO-FALSO\n")
reset()
sst = os.stat(SECRET); DENY = {(sst.st_dev, sst.st_ino)}
def sensitive(fd):
    p = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0"*1024).split(b"\0")[0].decode()
    st = os.fstat(fd)
    return (p.startswith(os.path.realpath(SECRETD)) or ".env" in os.path.basename(p), (st.st_dev, st.st_ino) in DENY, p)

def open_safe(parts, hook=None, nofollow=True, classify_name=True, classify_inode=True):
    fd = os.open(base, os.O_RDONLY|os.O_DIRECTORY); out = {"bytes":0,"err":None,"path":None}
    try:
        for i, part in enumerate(parts):
            if hook: hook(i, part)
            fl = os.O_RDONLY | (os.O_NOFOLLOW if nofollow else 0) | (os.O_DIRECTORY if i < len(parts)-1 else 0)
            nfd = os.open(part, fl, dir_fd=fd); os.close(fd); fd = nfd
        by_name, by_ino, p = sensitive(fd); out["path"] = p
        if (classify_name and by_name) or (classify_inode and by_ino):
            out["err"] = "RECUSADO pela classificação"; return out
        out["bytes"] = len(os.read(fd, 100))
    except OSError as e:
        out["err"] = errno.errorcode.get(e.errno, str(e.errno))
    finally:
        try: os.close(fd)
        except OSError: pass
    return out

def swap_last(i, part):               # troca determinística ENTRE aberturas de componente
    if part == "note.txt": os.unlink(NOTE); os.symlink(SECRET, NOTE)
def swap_dir(i, part):
    if part == "dir" and not os.path.islink(DATA):
        shutil.rmtree(DATA); os.symlink(SECRETD, DATA)
P = ["data","dir","note.txt"]
print("=== (a) TOCTOU: abertura por componente com dir_fd + O_NOFOLLOW ===")
reset(); print("controle (sem troca)           :", open_safe(P))
reset(); print("troca do ARQUIVO por symlink   :", open_safe(P, swap_last))
reset(); print("troca do DIRETÓRIO PAI symlink :", open_safe(P, swap_dir))
print("--- mutações (uma barreira por vez) ---")
reset(); print("M1 sem O_NOFOLLOW, com classif.:", open_safe(P, swap_last, nofollow=False))
reset(); print("M2 com O_NOFOLLOW, sem classif.:", open_safe(P, swap_last, classify_name=False, classify_inode=False))
reset(); print("M3 sem O_NOFOLLOW E sem classif:", open_safe(P, swap_last, nofollow=False, classify_name=False, classify_inode=False))
print("--- controle positivo: check-then-open (realpath e depois open do caminho) ---")
reset()
def check_then_open(path, hook):
    real = os.path.realpath(path); ok = not real.startswith(os.path.realpath(SECRETD))
    hook()                                   # a troca cai exatamente entre checar e abrir
    if not ok: return "recusado"
    with open(path) as f: return "LEU: " + f.read(40).strip()
print("check-then-open                :", check_then_open(NOTE, lambda: (os.unlink(NOTE), os.symlink(SECRET, NOTE))))
print("--- hard link (nome inofensivo, mesmo inode do arquivo sensível) ---")
reset(); L = os.path.join(DATA, "link.txt"); os.link(SECRET, L)
print("hard link, com lista de inodes :", open_safe(["data","dir","link.txt"]))
print("hard link, SEM lista de inodes :", open_safe(["data","dir","link.txt"], classify_inode=False))
fd = os.open(L, os.O_RDONLY); print("F_GETPATH do hard link         :", os.path.basename(fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0"*1024).split(b"\0")[0].decode()), "(o nome do link, não do original)"); os.close(fd)

print("\n=== (b) MODO DE ESCRITA: tmp O_CREAT|O_EXCL|O_NOFOLLOW + rename ===")
def naive_write(path, data): open(path, "w").write(data)
def safe_write(dirpath, name, data):
    dfd = os.open(dirpath, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    tmp = ".tmp-" + "".join(random.choices(string.ascii_lowercase, k=8))
    fd = os.open(tmp, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=dfd)
    os.write(fd, data.encode()); os.fsync(fd); os.close(fd)
    os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd); os.close(dfd)
reset(); os.unlink(NOTE); os.symlink(SECRET, NOTE)
naive_write(NOTE, "SOBRESCRITO\n"); print("escrita ingênua por symlink     : segredo agora =", repr(open(SECRET).read()))
reset(); os.unlink(NOTE); os.symlink(SECRET, NOTE)
safe_write(DATA, "note.txt", "DADO NOVO\n")
print("escrita segura sobre symlink    : segredo =", repr(open(SECRET).read()), "| note.txt é symlink?", os.path.islink(NOTE), "| conteúdo =", repr(open(NOTE).read()))
reset(); os.rename(DATA, DATA+"_real"); os.symlink(SECRETD, DATA)
try: safe_write(DATA, "x.txt", "y"); print("diretório pai symlink           : ESCREVEU (falha!)")
except OSError as e: print("diretório pai é symlink         : recusado,", errno.errorcode[e.errno])
print("arquivos no dir secreto depois  :", sorted(os.listdir(SECRETD)))
shutil.rmtree(base)
