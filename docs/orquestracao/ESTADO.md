# ESTADO da orquestração — Rodrigo AI

> Arquivo único de estado da orquestração (rastreado no git desde 2026-10-11, por decisão do Rodrigo).
> Quem detém a trava atualiza este arquivo a cada passo relevante. Modelo descrito em
> `docs/orquestracao/PLANO-ORQUESTRADOR-PROPOSTA.md` (ainda proposta, fora do git, em revisão pelo Rodrigo).

- **Atualizado em:** 2026-10-11 23:17 BRT, por Lingxi's Engineer Bot

## Trava (lease)
- titular: Lingxi's Engineer Bot (Grok Bot)
- desde: 2026-10-11 22:45 BRT (renovada 23:17 BRT)
- expira_em: 2026-10-12 03:17 BRT
- duração: 4 h, renovada a cada atualização. Aceita pelo Rodrigo em 2026-10-11 como ponto de partida; **revisar depois de uma semana de uso (~2026-10-18)**.
- reserva: Claude Code Sonnet (`~/.local/bin/claude`). Login e cota **não testados** — o Rodrigo pediu para não testar agora.

## Estado do repo
- `main`: `3feccb8` (local, **sem push**). Branch `f15-fatia4-integracao` (local, **sem push, sem merge**): 5 commits da F15 Fatia 4 + esta atualização, aguardando revisão do Rodrigo.
- Suíte: baseline em `main` 739/740; na branch 743/745 a 745/745. As únicas falhas, nos dois lados, são de `fvScreen.test.js` (HV.3 ×2 e "auditoria Kimi K3 achado 5"), intermitentes e pré-existentes (0 a 3 falhas por execução também em `main`). `tsc` verde.
- Não rastreados (não commitar nem apagar): arquivos de persona OpenClaw, `HANDOFF-*.md`, `docs/audits/f15-fechamento-lingxi-engineer-bot.md`, `docs/orquestracao/PLANO-ORQUESTRADOR-PROPOSTA.md`.

## Prioridades (em ordem) — registradas em `docs/roadmap-2026-10-09.md` (2026-10-11)
1. ~~**F15 Fatia 4 (integração)**~~ — **feita na branch `f15-fatia4-integracao`, aguardando revisão do Rodrigo** (plano aprovado: `docs/plan/f15-fatia4-integracao.md`). Token comparado com o emitido e de uso único (C2, B1); ferramentas do `runTurn` pelo coordenador (C1 parcial); mutação pós-SIM pelo gatekeeper (A1); fala de estouro dentro do turno (A3); pendentes com id e "o que você fez?" (A2).
   - **Fatia 4b** (decisão P1 do Rodrigo): decompositor multi-passo + rota de voz até o OpenClaw/especialistas, com plano próprio. Sem ela, H15.1/H15.7 seguem sintéticos (auditoria M2) e M4 (pending→completed via poller) fica para depois.
   - **Limitação registrada (P2)**: H15.3 aceita só cancelamento local — o OpenClaw não tem API de cancelamento.
   - **R3 aceito**: o coordenador é do processo; "o que você fez?" pode citar o trace de uma sessão anterior.
2. **Fase V Fatia 5** — **próxima**: imagem ao Gemini só com autorização por voz + cartão de privacidade. Escolhida pelo `orquestrador-de-voz` em 2026-10-11 ("FATIA5: b" — a F15 Fatia 5, suíte H15, já está em `6e88e5a`). Antes, conferir o estado real da Fase V Fatia 4 (handoff diz pendente; commit `41f2941` cita "Fase V fatia 4").
3. Depois (ordem do handoff §6): F16 (`conflictResolver`, fixtures, suíte), F13 (harness de latência), ressincar NotebookLM.

Método combinado (aceito pelo `orquestrador-de-voz` em 2026-10-11, "PLANO-PRIMEIRO: aceito"): plano curto antes do código (o que reaproveitar, menor diff, por que peça nova é inevitável) → testes que falham reproduzindo as lacunas → código em commits pequenos numa branch → sem push/merge sem aprovação do Rodrigo → nunca enfraquecer teste.

## Decisões do Rodrigo
Tomadas em 2026-10-11:
- D1. Nova ordem registrada no roteiro (F15 Fatia 4 antes da Fase V). ✔
- D2. Qual "Fatia 5": decidido pelo `orquestrador-de-voz` → Fase V Fatia 5. ✔
- D3. Claude Code como reserva: **não testar agora**.
- D4. `ESTADO.md` rastreado no git. ✔
- D5. Filas do `delegar` consertadas. ✔ (backup `~/.local/bin/delegar.bak-20261011-2248`)
- D6. Trava de 4 h como ponto de partida; revisar após uma semana.
- D7. Plano da F15 Fatia 4 aprovado com as recomendações: P1 (Fatia 4b separada), P2 (cancelamento só local no H15.3), R3 (trace do processo). ✔

Abertas: revisar e decidir push/merge da branch `f15-fatia4-integracao`. Herdadas: revisar `PLANO-ORQUESTRADOR-PROPOSTA.md`; H13a.10 (ouvir a voz); voz das confirmações (Gemini TTS ou `say`, D-b); HV.14 (10 perguntas reais sobre a tela, depois da Fase V); aprovação nominal da busca web autônoma na F15; Nível 2 do Google.

## Atribuições por agente
| Agente | Tarefa | Desde | Artefato / estado |
|---|---|---|---|
| Lingxi's Engineer Bot | Orquestrador (titular da trava) | 2026-10-11 | este arquivo |
| `orquestrador-de-voz` (OpenClaw, kimi-k3, sessão `ios-a7f5350f`) | Fase V Fatia 5 | 2026-10-11 | A sessão saturou o contexto ao planejar a Fatia 4 (saída ilegível); a Fatia 4 foi feita pelo Lingxi's Engineer Bot. Próxima tarefa vai para uma sessão nova |
| `coordenador`, `pesquisador`, `redator`, `revisor` | — | — | Livres (modelos `anthropic/*`, sem chave no gateway) |
| Cursor cloud agents | — | — | Livres. No CLI, Opus/Sonnet sem cota até 11/11; `auto`/Composer/Grok OK |
| `delegar` | — | — | OK. Filas: `antigravity-gemini-3.1-pro` primeiro; Opus/Sonnet do Cursor fora das filas até 11/11 |

## Último passo / próximo passo
- Último: F15 Fatia 4 implementada na branch `f15-fatia4-integracao` (5 commits, teste primeiro em cada um, suíte e `tsc` verdes fora das intermitências de `fvScreen`), sem push nem merge.
- Próximo: Rodrigo revisa a branch. Depois, **Fase V Fatia 5** (imagem da tela ao Gemini só com autorização por voz + cartão de privacidade), plano curto antes do código, numa sessão nova do `orquestrador-de-voz`. Rodrigo revisa `PLANO-ORQUESTRADOR-PROPOSTA.md`.
