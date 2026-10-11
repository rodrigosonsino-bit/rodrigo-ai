# Fase 15 — Procedimento de Recalibração de Orçamento (H15)

**Data:** 2026-10-11
**Status:** Ativo
**Origem:** `docs/phase-15-v3.md` §6 + achados r2 N3, r3 N5

---

## 1. Quando recalibrar

O harness H15 deve falhar em **H15.5** (estouro de orçamento) ou **H15.7** (média de chamadas/turno <= 3) quando os tetos atuais (`SUBAGENT_BUDGET`) estiverem desajustados com a realidade medida em produção. Sintomas:

- **H15.5 falhando com estouro em < 10 cenários adversariais** → o teto está alto demais (passa mais chamadas do que o usuário tipicamente precisa) OU baixo demais (estoura em casos legítimos).
- **H15.7 falhando com média > 3** → os 40 cenários multi-passo do H15.1 estão exigindo mais delegações do que o esperado; pode indicar que o decomposer está fragmentando demais, OU que o teto de 6 está otimista e deve subir.
- **H15.7 falhando com média muito abaixo de 3** → o teto pode estar alto demais; considere descer.

## 2. Procedimento passo a passo

### Passo 1 — Coletar métricas reais

Em produção ou staging com volume realista de turnos:

```bash
# Em logs, contar chamadas a subagentes por turnId
grep 'runSubAgentDelegation' log.jsonl | jq -r '.turnId' | sort | uniq -c | sort -n
```

Anotar:
- p50, p95, p99 de chamadas por turno.
- p50, p95 de duração total da orquestração (ms).
- Taxa de estouro observada por tipo (`max_calls`, `time`, `max_async`).

### Passo 2 — Calibrar teto de chamadas (`MAX_CALLS_PER_TURN`)

- Se p95 real ≤ 4 → manter 6 (folga saudável).
- Se p95 real entre 5-7 → subir para 8.
- Se p95 real > 7 → revisar decomposição antes de subir o teto; pode ser problema de decomposer.

Critério de aceite: H15.1 deve ter média ≤ 50% do novo teto (hoje, média ≤ 3 para teto 6).

### Passo 3 — Calibrar teto de tempo (`MAX_ORCHESTRATION_MS`)

- p99 real + 20% de margem, com mínimo de 30s e máximo de 120s.
- Se H15.5 foi executado com p99 > 60s em cenários legítimos, subir para 90s ou 120s.

### Passo 4 — Calibrar teto de async (`MAX_CONCURRENT_ASYNC`)

- Número de tarefas longas simultâneas observadas + 1 de folga.
- Se típicamente 0-1, manter 2. Se > 2, considerar 3 ou 4 com atenção ao consumo de CPU/memória.

### Passo 5 — Atualizar código

Editar `src/backend/agents/subAgent.ts`:

```ts
export const SUBAGENT_BUDGET = {
  MAX_CALLS_PER_TURN: NEW_VALUE_1,
  MAX_ORCHESTRATION_MS: NEW_VALUE_2,
  MAX_CONCURRENT_ASYNC: NEW_VALUE_3
} as const;
```

Adicionar comentário `/** Recalibrado YYYY-MM-DD conforme docs/phase-15-h15-recalibration.md */`.

### Passo 6 — Revalidar

```bash
npm run build:server
npm test
```

Esperado: **todos os testes H15.1–H15.7 verdes com os novos tetos.** A exceção permitida é o baseline do `fvScreen.test.js` (HV.3), que NÃO entra nesta validação.

### Passo 7 — Documentar decisão

Criar `docs/audits/phase-15-budget-recalibration-YYYY-MM-DD.md` com:
- Valores antigos vs. novos.
- Métricas que motivaram a mudança (com link para logs).
- Resultado da revalidação (print dos 6 testes H15 verdes).
- Assinatura de quem operou.

---

## 3. Anti-padrão a evitar

Nunca subir teto para fazer H15 "passar" sem investigar se o decomposer está fragmentando em excesso. Se H15.7 falhar duas vezes seguidas com o mesmo teto, o problema está na decomposição (Fase 15 anterior), não no orçamento.

---

## 4. Autoridade

Esta recalibração precisa de aprovação do owner do repo (Rodrigo) antes de entrar em produção. Teste local obrigatório e commit com prefixo `F15:`.
