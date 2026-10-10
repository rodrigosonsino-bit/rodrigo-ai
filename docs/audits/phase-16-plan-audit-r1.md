# Auditoria Crítica e Rigorosa do Plano da Fase 16 (v1)

- **Data:** 2026-10-09
- **Objeto auditado:** `docs/phase-16-v1.md`
- **Documentos de referência:** `docs/roadmap-2026-10-09.md` (Fase 16), `docs/prompt-proxima-sessao-2026-10-02.md`
- **Autor da auditoria:** Subagente Auditor de Plano
- **Veredicto Final:** **REFAZER**

---

## 1. Resumo Executivo e Veredicto

A auditoria analisou o plano da Fase 16 (`docs/phase-16-v1.md`) confrontando-o rigorosamente com os objetivos estipulados em `docs/roadmap-2026-10-09.md` e com o protocolo de desenvolvimento e planejamento definido em `docs/prompt-proxima-sessao-2026-10-02.md`.

A Fase 16 busca elevar o conhecimento pessoal e especializado do app em Teologia, Virtologia, Memória e na nova base de Neurociência, garantindo atribuição fiel sem alucinação, reconhecimento explícito de limites quando o assunto não consta no corpus e resolução determinística de memórias conflitantes.

Embora o plano rascunho v1 identifique as metas gerais, ele apresenta **falhas arquiteturais graves no tratamento de limites de conhecimento**, **ausência de especificação técnica e algorítmica para a resolução de memórias conflitantes**, **omissão de arquivos essenciais para o suporte do novo agente especialista**, **falta do prompt de sistema do novo agente**, e **ausência total de ancoragem em código existente (`file:line`)**.

Por essas razões, o veredicto é **REFAZER**. O plano deve ser completamente reescrito na versão `docs/phase-16-v2.md` sanando todos os achados apontados nesta auditoria.

---

## 2. Matriz de Conformidade com o Roadmap (`docs/roadmap-2026-10-09.md`)

| Requisito do Roadmap / Protocolo | Situação no Plano v1 | Avaliação |
|---|---|---|
| **1. Conhecimento pessoal (Teologia, Virtologia, Memória e Neurociência)** | Adiciona a fonte de Neurociência e menciona a criação do especialista. | ⚠️ **INCOMPLETO:** omite o prompt do `NeurocienciaAgent` e alterações em `sessionManager.ts` e `mlxWorkerEngine.ts`. |
| **2. Atribuição fiel ao corpus sem alucinação nem invenção de posições do usuário** | Mencionado no objetivo §1.1. | ⚠️ **INCOMPLETO:** falta especificação das travas de prompt em `specialistAgents.ts`. |
| **3. Reconhecimento explícito de limites quando o assunto não constar no corpus** | Mencionado em §1.2 e na Fatia 3 ("reforço do `KNOWLEDGE_PREAMBLE`"). | ❌ **FALHA DE DESIGN:** se não há correspondência no corpus, `retrieve()` retorna `[]` e o `KNOWLEDGE_PREAMBLE` nem é injetado! |
| **4. Resolução determinística de memórias conflitantes (fatos mais recentes)** | Afirmado em 1 frase no §1.4. | ❌ **OMISSÃO TÉCNICA:** zero especificação de código, algoritmo, ordenação ou trava de prompt em `memoryBlock.ts`. |
| **5. Tabela de critérios H16.1 a H16.4** | Presente na tabela do §4. | ⚠️ **PARCIAL:** omite a responsabilidade de medição ("Quem mede: Usuário" para H16.4) e alinhamento com protocolo de testes. |
| **6. Ancoragem em código real (`file:line`)** | Nenhuma linha de código ou arquivo de `src/backend/` é citado com localização exata. | ❌ **VIOLAÇÃO DO PROTOCOLO** |

---

## 3. Lista Numerada de Achados da Auditoria

### Achado 1 [CRÍTICO]: Falha Arquitetural no Reconhecimento de Limites de Conhecimento (Preamble Inexistente quando `chunks` é Vazio)
- **Local:** `docs/phase-16-v1.md` §3 (Fatia 3) e `src/backend/knowledge/retriever.ts` / `src/backend/voice/sessionManager.ts` (linhas 744-780).
- **Evidência:** O plano v1 propõe realizar o "reforço do prompt do Preamble de Conhecimento (`KNOWLEDGE_PREAMBLE`) para garantir aviso explícito quando o tópico estiver fora do corpus". No entanto, o fluxo do motor (`sessionManager.ts`) executa:
  ```ts
  const retrieved = this.retriever.retrieve(agentId, text);
  const knowledgeBlock = buildKnowledgeBlock(retrieved);
  ```
  Quando uma pergunta é feita sobre um tema ausente do corpus (ex.: as 40 perguntas de H16.2), `retriever.retrieve()` devolve um array vazio `[]`. Em `retriever.ts`, `buildKnowledgeBlock([])` retorna uma string vazia `''`. O `sessionManager.ts` filtra blocos vazios com `.filter((b) => b)`, OMITINDO completamente o `KNOWLEDGE_PREAMBLE` do prompt final!
- **Problema:** Mudar a redação do `KNOWLEDGE_PREAMBLE` tem efeito ZERO para perguntas onde o retriever não encontra trechos, pois o preâmbulo nem é injetado. O LLM fica sem instrução de limite e tende a opinar ou alucinar, falhando no teste H16.2 (>= 95% de reconhecimento de limite).
- **Ação Requerida:** No plano v2, o reconhecimento de limites deve ser endereçado em duas frentes:
  1. Atualizar o prompt dos agentes especialistas em `specialistAgents.ts` (`TeologiaAgent`, `VirtologiaAgent` e `NeurocienciaAgent`), instruindo-os a responder obrigatoriamente com a frase padronizada (*"Não encontrei no seu material uma posição registrada sobre este tópico."*) sempre que a pergunta consultar uma opinião/posição do usuário e não houver trecho do corpus fornecido ou se o trecho fornecido não contiver essa posição.
  2. Avaliar se o `buildKnowledgeBlock` ou o `sessionManager` deve injetar um aviso explícito de "Corpus consultado: nenhum trecho encontrado para esta pergunta" quando o agente acionado for um especialista.

---

### Achado 2 [CRÍTICO]: Omissão de Especificação Técnica e Algorítmica para Resolução de Memórias Conflitantes
- **Local:** `docs/phase-16-v1.md` §1.4 e `src/backend/memory/memoryBlock.ts` (linha 6).
- **Evidência:** O plano v1 se limita a declarar: *"Quando houver memórias antigas vs. recentes em conflito, a memória com timestamp mais recente sobrescreve a anterior"*. Não há trecho de código, interface, função de filtro nem alteração de prompt especificada.
- **Problema:** A implementação atual em `src/backend/memory/memoryBlock.ts` ordena as memórias mais recentes por `items.slice(-MAX_MEMORIES_INJECTED).reverse()` e gera uma lista simples com hífens. Se existirem memórias com fatos contraditórios registrados no passado (ex: *"Usuário prefere café sem açúcar"* gravado em jan/2026 vs *"Usuário prefere café com adoçante"* gravado em out/2026), AMBAS serão injetadas no bloco de memória. O LLM receberá instruções contraditórias sem qualquer regra de precedência explícita na mensagem de sistema.
- **Ação Requerida:** O plano v2 deve especificar detalhadamente:
  1. A atualização do prompt do bloco de memórias em `buildMemoryBlock` para instruir o LLM: *"As memórias abaixo estão ordenadas do fato mais recente para o mais antigo. Em caso de contradição ou conflito entre dois fatos, o fato mais recente (mais acima na lista) anula e prevalece sobre o fato antigo."*
  2. Se aplicável, uma função de deduplicação/resolução determinística no backend (`resolveConflictingMemories(items: StoredItem[])`) que identifique e filtre contradições diretas por chave/tópico antes da construção do bloco.

---

### Achado 3 [ALTO]: Omissão de Módulos Essenciais para a Integração do `NeurocienciaAgent`
- **Local:** `docs/phase-16-v1.md` §2.1, §2.2 e §3 (Fatia 2).
- **Evidência:** O plano v1 prevê atualizações apenas em `corpus.ts`, `specialistAgents.ts` e `voiceProtocol.ts`. No entanto, a integração de um novo agente especialista no Rodrigo AI exige alterações em pelo menos 4 outros arquivos da arquitetura:
  1. `src/backend/voice/sessionManager.ts` (linha 744):
     `if (this.privacy.sendKnowledge && this.retriever && (label === 'TEOLOGIA' || label === 'VIRTOLOGIA'))`
     Se `label === 'NEUROCIENCIA'` não for adicionado a essa condição, o `sessionManager` NÃO consultará o retriever e nenhum trecho de neurociência será injetado.
  2. `src/backend/voice/mlxWorkerEngine.ts` (linha 18 e prompt local):
     `const CLASSIFICATION_LABELS = new Set<OrchestratorLabel>(['GERAL', 'TEOLOGIA', 'VIRTOLOGIA', 'AMBIGUO']);`
     O classificador de intenção em worker local rejeitará o rótulo `NEUROCIENCIA` por não constar no conjunto permitido.
  3. `src/backend/agents/specialistAgents.ts` (função `createSpecialistAgents()`, linha 80):
     A fábrica precisa incluir `new NeurocienciaAgent()` na lista retornada para que o runtime registre o agente.
  4. `src/frontend/main.ts` (linha 233):
     Falta o mapeamento do rótulo para exibição na interface web (`NEUROCIENCIA: 'Neurociência'`).
- **Ação Requerida:** Mapear e detalhar as alterações necessárias nos 4 arquivos acima no plano v2.

---

### Achado 4 [ALTO]: Ausência do Prompt de Sistema do Agente (`NEUROCIENCIA_PROMPT`)
- **Local:** `docs/phase-16-v1.md` §2.2 (`specialistAgents.ts`).
- **Evidência:** O plano indica a criação do `NeurocienciaAgent`, mas omite o texto da constante `NEUROCIENCIA_PROMPT`.
- **Problema:** Sem a especificação literal do prompt, não há garantias sobre as diretrizes de identidade, tom (rigor acadêmico/científico), foco (neurobiologia da mente, aprendizagem, plasticidade), isenção de diagnósticos médicos/psiquiátricos e a trava estrita contra invenção de opiniões do usuário.
- **Ação Requerida:** Incluir no plano v2 o texto completo e revisado da constante `NEUROCIENCIA_PROMPT`.

---

### Achado 5 [ALTO]: Ausência Total de Ancoragem em Código Real (`file:line`)
- **Local:** `docs/phase-16-v1.md` (todo o documento).
- **Evidência:** O plano não inclui nenhuma referência de linha de código (`file:line`) para os arquivos `src/backend/knowledge/corpus.ts`, `src/backend/knowledge/retriever.ts`, `src/backend/agents/specialistAgents.ts`, `src/backend/voice/sessionManager.ts`, `src/shared/voiceProtocol.ts`, `src/backend/memory/memoryBlock.ts` ou `src/backend/voice/mlxWorkerEngine.ts`.
- **Problema:** Descumprimento direto do protocolo do projeto (`docs/prompt-proxima-sessao-2026-10-02.md` §6 - "Planejador").
- **Ação Requerida:** Ancorar rigorosamente cada fatia de implementação com nomes de arquivos e linhas exatas do código atual no plano v2.

---

### Achado 6 [MÉDIO]: Falta de Especificação dos Datasets de Fixture e do Harness do Teste H16
- **Local:** `docs/phase-16-v1.md` §3 (Fatia 4) e §4.
- **Evidência:** A Fatia 4 menciona genericamente "Suíte de testes H16".
- **Problema:** Os critérios H16.1 a H16.3 demandam 180 cenários de teste automatizados (80 perguntas do corpus, 40 fora do corpus, 60 cenários de memória). O plano não especifica onde esses datasets ficarão guardados (ex.: `src/backend/__tests__/fixtures/phase16-knowledge-questions.json` e `phase16-memory-scenarios.json`), qual a estrutura do schema do dataset nem a lógica do executor de testes determinístico em `src/backend/__tests__/phase16.test.ts`.
- **Ação Requerida:** Especificar no plano v2 os schemas dos arquivos JSON de fixture e a estrutura do arquivo de teste `phase16.test.ts`.

---

### Achado 7 [MÉDIO]: Desalinhamento na Tabela H16.4 com a Matriz de Responsabilidade do Usuário
- **Local:** `docs/phase-16-v1.md` §4 (H16.4).
- **Evidência:** A tabela de critérios de aceite lista H16.4 ("40 comparações cegas com >= 70% de preferência do usuário") sem especificar a coluna "Quem mede".
- **Problema:** O roadmap (`docs/roadmap-2026-10-09.md` §4) e a decisão de governança do projeto estipulam que critérios medidos pelo usuário não impedem o avanço do lado do agente e permanecem marcados como `PENDENTE` até a rodada final de testes do usuário.
- **Ação Requerida:** Adicionar a coluna "Quem mede" na tabela do plano v2 e registrar explicitamente o status `PENDENTE (Medição pelo Usuário no final)` para H16.4.

---

### Achado 8 [BAIXA]: Ausência do Protocolo de Gestão de Riscos e *Circuit Breaker*
- **Local:** `docs/phase-16-v1.md` (todo o documento).
- **Evidência:** O plano v1 omite a seção de Gestão de Riscos e a declaração de observância ao protocolo de *Circuit Breaker* (3+2 ciclos de ajuste).
- **Ação Requerida:** Incluir a seção de Gestão de Riscos e *Circuit Breaker* na versão v2.

---

## 4. Plano de Ação e Diretrizes para o Plano v2 (`docs/phase-16-v2.md`)

Para transformar o rascunho v1 em um plano aprovável e pronto para execução, a versão `docs/phase-16-v2.md` deverá obrigatoriamente:

1. **Reestruturar o Reconhecimento de Limites:**
   - Adicionar trava no prompt dos especialistas em `specialistAgents.ts` (`file:line`) exigindo a resposta padronizada *"Não encontrei no seu material uma posição registrada sobre este tópico."* para posições pessoais ausentes do corpus.
2. **Especificar a Resolução de Memórias Conflitantes:**
   - Atualizar `buildMemoryBlock` em `memoryBlock.ts` (`file:line`) com a instrução de precedência do fato mais recente sobre fatos antigos.
3. **Mapear a Integração Completa de `NeurocienciaAgent`:**
   - Atualizar `SOURCES` em `corpus.ts`.
   - Adicionar `NEUROCIENCIA_PROMPT` e instanciar em `createSpecialistAgents()` em `specialistAgents.ts`.
   - Atualizar `OrchestratorLabel` em `voiceProtocol.ts`.
   - Atualizar a checagem de busca de conhecimento em `sessionManager.ts` (linha 744).
   - Atualizar `CLASSIFICATION_LABELS` e o prompt em `mlxWorkerEngine.ts`.
   - Atualizar a interface de usuário em `main.ts`.
4. **Ancorar Todo o Plano em Código Real (`file:line`):**
   - Citar arquivos e números de linha exatos do estado atual do código para todas as fatias.
5. **Detalhar Fixtures e Suíte de Testes:**
   - Criar e descrever o schema dos arquivos de fixture JSON com os 180 cenários em `src/backend/__tests__/fixtures/` e a suíte `phase16.test.ts`.
6. **Alinhar a Tabela de Aceite e Incluir Seção de Riscos:**
   - Incluir a coluna "Quem mede" (agente vs usuário) e a seção de *Circuit Breaker*.

---

## 5. Conclusão da Auditoria

O rascunho v1 da Fase 16 traz boas intenções alinhadas com o roadmap, mas falha em nível arquitetural e técnico na entrega de garantias determinísticas. A reescrita no arquivo `docs/phase-16-v2.md` seguindo as diretrizes deste relatório garantirá uma implementação sólida, segura e perfeitamente integrada ao Rodrigo AI.
