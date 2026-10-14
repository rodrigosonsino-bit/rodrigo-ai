#!/bin/sh
# Fase 17: cria o worktree LIMPO que o Claude Code pode ler (.runtime/claude-readonly), a partir de origin/main.
# docs/research é gitignorado, então NÃO existe nesse worktree: o material pessoal fica fora do alcance por construção.
set -eu
cd "$(dirname "$0")/.."
DEST=".runtime/claude-readonly"
if [ -e "$DEST" ]; then
  echo "Já existe: $DEST (para atualizar: git -C $DEST checkout --detach origin/main)"
  exit 0
fi
git fetch -q origin main
git worktree add --detach "$DEST" origin/main
if [ -e "$DEST/docs/research" ]; then
  echo "ERRO: $DEST/docs/research existe; removendo o worktree."
  git worktree remove --force "$DEST"
  exit 1
fi
echo "OK: $DEST criado sem docs/research."
