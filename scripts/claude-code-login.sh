#!/bin/sh
# Fase 17 (A1 do Code): o Claude delegado NÃO usa o ~/.claude do usuário. Ele tem configuração e login PRÓPRIOS em
# .runtime/claude-home. Rode isto UMA vez, abra o Claude e digite /login (depois /exit).
set -eu
cd "$(dirname "$0")/.."
DIR="$(pwd)/.runtime/claude-home"
mkdir -p "$DIR" && chmod 700 "$DIR"
echo "Configuração própria do Claude delegado: $DIR"
echo "Faça /login quando o Claude abrir; depois /exit."
CLAUDE_CONFIG_DIR="$DIR" exec claude
