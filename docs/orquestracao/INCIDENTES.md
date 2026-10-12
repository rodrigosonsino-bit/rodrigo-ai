# Registro de incidentes

Formato de cada entrada: data (PT) · agente · sintoma · impacto · causa-raiz · correção · lição.

| # | Data (PT) | Agente | Sintoma | Causa-raiz | Correção | Lição |
|---|---|---|---|---|---|---|
| 1 | 2026-10-11 | Cursor CLI via delegar | Saída vazia em modo agente | Faltava `--trust` (o CLI ficava esperando o prompt de confiança no workspace) | Incluir `--trust --force` nas entradas do Cursor no delegar | L1 |
| 2 | 2026-10-11 16:52 | delegar | Script quebrado | Edição externa acrescentou agentes `antigravity-*` sem defini-los | Agentes definidos e filas refeitas, com backups `.bak-20261011-*` | L2 |
| 3 | 2026-10-11 | OpenClaw | Erro de schema no banco | O `openclaw` do PATH é um build antigo (9.8) | Usar `/opt/homebrew/bin/openclaw` (2026.10.1) | L3 |
| 4 | 2026-10-11 | OpenClaw orquestrador-de-voz (kimi) | Respostas sem sentido | Sessão `ios-a7f5350f` com contexto saturado | Nova sessão `brief-20261011-kimi`, com `--model nvidia/moonshotai/kimi-k3` | L4 |
| 5 | 2026-10-11 | NotebookLM CLI | "CSRF token not found" | Sessão de autenticação expirada | Rodrigo rodou `notebooklm login --browser-cookies chrome` | L5 |
| 6 | 2026-10-11 | `scripts/notebooklm/build_sources.py` | Texto desatualizado ("build quebrado") na fonte 00 | Texto fixo no gerador | Corrigido no PR #2 | L6 |
| 7 | 2026-10-11 | Cursor (delegar) | "Usage limit" | Cota Pro de "Outros modelos" (Opus/Sonnet) esgotada até 11/11 | Fixar `--model auto` e tirar Opus/Sonnet das filas | L7 |
