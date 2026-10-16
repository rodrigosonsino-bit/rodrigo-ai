#!/usr/bin/env python3
"""
Digita texto onde o cursor estiver focado no macOS, via AppleScript (System Events).

O texto vai para o osascript como argumento (`on run argv`), nunca interpolado no código
AppleScript: aspas, barras e quebras de linha no texto não viram código.

Dois modos:
- "colar" (padrão): põe o texto na área de transferência, manda ⌘V e devolve o conteúdo
  anterior da área de transferência (só texto; imagem/arquivo copiados se perdem). É o modo
  confiável para acentos e emoji — `keystroke` depende do layout de teclado e erra com "ç", "ã" etc.
- "teclar": `keystroke` caractere a caractere. Não mexe na área de transferência; bom para
  ASCII em campos que bloqueiam colar.

Requer permissão de Acessibilidade para o processo que chama (Terminal, app, node...):
Ajustes do Sistema > Privacidade e Segurança > Acessibilidade.

Uso: python3 scripts/digitar_texto.py "olá, mundo"   (ou texto por stdin)
     python3 scripts/digitar_texto.py --modo teclar --atraso 2 "texto"
"""
import argparse
import subprocess
import sys
import time

_SCRIPT_TECLAR = """
on run argv
    tell application "System Events" to keystroke (item 1 of argv)
end run
"""

_SCRIPT_COLAR = """
on run argv
    set novo to item 1 of argv
    set antigo to missing value
    try
        set antigo to the clipboard as text
    end try
    set the clipboard to novo
    delay 0.05
    tell application "System Events" to keystroke "v" using {command down}
    delay 0.2
    if antigo is not missing value then set the clipboard to antigo
end run
"""


class ErroDigitacao(RuntimeError):
    pass


def digitar_texto(texto: str, modo: str = "colar", atraso: float = 0.0, timeout: float = 15.0) -> None:
    """Digita `texto` no elemento com foco. Levanta ErroDigitacao se o osascript falhar."""
    if not isinstance(texto, str) or texto == "":
        raise ValueError("texto vazio")
    if modo not in ("colar", "teclar"):
        raise ValueError(f"modo inválido: {modo!r} (use 'colar' ou 'teclar')")
    if atraso > 0:
        time.sleep(atraso)  # tempo para o usuário pôr o foco no campo certo

    script = _SCRIPT_COLAR if modo == "colar" else _SCRIPT_TECLAR
    try:
        resultado = subprocess.run(
            ["/usr/bin/osascript", "-e", script, "--", texto],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise ErroDigitacao(f"osascript passou de {timeout}s") from exc

    if resultado.returncode != 0:
        erro = resultado.stderr.strip()
        # -1719 / -25211 / "not allowed assistive access" = falta permissão de Acessibilidade
        if "1719" in erro or "25211" in erro or "assistive" in erro.lower():
            raise ErroDigitacao(
                "sem permissão de Acessibilidade: libere o app que roda este script em "
                "Ajustes do Sistema > Privacidade e Segurança > Acessibilidade"
            )
        raise ErroDigitacao(erro or f"osascript saiu com código {resultado.returncode}")


def main() -> int:
    p = argparse.ArgumentParser(description="Digita texto onde o cursor estiver focado (macOS).")
    p.add_argument("texto", nargs="?", help="texto a digitar (sem ele, lê do stdin)")
    p.add_argument("--modo", choices=("colar", "teclar"), default="colar")
    p.add_argument("--atraso", type=float, default=0.0, help="segundos de espera antes de digitar")
    a = p.parse_args()

    texto = a.texto if a.texto is not None else sys.stdin.read().rstrip("\n")
    try:
        digitar_texto(texto, modo=a.modo, atraso=a.atraso)
    except (ValueError, ErroDigitacao) as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
