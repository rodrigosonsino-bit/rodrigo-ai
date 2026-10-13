#!/usr/bin/env bash
# Chamada direta à API do MiMo (Token Plan Singapura, formato OpenAI), sem passar por
# `opencode run` nem `mimo-cli` — evita o overhead de prompt de sistema/ferramentas que
# causou timeout e resposta vazia nas rotas por agente (2026-10-13).
# Uso: echo "<prompt>" | scripts/mimo-direto.sh [modelo] [max_tokens]
#   modelo padrão: mimo-v2.6-pro   |   max_tokens padrão: 6000
# Requer MIMO_API_KEY no ambiente (lida do ~/.zshenv se faltar). A chave nunca é impressa
# nem vai no argv. Gasta crédito do Token Plan. Resposta em stdout; erros em stderr.
set -euo pipefail

model="${1:-mimo-v2.6-pro}"
max_tokens="${2:-6000}"

if [ -z "${MIMO_API_KEY:-}" ] && [ -r "$HOME/.zshenv" ]; then
  set -a; . "$HOME/.zshenv"; set +a
fi
: "${MIMO_API_KEY:?MIMO_API_KEY não definida}"
command -v jq >/dev/null || { echo "jq não encontrado" >&2; exit 2; }

prompt=$(cat)
[ -n "$prompt" ] || { echo "prompt vazio (leia de stdin)" >&2; exit 2; }

payload=$(jq -cn --arg m "$model" --arg p "$prompt" --argjson t "$max_tokens" \
  '{model:$m, max_tokens:$t, messages:[{role:"user", content:$p}]}')

out=$(mktemp); trap 'rm -f "$out"' EXIT
code=$(printf 'header = "Authorization: Bearer %s"\nurl = "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions"\n' "$MIMO_API_KEY" |
  curl -sS --max-time 280 --config - -X POST -H "Content-Type: application/json" \
    --data "$payload" -o "$out" -w '%{http_code}') || { echo "falha de rede" >&2; exit 1; }

if [ "$code" != "200" ]; then
  echo "HTTP $code — corpo (até 300 bytes):" >&2; head -c 300 "$out" >&2; echo >&2; exit 1
fi
jq -r '.choices[0].message.content // empty' "$out" || { echo "resposta não-JSON" >&2; exit 1; }
echo "[uso: $(jq -c '.usage' "$out" 2>/dev/null)]" >&2
