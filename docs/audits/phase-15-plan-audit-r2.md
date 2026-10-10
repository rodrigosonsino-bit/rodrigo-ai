# Auditoria Crítica do Plano da Fase 15 (v3) — Rodada 2

- **Data:** 2026-10-10
- **Objeto auditado:** `docs/phase-15-v3.md`
- **Documentos de referência:** `docs/audits/phase-15-plan-audit-r1.md`, `docs/phase-15-v1.md`, `docs/phase-15-v2.md` (via citações da v3), `docs/roadmap-2026-10-09.md`, `docs/prompt-proxima-sessao-2026-10-02.md`
- **Autor da auditoria:** Subagente Auditor de Plano
- **Veredicto Final:** **APROVÁVEL COM RESSALVAS** (nenhum achado novo ALTO ou CRÍTICO; 2 MÉDIOS e 3 BAIXOS registrados abaixo — o transporte da ponte OpenClaw permanece dependente de decisão do usuário, o que é declarado honestamente no plano, §4.2/§9, e não pode ser cobrado como defeito do plano)

---

## 1. Reconciliação achado-por-achado contra a r1

| # | Achado r1 | Gravidade r1 | Veredicto r2 | Evidência na v3 |
|---|---|---|---|---|
| 1 | `ISubAgent` sem `AbortSignal` inviabiliza barge-in ≤350ms sem órfãs | CRÍTICO | **RESOLVIDO** | §2: `runTask(req: SubAgentTaskRequest, signal: AbortSignal)`. §4.3 combina `AbortSignal.any` com timeout próprio. |
| 2 | Omissão do critério H15.5 (orçamento/limites) | CRÍTICO | **RESOLVIDO** | §6 define tabela com 4 limites numéricos (6 chamadas/turno, 60s/turno, 15s timeout síncrono, 2 async simultâneas); §8 inclui H15.5 com 200 cenários adversariais. **Ressalva:** os números são declarados como "teto inicial para calibrar", não medidos — isto é honesto, mas vira achado novo N3 (abaixo). |
| 3 | Gatekeeper de mutação pós-execução (`needsConfirmation` tardio) | ALTO | **RESOLVIDO** | §2/§2.1: campo obrigatório `confirmationToken` em `SubAgentTaskRequest`, checado dentro de `ToolSubAgent.runTask` antes de `execute()` — a trava está no tipo e no adaptador, não só no chamador. Endereça exatamente a crítica "prosa não impede esquecimento". |
| 4 | Leitura autônoma sem classificar saída para nuvem | ALTO | **RESOLVIDO** | §5: tabela Local vs. Externa/Nuvem; novo sub-canal `RODRIGO_WEB_SEARCH` + função `webSearchEffective(cfg)` seguindo o padrão existente de `cloudVision`/`cloudTts`; H15.6 (50 cenários adversariais) cobre o bloqueio com o canal desligado. |
| 5 | Ausência de ancoragem `file:line` | ALTO | **RESOLVIDO** | §2.1 cita `sessionManager.ts` ~linha 501 (Fase 5c); §10 mapeia os três arquivos de agentes com o que falta em cada um, incluindo erro de `tsc` real (`adapters.ts`, ramo `else` de `ToolSubAgent`). Ancoragem suficiente para um plano. |
| 6 | Protocolo da ponte OpenClaw incompleto | MÉDIO | **PARCIAL** | §4.3/§4.4 especificam dois modos (curto síncrono 15s / longo assíncrono com `__ASYNC__:<taskId>`), poller (5-10s), persistência mínima de tarefa pendente, escopo por capacidade. Porém §4.2 declara explicitamente que o **transporte não foi confirmado** e lista duas hipóteses (HTTP ao gateway vs. CLI/MCP). O plano acerta em não inventar, mas o achado só fecha quando o usuário responder. |
| 7 | Rastreabilidade ("o que você fez?") sem especificação | MÉDIO | **RESOLVIDO** | §1 item 5 + §8 H15.4 (inclui tarefas assíncronas pendentes); §4.3 registra `taskId` no `ExecutionTrace` com status `pending`. Estrutura `ExecutionTrace` já existe em código (`subAgent.ts`, §10). |

**Placar r1:** 6 RESOLVIDOS, 1 PARCIAL (dependente de decisão externa, declarada no plano).

---

## 2. Novos achados introduzidos pela v3

### N1 [MÉDIO]: Persistência de tarefas assíncronas pendentes é mitigação incompleta por construção, e o reinício-informativo pode virar fala errada
- **Local:** §4.3, "Risco conhecido".
- **Evidência:** O plano admite que, após restart, só há "verificar o status de qualquer tarefa pendente salva antes de descartá-la", e que "retomar o poller automaticamente fica fora de escopo". Isso cria uma janela em que o usuário recebe, na subida, uma fala sobre uma tarefa cujo resultado final pode já ter mudado ou cuja tarefa não existe mais no OpenClaw — e o plano não especifica o que acontece com a pergunta do usuário que motivou a tarefa (ela não é re-entregue ao LLM; só um "status" é verificado).
- **Impacto:** UX de voz inconsistente pós-restart; risco de fala obsoleta ou confusa.
- **Ação sugerida:** especificar na Fatia 3 o comportamento exato na subida (falar um resumo com timestamp da tarefa; nunca re-injetar como se fosse conclusão nova; descartar tarefas com mais de X horas).

### N2 [MÉDIO]: Contrato interno `__ASYNC__:<taskId>` é frágil (string mágica no campo `output`)
- **Local:** §4.3.
- **Evidência:** O resultado síncrono-vs-assíncrono é sinalizado por um prefixo de string em `SubAgentTaskResult.output`, que a interface (`§2`) tipa como texto livre destinado a virar fala. Qualquer refatoração futura que normalize/trunque `output` (ex.: um sanitizador antes do TTS) quebra silenciosamente o contrato, e o cenário oposto (um subagente remoto retornar texto genuíno começando com `__ASYNC__:`) não é tratado.
- **Impacto:** acoplamento invisível entre `OpenClawSubAgent` e `SessionManager`; falha silenciosa possível (fala do literal "__ASYNC__:abc123" ao usuário).
- **Ação sugerida:** estender `SubAgentTaskResult` com um campo estrutural (`kind: 'final' | 'async_deferred'; asyncTaskId?: string`) — a v3 já demonstra, com `confirmationToken`, que sabe usar o tipo como trava; aplicar o mesmo padrão aqui.

### N3 [BAIXO]: Números de orçamento (§6) sem validação, embora declarados como tal
- **Local:** §6.
- **Evidência:** 6 chamadas/turno, 60s/turno, 2 async simultâneas são "teto inicial para calibrar com o próprio H15.1". O plano é honesto sobre isso, mas H15.5 verifica apenas "zero estouro silencioso" — não verifica se os tetos escolhidos permitem concluir os 40 cenários de H15.1 (risco de H15.1 falhar por teto apertado demais e o plano não prever procedimento de recalibração).
- **Ação sugerida:** adicionar uma linha em §9/Fatia 5: "se H15.1 falhar por estouro de orçamento em >10% dos cenários, recalibrar a tabela do §6 e re-rodar H15.5".

### N4 [BAIXO]: `confirmationToken` não tem validação de correspondência — só de presença
- **Local:** §2.1.
- **Evidência:** O contrato checa `if (req.isMutation && !req.confirmationToken)`. Um token sugerido é `` `${turnId}:${pendingMutation.askedAt}` ``, mas nada exige que o adaptador verifique que o token corresponde à mutação *desta* pergunta (vs. um token de turno anterior reusado por engano). O plano mesmo admite que "não é segurança criptográfica", o que é aceitável — mas uma checagem mínima de frescor (`turnId` do token == `req.turnId`) custaria uma linha no contrato e elevaria a garantia sem custo.
- **Ação sugerida:** incluir no contrato do §2.1 a verificação de que o token embute o `turnId` corrente.

### N5 [BAIXO]: Divergência de código `IAgent` (adapters/specialistAgents) é desviada para "auditoria de código", mas bloqueia a Fatia 2
- **Local:** §3 nota 1, §10.
- **Evidência:** A v3 registra corretamente que `adapters.ts` usa `.domain`/`.processQuery()` inexistentes e que `specialistAgents.ts` tem `NeurocienciaAgent` duplicado fora da interface real. O plano diz "corrigir no código antes de prosseguir" (Fatia 2) — aceitável — mas não há critério de aceite H15.x que trave a integração caso a correção não ocorra; a tabela H15 testa comportamento, não compilação da fronteira. Risco baixo porque `tsc` já acusa hoje.
- **Ação sugerida:** mencionar em H15.2 ou na Fatia 2 que `tsc --noEmit` limpo é pré-condição do harness.

---

## 3. Veredicto da Fase 15 (v3)

**APROVÁVEL COM RESSALVAS.**

- Nenhum CRÍTICO ou ALTO novo; os 2 CRÍTICOS e 2 ALTOS da r1 estão resolvidos com mecanismo real (tipo obrigatório, canal de privacidade, tabela de orçamento, harness ampliado).
- Ressalvas: (a) transporte da ponte OpenClaw (§4.2) continua bloqueado por decisão do usuário — Fatia 3 não pode começar antes; (b) N1 e N2 devem ser incorporados à Fatia 3/4 antes da implementação; (c) N3–N5 são ajustes de uma linha cada.
- Critério do projeto ("achados altos não resolvidos bloqueiam a aprovação") é atendido: não há alto não resolvido.
