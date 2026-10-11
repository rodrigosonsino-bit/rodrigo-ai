# Auditoria Crítica do Plano da Fase 16 (v3) — Rodada 3

- **Data:** 2026-10-10
- **Objeto auditado:** `docs/phase-16-v3.md`
- **Documentos de referência:** `docs/audits/phase-16-plan-audit-r1.md`, `docs/audits/phase-16-plan-audit-r2.md`, `docs/phase-16-v1.md`, `docs/phase-16-v2.md`
- **Autor da auditoria:** Subagente Auditor de Plano
- **Veredicto Final:** **APROVÁVEL COM RESSALVAS** (nenhum achado novo ALTO ou CRÍTICO; 1 MÉDIO e 4 BAIXOS registrados abaixo)

---

## 1. Reconciliação achado-por-achado contra a r2

| # | Achado r2 | Gravidade r2 | Veredicto r3 | Evidência na v3 |
|---|---|---|---|---|
| N1 | `resolveConflicts` pode apagar silenciosamente fatos cumulativos | MÉDIO | **PARCIAL** | §2.2: adicionou `logSuppression` obrigatório (registro em `ExecutionTrace` de cada supressão com chave e `createdAt`) + §3 fixtures incluem `kind='cumulative'` com >=5 cenários medindo taxa de falso-agrupamento. **Falta:** o log proposto (`logSuppression`) não tem assinatura nem destino especificado (arquivo? `ExecutionTrace`? console?). A mitigação existe no papel, mas a implementação concreta do log fica aberta. |
| N2 | Trava de limite por prompt só especificada para Neurociência | BAIXO | **RESOLVIDO** | §2.1: declara explicitamente "os prompts de Teologia e Virtologia serão revisados na Fatia 2 para conter a mesma frase padronizada de limite". |
| N3 | Fallback de `deriveTopicKey` sem normalização NFD | BAIXO | **RESOLVIDO** | §2.2: `normalize()` aplicada também no fallback (`if (words.length === 0) return normalize(text).trim();`). |
| N4 | Duplicata `NeurocienciaAgent` sem critério que trave | BAIXO | **RESOLVIDO** | §4 Fatia 5: pré-condição `tsc --noEmit` limpo. A duplicata faz `tsc` falhar hoje, então o harness não roda sem correção — trava real. |

**Placar r2:** 3 RESOLVIDOS, 1 PARCIAL (N1 — log de supressão sem assinatura/destino).

---

## 2. Novos achados introduzidos pela v3 (ajustes pós-r2)

### N1 [MÉDIO]: `logSuppression` em `resolveConflicts` sem assinatura, destino ou formato definido
- **Local:** §2.2, comentário: `logSuppression(key, existing, it)` e `logSuppression(key, it, existing)` — chamado mas não declarado.
- **Evidência:** A função `logSuppression` é invocada duas vezes no algoritmo mas **não existe** no arquivo `conflictResolver.ts` proposto. Não há: (a) assinatura TypeScript; (b) destino do log (`ExecutionTrace`? `console`? arquivo dedicado?); (c) formato do registro (JSON? texto? inclui `turnId`?); (d) se o log é síncrono/assíncrono e se falha silenciosamente. O plano diz "registro obrigatório" mas não diz **como**.
- **Impacto:** Implementação da Fatia 4 não pode completar o `conflictResolver.ts` sem esta definição; auditoria de código posterior não terá critério para validar se o log foi feito corretamente.
- **Ação sugerida:** Adicionar em §2.2 ou Fatia 4 a declaração completa:
  ```ts
  interface SuppressionLogEntry {
    timestamp: string;        // ISO
    topicKey: string;
    suppressed: { text: string; createdAt: string };
    kept: { text: string; createdAt: string };
    reason: 'preference_update' | 'cumulative_false_positive' | 'unknown';
  }
  function logSuppression(entry: SuppressionLogEntry): void; // escreve em ExecutionTrace + console.warn
  ```

### N2 [BAIXO]: `deriveTopicKey` usa `slice(0, 4)` após ordenação — perde informação posicional que poderia distinguir tópicos
- **Local:** §2.2: `return words.slice(0, 4).sort().join('_');`.
- **Evidência:** A ordenação alfabética dos 4 termos mais frequentes (após remoção de stopwords) faz "café açúcar gosto" e "açúcar café prefiro" gerarem a mesma chave `açúcar_café_gosto_prefiro` — correto para preferências. Mas para fatos cumulativos como "irmã Ana mora SP" vs "irmã Ana anos 40", a chave seria `ana_anos_irmã_mora` vs `ana_anos_irmã_40` (diferentes, ok). O risco real é colisão de tópicos **diferentes** que compartilham 4+ palavras raras (ex.: "gato preto dorme sofá" vs "gato preto come peixe" → ambos `come_dorme_gato_peixe` vs `come_dorme_gato_peixe` — colisão). O plano admite isso ("limite conhecido"), mas não propõe mitigação além do log.
- **Impacto:** Baixo — o heurístico é declarado como tal; a suíte de 60 cenários (H16.3) medirá a taxa real. Não há promessa de zero colisão.
- **Ação sugerida:** Considerar `slice(0, 5)` ou incluir bigramas; ou documentar que a taxa alvo de falso-positivo em H16.3 é ≤5% (hoje H16.3 só diz "≥95% usa o fato mais recente" — métrica de acerto, não de falso-agrupamento).

### N3 [BAIXO]: H16.3 (60 cenários) mede "usa o fato mais recente" mas não mede "não suprimiu fato aditivo válido"
- **Local:** §5 Tabela H16.3: "60 cenários de memória (antigos/recentes/conflitantes) >= 95% usam o fato mais recente".
- **Evidência:** O critério H16.3 valida apenas que a entrada mais recente (por `createdAt`) sobreviveu. Não valida que entradas **aditivas** (ex.: "irmã Ana mora SP" + "irmã Ana fez 40 anos") **não foram suprimidas** — ambas deveriam sobreviver porque não são conflito de preferência. Os fixtures §3 incluem `kind='cumulative'` com `expectedSurvivorText` listando AMBAS, mas o critério de aceite H16.3 não exige passar nesses cenários especificamente.
- **Impacto:** Baixo — os fixtures medem, mas o critério de aceite oficial não cobra. Risco de "passa no harness" mas falha silenciosa em fato aditivo.
- **Ação sugerida:** Adicionar em H16.3: "e 0 supressão indevida nos cenários `kind='cumulative'` (≥5 incluídos)" — ou criar H16.5 dedicado.

### N4 [BAIXO]: `NEUROCIENCIA_PROMPT` não contém a frase padronizada de limite ("declare explicitamente que não encontrou a posição registrada...")
- **Local:** §2.3 `NEUROCIENCIA_PROMPT` vs. §2.1 bloco injetado.
- **Evidência:** O bloco injetado pelo `sessionManager` (§2.1) já contém a frase: `[Conhecimento: O corpus não contém informações sobre "...". O sistema DEVE declarar explicitamente que não encontrou a posição registrada do usuário sobre isso, sem adivinhar.]`. O prompt de Neurociência (§2.3) **não** contém essa instrução — só isenção médica. A r1 (frente 1) pediu a trava **no prompt do especialista** para todos os três. A v3 delega ao bloco injetado (que funciona pois a condição testa os 3 rótulos), mas o prompt de Neurociência fica inconsistente com Teologia/Virtologia (que §2.1 diz que serão revisados na Fatia 2).
- **Impacto:** Baixo — o bloco injetado já garante o comportamento em runtime; mas a inconsistência entre prompts pode confundir auditoria de código ou manutenção futura.
- **Ação sugerida:** Adicionar a frase padronizada ao `NEUROCIENCIA_PROMPT` no §2.3 (uma linha), ou declarar explicitamente que o bloco injetado substitui a necessidade no prompt (e fazer o mesmo para Teologia/Virtologia na Fatia 2).

### N5 [BAIXO]: Fixtures de conhecimento (H16.1/H16.2) não definem corpus de fixture isolado — risco de vazamento do `docs/research/` real
- **Local:** §3: "conhecimento usa corpus de fixture isolado (não `docs/research/` real — boa decisão de isolamento)".
- **Evidência:** O plano afirma a decisão mas não especifica: (a) onde o corpus de fixture fica (arquivo/caminho); (b) schema do corpus (mesmo formato de `docs/research/`?); (c) como o `KnowledgeRetriever` é instanciado apontando para o fixture em teste vs. real em produção. Sem isso, a implementação do harness pode acidentalmente ler o corpus real do usuário, vazando dados pessoais nos logs de teste e tornando testes não-determinísticos.
- **Impacto:** Baixo — decisão correta declarada, mas implementação faltando especificação.
- **Ação sugerida:** Adicionar em §3 ou Fatia 5: `src/backend/__tests__/fixtures/phase16-corpus/` com estrutura espelhada de `docs/research/` (ex.: `teologia/*.md`, `virtologia/*.md`, `neurociencia/*.md`) e injeção via `process.env.RODRIGO_KNOWLEDGE_ROOT` ou similar no `KnowledgeRetriever` para testes.

---

## 3. Veredicto da Fase 16 (v3)

**APROVÁVEL COM RESSALVAS.**

- Todos os achados CRÍTICOS/ALTOS da r1 estão **RESOLVIDOS** com mecanismo real (bloco de limite injetado, algoritmo completo `conflictResolver.ts`, 4 arquivos listados, prompt de Neurociência, ancoragens `file:line`, fixtures com schema, coluna "quem mede", circuit breaker).
- 3 de 4 achados da r2 **RESOLVIDOS**; 1 **PARCIAL** (N1 — log de supressão sem assinatura/destino).
- **Nenhum achado novo ALTO ou CRÍTICO.**
- **1 MÉDIO novo** (N1: `logSuppression` sem assinatura/destino) — precisa ser definido antes/durante Fatia 4, mas não bloqueia aprovação do plano.
- **4 BAIXOS novos** (N2–N5) — ajustes de heurística, métrica de harness, consistência de prompt, especificação de fixture.
- Critério do projeto ("achados altos não resolvidos bloqueiam a aprovação") **atendido**: não há alto não resolvido.

---

## 4. Pontos de atenção para a implementação (não bloqueiam aprovação)

1. **Fatia 2 não avança sem `tsc --noEmit` limpo** — duplicata `NeurocienciaAgent` em `specialistAgents.ts` fora da `IAgent` real trava compilação hoje. §4 Fatia 5 já exige isso.
2. **Fatia 4 (`conflictResolver.ts`)** precisa da assinatura e implementação de `logSuppression` (N1 acima) — sem isso o "registro obrigatório" não é testável.
3. **Fatia 5 (harness)** precisa do corpus de fixture isolado especificado (N5) para evitar vazamento de `docs/research/` real.
4. **H16.4 (40 comparações cegas, ≥70% preferência usuário)** permanece **PENDENTE (Usuário)** — não automatizável; requer agendamento com o usuário.
5. **Prompts de Teologia/Virtologia** — §2.1 promete revisão na Fatia 2 para incluir frase padronizada de limite; verificar se o bloco injetado já torna isso redundante ou se ambos coexistem.