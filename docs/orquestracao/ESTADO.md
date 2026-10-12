# ESTADO da orquestração — Rodrigo AI

> Arquivo único de estado da orquestração (rastreado no git desde 2026-10-11, por decisão do Rodrigo).
> **Quem for agir no projeto lê este arquivo primeiro** e não dá ordens sem deter a trava.
> Quem detém a trava atualiza este arquivo a cada passo relevante. Modelo descrito em
> `docs/orquestracao/PLANO-ORQUESTRADOR-PROPOSTA.md` (aceito pelo Rodrigo em 2026-10-11; no git a partir do PR do branch `docs-estado-pos-merge`).
> O gerador do NotebookLM (`scripts/notebooklm/build_sources.py`) copia este arquivo para a fonte 00 (§2b) e para a fonte 31: o estado escrito à mão mora só aqui.

- **Atualizado em:** 2026-10-12 08:35 BRT, por ORQUESTRADOR_GROK (Grok Bot; antes chamado Lingxi's Engineer Bot)

> **Protocolo "final de sessão" (regra permanente, 2026-10-12):** quando o Rodrigo disser "final de sessão", o Claude/orquestrador registra a sessão no `CLAUDE.md` (`## Registro de sessões`), atualiza o notebook 803ea045 e escreve `docs/handoff-AAAA-MM-DD.md`, referenciado na seção "Último passo / próximo passo" abaixo. Checklist completo no `CLAUDE.md`.

## Trava (lease)
- titular: ORQUESTRADOR_GROK (Grok Bot, com voz em tempo real)
- desde: 2026-10-11 22:45 BRT (renovada 2026-10-12 08:35 BRT)
- expira_em: 2026-10-12 12:35 BRT
- duração: 4 h, renovada a cada atualização. Aceita pelo Rodrigo em 2026-10-11 como ponto de partida; **revisar depois de uma semana de uso (~2026-10-18)**.
- reserva: Claude Code Sonnet (`~/.local/bin/claude`). Login e cota **não testados** — o Rodrigo pediu para não testar agora.

## Estado do repo
- `main`: **PRs #2 (`d94575b`), #3 (`6720acd`) e #4 mergeados** em 2026-10-12, com aval do Rodrigo. Antes: `9cb5bdb`, que é o PR #1 da F15 Fatia 4.
- PR #3 (mergeado): plano de auto-melhoria (Fases 1 e 2), `INCIDENTES.md`, `LICOES.md`, `docs/conhecimento/` (7 áreas: índice, sínteses com citação e briefs por papel), evidências da Fase 2. Também corrige no gerador os 2 apontamentos do review do PR #2: o estado da F16 (o `conflictResolver` já existe, em `eba54e5`) e os hashes dos commits da F15. Acrescenta a fonte 34.
- Suíte: em `main` 739/740 a 740/740; na branch da Fatia 4, 743/745 a 745/745. As únicas falhas são de `fvScreen.test.js` (HV.3 ×2 e "auditoria Kimi K3 achado 5"), **intermitentes e pré-existentes** (0 a 3 falhas por execução também antes da Fatia 4). `tsc` verde.
- Não rastreados (não commitar nem apagar): arquivos de persona OpenClaw (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `DREAMS.md`), `HANDOFF-*.md`, `.openclaw-cli-images/`.

## NotebookLM ("Rodrigo AI (orquestrador de voz)", `803ea045-d8fb-4a59-9caa-872d91a51124`)
- **31 fontes**, todas prontas, atualizadas a partir do `main` a cada merge. Em 2026-10-12, as fontes 00, 31 e 34 são trocadas a cada mudança relevante. Histórico: 30 fontes em 2026-10-11, depois do PR #1.
- Novas: 30 plano de orquestração (`930ad4e8`), 31 estado da orquestração = este arquivo (id atual em `notebooklm source list`; o antigo `d8a2168d` foi substituído por `2c09d0c8` em 2026-10-11 e é trocado a cada reenvio), 32 auditoria de fechamento da F15 (`008ad12c`), 33 plano da F15 Fatia 4 (`461564f4`).

## Auto-melhoria e conhecimento (2026-10-12, PRs #3 e #4)
- PR #4: `PLANO-ESPECIALISTAS-UNIFICADOS.md` (proposta; próximos passos: `ROTEAMENTO.md` + gerador de profile-sources, depois skills `especialista-<área>` no OpenClaw).
- Fase 1: `INCIDENTES.md` (7 incidentes reais), `LICOES.md` (L1–L7), `docs/conhecimento/<área>/INDICE.md` para as 7 áreas (Virtologia sempre rotulada "segundo Casarotto") e 12 briefs por papel em `docs/conhecimento/briefs/`.
- Sínteses (NotebookLM, só fontes dos notebooks, com citação): neurociência, virtologia, hermenêutica, teologia (NT e AT), exegese, psicanálise e engenharia de software.
- Fase 2:
  - Novo notebook **"ENGENHARIA DE SOFTWARE (backend e frontend)" `d7378de8-3f8f-4fec-94ff-c6d96f216e4a`**, com 17 fontes; o markdown está em `docs/research/ENGENHARIA_SOFTWARE/`.
  - Psicanálise exportada para `docs/research/` (124 fontes, de 6 notebooks).
  - **Deletados** 3 notebooks vazios sem título (deb98c1c, d6421dc7, 91c4cf62).
  - Os 2 "Psicoterapeuta" (5cddc991, 082c057a) foram **mantidos**: o conteúdo difere. Fica para o Rodrigo decidir.
  - As evidências estão em `docs/orquestracao/evidencias/fase2-notebooks.md`.
- Rotina semanal de revisão (seg 08:00 BRT): o Rodrigo cria; prompt no relatório do orquestrador.

## Decisões de privacidade (2026-10-12) — `DECISOES-PRIVACIDADE-ESPECIALISTAS.md`
- **D-P1:** Kimi/NVIDIA é provedor de nuvem de terceiros novo. O app **não encaminha texto do usuário** a agentes do OpenClaw em nuvem até plano + auditoria + aval atualizarem `privacyText.ts` e o README §7. **Não ligar `RODRIGO_WEB_SEARCH=1`** até a fatia de follow-up (fixar o agente/modelo do gateway, atualizar o cartão, teste de consistência).
- **D-P2:** agentes em nuvem leem só `docs/conhecimento/` revisado, nunca `docs/research/`. As skills `especialista-<área>` estão **bloqueadas**.
- Critérios de aceite C3–C9 em `PLANO-ESPECIALISTAS-UNIFICADOS.md` §7. As pré-condições da Fase V Fatia 5 (diagnóstico do `fvScreen`, `RODRIGO_CLOUD_VISION` desligado por padrão, auditor de outra família) estão no roteiro.

## Prioridades (em ordem) — registradas em `docs/roadmap-2026-10-09.md` (2026-10-11)
1. ~~**F15 Fatia 4 (integração)**~~ — **mergeada (PR #1, `9cb5bdb`)**. Token comparado com o emitido e de uso único (o token forjado do H15.2 agora dá 0 execuções); ferramentas do `runTurn` pelo coordenador; mutação pós-SIM pelo gatekeeper; fala de estouro dentro do turno; pendentes com id e "o que você fez?". Testes primeiro, nenhum teste afrouxado.
   - **Aberto — Fatia 4b** (decisão P1 do Rodrigo): decompositor multi-passo + rota de voz até o OpenClaw/especialistas, com plano próprio. Sem ela, H15.1/H15.7 seguem sintéticos e o pending→completed via poller fica para depois.
   - **Aberto — limitação do H15.3 (P2)**: só cancelamento local — o OpenClaw não tem API de cancelamento.
   - **R3 aceito**: o coordenador é do processo; "o que você fez?" pode citar o trace de uma sessão anterior.
2. **Fase V Fatia 5 — PRÓXIMA**: imagem da tela ao Gemini só com autorização por voz + cartão de privacidade. **Plano curto primeiro; nenhum código antes da aprovação do Rodrigo.** Antes, conferir o estado real da Fase V Fatia 4 (commit `41f2941` cita "Fase V fatia 4"). Pontos de atenção: `RODRIGO_CLOUD_VISION` vem ligado por padrão; `mlx-vlm` não está nos scripts de setup; o modelo de visão padrão não é o que o plano prevê.
3. Depois (ordem do handoff §6): F16 (`conflictResolver`, fixtures, suíte), F13 (harness de latência).

Método combinado (aceito pelo `orquestrador-de-voz` em 2026-10-11): plano curto antes do código (o que reaproveitar, menor diff, por que peça nova é inevitável) → testes que falham reproduzindo as lacunas → código em commits pequenos numa branch → sem push/merge sem aprovação do Rodrigo → nunca enfraquecer teste.

## Decisões do Rodrigo
Tomadas em 2026-10-11:
- D1. Nova ordem registrada no roteiro (F15 Fatia 4 antes da Fase V). ✔
- D2. Qual "Fatia 5": decidido pelo `orquestrador-de-voz` → Fase V Fatia 5. ✔
- D3. Claude Code como reserva: **não testar agora**.
- D4. `ESTADO.md` rastreado no git. ✔
- D5. Filas do `delegar` consertadas. ✔ (backup `~/.local/bin/delegar.bak-20261011-2248`)
- D6. Trava de 4 h como ponto de partida; revisar após uma semana.
- D7. Plano da F15 Fatia 4 aprovado com P1, P2 e R3. ✔ Push, PR #1 e merge aprovados. ✔

Abertas: H13a.10 (ouvir a voz Charon); voz das confirmações (Gemini TTS ou `say`, D-b); HV.14 (10 perguntas reais sobre a tela, depois da Fase V); aprovação nominal da busca web autônoma na F15; Nível 2 do Google; plano da Fatia 4b quando for escrito.

## Atribuições por agente
| Agente | Tarefa | Desde | Artefato / estado |
|---|---|---|---|
| ORQUESTRADOR_GROK (Grok Bot) | Orquestrador (titular da trava) | 2026-10-11 | este arquivo |
| `orquestrador-de-voz` (OpenClaw) | Fase V Fatia 5 (plano primeiro) | 2026-10-11 | A sessão `ios-a7f5350f` (kimi-k3) **saturou o contexto** (saída ilegível ao planejar a Fatia 4) — **não usar**; usar uma sessão nova |
| `coordenador`, `pesquisador`, `redator`, `revisor`, `operador`, `social` | — | — | Livres. **Modelo `nvidia/moonshotai/kimi-k3`** desde 2026-10-12, os 6 testados com "OK" (backup `~/.openclaw/openclaw.json.bak-20261012-0803-kimi`). `main` e `orquestrador-de-voz` continuam com `anthropic/*` (sessões novas usam `--model kimi-k3`); a troca fica para o Rodrigo decidir |
| Cursor CLI / cloud agents | — | — | Plano Pro: "Outros modelos" 100% usado até 11/11, on-demand desligado; `auto`/Composer/Grok OK; precisa de `--trust` |
| `delegar` | — | — | Filas: `antigravity-gemini-3.1-pro` primeiro. **Código desde 2026-10-12 (revisão semanal): gemini-3.1-pro → cursor-composer25 → cursor-auto**; codex, agy e gpt5-codex-high saíram da fila, mas continuam em AGENTES. Opus/Sonnet fora até 11/11. Log com `tarefa`, `modelo` e `teste`; cooldown de 1 h após erro de cota (`--sem-cooldown` ignora). Backup: `~/.local/bin/delegar.bak-20261012-0817-revisao`. Validado: py_compile, `--help`, `--lista`, uma tarefa real com `--teste` (OK em 9 s, registrada no log) e teste unitário do cooldown |

## Último passo / próximo passo
- Último: PRs #2, #3 e #4 mergeados; agentes OpenClaw em kimi-k3; skill `agent-catalog` com as filas reais; NotebookLM atualizado a partir do `main`.
- Próximo: **Fase V Fatia 5**, plano curto antes do código, numa sessão nova do `orquestrador-de-voz`; nenhum código antes do aval do Rodrigo.
