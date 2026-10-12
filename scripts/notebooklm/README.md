# Notebook do NotebookLM do Rodrigo AI

Notebook: https://notebooklm.google.com/notebook/803ea045-d8fb-4a59-9caa-872d91a51124  (conta rodrigosonsino@gmail.com). Criado em 2026-10-08 a partir do commit 984a797 (22 fontes); atualizado em 2026-10-08 a partir do commit 6e19437 (24 fontes); **atualizado em 2026-10-11 após o merge do PR #1 (`9cb5bdb`): 30 fontes.**

Fontes geradas por `build_sources.py` (30):
- 00 handoff "LEIA PRIMEIRO" (fatos por comando; o §2b é uma cópia de `docs/orquestracao/ESTADO.md`, onde mora o estado escrito à mão), 01 `CLAUDE.md`, 02 `README.md`, 03 memória do agente, 04 resumo de arquitetura.
- 05–15 documentos de fase: handoffs, 13a, 12, 10a/11, relatórios 1–5c, planos 6–9 e 1–5c, correções, Fase V e 13b, roteiro oficial e planos/auditorias de F14–F16.
- 20–29 código e testes (backend de voz, núcleo, worker, scripts, frontend/shared, configuração, testes da 13a, lista de testes, testes da Fase V, testes de F14–F16).
- 30 plano de orquestração (`docs/orquestracao/PLANO-ORQUESTRADOR-PROPOSTA.md`), 31 estado da orquestração (`docs/orquestracao/ESTADO.md`), 32 auditoria de fechamento da F15 (`docs/audits/f15-fechamento-lingxi-engineer-bot.md`), 33 plano da F15 Fatia 4 (`docs/plan/f15-fatia4-integracao.md`) — cópias literais. No notebook, os títulos são "Plano de orquestração (2026-10-11)", "Estado da orquestração (fonte única)", "Auditoria de fechamento da F15" e "Plano F15 Fatia 4 (mergeado no PR #1)".

As fontes são um **retrato estático**: não acompanham o repositório. Ao mudar o `ESTADO.md`, reenviar as fontes 00 e 31. Para atualizar:

1. `REPO=$PWD OUT=/caminho/vazio python3 scripts/notebooklm/build_sources.py` (regenera as 30 fontes; os fatos do handoff vêm de comandos, inclusive o `tsc` do servidor; recusa gerar se achar a chave real ou conteúdo de docs/research).
2. `notebooklm source list -n 803ea045-d8fb-4a59-9caa-872d91a51124` para achar os ids das fontes que mudaram.
3. `notebooklm source add <arquivo> -n 803ea045-d8fb-4a59-9caa-872d91a51124` com o caminho REAL (`/private/tmp/...`, nunca `/tmp/...`: no macOS `/tmp` é symlink e a CLI recusa — "Path is a symlink"). Conferir com `source list` que a nova ficou `ready` e, se preciso, renomear para o mesmo título da antiga.
4. Só então apagar a antiga (`notebooklm source delete <id> -n 803ea045-d8fb-4a59-9caa-872d91a51124 --yes`; pedir aval do usuário).

Nunca entram: docs/research/ (material pessoal), .env, chaves, .runtime, dist, node_modules, data/.
