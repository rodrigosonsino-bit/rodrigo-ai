# Fase 16 — Conhecimento Pessoal Avançado e Novas Bases (plano v2)

Data: 2026-10-09. Autor: Orquestrador. Estado: **Aprovado para implementação**.
Substitui `docs/phase-16-v1.md` (REFAZER — auditoria em `docs/audits/phase-16-plan-audit-r1.md`).

---

## 1. Contexto, Ancoragem no Código e Objetivos

A Fase 16 integra o conhecimento do usuário para respostas factuais e fiéis, eliminando alucinações de preferências pessoais (ex.: Teologia, Virtologia, e a nova base de Neurociência).

Quando o usuário faz uma pergunta de conhecimento:
1. O classificador de intenção roteia para um dos especialistas (`TEOLOGIA`, `VIRTOLOGIA` ou `NEUROCIENCIA`).
2. O `SessionManager` busca o conhecimento correspondente no `KnowledgeRetriever`. Se nenhum trecho for encontrado (assunto fora do corpus), ele INJETA uma instrução explícita no sistema para reconhecer o limite.
3. Se houver conflito temporal nas memórias recuperadas para o contexto, um algoritmo de deduplicação preserva apenas o fato mais recente.

---

## 2. Mudanças e Correções de Arquitetura

### 2.1 Adição do Rótulo `NEUROCIENCIA` e Injeção em `sessionManager.ts`
A busca de conhecimento hoje é feita apenas para `TEOLOGIA` e `VIRTOLOGIA`.
```ts
// src/backend/voice/sessionManager.ts ~linha 744:
if (handledLabel === 'TEOLOGIA' || handledLabel === 'VIRTOLOGIA' || handledLabel === 'NEUROCIENCIA') {
  const agentKey = handledLabel.toLowerCase();
  const chunkBlock = this.knowledgeRetriever ? this.knowledgeRetriever.retrieve(agentKey, transcript) : '';
  if (chunkBlock) {
    baseBlocks.push(chunkBlock);
  } else {
    // Correção Crítica F16: Injeção quando NÃO há conhecimento
    baseBlocks.push(`[Conhecimento: O corpus não contém informações sobre "${transcript}". O sistema DEVE declarar explicitamente que não encontrou a posição registrada do usuário sobre isso, sem adivinhar.]`);
  }
}
```

Também será atualizado o `CLASSIFICATION_LABELS` em `mlxWorkerEngine.ts`, o `createSpecialistAgents()` em `specialistAgents.ts` e o `main.ts` (frontend).

### 2.2 Resolução Determinística de Memórias Conflitantes (`memoryBlock.ts`)
Para evitar que o LLM escolha aleatoriamente entre um *"gosto de café com açúcar"* antigo e um *"tomo café sem açúcar"* novo, as memórias recuperadas passarão por uma deduplicação por similaridade no momento do build do bloco, preservando o `updatedAt` ou `createdAt` maior.

### 2.3 Prompt de Sistema para Neurociência
Em `src/backend/agents/specialistAgents.ts`:
```ts
const NEUROCIENCIA_PROMPT = 
  'Você é o Especialista em Neurociência, neurobiologia da mente e aprendizagem. ' +
  'Suas respostas devem ser estritamente baseadas nos princípios científicos e no material de referência ' +
  'do usuário, se aplicável. Você NÃO prescreve tratamentos médicos e NÃO diagnostica condições clínicas.';
```

---

## 3. Fatias de Implementação da Fase 16

- **Fatia 1:** Atualização de `OrchestratorLabel` (protocolo, `mlxWorkerEngine.ts`, `main.ts`).
- **Fatia 2:** Criação do `NeurocienciaAgent`, prompt de sistema e adição no `createSpecialistAgents()` e `corpus.ts`.
- **Fatia 3:** Refatoração de `sessionManager.ts` para garantir injeção de trava quando a busca de conhecimento retornar vazia (Reconhecimento de Limite).
- **Fatia 4:** Algoritmo de resolução temporal (deduplicação) em `src/backend/memory/index.ts`.
- **Fatia 5:** Suíte de testes automatizados `phase16.test.ts` com mocks para cenários fora-do-corpus e conflito de memórias.

---

## 4. Tabela de Critérios de Aceite (Harness H16)

| ID | Critério | Medição |
|---|---|---|
| H16.1 | 80 perguntas com referência esperada definida antes >= 90% corretas e compatíveis com o material, zero citação inventada | Agente (Testes) |
| H16.2 | 40 perguntas sem resposta no corpus >= 95% reconhecem o limite | Agente (Testes) |
| H16.3 | 60 cenários de memória (antigos/recentes/conflitantes) >= 95% usam o fato mais recente | Agente (Testes) |
| H16.4 | 40 comparações cegas com >= 70% de preferência do usuário pela versão personalizada | **PENDENTE (Usuário)** |

*(Nota de Segurança: O projeto segue o circuito de max 3 fatias de código seguidas por auditoria rigorosa de código, sob pena de bloqueio pelo Kimi.)*
