# Fase 17 — token dedicado do Claude delegado (N2 da reauditoria 2)

O filho (`claude` sob `sandbox-exec`) não acessa o Keychain: `com.apple.SecurityServer`/`securityd` e `~/Library/Keychains` são negados,
e a execução de binários está limitada a uma lista (N1). Por isso o login por `/login` não persiste. A autenticação é por **token dedicado e revogável**.

- Gerar: `claude setup-token` no Terminal do Mac (fora do app). O token é separado do login principal.
- Guardar: `~/.config/rodrigo-ai/claude-oauth-token`, **fora do repositório**, uma linha, `chmod 600`, dono = usuário, sem symlink.
  Sem passar pela área de transferência (o token não aparece na tela nem no histórico do shell):
  `mkdir -p ~/.config/rodrigo-ai && chmod 700 ~/.config/rodrigo-ai && (umask 077; read -rs T && printf '%s\n' "$T" > ~/.config/rodrigo-ai/claude-oauth-token; unset T) && chmod 600 ~/.config/rodrigo-ai/claude-oauth-token`
  (cole o token e tecle Enter; nada é exibido). **Se você copiou o token**, limpe a área de transferência logo depois: `pbcopy < /dev/null`.
- Uso: `loadClaudeOAuthToken()` valida o arquivo; `claudeChildEnv(..., token)` põe `CLAUDE_CODE_OAUTH_TOKEN` **só** no env do filho.
  Do ambiente do pai, nada com TOKEN/KEY/SECRET atravessa (`scrubEnv`). O valor nunca é logado; os motivos de recusa não contêm o token.
  O arquivo fica no HOME negado ao sandbox: o filho não lê o arquivo, só recebe o valor no próprio env.
- Conferir: `sh scripts/claude-code-login.sh` e depois `node scripts/claude-code-selftest.mjs` (tem de dar APROVADO).
- Revogar: apagar o arquivo e revogar o token na conta da Anthropic.
- Risco aceito: no modo escrita (desligado por padrão), o Bash do filho consegue ler o próprio env e, portanto, o token,
  e a 443 está aberta. Por isso o token é dedicado, revogável e o modo escrita continua desligado até haver proxy com allowlist.

## A3: proxy local (o filho não recebe mais o token)

- O processo pai sobe um proxy em `127.0.0.1:<porta efêmera>` que lê o arquivo do token e injeta `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`, só para `api.anthropic.com:443`, sem CONNECT.
- O filho recebe apenas `ANTHROPIC_BASE_URL=http://127.0.0.1:<porta>` e um nonce aleatório (`ANTHROPIC_AUTH_TOKEN`), que só vale nesse proxy.
- O perfil do sandbox nega toda a rede exceto `localhost:<porta>` (sem 443 direto, sem DNS).
- Modo escrita usa uma raiz separada (`writeRoots` em `config/claude-code-roots.json`, criada por `sh scripts/setup-claude-write.sh`), que não pode ser igual nem aninhada à raiz de leitura.

## A4: endurecimento (reauditoria 4)

- **Nonce por job**: cada job (leitura ou escrita) recebe um nonce novo de 32 bytes; ele é revogado no fim do job (sucesso, falha, cancelamento, timeout ou erro de spawn). Nonce revogado => 401. Nada é reaproveitado entre jobs nem entre modos.
- **Porta efêmera**: o proxy escuta numa porta escolhida pelo SO (só `127.0.0.1`, exclusiva). O perfil do job libera só essa porta; a impressão digital do selftest é calculada com a porta de referência 47817 — o perfil real só difere no número da porta (há teste que prova isso).
- **Só a API de mensagens**: só `POST /v1/messages` e `POST /v1/messages/count_tokens` (query só `beta=true`); `Host` tem de ser `127.0.0.1:<porta>`/`localhost:<porta>`. Qualquer outro método/caminho => 405/403.
- **Corpo filtrado**: JSON-objeto, até 32 MiB (acima => 413), sem `mcp_servers`, `container` ou `betas`, e ferramentas só do cliente (sem `type` ou `type: "custom"`); qualquer ferramenta de servidor (web_search, web_fetch, code_execution, bash/text_editor/computer, memory…) => 403.
- **anthropic-beta com lista de permissão**: betas de servidor (mcp-, web-fetch, web-search, code-execution, files-api, skills-, container…) derrubam o pedido; desconhecidos são descartados; `oauth-2025-04-20` sempre vai.
- **TLS explícito**: `rejectUnauthorized: true` e só os CAs embutidos do Node; com `NODE_TLS_REJECT_UNAUTHORIZED=0` o proxy não sobe. Timeouts: cabeçalhos 30 s, upstream 10 min; no máximo 32 conexões.
- **Logs de recusa**: só método, caminho (sem query) e motivo — nunca cabeçalhos, corpo, nonce ou token.
- **Área de transferência e nsurlsessiond negados** no sandbox (mach-lookup de `com.apple.pasteboard*` e `com.apple.nsurlsession*`): `pbpaste`/`pbcopy` falham dentro do filho.
- **Pastas próprias por modo**: leitura usa `.runtime/claude-home` e `.runtime/claude-tmp`; escrita usa `.runtime/claude-home-write` e `.runtime/claude-tmp-write`. Um modo não lê nem grava as pastas do outro.
- **Sobreviventes de setsid**: no fim do job, além de matar o grupo, uma varredura (`lsof -d cwd`) mata processos do usuário cujo diretório atual está na raiz do job ou nas pastas próprias.

## A5 (reauditoria 5: F1–F5)
- F1: o proxy aceita só os tipos de bloco do Claude Code (text, image, document, tool_use, tool_result, thinking, redacted_thinking). Uma `source` precisa ser base64 ou text e não pode ter `url` nem `file_id`. A checagem é recursiva dentro do tool_result; no `system` só entram blocos text.
- F2: o perfil do sandbox (v7) nega process-info* e signal, liberando apenas o próprio sandbox (`target same-sandbox`) e listpids. `target others` não faz efeito no macOS. O nonce chega ao filho pelo fd 3 (`CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR=3`), num pipe de uso único que é fechado logo após a escrita, e não aparece mais no env. Sem fd 3, o job falha e o nonce é revogado.
- F3: chaves duplicadas são recusadas (400) e chaves proibidas são comparadas sem diferenciar maiúsculas de minúsculas. Para cima sai o JSON validado e re-serializado, com Content-Length recalculado.
- F4: só cabeçalhos de uma lista de permissão chegam à Anthropic (accept, accept-encoding, content-type, user-agent, anthropic-version, x-app, x-claude-code-session-id, x-stainless-*), mais authorization, host e anthropic-beta filtrado.
- F5: revogar o nonce destrói na hora os streams em andamento, tanto o do upstream quanto o da resposta.
