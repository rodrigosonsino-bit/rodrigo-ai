"""v2.6: variante escolhida para o destino que é symlink: RECUSAR (e registrar), em vez de substituí-lo em silêncio.
O rename continua não seguindo o symlink: defesa de fundo contra a corrida entre o lstat e o rename."""
import os, stat, errno, tempfile, shutil, random, string
base = tempfile.mkdtemp(prefix="t2c-"); data = os.path.join(base, "data"); sec = os.path.join(base, "sec"); os.makedirs(data); os.makedirs(sec)
SEC = os.path.join(sec, ".env"); NOTE = os.path.join(data, "note.txt"); open(SEC, "w").write("SEGREDO-FALSO\n")
def safe_write_recusa(dirpath, name, texto, hook=None):
    dfd = os.open(dirpath, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            if stat.S_ISLNK(os.lstat(name, dir_fd=dfd).st_mode): return "RECUSADO (destino é symlink)"
        except FileNotFoundError: pass
        if hook: hook()                                        # troca determinística entre o lstat e o rename
        tmp = ".tmp-" + "".join(random.choices(string.ascii_lowercase, k=8))
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        os.write(fd, texto.encode()); os.fsync(fd); os.close(fd)
        os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd); return "escrito"
    finally: os.close(dfd)
os.symlink(SEC, NOTE)
print("destino já é symlink            :", safe_write_recusa(data, "note.txt", "NOVO\n"), "| segredo:", repr(open(SEC).read()), "| ainda symlink:", os.path.islink(NOTE))
os.unlink(NOTE); open(NOTE, "w").write("velho\n")
r = safe_write_recusa(data, "note.txt", "NOVO\n", hook=lambda: (os.unlink(NOTE), os.symlink(SEC, NOTE)))
print("symlink plantado entre lstat e rename:", r, "| segredo:", repr(open(SEC).read()), "| note.txt agora é symlink?", os.path.islink(NOTE), "| conteúdo:", repr(open(NOTE).read()))
shutil.rmtree(base)
