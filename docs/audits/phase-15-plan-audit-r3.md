# Auditoria Crítica do Plano da Fase 15 (v3) — Rodada 3

- **Data:** 2026-10-10
- **Objeto auditado:** `docs/phase-15-v3.md`
- **Documentos de referência:** `docs/audits/phase-15-plan-audit-r1.md`, `docs/audits/phase-15-plan-audit-r2.md`, `docs/phase-15-v1.md`, `docs/phase-15-v2.md`
- **Autor da auditoria:** Subagente Auditor de Plano
- **Veredicto Final:** **APROVÁVEL COM RESSALVAS** (nenhum achado novo ALTO ou CRÍTICO; 2 MÉDIOS e 4 BAIXOS registrados abaixo — o transporte da ponte OpenClaw permanece dependente de decisão do usuário, declarado honestamente no plano §4.2/§9)

---

## 1. Reconciliação achado-por-achado contra a r2

| # | Achado r2 | Gravidade r2 | Veredicto r3 | Evidência na v3 |
|---|---|---|---|---|
| N1 | Persistência pós-restart sem comportamento definido na subida | MÉDIO | **RESOLVIDO** | §4.3 "Comportamento exato na subida": 4 passos explícitos (descartar >6h sem falar, verificar status real, resumo datado + marcado como tarefa anterior, falha honesta se `taskId` sumiu). Fatia 3 inclui implementação. |
| N2 | Contrato `__ASYNC__:<taskId>` frágil (string mágica em `output`) | MÉDIO | **RESOLVIDO** | §2: `SubAgentTaskResult` ganha `kind?: 'final' \| 'async_deferred'` + `asyncTaskId?: string`; §4.3 usa o discriminante estrutural, não o prefixo. |
| N3 | Tetos de orçamento sem procedimento de recalibração | BAIXO | **RESOLVIDO** | §6 "Procedimento de recalibração": se H15.1 falhar por estouro >10%, recalibrar tabela §6 e re-rodar H15.5 registrando old/new. |
| N4 | `confirmationToken` só checava presença, não frescor | BAIXO | **RESOLVIDO** | §2.1: contrato de `ToolSubAgent.runTask` exige `req.confirmationToken.startsWith(\`${req.turnId}:\`)` antes de executar mutação. |
| N5 | Divergência de `IAgent` sem critério que trave | BAIXO | **RESOLVIDO** | §7 Fatia 2: pré-condição verificável `npx tsc -p tsconfig.server.json --noEmit` limpo antes de prosseguir. |

**Placar r2:** 5 RESOLVIDOS (1 MÉDIO → resolvido, 1 MÉDIO → resolvido, 3 BAIXOS → resolvidos).

---

## 2. Novos achados introduzidos pela v3 (ajustes pós-r2)

### N1 [MÉDIO]: Intervalo de polling e teto de duração de tarefas assíncronas OpenClaw indefinidos ("N minutos")
- **Local:** §4.3, parágrafo do poller: "`poller (openClawClient.pollStatus(taskId), intervalo de 5-10s, teto de N minutos — número a definir junto com a resposta do usuário no §4.2)`".
- **Evidência:** O plano delega a definição do teto máximo de duração de uma tarefa assíncrona ("N minutos") para uma decisão futura do usuário sobre o transporte (§4.2). Sem esse número, não há como implementar o poller com timeout real, nem validar H15.4/H15.5 para cenários longos.
- **Impacto:** Implementação da Fatia 3 bloqueada ou incompleta; critério de aceite H15.4 ("incluindo tarefas assíncronas pendentes") não testável em full.
- **Ação sugerida:** Definir um teto conservador padrão (ex.: 10 min) no plano, com nota de que pode ser ajustado após confirmação do transporte; remover a dependência de "resposta do usuário no §4.2" para este parâmetro.

### N2 [MÉDIO]: Esquema de persistência de tarefas assíncronas pendentes não especificado
- **Local:** §4.3 "Risco conhecido": "persistir tarefas assíncronas pendentes em `data/` (mesmo padrão de `JsonStore` já usado para lembretes)".
- **Evidência:** O plano cita o padrão `JsonStore` mas não define: (a) estrutura do registro persistido (campos mínimos: `taskId`, `prompt`, `capability`, `startedAt`, `turnId`, `confirmationToken?`); (b) atomicidade da escrita (escrita atômica via temp+rename?); (c) índice para recuperação na subida (ler todos ou lookup por `taskId`?); (d) limpeza de registros órfãos após conclusão/falha.
- **Impacto:** Implementação da mitigação mínima (§4.3 comportamento na subida) fica ambígua; risco de corrupção ou perda de tarefas se o formato não for estável.
- **Ação sugerida:** Adicionar em §4.3 ou Fatia 3 um sub-item "Schema de persistência" com os campos obrigatórios e o padrão de escrita/limpeza.

### N3 [BAIXO]: Limite arbitrário de 6h para descarte silencioso de tarefas na subida
- **Local:** §4.3 "Comportamento exato na subida", passo 1: "descartar (sem falar nada) qualquer uma com mais de 6h de idade".
- **Evidência:** O valor "6h" não tem justificativa técnica (não deriva de TTL do OpenClaw, nem de SLA de usuário, nem de medição). Uma tarefa legítima de 5h59min gera fala na subida; uma de 6h01min é silenciosamente descartada — UX inconsistente na fronteira.
- **Impacto:** Baixo (caso de borda), mas expõe ausência de critério racional para o threshold.
- **Ação sugerida:** Justificar o valor (ex.: "baseado no TTL padrão de tarefas do OpenClaw gateway = 6h") ou tornar configurável via env `RODRIGO_ASYNC_TASK_TTL_HOURS`.

### N4 [BAIXO]: Canal `RODRIGO_WEB_SEARCH` adicionado sem demonstração de integração completa no `PrivacyConfig`
- **Local:** §5: snippet de `privacy.ts` adiciona `readonly webSearch: boolean` e `webSearchEffective(cfg)`.
- **Evidência:** O plano não mostra: (a) onde `RODRIGO_WEB_SEARCH` é lido do ambiente (ex.: `envToPrivacyConfig()` em `privacy.ts`?); (b) se o canal aparece em `/api/privacy` (exposição obrigatória citada: "motivo exposto em `/api/privacy`"); (c) teste de integração H15.6 cobrirá apenas o bloqueio, não a exposição correta no endpoint de privacidade.
- **Impacto:** Baixo — padrão citado (`cloudVision`/`cloudTts`) existe no código; risco de omissão na integração real.
- **Ação sugerida:** Adicionar em §5 ou Fatia 1/4 uma linha confirmando que `envToPrivacyConfig` e `/api/privacy` serão atualizados (ou citar arquivo:linha onde já estão).

### N5 [BAIXO]: Limites de orçamento (§6) só têm recalibração para "apertado demais", não para "frouxo demais"
- **Local:** §6 "Procedimento de recalibração": "Se H15.1 falhar por estouro de orçamento em >10% dos 40 cenários, recalibrar...".
- **Evidência:** O gatilho só dispara se os tetos forem **muito baixos** (impedem conclusão legítima). Não há gatilho se os tetos forem **muito altos** (permitem cadeias longas desnecessárias, latência alta, custo excessivo). H15.5 testa "zero estouro silencioso", mas não testa "orçamento respeitado de forma eficiente".
- **Impacto:** Baixo — o plano é honesto ao dizer "teto inicial para calibrar"; mas a métrica de eficiência do orçamento fica fora do harness.
- **Ação sugerida:** Adicionar em H15.5 ou nova H15.7: "média de chamadas/turno nos 40 cenários H15.1 ≤ 3 (50% do teto)" — mede se o teto não é excessivamente folgado.

### N6 [BAIXO]: `confirmationToken` previsível (`turnId:askedAt`) — risco teórico de *confused deputy* se `turnId` for previsível
- **Local:** §2.1: "O valor do token pode ser tão simples quanto `` `${turnId}:${pendingMutation.askedAt}` ``".
- **Evidência:** O plano admite "não é segurança criptográfica contra um atacante — é uma trava estrutural contra um erro de integração futura". Se `turnId` for sequencial ou timestamp previsível, um subagente malicioso/bugado poderia forjar token válido para outro turno. O risco é teórico (exige comprometer o subagente), mas a previsibilidade do token enfraquece a trava.
- **Impacto:** Baixo (ameaça modelada como "erro de integração", não atacante ativo); mitigado pela checagem de frescor (`turnId` do token == `req.turnId`).
- **Ação sugerida:** Incluir nonce aleatório curto no token (ex.: `` `${turnId}:${askedAt}:${crypto.randomUUID().slice(0,8)}` ``) — custo zero, eleva a barreira sem mudar o modelo de ameaça.

---

## 3. Veredicto da Fase 15 (v3)

**APROVÁVEL COM RESSALVAS.**

- Todos os 5 achados da r2 estão **RESOLVIDOS** com mecanismo real (tipo estrutural, comportamento de subida explícito, procedimento de recalibração, frescor de token, gate de compilação).
- **Nenhum achado novo ALTO ou CRÍTICO.**
- **2 MÉDIOS novos** (N1: polling/teto indefinido; N2: schema de persistência não especificado) — exigem definição antes/durante Fatia 3, mas não bloqueiam aprovação do plano (são detalhes de implementação faltantes).
- **4 BAIXOS novos** (N3–N6) — ajustes de uma linha ou documentação.
- **Ressalva externa mantida:** Transporte da ponte OpenClaw (§4.2) depende de decisão do usuário — Fatia 3 não inicia antes. Isso é declarado honestamente e não é defeito do plano.
- Critério do projeto ("achados altos não resolvidos bloqueiam a aprovação") **atendido**: não há alto não resolvido.

---

## 4. Pontos de atenção para a implementação (não bloqueiam aprovação)

1. **Fatia 2 não avança sem `tsc --noEmit` limpo** — o código atual em `adapters.ts` (erro `Expected 2 arguments, but got 0` no `else` do `ToolSubAgent`) e `specialistAgents.ts` (duplicata `NeurocienciaAgent` fora da `IAgent` real) travam a compilação. §7 Fatia 2 já exige isso como pré-condição.
2. **Fatia 3 bloqueada por §4.2** — confirmar transporte (HTTP gateway vs CLI/MCP) antes de escrever qualquer código de ponte.
3. **H15.6 (50 cenários adversariais de busca web bloqueada)** exige que `RODRIGO_WEB_SEARCH` esteja integrado em `envToPrivacyConfig` e `/api/privacy` — verificar na Fatia 1/4.
4. **Testes de estresse H15.1/H15.5** devem usar corpus de fixture isolado, não `docs/research/` real — evitar flakiness.