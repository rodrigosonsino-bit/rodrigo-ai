# Fase 16 — Conhecimento Pessoal Avançado e Novas Bases (plano v1)

Data: 2026-10-09. Autor: Orquestrador. Estado: **rascunho v1 para auditoria**.

## 1. Contexto e Objetivos

A Fase 16 aprimora a recuperação e aplicação do **conhecimento pessoal e especializado** do usuário:
1. **Atribuição Fiel e Ausência de Alucinação:** Os agentes de Teologia e Virtologia (e o agente de Neurociência) respondem com base rigorosa no corpus de conhecimento do usuário (`docs/research/`), sem inventar posições ou opiniões pessoais não sustentadas pelo texto.
2. **Reconhecimento de Limite de Conhecimento:** Se uma pergunta sobre a posição/visão do usuário não tiver resposta no corpus de conhecimento registrado, o sistema reconhece explicitamente o limite em vez de adivinhar (*"Não encontrei no seu material uma posição registrada sobre este tópico."*).
3. **Nova Base de Conhecimento — Neurociência:**
   - Adicionada a nova fonte `neurociencia-profile-source.md` em `docs/research/`.
   - Adicionado o novo agente especialista `NeurocienciaAgent` e registrada a fonte no `loadKnowledgeCorpus`.
4. **Resolução de Conflitos em Memórias:**
   - Quando houver memórias antigas vs. recentes em conflito, a memória com timestamp mais recente sobrescreve a anterior.

---

## 2. Mudanças na Arquitetura do Corpus (`src/backend/knowledge/`)

### 2.1 Atualização de `SOURCES` em `corpus.ts`
```ts
const SOURCES: ReadonlyArray<{ agentId: string; file: string }> = [
  { agentId: 'teologia', file: 'teologia-profile-source.md' },
  { agentId: 'virtologia', file: 'virtologia-profile-source.md' },
  { agentId: 'neurociencia', file: 'neurociencia-profile-source.md' }
];
```

### 2.2 Criação do `NeurocienciaAgent` (`src/backend/agents/specialistAgents.ts`)
- Agente dedicado com foco em neurociência, neurobiologia da mente e aprendizagem.
- Roteamento via `OrchestratorLabel` ou `NEUROCIENCIA` adicionado aos rótulos suportados.

---

## 3. Fatias de Implementação da Fase 16

- **Fatia 1:** Adição do arquivo fonte de Neurociência em `docs/research/neurociencia-profile-source.md` e atualização do `corpus.ts`.
- **Fatia 2:** Criação do `NeurocienciaAgent` e atualização dos rótulos de roteamento em `specialistAgents.ts` e `voiceProtocol.ts`.
- **Fatia 3:** Reforço do prompt do Preamble de Conhecimento (`KNOWLEDGE_PREAMBLE`) para garantir aviso explícito quando o tópico estiver fora do corpus ("Reconhecimento de Limite").
- **Fatia 4:** Suíte de testes H16 (80 perguntas de corpus, 40 perguntas fora do corpus, 60 cenários de resolução de memórias conflitantes).

---

## 4. Tabela de Critérios de Aceite (Harness H16)

| ID | Critério |
|---|---|
| H16.1 | 80 perguntas com referência esperada definida antes >= 90% corretas e compatíveis com o material, zero citação inventada |
| H16.2 | 40 perguntas sem resposta no corpus >= 95% reconhecem o limite |
| H16.3 | 60 cenários de memória (antigos/recentes/conflitantes) >= 95% usam o fato certo |
| H16.4 | 40 comparações cegas com >= 70% de preferência do usuário pela versão personalizada |
