# Auditoria adversarial — `desktop-control-automation.md` v2

| Campo | Valor |
| --- | --- |
| Data | 2026-10-16 |
| Plano | `docs/plans/desktop-control-automation.md` (v2) |
| Checkout | `/Users/rodrigosonsino/orca/workspaces/rodrigo-ai/halibut` |
| Auditor independente | Cursor Task / gpt-5.6-sol-high |
| Revalidação | Conferência mecânica no código do checkout (não só na tabela A1–A12 do plano) |
| **Veredito** | **REJEITADO** |

## Achados bloqueantes (síntese)

1. **CRÍTICO — AUTO_CORRECAO / T4:** plano registra `decisionLog` *depois* da mutação; caminho real `armedDelegation` → `runSubAgentDelegation` **não** usa `withAudit` (só `delegateToolInTurn` com `isMutation`).
2. **CRÍTICO — Isolamento de subagentes:** `claude -p` com `--permission-mode bypassPermissions`, Bash/Write, `cwd` no repo real, `outboundGuard` só em prompt/saída; `capabilityPolicy` concede shell/rede/escrita a `claude_code`.
3. **CRÍTICO — Rollback / dual-worktree:** `git checkout` genérico e commit síncrono em duas árvores sem baseline/patch/lock — risco de destruir trabalho legítimo.
4. **ALTA — Pipeline não executável:** enums novos ausentes de `voiceProtocol.ts` / `worker.py`; §5 omite parser, prompt, despacho e testes de paridade.
5. **ALTA — lock/sleep vs `markPlayed`:** mutação confirmada executa *antes* da fala final; `markPlayed` só promove pergunta armada — não há estado pós-reprodução para SO.
6. **ALTA — TCC / identidade:** matriz com erros (mídia/System Events não são “sem TCC”); app ad hoc em `desktop/build.sh` sem `NSAppleEventsUsageDescription`; rebuild reautoriza.
7. **ALTA — Token Claude:** `ClaudeCodeSubAgent` valida prefixo; **não** consome via `consumeMutationToken` (diferente de `ToolSubAgent`).
8. **ALTA — Digitação / allowlist / voz / mute / testes:** ver seção abaixo e revalidação A1–A12.

## Revalidação A1–A12

| Id | Status | Evidência |
| --- | --- | --- |
| A1 | **PARCIAL** | Nomes `armedMutation`/`markPlayed`/`classifyConfirmation` corretos; delegação sem `withAudit`; roteamento das novas intenções não especificado no worker/session. |
| A2 | **SANADO** | Usa `pendingSynthesis` no turno; não depende de canal inventado (nota: `speakOutOfTurn` *existe*, mas o v2 evita usá-lo no caminho principal). |
| A3 | **NÃO SANADO** | SLI 1,2–1,8 s contradiz baseline ~3,2 s / p95 ~3,8 s. |
| A4 | **NÃO SANADO** | Matriz TCC incompleta/errada; sem preflight estável; doctor não ganha desenho concreto além do nome `checkDesktopPermissions`. |
| A5 | **SANADO** | `window_hide_others` removido. |
| A6 | **PARCIAL** | Allowlist só explícita em `app_open`; sem bundle IDs; quit/mídia dinâmicos. |
| A7 | **NÃO SANADO** | Fronteira declarativa; Bash+rede+repo real; token não one-shot no Claude. |
| A8 | **PARCIAL** | Nomes tipados propostos; schemas/worker/gates incompletos. |
| A9 | **PARCIAL** | Regra argv boa; scripts dinâmicos/`tell application` não especificados. |
| A10 | **NÃO SANADO** | Floor 10% não desmuta; pergunta ainda em `armed*`; lock/sleep sem pós-`markPlayed`. |
| A11 | **NÃO SANADO** | Kill-switch sem parse fail-closed; auto-correção fora do protocolo T4 real. |
| A12 | **NÃO SANADO** | Suíte omite token, egress, rollback sujo, mute, TCC por alvo, troca de voz em síntese. |

## Matriz TCC

**INCOMPLETE** — faltam/erram: AppleEvents por alvo (Spotify/Music/Finder/System Events); Accessibility para minimizar/atalhos DitadoLocal; Files & Folders; identidade estável vs ad hoc; microfone já no app vs Node em dev; Screen Recording se visão ativa; FDA se subagente escapar.

## Pipeline

**INFIDEL** quanto ao desenho proposto para as novas ações (nomes do gate atuais ok; integração e T4 na auto-correção não).

## Isolamento

**INSUFICIENTE** para Pilar 4 e digitação em app arbitrário.

## Veredito

**REJEITADO.** Não implementar até v3 fechar: (1) ligação executável worker↔session↔tools, (2) T4/`withAudit` + consumo atômico de token em toda auto-correção, (3) sandbox/worktree descartável sem `git checkout` cego, (4) matriz TCC correta + identidade assinada, (5) estado pós-`markPlayed` para lock/sleep, (6) digitação como mutação com alvo fixo, (7) testes adversariais listados.
