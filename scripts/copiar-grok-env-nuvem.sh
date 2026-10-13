#!/usr/bin/env bash
# Copia GROK_WEBHOOK_URL e GROK_WEBHOOK_KEY para a área de transferência no formato
# CHAVE=valor (uma por linha), pronto para colar no campo de variáveis de ambiente
# do ambiente de nuvem do Claude Code (claude.ai/code → ambiente → editar).
# Os valores vêm do ~/.zshenv e nunca são impressos na tela.
# Depois de colar, o script apaga a área de transferência após 60 s.
set -euo pipefail

command -v pbcopy >/dev/null || { echo "pbcopy não encontrado (só macOS)" >&2; exit 2; }
[ -r "$HOME/.zshenv" ] || { echo "~/.zshenv não encontrado" >&2; exit 2; }

set -a
# shellcheck disable=SC1091
. "$HOME/.zshenv"
set +a

: "${GROK_WEBHOOK_URL:?GROK_WEBHOOK_URL não definida no ~/.zshenv}"
: "${GROK_WEBHOOK_KEY:?GROK_WEBHOOK_KEY não definida no ~/.zshenv}"

printf 'GROK_WEBHOOK_URL=%s\nGROK_WEBHOOK_KEY=%s\n' "$GROK_WEBHOOK_URL" "$GROK_WEBHOOK_KEY" | pbcopy
echo "Copiado: 2 linhas (valores ocultos). Cole no campo de variáveis do ambiente de nuvem."
echo "A área de transferência será limpa em 60 s."

( sleep 60; printf '' | pbcopy ) >/dev/null 2>&1 &
