# ESTADO da orquestração — Rodrigo AI

> Arquivo único de estado da orquestração (rastreado no git desde 2026-10-11, por decisão do Rodrigo).
> Quem detém a trava atualiza este arquivo a cada passo relevante. Modelo descrito em
> `docs/orquestracao/PLANO-ORQUESTRADOR-PROPOSTA.md` (ainda proposta, fora do git, em revisão pelo Rodrigo).

- **Atualizado em:** 2026-10-11 22:55 BRT, por Lingxi's Engineer Bot

## Trava (lease)
- titular: Lingxi's Engineer Bot (Grok Bot)
- desde: 2026-10-11 22:45 BRT (renovada 22:55 BRT)
- expira_em: 2026-10-12 02:55 BRT
- duração: 4 h, renovada a cada atualização. Aceita pelo Rodrigo em 2026-10-11 como ponto de partida; **revisar depois de uma semana de uso (~2026-10-18)**.
- reserva: Claude Code Sonnet (`~/.local/bin/claude`). Login e cota **não testados** — o Rodrigo pediu para não testar agora.

## Estado do repo
- Base: `6e88e5a` (= `origin/main` em 2026-10-11 22:15) + commit local desta atualização (roteiro + este arquivo), **sem push**.
- Suíte: 740/740 no handoff (22:15). Na auditoria F15 (~22:40): 737/740, 3 falhas em `fvScreen.test.js` HV.3 (intermitente, não é F15).
- Não rastreados (não commitar nem apagar): arquivos de persona OpenClaw, `HANDOFF-*.md`, `docs/audits/f15-fechamento-lingxi-engineer-bot.md`, `docs/orquestracao/PLANO-ORQUESTRADOR-PROPOSTA.md`.

## Prioridades (em ordem) — registradas em `docs/roadmap-2026-10-09.md` (2026-10-11)
1. **F15 Fatia 4 (integração)**: coordenador no `runTurn`; mutação pelo gatekeeper de token; corrigir H15.2 (token forjado). Ref.: `docs/audits/f15-fechamento-lingxi-engineer-bot.md` C1, C2, A1. Decisão do Rodrigo em 2026-10-11 ("os dois, primeiro a fatia 4").
2. **Fase V Fatia 5**: imagem ao Gemini só com autorização por voz + cartão de privacidade. Escolhida pelo `orquestrador-de-voz` em 2026-10-11 ("FATIA5: b" — a F15 Fatia 5, suíte H15, já está em `6e88e5a`). Antes, conferir o estado real da Fase V Fatia 4 (handoff diz pendente; commit `41f2941` cita "Fase V fatia 4").
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

Abertas (herdadas): revisar `PLANO-ORQUESTRADOR-PROPOSTA.md`; H13a.10 (ouvir a voz); voz das confirmações (Gemini TTS ou `say`, D-b); HV.14 (10 perguntas reais sobre a tela, depois da Fase V); aprovação nominal da busca web autônoma na F15; Nível 2 do Google.

## Atribuições por agente
| Agente | Tarefa | Desde | Artefato / estado |
|---|---|---|---|
| Lingxi's Engineer Bot | Orquestrador (titular da trava) | 2026-10-11 | este arquivo |
| `orquestrador-de-voz` (OpenClaw, kimi-k3, sessão `ios-a7f5350f`) | F15 Fatia 4 → Fase V Fatia 5 | 2026-10-11 | Ordem e método recebidos e aceitos; próximo: entregar o plano curto da Fatia 4 (sem código) |
| `coordenador`, `pesquisador`, `redator`, `revisor` | — | — | Livres (modelos `anthropic/*`, sem chave no gateway) |
| Cursor cloud agents | — | — | Livres. No CLI, Opus/Sonnet sem cota até 11/11; `auto`/Composer/Grok OK |
| `delegar` | — | — | OK. Filas: `antigravity-gemini-3.1-pro` primeiro; Opus/Sonnet do Cursor fora das filas até 11/11 |

## Último passo / próximo passo
- Último: `delegar` consertado; nova ordem no roteiro; `orquestrador-de-voz` escolheu Fase V Fatia 5 e aceitou o método plano-primeiro; este arquivo foi para o git (commit local, sem push).
- Próximo: `orquestrador-de-voz` entrega o plano curto da F15 Fatia 4 para revisão antes de qualquer código. Rodrigo revisa `PLANO-ORQUESTRADOR-PROPOSTA.md`.
