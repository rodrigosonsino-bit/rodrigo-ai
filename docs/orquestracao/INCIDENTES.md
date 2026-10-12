# Registro de incidentes

Formato de cada entrada: data (PT) · agente · sintoma · impacto · causa-raiz · correção · lição · evidência (commit, backup ou arquivo).

| # | Data (PT) | Agente | Sintoma | Impacto | Causa-raiz | Correção | Lição | Evidência |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-11 | Cursor CLI via delegar | Saída vazia em modo agente | Alto: nenhuma delegação ao Cursor funcionava | Faltava `--trust` (o CLI ficava esperando o prompt de confiança no workspace) | Incluir `--trust --force` nas entradas do Cursor no delegar | L1 | `~/.local/bin/delegar.bak-20261011-cursor` |
| 2 | 2026-10-11 16:52 | delegar | Script quebrado | Alto: todas as filas falhavam | Edição externa acrescentou agentes `antigravity-*` sem defini-los | Agentes definidos e filas refeitas | L2 | `~/.local/bin/delegar.bak-20261011-2248` |
| 3 | 2026-10-11 | OpenClaw | Erro de schema no banco | Médio: o CLI não falava com as sessões | O `openclaw` do PATH é um build antigo (9.8) | Usar `/opt/homebrew/bin/openclaw` (2026.10.1) | L3 | — |
| 4 | 2026-10-11 | OpenClaw orquestrador-de-voz (kimi) | Respostas sem sentido | Médio: o plano da Fatia 4 foi perdido nessa sessão | Sessão `ios-a7f5350f` com contexto saturado | Nova sessão `brief-20261011-kimi`, com `--model nvidia/moonshotai/kimi-k3` | L4 | `ESTADO.md` (atribuições) |
| 5 | 2026-10-11 | NotebookLM CLI | "CSRF token not found" | Médio: atualização do notebook bloqueada | Sessão de autenticação expirada | Rodrigo rodou `notebooklm login --browser-cookies chrome` | L5 | — |
| 6 | 2026-10-11 | `scripts/notebooklm/build_sources.py` | Texto desatualizado ("build quebrado") na fonte 00 | Médio: outros agentes recebiam estado falso | Texto fixo no gerador | Corrigido | L6 | PR #2 (`d94575b`) |
| 7 | 2026-10-11 | Cursor (delegar) | "Usage limit" | Alto: Opus/Sonnet indisponíveis | Cota Pro de "Outros modelos" (Opus/Sonnet) esgotada até 11/11 | Fixar `--model auto` e tirar Opus/Sonnet das filas | L7 | `ESTADO.md` |
| 8 | 2026-10-12 | OpenClaw pesquisador, redator, revisor, coordenador, operador e social | Agentes sem modelo funcional | Alto: especialistas do OpenClaw inutilizáveis | Os 6 apontavam para `anthropic/*`, e o gateway não tem chave da Anthropic | Trocados para `nvidia/moonshotai/kimi-k3` via `openclaw config set`; os 6 responderam "OK" no teste | L8 | `~/.openclaw/openclaw.json.bak-20261012-0803-kimi` |
| 9 | 2026-10-12 | Skill `agent-catalog` (OpenClaw) | Filas do delegar desatualizadas | Médio: recomendava Opus/Sonnet indisponíveis | O catálogo não acompanhou a mudança das filas | QUICK_REFERENCE, AGENT_CATALOG e SKILL atualizados | L9 | `~/.openclaw/agent-catalog.bak-20261012-0803.tgz` |
| 10 | 2026-10-12 | Codex review (PRs #2 e #3) | Docs com estado contraditório | Médio: risco de refazer trabalho já feito | Status e inventário não foram atualizados depois da execução | Corrigido no PR #4 | L10 | PR #4 |
