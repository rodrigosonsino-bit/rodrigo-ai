"""T2: política de arquivos sensíveis + leitura/escrita seguras (docs/plans/openjarvis-voz-desktop-v2.md §3.2,
docs/plans/t2-0-inventario-e-contrato-ipc.md).

Garantias projetadas (cada uma tem teste próprio em test_file_policy.py):
- a abertura é feita COMPONENTE A COMPONENTE com dir_fd e O_NOFOLLOW (camada 1);
- o arquivo JÁ ABERTO é classificado por nome (F_GETPATH) e por inode (st_dev, st_ino) (camada 2);
- a escrita classifica o DESTINO FINAL antes de criar o temporário, grava em temporário exclusivo e faz rename.

Os ganchos de teste só valem com RODRIGO_FILE_POLICY_TEST=1 (nunca configuráveis em produção).
"""
from __future__ import annotations

import errno
import fcntl
import fnmatch
import hashlib
import json
import os
import secrets
import stat
from typing import Any, Callable, Optional

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_MAX_INODE_WALK = 5000

# Ganchos SÓ de teste (ver docstring).
TEST_HOOKS: dict[str, Any] = {"between_components": None, "disable_nofollow": False, "disable_classify": False}


def _test_on() -> bool:
    return os.environ.get("RODRIGO_FILE_POLICY_TEST") == "1"


def _hook(name: str) -> Any:
    return TEST_HOOKS.get(name) if _test_on() else None


class PolicyError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _fd_path(fd: int) -> Optional[str]:
    """Caminho atual do descritor. macOS: F_GETPATH; Linux: /proc. Devolve None se não for possível."""
    try:
        if hasattr(fcntl, "F_GETPATH"):
            buf = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0" * 1024)
            return os.fsdecode(buf.split(b"\0", 1)[0])
        return os.readlink(f"/proc/self/fd/{fd}")
    except OSError:
        return None


class FilePolicy:
    def __init__(self, policy: dict, repo_root: str, roots: list[str], data_dir: Optional[str] = None) -> None:
        self.repo_root = os.path.realpath(repo_root)
        self.deny_globs: list[str] = list(policy.get("name_deny_globs", []))
        self.allow_names: list[str] = list(policy.get("name_allow", []))
        self.exclude_dirs: list[str] = list(policy.get("exclude_dirs_for_name_rules", []))
        deny: list[str] = []
        for rel in policy.get("deny_paths_in_repo", []):
            deny.append(os.path.realpath(os.path.join(self.repo_root, rel)))
        for p in policy.get("deny_paths_outside_repo", []):
            deny.append(os.path.realpath(os.path.expanduser(p)))
        if data_dir:
            deny.append(os.path.realpath(data_dir))
        self.deny_paths = deny
        # Raízes permitidas: o caminho pedido precisa começar por uma delas (como escrita, sem resolver); a raiz é
        # resolvida UMA vez aqui (código confiável) e o resto é percorrido sem seguir symlink.
        self.roots = [(os.path.abspath(r), os.path.realpath(r)) for r in roots]
        self.sensitive_inodes: set[tuple[int, int]] = set()
        self.reload_inodes()

    @classmethod
    def from_file(cls, policy_path: str, repo_root: str, roots: list[str], data_dir: Optional[str] = None) -> "FilePolicy":
        with open(policy_path, "r", encoding="utf-8") as f:
            return cls(json.load(f), repo_root, roots, data_dir)

    # --- classificação por nome/caminho resolvido ---
    def classify_path(self, real_path: str) -> str:
        p = os.path.realpath(real_path) if not os.path.islink(real_path) else real_path
        for d in self.deny_paths:
            if p == d or p.startswith(d.rstrip(os.sep) + os.sep):
                return "sensitive"
        base = os.path.basename(p)
        if base in self.allow_names:
            return "ordinary"
        rel = p
        if p.startswith(self.repo_root + os.sep):
            rel = p[len(self.repo_root) + 1:]
            if any(part in self.exclude_dirs for part in rel.split(os.sep)[:-1]):
                return "ordinary"
        for g in self.deny_globs:
            if fnmatch.fnmatch(base, g):
                return "sensitive"
        return "ordinary"

    # --- inodes dos sensíveis existentes (defesa contra hard link) ---
    def reload_inodes(self) -> None:
        found: set[tuple[int, int]] = set()
        budget = [_MAX_INODE_WALK]

        def add(path: str) -> None:
            try:
                st = os.lstat(path)
            except OSError:
                return
            if stat.S_ISREG(st.st_mode):
                found.add((st.st_dev, st.st_ino))

        def walk(top: str, name_rules: bool) -> None:
            stack = [top]
            while stack and budget[0] > 0:
                d = stack.pop()
                try:
                    it = list(os.scandir(d))
                except OSError:
                    continue
                for e in it:
                    budget[0] -= 1
                    if budget[0] <= 0:
                        return
                    try:
                        if e.is_dir(follow_symlinks=False):
                            if name_rules and e.name in self.exclude_dirs:
                                continue
                            stack.append(e.path)
                        elif e.is_file(follow_symlinks=False):
                            if name_rules:
                                if self.classify_path(e.path) == "sensitive":
                                    add(e.path)
                            else:
                                add(e.path)
                    except OSError:
                        continue

        walk(self.repo_root, True)
        for _given, real in self.roots:  # outras raízes permitidas: um .env lá também ganha a defesa por inode
            if real != self.repo_root:
                walk(real, True)
        for d in self.deny_paths:
            if os.path.isdir(d):
                walk(d, False)
            elif os.path.exists(d):
                add(d)
        self.sensitive_inodes = found

    # --- abertura componente a componente ---
    def _resolve_root(self, path: str) -> tuple[str, list[str]]:
        if not os.path.isabs(path) or "\0" in path:
            raise PolicyError("bad_request")
        norm = os.path.normpath(path)
        for given, real in self.roots:
            if norm == given or norm.startswith(given.rstrip(os.sep) + os.sep):
                rel = os.path.relpath(norm, given)
                if rel == ".":
                    raise PolicyError("bad_request")
                parts = rel.split(os.sep)
                if any(p in ("", "..") for p in parts):
                    raise PolicyError("bad_request")
                return real, parts
        raise PolicyError("bad_request")

    def _nofollow_flag(self) -> int:
        return 0 if (_test_on() and TEST_HOOKS.get("disable_nofollow")) else _NOFOLLOW

    def _open_parent(self, root_real: str, parts: list[str]) -> int:
        fd = os.open(root_real, os.O_RDONLY | _DIRECTORY)
        try:
            for part in parts[:-1]:
                h = _hook("between_components")
                if h:
                    h(fd, part)
                try:
                    nfd = os.open(part, os.O_RDONLY | _DIRECTORY | self._nofollow_flag(), dir_fd=fd)
                except OSError as e:
                    raise PolicyError(self._reason_for(e, fd, part)) from e
                os.close(fd)
                fd = nfd
            return fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def _reason_for(e: OSError, dir_fd: int, name: str) -> str:
        try:
            if stat.S_ISLNK(os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode):
                return "symlink"
        except OSError:
            pass
        if e.errno in (errno.ELOOP,):
            return "symlink"
        if e.errno in (errno.ENOENT, errno.ENOTDIR):
            return "not_found"
        return "io_error"

    def _classify_fd(self, fd: int, st: os.stat_result, fallback_path: str) -> str:
        if _test_on() and TEST_HOOKS.get("disable_classify"):
            return "ordinary"
        if (st.st_dev, st.st_ino) in self.sensitive_inodes:
            return "sensitive"
        p = _fd_path(fd) or fallback_path
        return self.classify_path(p)

    # --- API ---
    def read(self, path: str, max_bytes: int = 1_048_576) -> dict:
        try:
            root_real, parts = self._resolve_root(path)
            parent = self._open_parent(root_real, parts)
        except PolicyError as e:
            return {"ok": False, "reason": e.reason}
        except OSError:
            return {"ok": False, "reason": "io_error"}
        try:
            h = _hook("between_components")
            if h:
                h(parent, parts[-1])
            try:
                fd = os.open(parts[-1], os.O_RDONLY | self._nofollow_flag(), dir_fd=parent)
            except OSError as e:
                return {"ok": False, "reason": self._reason_for(e, parent, parts[-1])}
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    return {"ok": False, "reason": "bad_request"}
                cls = self._classify_fd(fd, st, os.path.join(root_real, *parts))
                if cls == "sensitive":
                    return {"ok": False, "reason": "sensitive"}
                data = b""
                while len(data) <= max_bytes:
                    chunk = os.read(fd, min(65536, max_bytes + 1 - len(data)))
                    if not chunk:
                        break
                    data += chunk
                if len(data) > max_bytes:
                    return {"ok": False, "reason": "too_large"}
                return {"ok": True, "data": data, "size": len(data), "class": cls}
            finally:
                os.close(fd)
        except OSError:
            return {"ok": False, "reason": "io_error"}
        finally:
            os.close(parent)

    def check_readable(self, path: str) -> dict:
        """Abre, classifica e fecha SEM ler o conteúdo (para dependências que abrem o arquivo por conta própria, como
        o mlx_whisper). Janela residual declarada: entre esta checagem e a abertura da dependência."""
        return self._probe(path)

    def _probe(self, path: str) -> dict:
        try:
            root_real, parts = self._resolve_root(path)
            parent = self._open_parent(root_real, parts)
        except PolicyError as e:
            return {"ok": False, "reason": e.reason}
        except OSError:
            return {"ok": False, "reason": "io_error"}
        try:
            try:
                fd = os.open(parts[-1], os.O_RDONLY | self._nofollow_flag(), dir_fd=parent)
            except OSError as e:
                return {"ok": False, "reason": self._reason_for(e, parent, parts[-1])}
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    return {"ok": False, "reason": "bad_request"}
                cls = self._classify_fd(fd, st, os.path.join(root_real, *parts))
                return {"ok": cls != "sensitive", "reason": None if cls != "sensitive" else "sensitive", "class": cls}
            finally:
                os.close(fd)
        finally:
            os.close(parent)

    def check_writable(self, path: str) -> dict:
        """Classifica o destino final de uma escrita feita por quem já grava de forma atômica (ex.: WAV do TTS)."""
        try:
            root_real, parts = self._resolve_root(path)
            parent = self._open_parent(root_real, parts)
        except PolicyError as e:
            return {"ok": False, "reason": e.reason}
        except OSError:
            return {"ok": False, "reason": "io_error"}
        try:
            return self._dest_verdict(parent, parts[-1], root_real, parts)
        finally:
            os.close(parent)

    def _dest_verdict(self, parent: int, name: str, root_real: str, parts: list[str]) -> dict:
        parent_path = _fd_path(parent) or os.path.join(root_real, *parts[:-1])
        if self.classify_path(os.path.join(parent_path, name)) == "sensitive":
            return {"ok": False, "reason": "sensitive"}
        try:
            st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return {"ok": True, "reason": None}
        except OSError:
            return {"ok": False, "reason": "io_error"}
        if stat.S_ISLNK(st.st_mode):
            return {"ok": False, "reason": "symlink"}
        if (st.st_dev, st.st_ino) in self.sensitive_inodes:
            return {"ok": False, "reason": "sensitive"}
        return {"ok": True, "reason": None}

    def write(self, path: str, data: bytes, max_bytes: int = 262_144) -> dict:
        if len(data) > max_bytes:
            return {"ok": False, "reason": "too_large"}
        try:
            root_real, parts = self._resolve_root(path)
            parent = self._open_parent(root_real, parts)
        except PolicyError as e:
            return {"ok": False, "reason": e.reason}
        except OSError:
            return {"ok": False, "reason": "io_error"}
        tmp = None
        try:
            # Classifica o destino FINAL antes de criar qualquer coisa (o descritor do temporário não revela o destino).
            v = self._dest_verdict(parent, parts[-1], root_real, parts)
            if not v["ok"]:
                return {"ok": False, "reason": v["reason"]}
            tmp = f".{parts[-1]}.{secrets.token_hex(6)}.tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=parent)
            try:
                view = memoryview(data)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
            # Reconfere imediatamente antes do rename (symlink plantado depois da primeira checagem).
            v2 = self._dest_verdict(parent, parts[-1], root_real, parts)
            if not v2["ok"]:
                os.unlink(tmp, dir_fd=parent)
                tmp = None
                return {"ok": False, "reason": v2["reason"]}
            os.rename(tmp, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
            tmp = None
            return {"ok": True, "bytes_written": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        except OSError:
            return {"ok": False, "reason": "io_error"}
        finally:
            if tmp is not None:
                try:
                    os.unlink(tmp, dir_fd=parent)
                except OSError:
                    pass
            os.close(parent)
