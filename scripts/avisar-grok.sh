#!/usr/bin/env bash
# Envia uma mensagem do Claude para o Ogra (Grok) via webhook.
# Uso: scripts/avisar-grok.sh [--session ID] [--reply-to ASSUNTO] "<texto>"
#   --session ID      ID da sessão do Claude (o Ogra devolve a resposta nessa sessão).
#                     Padrão: $CLAUDE_SESSION_ID, se definida. Sem ID, o campo é omitido.
#   --reply-to ASSUNTO  usar quando a mensagem responde a algo do Ogra.
# Requer GROK_WEBHOOK_URL e GROK_WEBHOOK_KEY no ambiente. A chave nunca é impressa
# nem passada na linha de comando (fica fora do argv, logo fora do `ps`).
# Saída: apenas o código HTTP. Código de saída 0 se 2xx, 1 caso contrário.
set -euo pipefail

session="${CLAUDE_SESSION_ID:-}"
reply_to=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session)  session="${2:?--session exige um valor}"; shift 2 ;;
    --reply-to) reply_to="${2:?--reply-to exige um valor}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "opção desconhecida: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  echo "uso: $0 [--session ID] [--reply-to ASSUNTO] \"<mensagem>\"" >&2
  exit 2
fi
: "${GROK_WEBHOOK_URL:?GROK_WEBHOOK_URL não definida}"
: "${GROK_WEBHOOK_KEY:?GROK_WEBHOOK_KEY não definida}"
command -v jq >/dev/null || { echo "jq não encontrado" >&2; exit 2; }

payload=$(jq -cn --arg m "$1" --arg s "$session" --arg r "$reply_to" \
  '{source:"claude", project:"rodrigo-ai", message:$m}
   + (if $s != "" then {session:$s} else {} end)
   + (if $r != "" then {reply_to:$r} else {} end)')

body=$(mktemp)
trap 'rm -f "$body"' EXIT

# O header com a chave e a URL vão por stdin (--config -), não por argumento.
code=$(printf 'header = "Authorization: Bearer %s"\nurl = "%s"\n' \
        "$GROK_WEBHOOK_KEY" "$GROK_WEBHOOK_URL" |
  curl -sS --max-time 20 --config - \
    -X POST -H "Content-Type: application/json" \
    --data "$payload" -o "$body" -w '%{http_code}') || { echo "falha de rede" >&2; exit 1; }

echo "HTTP $code"
case "$code" in
  2??) exit 0 ;;
  *) echo "corpo da resposta (até 300 bytes):" >&2; head -c 300 "$body" >&2; echo >&2; exit 1 ;;
esac
