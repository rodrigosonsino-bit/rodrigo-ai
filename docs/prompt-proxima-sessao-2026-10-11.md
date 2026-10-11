# Prompt de continuidade — 2026-10-11 (pós-F14 fechada)

Cole isto no início de uma nova sessão de trabalho neste repositório.

---

## 1. Quem você é e onde está

Você está trabalhando no repositório:

`/Users/rodrigosonsino/Documents/Codex/2026-09-11/referenced-chatgpt-conversation-this-is-an/outputs/rodrigo-ai`

É o **Rodrigo AI (orquestrador de voz)** — assistente de voz local-first em pt-BR (macOS, Swift worker + Node/TypeScript backend). Usuário: **Rodrigo Sonsino** (`gateway-owner`). Branch: `main`. Node 24+, test runner `node:test`, build do backend com `npx tsc -p tsconfig.server.json`, suíte com `npm test`.

**Leia primeiro, nesta ordem:**
1. `CLAUDE.md` (raiz do repo — regras rígidas de sandbox, build, testes)
2. `docs/roadmap-2026-10-09.md` (roteiro oficial das fases)
3. Este prompt inteiro antes de tocar em qualquer arquivo.

## 2. Estado exato em 2026-10-11 14:20 (BRT)

**Git**: `log origin/main..main` = 1 commit local à frente (`36613ce`, F14 Fatia 4). Árvore limpa exceto arquivos de persona OpenClaw não rastreados (`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `DREAMS.md`, `memory/`, `.openclaw-cli-images/`) — **não comitar nem apagar esses**, são do agente OpenClaw, não do app.

**Suíte de testes**: **688/689**. Única falha é `fvScreen.test.js` HV.3 + relacionados (409 vs 400/200 em captura de tela — Fase V). **Pré-existente, confirmada via `git stash` no HEAD; NÃO tente consertar como parte de outra fase sem autorização.**

**Fases e status real de código** (verificado em código, não só em plano):

| Fase | Estado |
|---|---|
| 1–12 | Implementadas e auditadas, histórico antigo |
| 13a/b | Implementada; falta: Rodrigo ouvir a voz nova (H13a.10) e medir latência real (harness de 200 turnos) |
| V (visão) | Fatias 1–3 prontas; falta: Fatia 4 (visão local no worker), Fatia 5 (Gemini só com autorização + cartão de privacidade); teste `fvScreen` HV.3 quebrado (409 vs 400) |
| **F14** | ✅ **FECHADA 2026-10-11**: Fatia 1 (CONSULTAR), Fatia 2 (match por conteúdo), Fatia 3 (REAGENDAR + bootstrap de restart), Fatia 4 (suíte de estresse). H14.1 120/120, H14.2 0 violações, H14.4 30/30 |
| **F15** | Plano `docs/phase-15-v3.md` **Aprovado com ressalvas** (auditoria r3 incorporada). Implementado: gatekeeper de `confirmationToken` em `adapters.ts`. **Bloqueio: `src/backend/agents/openClawSubAgent.ts` ainda é mock** — travado na decisão D15 (§4.2 do plano): transporte real HTTP ao gateway vs CLI/MCP. **Só Rodrigo pode decidir.** |
| **F16** | Plano `docs/phase-16-v3.md` **Aprovado com ressalvas** (auditoria r3 incorporada). **Bloqueio real: `src/backend/memory/conflictResolver.ts` NÃO EXISTE** — o algoritmo de dedupe aprovado no plano nunca foi escrito. Fixtures (180 cenários) também não existem |
| F17 | Não iniciada; exige V/F13/F14/F15/F16 fechadas + 30 dias de uso real |
| F18/F19 | Sem plano escrito |

**Ordem do roteiro** (reconfirmada 09/10): V → F13 (paralelo) → F14 ✅ → F15 → F16 → F17. F18/F19 depois.

## 3. Como o ciclo de trabalho funciona aqui (importante)

Cada fase segue o ciclo: **plano versionado → auditoria do plano (subagente) → incorporar achados → implementar → auditoria de código (subagente) → corrigir → relatório**. Achados ALTO/CRÍTICO não resolvidos bloqueiam "aprovado". Nunca apagar versões anteriores de planos (v1/v2/v3 convivem). Auditorias estão em `docs/audits/`.

**Subagentes neste gateway**: o modelo padrão é `anthropic/claude-sonnet-5-5` mas **NÃO há chave Anthropic configurada** — spawns com ele falham. Use `sessions_spawn` com `model: "nvidia/moonshotai/kimi-k3"` (funciona, foi usado nas auditorias r2/r3 e na F14 Fatia 4). Contexto isolado: `context: "isolated"`.

Há também agentes externos via CLI (verificados em 11/10): `opencode run -m mimo/mimo-v2.6-flash`, `delegar --tipo arquivo|codigo` com ordens de queda para Cursor/opencode/kimi/deepseek. Úteis para geração de fixtures e tarefas baratas; note que mimo-flash já travou 2x em tarefas longas de geração — para trabalho crítico prefira Kimi K3 via sessions_spawn.

## 4. Lições duras desta sessão (não repita os erros)

1. **Julgar resultado de tool por regex na string de resposta é frágil** — verifique o estado final do `JsonStore`. Foi o motivo do falso 66.7% no H14.1.
2. **O gate de confirmação mora no SessionManager, não nas tools** — chamar `execute()` direto em teste sem `preview()` ignora o design real. H14.2 testa via preview + estado final.
3. **`setTimeout` do Node trunca delay > 2^31−1 ms (~24,85 dias)** — `reminderScheduler.ts` agora reagenda em cadeia (achado documentado no código).
4. **`dueAt` inválido (NaN) disparava notificação imediata** — agora recusa com log.
5. **Sandbox do exec**: testes que sobem `http.Server` real dão `EPERM` (já documentado no CLAUDE.md do projeto). Rode a suíte completa sem sandbox.
6. **Bug de empate no matcher** (`findBestMatchingItemIndex`): palavras de ≤2 caracteres só contam por igualdade exata; substring só entre palavras >2 chars. Não regredir isso.
7. **Consistência preview↔execute (achado D5)**: `preview(EDITAR)` cai para o mais recente quando `notFound`; `execute(EDITAR)` deve fazer o mesmo — senão a pergunta de confirmação promete uma coisa e a execução faz outra.

## 5. Infraestrutura ao redor do repo

- **NotebookLM**: notebook `803ea045-d8fb-4a59-9caa-872d91a51124` ("Rodrigo AI — Arquitetura, Memória e Contexto"), **atualizado em 2026-10-11 com 26 fontes, 0 duplicatas, todas ready** (retrato do commit `36613ce`). Procedimento: `REPO=$PWD OUT=$(mktemp -d /private/tmp/nb-XXXX) python3 scripts/notebooklm/build_sources.py`, subir com `notebooklm source add <path> -n <NB>` (caminho `/private/tmp/...`, nunca `/tmp` puro — symlink no macOS; a flag é posicional + `-n`, não `--file`; delete precisa de `-y`). Só apagar fontes antigas **por ID** após confirmar paridade de títulos e com aval do Rodrigo. Se der erro `CSRF token not found ... notebook.google.com`: a sessão expirou; a correção é Rodrigo rodar `notebooklm login --browser-cookies chrome` no terminal dele (leitura dos cookies do Chrome exige permissão de disco que o processo do agente nem sempre tem).
- **Modelo desta sessão de orquestração**: `nvidia/moonshotai/kimi-k3` (default configurado: `anthropic/claude-sonnet-5-5`, indisponível sem chave).
- **Auditorias**: padrão de nomenclatura `docs/audits/phase-XX-plan-audit-rN.md`.

## 6. Próximos passos concretos (ordem sugerida)

1. **Push**: `git push origin main` (1 commit local: `36613ce`). **Pergunte antes** se o usuário quer.
2. **F15, decisão D15 (bloqueio humano)**: transporte do `openClawSubAgent.ts` — §4.2 de `docs/phase-15-v3.md`. Apresente as opções (HTTP ao gateway vs CLI/MCP) e aguarde decisão do Rodrigo. Sem ela, Fatia 3 da F15 não começa.
3. **F16**: escrever `src/backend/memory/conflictResolver.ts` conforme `docs/phase-16-v3.md` (o algoritmo completo está no plano: dedupe/merge com `logSuppression` obrigatório, `MemoryFixtureCase.kind='cumulative'`, normalize() NFD no fallback de `deriveTopicKey`), depois fixtures (60 cenários, ≥5 aditivos) e suíte. Ciclo completo com auditoria de código via subagente Kimi K3.
4. **Fase V**: fatias 4 (visão local no worker) e 5 (Gemini com autorização explícita + cartão de privacidade); o teste `fvScreen` HV.3 já quebrado provavelmente fica verde no caminho.
5. **F13**: harness de latência (200 turnos) + Rodrigo ouvir a voz nova.

## 7. Estilo de trabalho combinado com o usuário

- Commits em português, formato `"F14 Fatia 4: ..."` / `"Handoff de ..."`.
- Não commitar sem aval explícito; apresentar resultado + sugestão de mensagem.
- Push também pede aval.
- Cancelamento cooperativo via `AbortSignal`; nunca inventar sucesso/falha em silêncio.
- Respostas ao usuário em pt-BR, diretas, sem enrolação.

---

_Prompt gerado em 2026-10-11 ~14:20 BRT pela sessão do orquestrador-de-voz, após fechamento verificado da F14 (suite 688/689, commit 36613ce)._
