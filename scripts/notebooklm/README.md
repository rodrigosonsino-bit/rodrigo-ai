# Notebook do NotebookLM do Rodrigo AI

Notebook: https://notebooklm.google.com/notebook/803ea045-d8fb-4a59-9caa-872d91a51124  (conta rodrigosonsino@gmail.com). Criado em 2026-10-08 a partir do commit 984a797 (22 fontes); **atualizado em 2026-10-08 a partir do commit 6e19437: 24 fontes** (novas: 14 Fase V e 13b, 28 testes da Fase V).

As fontes são um **retrato estático**: não acompanham o repositório. Para atualizar:

1. `REPO=$PWD OUT=/caminho/vazio python3 scripts/notebooklm/build_sources.py` (regenera as 22 fontes; o fato do handoff vem de comandos; recusa gerar se achar a chave real ou conteudo de docs/research).
2. `notebooklm source list -n 803ea045-d8fb-4a59-9caa-872d91a51124` e apagar as fontes antigas (`notebooklm source delete <id> -n 803ea045-d8fb-4a59-9caa-872d91a51124`, pedir aval do usuario).
3. `notebooklm source add <arquivo>` com o caminho REAL (`/private/tmp/...`, nunca `/tmp/...`: no macOS `/tmp` é symlink e a CLI recusa — "Path is a symlink"). Ordem segura: adicionar as novas, conferir `ready`, só então apagar as antigas (`source delete <id> -n ... --yes`).
4. (antigo passo 3) `notebooklm source add <arquivo> -n 803ea045-d8fb-4a59-9caa-872d91a51124` para cada arquivo novo; conferir com `source list` que todas ficaram `ready`.

Nunca entram: docs/research/ (material pessoal), .env, chaves, .runtime, dist, node_modules, data/.
