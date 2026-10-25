#!/bin/sh
# Fase 17 (A1/R1 + N2 do Code): o Claude delegado NÃO usa o ~/.claude nem o Keychain do usuário. Ele tem configuração própria
# em .runtime/claude-home e se autentica por um token dedicado e revogável (claude setup-token) guardado em
# ~/.config/rodrigo-ai/claude-oauth-token (0600, fora do repositório). Este script só confere o arquivo e mostra os passos.
# Requer `npm run build:server` antes.
set -eu
cd "$(dirname "$0")/.."
exec node scripts/claude-code-login.mjs
