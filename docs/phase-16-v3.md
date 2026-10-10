# Fase 16 — Conhecimento Pessoal Avançado e Novas Bases (plano v3)

Data: 2026-10-09. Autor: Orquestrador. Estado: **proposto para nova auditoria — NÃO aprovado**.
Substitui `docs/phase-16-v2.md`. Motivo: reconciliação direta contra `docs/audits/phase-16-plan-audit-r1.md`
(§6 deste documento) encontrou 1 achado CRÍTICO que a v2 resolveu só em prosa, sem algoritmo (a r1 pediu
exatamente "função/pseudocódigo", "zero especificação de código" era a queixa original), e 1 achado MÉDIO
(fixtures de teste) ainda sem especificação. O resto da v2 (achados 1, 3, 4, 5 parcial, 7, 8) está correto e
é mantido sem mudança — ver §6.

> Atualização 2026-10-10 (r2): os achados da auditoria da rodada 2 (`docs/audits/phase-16-plan-audit-r2.md`)
> foram incorporados — ver §7. Veredicto da r2: **APROVÁVEL COM RESSALVAS** (nenhum achado novo ALTO/CRÍTICO).

---

## 1. Contexto, Ancoragem no Código e Objetivos

*(Inalterado da v2.)* A Fase 16 integra o conhecimento do usuário para respostas factuais e fiéis,
eliminando alucinações de preferências pessoais (Teologia, Virtologia, Neurociência). Quando o usuário faz
uma pergunta de conhecimento: (1) o classificador roteia para um especialista; (2) o `SessionManager` busca
no `KnowledgeRetriever` e injeta uma trava explícita quando não há trecho; (3) memórias conflitantes são
resolvidas deterministicamente — especificado agora no §3 (era prosa solta na v2).

---

## 2. Mudanças e Correções de Arquitetura (mantido da v2, inalterado)

### 2.1 Rótulo `NEUROCIENCIA` e Injeção em `sessionManager.ts` (~linha 744)

```ts
if (handledLabel === 'TEOLOGIA' || handledLabel === 'VIRTOLOGIA' || handledLabel === 'NEUROCIENCIA') {
  const agentKey = handledLabel.toLowerCase();
  const chunkBlock = this.knowledgeRetriever ? this.knowledgeRetriever.retrieve(agentKey, transcript) : '';
  if (chunkBlock) {
    baseBlocks.push(chunkBlock);
  } else {
    baseBlocks.push(`[Conhecimento: O corpus não contém informações sobre "${transcript}". O sistema DEVE declarar explicitamente que não encontrou a posição registrada do usuário sobre isso, sem adivinhar.]`);
  }
}
```

O bloco injetado acima cobre os três rótulos (a condição testa `TEOLOGIA || VIRTOLOGIA || NEUROCIENCIA`), então
H16.2 é atendido por ele. Quanto à trava nos prompts de sistema (frente 1 da r1): o `NEUROCIENCIA_PROMPT`
completo está no §2.3; **os prompts de Teologia e Virtologia serão revisados na Fatia 2 para conter a mesma
frase padronizada de limite** (declarar que não achou a posição registrada, sem adivinhar) — decisão explícita
desta v3, para não deixar a frente 1 da r1 implicitamente delegada ao bloco dinâmico (achado r2 N2).

Também atualiza `CLASSIFICATION_LABELS` em `mlxWorkerEngine.ts`, `createSpecialistAgents()` em
`specialistAgents.ts` e `main.ts` (frontend) — os 4 arquivos que a r1 (achado 3) cobrou.

**Nota de reconciliação de código, verificada agora:** o código já escrito em `specialistAgents.ts` (não
commitado) define `NeurocienciaAgent` **duas vezes, idêntico**, e em nenhuma das duas versões no formato
real de `IAgent` (`id`, `name`, `role`, `isAvailable()`, `getSystemPrompt()` — ver
`src/shared/extensions/agents.ts`); o código usa `domain`/`processQuery()`, que não existem nessa
interface. Isto não é um defeito desta v3 nem da v2 — nenhuma versão do plano jamais especificou esse
formato. É uma correção de código (deletar a duplicata, reescrever contra a interface real), não de plano;
registrado aqui para não se perder antes da próxima auditoria de código.

### 2.2 Resolução Determinística de Memórias Conflitantes — especificação completa (substitui a v2)

**O que a v2 dizia e por que não bastava:** uma frase ("deduplicação por similaridade... preservando o
`updatedAt` ou `createdAt` maior") sem função, sem algoritmo, sem arquivo:linha — exatamente a ausência que
a r1 (achado 2, CRÍTICO) cobrou. Verificação feita agora contra o código real
(`src/backend/storage/jsonStore.ts:12-19`): `StoredItem` **não tem campo `updatedAt`** — só `createdAt`.
Verificação feita agora contra `src/backend/tools/mutatingTools.ts:459-485` (`MemoriaTool.execute`,
`MEMORIA_EDITAR`): a edição **muta o item em memória no lugar** (`store.items[idx] = {...}`), sem tocar
`createdAt` — então `createdAt` reflete corretamente "quando esta entrada distinta foi criada", que é
exatamente o que o cenário da r1 precisa (duas entradas *separadas*, uma de jan/2026 e outra de out/2026).
A v2 estava certa em usar um carimbo de tempo; estava errada no nome do campo, e nunca disse como agrupar
"mesmo assunto".

**Algoritmo (novo arquivo `src/backend/memory/conflictResolver.ts`, consumido por `memoryBlock.ts:6` antes
da linha `const recent = items.slice(-MAX_MEMORIES_INJECTED).reverse();`):**

```ts
import type { StoredItem } from '../storage/jsonStore.js';

// Palavras que carregam zero informação de tópico para memórias de preferência pessoal —
// inclui verbos comuns de preferência/posse, porque o que importa pra deduplicar é o OBJETO
// ("café", "açúcar"), não o verbo ("gosto" vs "tomo" vs "prefiro") nem a negação ("sem").
// Isto é deliberado: o objetivo é agrupar por ASSUNTO pra decidir qual é mais recente, não
// entender a relação semântica entre as duas — essa segunda tarefa ficaria genuinamente mais
// cara (exigiria embeddings ou chamada a LLM) e não está no escopo desta fase.
const TOPIC_STOPWORDS = new Set([
  'eu', 'o', 'a', 'os', 'as', 'de', 'da', 'do', 'das', 'dos', 'que', 'e', 'é', 'um', 'uma',
  'com', 'sem', 'para', 'por', 'em', 'no', 'na', 'meu', 'minha', 'me', 'nao', 'não',
  'gosto', 'gosta', 'prefiro', 'prefere', 'quero', 'quer', 'tomo', 'toma', 'bebo', 'bebe',
  'como', 'come', 'uso', 'usa', 'sou', 'é', 'tenho', 'tem'
]);

export function deriveTopicKey(text: string): string {
  const normalize = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '');
  const words = normalize(text)
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TOPIC_STOPWORDS.has(w));
  // Fallback (achado r2 N3): aplica a MESMA normalização no texto-cru — antes, frases só de
  // stopwords com grafias acentuadas diferentes ("não é" vs "nao e") não colidiam por engano.
  if (words.length === 0) return normalize(text).trim();
  return words.slice(0, 4).sort().join('_'); // ordenado: ordem de palavras na frase não deveria mudar o agrupamento
}

/** Agrupa por tópico derivado, mantém só a entrada mais recente (createdAt maior) de cada grupo.
 *  Determinístico: mesma entrada, mesmo resultado, sempre — sem chamada de rede nem de LLM.
 *  REGISTRO OBRIGATÓRIO (achado r2 N1): toda entrada suprimida é logada em `ExecutionTrace` com a chave
 *  e o `createdAt`, para auditoria e para responder "por que você esqueceu X?" — a supressão não é
 *  silenciosa. Este log é o que torna o risco de falso-agrupamento observável em vez de invisível. */
export function resolveConflicts(items: readonly StoredItem[]): StoredItem[] {
  const byKey = new Map<string, StoredItem>();
  for (const it of items) {
    const key = deriveTopicKey(it.text);
    const existing = byKey.get(key);
    if (!existing || it.createdAt > existing.createdAt) {
      if (existing) logSuppression(key, existing, it); // suprimiu `existing` em favor de `it`
      byKey.set(key, it);
    } else {
      logSuppression(key, it, existing); // suprimiu `it` em favor de `existing`
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
```

`buildMemoryBlock` (`memoryBlock.ts:6`) passa a chamar `resolveConflicts(items)` antes do `.slice(-MAX_MEMORIES_INJECTED)` atual — dedup primeiro, corte de tamanho depois (na ordem inversa, o corte poderia descartar a entrada nova e manter a velha, exatamente o bug que isto existe para evitar).

**Limite conhecido e declarado, não escondido:** `deriveTopicKey` é um heurístico lexical, não semântico.
Duas memórias sobre o mesmo assunto com vocabulário totalmente diferente ("gosto de café com açúcar" vs
"prefiro minha bebida da manhã adocicada") **não** vão colidir — ficam como duas entradas separadas, sem
regressão (hoje nenhuma das duas colide também, então não piora nada). Memórias sobre assuntos genuinamente
diferentes que compartilham 4 palavras pouco comuns podem colidir por engano. A suíte de teste abaixo (§4)
existe para medir a taxa real de cada erro antes de confiar no número "95%" do critério H16.3 — não assumir
que o heurístico já está calibrado.

**Limite que exige cuidado adicional (achado r2 N1):** "mais recente vence" **apaga a entrada antiga do bloco
de memória**. Para preferências mutáveis ("café sem açúcar" → "café com adoçante") isso é correto; mas para
fatos *cumulativos* sobre o mesmo tópico ("minha irmã Ana mora em SP" / "minha irmã Ana fez 40 anos") a
colisão destruiria informação válida. Isto não é resolvido pelo heurístico lexical — é mitigado por dois
gatilhos obrigatórios: (a) o `logSuppression` acima (toda supressão fica auditável), e (b) o fixture de
fato-aditivo abaixo, que mede a taxa de falso-agrupamento em vez de assumir zero.

### 2.3 Prompt de Sistema para Neurociência (inalterado da v2)

```ts
const NEUROCIENCIA_PROMPT =
  'Você é o Especialista em Neurociência, neurobiologia da mente e aprendizagem. ' +
  'Suas respostas devem ser estritamente baseadas nos princípios científicos e no material de referência ' +
  'do usuário, se aplicável. Você NÃO prescreve tratamentos médicos e NÃO diagnostica condições clínicas.';
```

---

## 3. Fixtures e Harness de Teste (novo — resolve achado 6 [MÉDIO] da r1)

A r1 pediu onde os 180 cenários (80+40+60) ficam guardados e o schema. Proposta:

```
src/backend/__tests__/fixtures/phase16-knowledge-questions.json   // H16.1 — 80 itens
src/backend/__tests__/fixtures/phase16-knowledge-outofcorpus.json // H16.2 — 40 itens
src/backend/__tests__/fixtures/phase16-memory-scenarios.json      // H16.3 — 60 itens
```

Schema comum (um objeto por cenário):

```ts
interface KnowledgeFixtureCase {
  id: string;                 // ex. "H16.1-003"
  question: string;           // pergunta de voz simulada
  expectedLabel: 'TEOLOGIA' | 'VIRTOLOGIA' | 'NEUROCIENCIA';
  expectedSourceRef?: string; // referência esperada no corpus (H16.1 só)
  expectRecognizedLimit?: boolean; // true pra H16.2 (espera reconhecer limite, não resposta)
}

interface MemoryFixtureCase {
  id: string;                 // ex. "H16.3-012"
  items: Array<{ text: string; createdAt: string }>; // histórico simulado, ordem de criação
  expectedSurvivorText: string; // qual entrada deveria sobreviver à resolução de conflito
  // NOVO (achado r2 N1): casos de fato ADITIVO sobre o mesmo tópico, onde o esperado é que
  // NENHUMA entrada seja suprimida. Ao menos 5 dos 60 cenários usam kind='cumulative' com
  // expectedSurvivorText listando AMBAS as entradas — mede a taxa real de falso-agrupamento.
  kind?: 'preference' | 'cumulative';
}
```

`src/backend/__tests__/phase16.test.ts` lê os três arquivos, roda `resolveConflicts()` direto (sem mock de
LLM) para os casos de memória, e usa o motor de conhecimento real com um corpus de fixture isolado (não
`docs/research/` real do usuário) para os casos de H16.1/H16.2.

---

## 4. Fatias de Implementação da Fase 16 (atualizado)

- **Fatia 1:** `OrchestratorLabel` (protocolo, `mlxWorkerEngine.ts`, `main.ts`).
- **Fatia 2:** `NeurocienciaAgent` **corrigido contra a `IAgent` real** (ver nota §2.1), prompt de sistema,
  `createSpecialistAgents()`, `corpus.ts`.
- **Fatia 3:** Injeção de trava de limite em `sessionManager.ts` quando a busca retornar vazia.
- **Fatia 4:** `src/backend/memory/conflictResolver.ts` (§2.2) + integração em `memoryBlock.ts`.
- **Fatia 5:** Fixtures (§3, incluindo os casos `kind='cumulative'`, achado r2 N1) + `phase16.test.ts`.
  **Pré-condição verificável (achado r2 N4): `npx tsc -p tsconfig.server.json --noEmit` limpo** — a suíte não
  roda com a duplicata de `NeurocienciaAgent` que o `tsc` acusa hoje.

---

## 5. Tabela de Critérios de Aceite (Harness H16) — inalterada da v2

| ID | Critério | Medição |
|---|---|---|
| H16.1 | 80 perguntas com referência esperada definida antes >= 90% corretas e compatíveis com o material, zero citação inventada | Agente (Testes) |
| H16.2 | 40 perguntas sem resposta no corpus >= 95% reconhecem o limite | Agente (Testes) |
| H16.3 | 60 cenários de memória (antigos/recentes/conflitantes) >= 95% usam o fato mais recente | Agente (Testes) |
| H16.4 | 40 comparações cegas com >= 70% de preferência do usuário pela versão personalizada | **PENDENTE (Usuário)** |

*(Nota de Segurança, inalterada: o projeto segue o circuito de max 3 fatias de código seguidas por auditoria rigorosa de código.)*

---

## 6. Reconciliação achado-por-achado contra `docs/audits/phase-16-plan-audit-r1.md`

| Achado r1 | Gravidade | Status na v2 | Status nesta v3 |
|---|---|---|---|
| 1. Preamble não injetado quando corpus vazio | CRÍTICO | Resolvido | Mantido |
| 2. Resolução de memórias conflitantes sem algoritmo | CRÍTICO | **Não resolvido (só prosa)** | Resolvido (§2.2, código completo) |
| 3. Faltam 4 arquivos na integração do `NeurocienciaAgent` | ALTO | Resolvido | Mantido |
| 4. Falta o texto do `NEUROCIENCIA_PROMPT` | ALTO | Resolvido | Mantido |
| 5. Ausência de ancoragem `file:line` | ALTO | Parcial | Esta v3 cita `jsonStore.ts:12-19` e `mutatingTools.ts:459-485` para fundamentar §2.2 |
| 6. Falta schema de fixture/harness de teste | MÉDIO | **Não resolvido** | Resolvido (§3) |
| 7. Coluna "quem mede" ausente | MÉDIO | Resolvido | Mantido |
| 8. Falta seção de Circuit Breaker | BAIXA | Resolvido | Mantido |

---

## 7. Reconciliação contra `docs/audits/phase-16-plan-audit-r2.md` (incorporada em 2026-10-10)

| Achado r2 | Gravidade | Onde foi tratado nesta v3 |
|---|---|---|
| N1. `resolveConflicts` pode apagar silenciosamente fatos cumulativos | MÉDIO | §2.2 (`logSuppression` obrigatório + limite declarado) e §3 (`MemoryFixtureCase.kind='cumulative'`, >=5 cenários de fato aditivo) + Fatia 5 |
| N2. Trava de limite por prompt só especificada para Neurociência | BAIXO | §2.1: declara explicitamente que Teologia/Virtologia recebem a frase padronizada na Fatia 2 |
| N3. Fallback de `deriveTopicKey` sem normalização NFD | BAIXO | §2.2: `normalize()` aplicado também ao fallback |
| N4. Duplicata de `NeurocienciaAgent` sem critério que trave | BAIXO | §4 Fatia 5: `tsc --noEmit` limpo como pré-condição verificável |

Nenhum achado ALTO/CRÍTICO novo — veredicto r2 **APROVÁVEL COM RESSALVAS**, mantido.
