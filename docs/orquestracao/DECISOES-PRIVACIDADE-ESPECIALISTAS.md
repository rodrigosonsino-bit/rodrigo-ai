# Decisões de privacidade — especialistas e agentes em nuvem (2026-10-12)

> Status: **DECIDIDO pelo Rodrigo** em 2026-10-12, a partir da revisão do Claude (fallback Sonnet) sobre as mudanças do dia. O PR que traz este documento está aberto para revisão; nenhum código do app mudou.
> Relacionados: `PLANO-ESPECIALISTAS-UNIFICADOS.md` (emendado em §3.4 e com a nova §7), `docs/roadmap-2026-10-09.md` (pré-condições da Fase V Fatia 5), `CLAUDE.md` (regra de dependência externa nova = plano + aprovação + auditoria).

## D-P1 — Kimi/NVIDIA é um provedor de nuvem de terceiros novo

**Contexto.** Em 2026-10-12, 6 agentes do OpenClaw (pesquisador, redator, revisor, coordenador, operador e social) passaram para `nvidia/moonshotai/kimi-k3`, com backup em `~/.openclaw/openclaw.json.bak-20261012-0803-kimi`. Hoje `src/shared/privacyText.ts` e o README §7 só citam o Gemini e a busca web via OpenClaw, e dizem que não há fallback para outro provedor.

**Decisão.**
1. `nvidia/moonshotai/kimi-k3` (NVIDIA + Moonshot) fica **classificado como provedor de nuvem de terceiros novo**.
2. Até que um **plano + auditoria + aprovação do Rodrigo** atualizem `privacyText.ts` e o README §7, **o app não pode encaminhar texto do usuário a agentes do OpenClaw que rodem em modelos de nuvem**. Isso inclui a futura Fatia 4b (rota de voz até os agentes/especialistas do OpenClaw).
3. O uso de agentes do OpenClaw **fora do app** (orquestração, revisão e estudo pelo ORQUESTRADOR_GROK, com material do repo) continua permitido. Não envolve fala nem texto do usuário do app.

**O que o código faz hoje** (lido em `main` = `ccf03ca`, 2026-10-12; nada foi alterado):

| Ponto | O que o código faz | Arquivo |
|---|---|---|
| Única rota wired | Só a capacidade `openclaw_web` tem cliente HTTP. `openclaw_drive` e `openclaw_social` ficam declaradas com `wired: false`, sem execução | `src/backend/agents/openClawCapabilities.ts` |
| `RODRIGO_CLOUD=0` | **Respeitado.** `openclaw_web` só chama o gateway se `webSearchEffective(cfg) = cfg.cloud && cfg.webSearch`; caso contrário devolve `WEB_SEARCH_DISABLED_TEXT` sem fazer rede | `openClawSubAgent.ts` (≈l.104), `privacy.ts` (≈l.71–75) |
| `RODRIGO_WEB_SEARCH` | **Padrão 0** (`parseFlag(env, 'RODRIGO_WEB_SEARCH', false)`), então por padrão não sai nada | `privacy.ts` (≈l.122) |
| `RODRIGO_SEND_HISTORY=0` | **Não consultado na rota OpenClaw.** O cliente manda uma única mensagem, `messages: [{ role: 'user', content: prompt }]`, sem histórico. O `prompt` é o `content` da ação detectada no turno (`delegateToolInTurn`), então o texto do usuário daquele turno sai | `openClawHttpClient.ts` (≈l.34–44), `sessionManager.ts` (≈l.439–455) |
| Destino | `POST {RODRIGO_OPENCLAW_GATEWAY_URL ou http://127.0.0.1:18789}/v1/chat/completions`, sem `model` nem agente no corpo. **O agente e o modelo são decididos pelo gateway**: a config tem uma única binding (`main` para o WhatsApp). Não verifiquei qual agente responde a essa rota HTTP; o `main` ainda aponta para `anthropic/claude-sonnet-5-5` | `openClawHttpClient.ts`; `~/.openclaw/openclaw.json` (só lido) |
| Sem token | Sem `RODRIGO_OPENCLAW_GATEWAY_TOKEN`, `makeOpenClawHttpClient` devolve `null` e o subagente responde "Gateway OpenClaw não conectado" | `openClawHttpClient.ts` (≈l.28), `openClawSubAgent.ts` (≈l.139) |

**Conclusão.**
- Com os padrões atuais (`RODRIGO_WEB_SEARCH=0`), ou com `RODRIGO_CLOUD=0`, nenhum texto do usuário vai ao OpenClaw.
- Com os dois ligados, o texto da busca sai **sem histórico**, mas o modelo que o processa é escolhido pelo gateway, e pode ser um modelo de nuvem diferente do que o cartão de privacidade descreve. Por isso a regra 2 da D-P1 vale também para a busca web: **não ligar `RODRIGO_WEB_SEARCH=1` até a fatia de follow-up abaixo**.

**Follow-up obrigatório (fatia futura separada, com plano + auditoria + aval):**
1. Fixar no corpo da requisição o agente e o modelo do gateway que a rota usa. Se for de nuvem, declarar o provedor.
2. Atualizar `privacyText.ts` e o README §7 com todos os provedores possíveis (Gemini, NVIDIA/Moonshot e o que mais houver) e remover a frase "sem fallback para outro provedor" se ela deixar de ser verdade.
3. **Teste de consistência:** o cartão de privacidade precisa listar todo provedor alcançável pela config efetiva. O teste falha se uma rota nova não estiver declarada.
4. Decidir se `RODRIGO_SEND_HISTORY=0` também deve restringir o conteúdo enviado ao OpenClaw (hoje já não há histórico, mas a regra precisa ser explícita e testada).

## D-P2 — agentes em nuvem leem só `docs/conhecimento/`

**Decisão.**
1. Agentes em modelos de nuvem (OpenClaw e `delegar`) podem ler **somente** `docs/conhecimento/`, isto é, sínteses **revisadas por humano**, índices e briefs. **Nunca** `docs/research/`, que é material pessoal e protegido; o `CLAUDE.md` diz que ele não vai a terceiros, e a decisão D1 mantém `RODRIGO_SEND_KNOWLEDGE` desligado por padrão.
2. A §3.4 do `PLANO-ESPECIALISTAS-UNIFICADOS.md` foi emendada: as skills não trazem caminhos de `docs/research/`.
3. **A instalação das skills `especialista-<área>` fica BLOQUEADA** até:
   - a D-P1 ser resolvida, se a skill puder ser usada por uma rota do app;
   - a revisão humana das sínteses usadas pela skill (critério C5 em `PLANO-ESPECIALISTAS-UNIFICADOS.md` §7).
4. Consultas a notebooks do NotebookLM (Google) feitas pelo ORQUESTRADOR_GROK continuam permitidas, porque os notebooks já são do Rodrigo na conta Google dele. Um agente em nuvem de terceiros não recebe o texto bruto das fontes, só sínteses revisadas.

**Atenção:** em 2026-10-12, as sínteses de `docs/conhecimento/*/sinteses/` foram geradas pelo NotebookLM a partir de `docs/research`/notebooks e ainda estão **"revisão humana pendente"**. Até a revisão, nem elas podem ir a agentes de nuvem como conhecimento canônico.
