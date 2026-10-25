#!/bin/sh
# Fase 17 / A3: cria o worktree de ESCRITA (.runtime/claude-write), separado do de leitura, a partir de origin/main.
# O modo escrita (desligado por padrão) só grava aqui e não enxerga .runtime/claude-readonly. Nada daqui vai para o
# repositório sozinho: revise e traga as mudanças à mão.
set -eu
cd "$(dirname "$0")/.."
DEST=".runtime/claude-write"
if [ -e "$DEST" ]; then
  echo "Já existe: $DEST"
  exit 0
fi
git fetch -q origin main
git worktree add --detach "$DEST" origin/main
if [ -e "$DEST/docs/research" ]; then
  echo "ERRO: $DEST/docs/research existe; removendo o worktree."
  git worktree remove --force "$DEST"
  exit 1
fi
echo "OK: $DEST criado sem docs/research. Rode de novo: node scripts/claude-code-selftest.mjs"
