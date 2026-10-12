# Plano de orquestração do projeto Rodrigo AI (PROPOSTA)

- Status: **PROPOSTA para revisão do Rodrigo**. Nada aqui vale até ele aprovar.
- Data: 2026-10-11, ~22:45 BRT. Autor: Lingxi's Engineer Bot (Grok Bot).
- Escopo: arquivo **fora do git**. Nenhum arquivo rastreado foi editado. Nada foi commitado.
- Base: `HANDOFF-2026-10-11-noite.md`, `docs/roadmap-2026-10-09.md`, `docs/prompt-proxima-sessao-2026-10-02.md` (§1, §6), `docs/audits/f15-fechamento-lingxi-engineer-bot.md`, `~/.openclaw/workspace/TOOLS.md`, `~/.local/bin/delegar`, `openclaw agents list` e `openclaw sessions --all-agents` (2026.10.1).

## 0. Decisão do Rodrigo e o que este plano NÃO é

Decisão: **um único orquestrador** acima do projeto inteiro e de todos os agentes.

- Este documento trata do **processo de desenvolvimento** (quem manda em quem enquanto o app é construído).
- O app também tem um "orquestrador": o `SessionManager` + `SubAgentCoordinator` da **F15** (`src/backend/agents/subAgent.ts`, `src/backend/voice/sessionManager.ts`). Isso é **funcionalidade do produto** (o app delegando a subagentes em tempo de execução) e não muda com este plano.
- O agente OpenClaw `orquestrador-de-voz` é uma **sessão de desenvolvimento** que trabalha neste repo (workspace = raiz do repo, segundo `openclaw agents list`). Apesar do nome, neste plano ele **não** é o orquestrador do projeto. Ele é o executor principal do repo.

## 1. Hierarquia

| Nível | Quem | Papel |
|---|---|---|
| 0 | **Rodrigo** | Decide prioridades, aprova commit/push, faz as medições de voz real. |
| 1 | **Orquestrador do projeto** (titular: Lingxi's Engineer Bot; reserva: Claude Code Sonnet, `~/.local/bin/claude`) | Fala com o Rodrigo (o titular atende por voz em tempo real), mantém `ESTADO.md`, decide quem faz o quê, verifica as entregas antes de reportar. Não escreve código de produto direto quando há executor disponível. |
| 2 | `orquestrador-de-voz` (OpenClaw) | Executor principal do repo: planos `docs/phase-N-vX.md`, implementação, testes, spawns de auditoria (`sessions_spawn` com Kimi K3, `HANDOFF-2026-10-11-noite.md` §3). Recebe ordens só do nível 1, via `openclaw agent --session-key ...`. |
| 2 | Cursor cloud agents | Fatias de código pequenas e isoladas, com PR e prova real, supervisionadas pelo nível 1. |
| 3 | CLIs via `delegar` (`hermes`, `opencode`, `kimi`, `deepseek`, `codex`, `agy`, `agent`/Cursor, `mimo-pago`) | Trabalho braçal e segunda opinião. Resposta é rascunho e sempre auditada (`TOOLS.md`, "Regra principal"). |
| 3 | `coordenador` (Chief of Staff) + `pesquisador`, `redator`, `revisor` | Só para tarefas de pesquisa/redação/revisão fora do código, **pedidas pelo nível 1**. O `coordenador` **não** coordena este projeto, para não haver dois orquestradores. |
| — | `main` (WhatsApp), `social`, `operador`, `engenheiro-prompt` | Fora deste projeto, salvo pedido explícito do Rodrigo. |

Atenção: os agentes OpenClaw acima, exceto `engenheiro-prompt`, estão configurados com modelos `anthropic/*` (`openclaw agents list`), e o handoff diz que **não há chave Anthropic no gateway** (§3). Na prática, a sessão ativa do `orquestrador-de-voz` roda `moonshotai/kimi-k3` (`openclaw sessions`). Quem delegar a esses agentes deve fixar um modelo que funcione.

**Por que reaproveitar e não criar agente novo:** o `orquestrador-de-voz` já tem o repo como workspace e o histórico da F14/F15. O `delegar` já faz a queda entre CLIs. A única peça nova é um arquivo de estado (seção 2).

## 2. Fonte única de estado: `docs/orquestracao/ESTADO.md`

**Por que um arquivo novo é inevitável:** os `HANDOFF-*.md` são retratos de uma sessão, há mais de um (`HANDOFF-2026-10-11.md` e `-noite.md`) e o mais novo substitui o anterior. O `docs/roadmap-2026-10-09.md` é o roteiro oficial, rastreado, e só muda com decisão do Rodrigo. Nenhum dos dois serve para estado que muda a cada passo e precisa de trava.

Conteúdo (modelo inicial já preenchido em `ESTADO.md`):
1. **Trava (lease):** titular, desde, expira em.
2. Prioridades em ordem.
3. Decisões abertas do Rodrigo.
4. Atribuições por agente (quem, o quê, desde quando, onde está o artefato).
5. Último passo feito e próximo passo.
6. Carimbo de "atualizado em" + quem atualizou.

Regras: o titular atualiza a cada passo relevante (tarefa delegada, entrega verificada, decisão do Rodrigo, falha). O handoff de fim de sessão continua existindo e passa a apontar para o `ESTADO.md`. Rastrear ou não o `ESTADO.md` no git é decisão aberta (Q4).

## 3. Troca de orquestrador (Grok Bot ↔ Claude Code Sonnet)

**Gatilho de saída do titular:** limite semanal do Grok Bot esgotado, indisponibilidade, ou ordem do Rodrigo.

**Trava:** campo `Trava` no `ESTADO.md` com `titular`, `desde` e `expira_em` (proposta: 4 h, renovada a cada atualização). Regras:
- Só o titular manda ordens a agentes de nível 2/3.
- Outro orquestrador só assume se (a) o titular liberou a trava (`titular: livre`), ou (b) a trava venceu **e** o Rodrigo confirmou a troca.
- Antes de mandar a primeira ordem, quem assume grava seu nome na trava e relê o arquivo para confirmar que a gravação é sua.

**Passagem (quem sai):** atualiza o `ESTADO.md` (tarefas em voo, sessões OpenClaw e chaves de sessão, PRs abertos), grava `titular: livre` e avisa o Rodrigo.

**Quem entra lê, nesta ordem:** `docs/orquestracao/ESTADO.md` → `CLAUDE.md` → handoff mais novo → `docs/roadmap-2026-10-09.md` → `docs/prompt-proxima-sessao-2026-10-02.md` §1 e §6 → `~/.openclaw/workspace/TOOLS.md`. Depois confere o estado real (`git status`, `git log -1`, `openclaw sessions --all-agents` pelo binário `/opt/homebrew/bin/openclaw`) antes de agir. Se algo divergir do `ESTADO.md`, vale o estado real, e a divergência é registrada.

**Devolução:** mesmo procedimento ao contrário, quando o Rodrigo pedir ou o limite do titular voltar.

**Pré-requisito não verificado:** o `claude` está instalado (2.1.294), mas a autenticação dele e a cota do Sonnet no Claude Code **não foram testadas**. A cota do Sonnet **dentro do Cursor** está esgotada até 11/11/2026, mas essa é outra conta (Q3).

## 4. Regras que valem para qualquer orquestrador

Vêm de `docs/prompt-proxima-sessao-2026-10-02.md` §1/§6, do roadmap e do handoff §7:
- Plano antes de código. Mudança não trivial passa por plano → auditoria de plano → implementação → verificação → auditoria de código.
- Menor diff possível. Teste que falha **antes** da correção (prova de mutação).
- Nunca enfraquecer teste nem baixar alvo. Mudar alvo H exige registro e aprovação do Rodrigo.
- Sem commit e sem push sem aval explícito do Rodrigo.
- Ações financeiras proibidas. Mensagens externas e ações irreversíveis fora de escopo do app.
- Privacidade: áudio nunca sai da máquina. Nova saída para nuvem só com plano e aprovação. `docs/research/` e `.env` nunca vão a terceiros nem a auditores.
- Nunca aceitar autodeclaração de subagente: verificar no código ou por comando.
- Critério que depende da voz/uso do Rodrigo não se autocertifica: fica PENDENTE.
- Circuit breaker: 3 ciclos sem convergir → trocar auditor; +2 → parar e escalar ao Rodrigo.

## 5. Fila de prioridade atual

1. **F15 Fatia 4 (integração):** ligar o coordenador ao `runTurn`, fazer a mutação passar pela trava do token, corrigir o H15.2 (token forjado aceito). Fonte: `docs/audits/f15-fechamento-lingxi-engineer-bot.md` (C1, C2, A1).
2. **Fase V Fatia 5:** imagem da tela ao Gemini só com autorização por voz + cartão de privacidade (`docs/roadmap-2026-10-09.md`, Fase V).

Isto **inverte** a ordem oficial do roteiro (V antes de F15), que vale "até o usuário mudar explicitamente" (`docs/roadmap-2026-10-09.md`, "Como ler a tabela"). A mudança precisa ser registrada no roteiro, com aval do Rodrigo para editar esse arquivo rastreado (Q1).

**Ambiguidade:** existem duas "Fatias 5". A da F15 é a suíte H15, já commitada em `6e88e5a`, e é onde entra a correção do H15.2. A da Fase V é a da imagem ao Gemini. Este plano assume a da Fase V (Q2).

**Também pendente na Fase V:** o handoff diz que a Fatia 4 (visão local) falta, mas o commit `41f2941` cita "Fase V fatia 4". O estado real precisa ser conferido antes de começar a Fatia 5.

## 6. Achado que afeta o plano

O `~/.local/bin/delegar` atual (alterado às 16:52, depois do backup `delegar.bak-20261011-cursor` das 15:54) lista nas filas agentes que não existem na tabela `AGENTES` (`antigravity-*`). Teste feito agora: `delegar --tipo texto "ping"` sai na hora com `ERRO: agente(s) desconhecido(s)` (código 2). Também voltou o `cursor-claude-opus5` às filas, apesar do comentário dizendo que ele saiu. Até corrigir, só `delegar --ordem ...` funciona. Não mexi no arquivo (Q5).

## 7. Perguntas para o Rodrigo

- **Q1.** Registrar no `docs/roadmap-2026-10-09.md` a nova ordem (F15 Fatia 4 antes da Fase V)? Isso edita arquivo rastreado.
- **Q2.** "Fatia 5" é a da **Fase V** (imagem ao Gemini)? A correção do H15.2 já entra na F15 Fatia 4/5.
- **Q3.** Confirmar que o Claude Code (`claude`) está logado e com cota de Sonnet própria, fora do Cursor. Posso testar com uma chamada mínima?
- **Q4.** O `ESTADO.md` fica fora do git (como agora) ou passa a ser rastreado?
- **Q5.** Posso consertar as filas do `delegar` (tirar `antigravity-*` ou criar essas entradas)?
- **Q6.** Duração da trava: 4 h está bom?
