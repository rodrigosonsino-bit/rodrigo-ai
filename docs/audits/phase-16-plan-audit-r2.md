# Auditoria Crítica do Plano da Fase 16 (v3) — Rodada 2

- **Data:** 2026-10-10
- **Objeto auditado:** `docs/phase-16-v3.md`
- **Documentos de referência:** `docs/audits/phase-16-plan-audit-r1.md`, `docs/phase-16-v1.md`, `docs/phase-16-v2.md` (via citações da v3), `docs/roadmap-2026-10-09.md`, `docs/prompt-proxima-sessao-2026-10-02.md`
- **Autor da auditoria:** Subagente Auditor de Plano
- **Veredicto Final:** **APROVÁVEL COM RESSALVAS** (nenhum achado novo ALTO ou CRÍTICO; 1 MÉDIO e 3 BAIXOS registrados abaixo)

---

## 1. Reconciliação achado-por-achado contra a r1

| # | Achado r1 | Gravidade r1 | Veredicto r2 | Evidência na v3 |
|---|---|---|---|---|
| 1 | Preamble não injetado quando `chunks` vazio (falha de design do reconhecimento de limite) | CRÍTICO | **RESOLVIDO** | §2.1: `sessionManager.ts` (~linha 744) passa a injetar explicitamente um bloco `[Conhecimento: O corpus não contém informações sobre "..."]` no ramo `else` (quando `retrieve()` retorna vazio) — exatamente a frente 2 que a r1 exigia. A frente 1 (trava no prompt do especialista) existe para Neurociência no §2.3, mas ver achado novo N2 abaixo. |
| 2 | Resolução de memórias conflitantes sem algoritmo (só prosa) | CRÍTICO | **RESOLVIDO** | §2.2: algoritmo completo em `conflictResolver.ts` — `deriveTopicKey()` (normalização NFD, stopwords de preferência, chave ordenada de até 4 termos) + `resolveConflicts()` determinístico por `createdAt` maior, consumido em `memoryBlock.ts:6` antes do `slice(-MAX)`, com justificativa de ordem (dedup antes do corte). Verificou o código real: `StoredItem` não tem `updatedAt` (`jsonStore.ts:12-19`) e `MEMORIA_EDITAR` muta in-place sem tocar `createdAt` (`mutatingTools.ts:459-485`) — a escolha do campo está fundamentada. Vence a exigência r1 de "função/pseudocódigo". |
| 3 | Faltam 4 arquivos na integração do `NeurocienciaAgent` | ALTO | **RESOLVIDO** | §2.1 lista os 4 arquivos (`mlxWorkerEngine.ts`, `specialistAgents.ts`, `main.ts`, `sessionManager.ts` ~744) com o snippet da condição atualizada; §4 Fatia 1/2 distribui o trabalho. |
| 4 | Falta o texto do `NEUROCIENCIA_PROMPT` | ALTO | **RESOLVIDO** | §2.3: prompt completo, com isenção de diagnóstico/prescrição e base estrita no material do usuário. |
| 5 | Ausência de ancoragem `file:line` | ALTO | **RESOLVIDO** | Cita `sessionManager.ts` ~744, `memoryBlock.ts:6`, `jsonStore.ts:12-19`, `mutatingTools.ts:459-485`. Suficiente para plano. |
| 6 | Falta schema de fixture/harness dos 180 cenários | MÉDIO | **RESOLVIDO** | §3: 3 arquivos de fixture nomeados, schemas `KnowledgeFixtureCase` e `MemoryFixtureCase` em TypeScript, e estratégia de execução (memória roda `resolveConflicts()` puro, sem mock de LLM; conhecimento usa corpus de fixture isolado, não o `docs/research/` real — boa decisão de isolamento). |
| 7 | Coluna "quem mede" ausente / H16.4 sem status do usuário | MÉDIO | **RESOLVIDO** | §5: coluna Medição presente; H16.4 marcado **PENDENTE (Usuário)**, alinhado à governança. |
| 8 | Falta seção de Circuit Breaker | BAIXA | **RESOLVIDO** | §5, nota de segurança: "o projeto segue o circuito de max 3 fatias de código seguidas por auditoria rigorosa de código". Mínimo, mas presente. |

**Placar r1:** 8 RESOLVIDOS, 0 parciais.

---

## 2. Novos achados introduzidos pela v3

### N1 [MÉDIO]: O heurístico `deriveTopicKey` pode colidir memórias de assuntos diferentes, e a direção do conflito nem sempre é "a mais recente vence"
- **Local:** §2.2.
- **Evidência:** O próprio plano declara o limite ("memórias sobre assuntos genuinamente diferentes que compartilham 4 palavras pouco comuns podem colidir por engano") — honesto. Mas há um risco não dito: a regra "mais recente vence" **apaga silenciosamente a entrada antiga do bloco de memória**. Para preferências mutáveis ("café sem açúcar" → "café com adoçante") isso é correto; para fatos cumulativos que compartilham tópico ("minha irmã Ana mora em SP" / "minha irmã Ana fez 40 anos") a colisão destruiria informação válida sem aviso ao usuário e sem log. O exemplo da r1 é claramente do primeiro tipo, mas nada no algoritmo distingue "atualização de preferência" de "fato aditivo sobre o mesmo tópico".
- **Impacto:** perda silenciosa de memória válida; a taxa real disso só será medida pela suíte de 60 cenários (H16.3), que o plano mesmo admite ainda não existir — "não assumir que o heurístico já está calibrado".
- **Ação sugerida:** registrar em `ExecutionTrace`/log cada supressão feita por `resolveConflicts` (entrada suprimida + chave), para auditoria e para responder "por que você esqueceu X?"; e incluir nos fixtures de H16.3 pelo menos um cenário de fato aditivo para medir a taxa de falso-agrupamento.

### N2 [BAIXO]: A trava de limite por prompt de sistema só foi especificada para Neurociência
- **Local:** §2.1 vs. §2.3.
- **Evidência:** A r1 (ação requerida, frente 1) pediu instrução de resposta padronizada nos prompts de `TeologiaAgent`, `VirtologiaAgent` **e** `NeurocienciaAgent`. A v3 entrega o bloco `[Conhecimento: ...]` injetado pelo `sessionManager` (que cobre os três rótulos, pois a condição inclui os três) e o prompt só de Neurociência. O bloco injetado provavelmente basta para H16.2, mas a frente 1 da r1 para Teologia/Virtologia ficou implicitamente delegada ao bloco dinâmico, sem declaração explícita de que os prompts existentes já contêm (ou não) a trava.
- **Ação sugerida:** uma linha no §2.1 afirmando que os prompts de Teologia/Virtologia serão revisados na Fatia 2/3 para incluir a frase padronizada, ou que o bloco injetado a substitui.

### N3 [BAIXO]: `deriveTopicKey` pode produzir chave vazia equivalente para memórias distintas compostas só de stopwords
- **Local:** §2.2, comentário "frase só de stopwords: usa o texto cru como chave".
- **Evidência:** O fallback usa `text.trim().toLowerCase()` **sem** a normalização NFD/remoção de acentos aplicada no caminho normal. Duas memórias só-de-stopwords com grafias acentuadas diferentes ("não é" vs "nao e") não colidem — e, pior, o `!` e `createdAt` das duas é preservado separadamente mesmo sendo semanticamente idênticas. Caso de borda raro, mas trivialmente corrigível aplicando a mesma normalização no fallback.
- **Ação sugerida:** normalizar o fallback com o mesmo pipeline (lowercase + NFD + strip) antes de usar como chave.

### N4 [BAIXO]: Duplicata `NeurocienciaAgent` no código é desviada para "auditoria de código", sem critério que trave
- **Local:** §2.1, nota de reconciliação; §4 Fatia 2.
- **Evidência:** Igual ao achado N5 da F15: o plano registra corretamente o desvio (duplicata idêntica fora da `IAgent` real) e manda corrigir antes, mas a tabela H16 não inclui pré-condição de compilação (`tsc --noEmit` limpo). Com a duplicata, `tsc` falha hoje — então na prática o harness não roda sem a correção, o que reduz a gravidade para BAIXO.
- **Ação sugerida:** mencionar na Fatia 5 que a suíte só roda com `tsc --noEmit` limpo.

---

## 3. Veredicto da Fase 16 (v3)

**APROVÁVEL COM RESSALVAS.**

- Os 2 CRÍTICOS da r1 estão resolvidos com mecanismo real: bloco de limite injetado no ramo vazio do `sessionManager` e algoritmo completo de resolução de conflitos com fundamentação contra o código real.
- Nenhum achado novo ALTO ou CRÍTICO.
- Ressalvas: N1 merece tratamento antes da Fatia 5 (log de supressão + fixture de fato aditivo), pois é o único risco novo com impacto em dado do usuário; N2–N4 são ajustes de uma linha.
- Critério do projeto ("achados altos não resolvidos bloqueiam a aprovação") é atendido: não há alto não resolvido.
