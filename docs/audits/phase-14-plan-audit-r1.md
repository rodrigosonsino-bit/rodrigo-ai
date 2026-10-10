# Auditoria Crítica e Rigorosa: Plano da Fase 14 (v1)

**Data:** 2026-10-09  
**Objeto:** `docs/phase-14-v1.md`  
**Referência:** `docs/roadmap-2026-10-09.md` (Fase 14) & `docs/prompt-proxima-sessao-2026-10-02.md`  
**Autor da Auditoria:** Subagente Auditor de Plano  

---

## 1. Veredito

**VEREDITO: APROVADO COM AJUSTES**

O plano `docs/phase-14-v1.md` direciona corretamente o objetivo de fechar o ciclo de vida de notas, lembretes e memórias por voz (consulta, localização exata por conteúdo, reagendamento, resiliência e relógio injetável). Os critérios de aceite H14.1 a H14.4 refletem integralmente o roadmap.

No entanto, o documento em sua versão v1 possui **erros arquiteturais de protocolo, contradições internas, lacunas na maquina de estados de voz para ambiguidade, e ausência de especificação técnica para atomicidade de IO e injeção de Clock**. Esses pontos precisam ser corrigidos na versão v2 antes do início da implementação.

---

## 2. Conformidade com o Roadmap (`docs/roadmap-2026-10-09.md`)

| Requisito do Roadmap | Cobertura no Plano v1 | Avaliação |
| :--- | :--- | :--- |
| **Consulta e busca por voz** (notas, lembretes, memórias) | Presente no §2.1 e Fatia 1 | **Com Avaria:** confunde Consulta (leitura) com Mutação (confirmação). |
| **Localização exata por conteúdo** (substitui o mais recente) | Presente no §2.2 e Fatia 2 | **Incompleto:** não detalha o algoritmo de busca nem a máquina de estados para desambiguação. |
| **Reagendamento de lembretes e relógio injetável** | Presente no §2.3 e Fatia 3 | **Incompleto:** falta separar parsing de item vs. parsing de novo horário em `REAGENDAR`. |
| **Resiliência a reinício/falhas e tolerância de 10s** | Presente no §2.4, §5 e Fatia 4 | **Incompleto:** falta atomicidade de escrita no `JsonStore` e prevenção de *timer drift* no macOS. |

---

## 3. Lista Numerada de Achados (Pontos Cegos, Contradições e Lacunas)

### Achado 1 (CRÍTICA - Erro de Arquitetura de Protocolo): Errada inclusão de `*_CONSULTAR` em `MutationName`
- **Descrição:** No §3.1, o plano coloca `LEMBRETE_CONSULTAR`, `NOTA_CONSULTAR` e `MEMORIA_CONSULTAR` em `ToolName / MutationName`.
- **Impacto:** No protocolo do Rodrigo AI (`sessionManager.ts` e `mutatingTools.ts`), mutações exigem confirmação do usuário (*"Posso criar/apagar...?"*). Se a consulta for uma mutação, o app perguntaria *"Posso consultar seus lembretes?"* e aguardaria um "Sim", destruindo a experiência de busca por voz e violando o requisito de resposta direta falada.
- **Ajuste Exigido:** Consultas devem ser tratadas como **ferramentas de leitura instantânea** (estendendo `TOOL_NAMES` / `ITool` ou um leitor dedicado), executadas diretamente no fluxo de conversação sem confirmação (`PendingMutation`).

### Achado 2 (ALTA - Lacuna na Máquina de Estados de Voz): Ausência do protocolo de desambiguação
- **Descrição:** O §2.2 afirma: *"Se houver ambiguidade entre múltiplos itens parecidos, o app pergunta para confirmar qual item o usuário deseja alterar antes de executar a ação."*
- **Impacto:** O `sessionManager.ts` atualmente suporta apenas o estado de confirmação binária (`PendingMutation` esperando sim/não). Se o usuário tem duas notas (*"Remédio de alergia"* e *"Remédio de pressão"*) e diz *"Apaga a nota do remédio"*, o app precisa perguntar *"Você quer apagar a nota sobre alergia ou sobre pressão?"*. O plano v1 não especifica o estado `PendingDisambiguation`, como as opções são mantidas na sessão, nem como a fala seguinte do usuário é parseada para escolher a opção correta ou cancelar.
- **Ajuste Exigido:** Especificar em detalhes o estado `PendingDisambiguation` na `SessionManager`, o timeout da opção, o formato da pergunta e a gramática de seleção.

### Achado 3 (ALTA - Parser e Assinatura do Reagendamento): Estrutura de `LEMBRETE_REAGENDAR` não especificada
- **Descrição:** No §2.3 e Fatia 3, introduz-se o reagendamento. Porém, comandos como *"Passa o lembrete do remédio pras 15h"* ou *"Muda o lembrete da reunião de amanhã para sexta às 10h"* possuem dois componentes distintos: o matcher do item alvo e a especificação do novo horário.
- **Impacto:** O parser atual (`relativeTimeParser.ts`) analisa a frase inteira procurando expressões temporais e deixa o resto como `residualText`. Ao tentar aplicar isso no reagendamento sem um separador claro, o matcher do item pode capturar pedaços da expressão de tempo antiga ou nova, falhando na localização do item correto.
- **Ajuste Exigido:** Definir explicitamente a função de parsing de reagendamento em `relativeTimeParser.ts` (separando `targetQuery` de `newDueAt`/`newRecurrence`) e os métodos correspondentes na `LembreteTool`.

### Achado 4 (MÉDIA - Contradição Interna): "Busca Semântica" no §2.1 vs Normalização de Texto no §3.2
- **Descrição:** O §2.1 menciona *"Busca semântica e por palavra-chave no conteúdo das notas salvas"*. No entanto, o §3.2 e a Fatia 1 definem apenas *"Índice de busca insensível a maiúsculas/minúsculas e acentos"*.
- **Impacto:** Contradição de escopo. Busca semântica verdadeira exige embeddings locais ou LLM, o que aumenta a latência e complexidade. Normalização de string (NFD + minúsculas + substring) é determinística e rápida, mas não é "semântica".
- **Ajuste Exigido:** Esclarecer na v2 que a Fase 14 utilizará busca determinística por correspondência de texto (insensível a acentos, maiúsculas e pontuação, com suporte a tokens/palavras-chave parciais) em `JsonStore`. Remover o termo "busca semântica" para evitar falsa expectativa.

### Achado 5 (ALTA - Integridade do Armazenamento e Resiliência): Falta de escrita atômica em `JsonStore`
- **Descrição:** O §3.2 e §2.4 tratam da resiliência a travamentos e reinícios (H14.4). Porém, a implementação atual de `JsonStore.write()` utiliza `fs.writeFileSync(this.filePath, ...)` diretamente.
- **Impacto:** Se o processo for interrompido ou a máquina travar durante o IO de escrita em disk, o arquivo JSON pode ser zerado ou corrompido. Isenção de corrupção em 30 cenários de falha (H14.4) exige gravação segura.
- **Ajuste Exigido:** Implementar escrita atômica no `JsonStore` (escrever em arquivo temporário `.tmp` no mesmo diretório e realizar `fs.renameSync` atômico).

### Achado 6 (MÉDIA - Esquema de Dados): Incompatibilidade de campos em `StoredItem` (`updatedAt`)
- **Descrição:** O §3.2 promete armazenar *"timestamps de criação e última modificação"*. No entanto, a interface `StoredItem` em `src/backend/storage/jsonStore.ts` possui apenas `createdAt`.
- **Impacto:** Edições de notas e lembretes não registram quando foram alterados, impedindo ordenação por modificação recente em consultas e auditoria.
- **Ajuste Exigido:** Adicionar o campo opcional `updatedAt?: string` na interface `StoredItem` e garantir que operações de edição (`*_EDITAR`, `LEMBRETE_REAGENDAR`) atualizem esse campo com `ISO 8601`.

### Achado 7 (MÉDIA - Arquitetura de Testabilidade): Injeção de `Clock` incompleta
- **Descrição:** O §2.3 menciona *"Relógio injetável (`Clock`) em todo o motor para testabilidade determinística"*. Contudo, atualmente `JsonStore`, `mutatingTools.ts` e `ReminderScheduler` usam chamadas diretas a `new Date()`, `Date.now()` e `setTimeout`.
- **Impacto:** O harness de testes de estresse (120 tarefas, 100 cenários de precisão temporal e 30 falhas) não conseguirá rodar de forma determinística e rápida sem avançar o tempo via relógio injetável (`IClock` / `SystemClock` / `VirtualClock`).
- **Ajuste Exigido:** Definir a interface `IClock` (`now(): Date`, `setTimeout(...)`, etc.) e injetá-la explicitamente no `JsonStore`, `ReminderScheduler` e nas ferramentas.

### Achado 8 (MÉDIA - Formatação da Saída Falada): Falta de limites e regras de resumo para voz
- **Descrição:** O §2.1 exige *"Resumos curtos sem markdown ou listas complexas"*. Não há, contudo, especificação de limites máximos de itens retornados na fala nem conduta para quando a busca retornar 0 ou muitos resultados (ex.: 15 notas encontradas).
- **Impacto:** O síntese de voz pode tentar ler uma lista gigante de 20 notas, violando os limites de TTS (`MAX_GROUP_CHARS`) e degradando a UX falada.
- **Ajuste Exigido:** Especificar na v2 as regras de formatação falada:
  1. 0 resultados: *"Não encontrei nenhuma nota/lembrete sobre X."*
  2. 1 a 3 resultados: Falar o conteúdo em linguagem corrida natural.
  3. > 3 resultados: Falar os 3 mais recentes/relevantes e resumir a contagem total (*"Encontrei 7 notas. As três mais recentes são..."*).

### Achado 9 (MÉDIA - Tolerância Temporal e Suspensão no macOS): Prevenção de atraso no agendamento (H14.3)
- **Descrição:** O critério H14.3 exige `>= 99/100` notificações disparadas até 10s do horário com o sistema acordado. Em Node.js no macOS, timers de longa duração podem sofrer degradação de precisão por causa da otimização de energia da CPU.
- **Impacto:** `setTimeout` de várias horas pode ter *drift* superior a 10s se não houver um mecanismo de re-checagem ativa ou ordenação de timers.
- **Ajuste Exigido:** O `ReminderScheduler` deve agendar o timer próximo (para os próximos minutos) ou realizar *wake-up checks* periódicos (ex: a cada 1 minuto) para garantir disparo com precisão <= 10s.

### Achado 10 (BAIXA - Metodologia): Ausência do Circuito de Segurança (*Circuit Breaker*)
- **Descrição:** O plano v1 não faz menção ao protocolo de *circuit breaker* de 3+2 ciclos exigido pelas diretrizes do projeto (`docs/prompt-proxima-sessao-2026-10-02.md` §6).
- **Impacto:** Sem estratégia explícita de limitação de tentativas e mitigação de riscos, execuções de testes podem entrar em loops infinitos em caso de falhas sistemáticas.
- **Ajuste Exigido:** Incluir explicitamente a seção de Gestão de Riscos e *Circuit Breaker* na v2 do plano.

---

## 4. Plano de Ação para a Versão v2 (`docs/phase-14-v2.md`)

Para elevar o plano de **APROVADO COM AJUSTES** para versão executável final, a versão v2 deve:

1. **Ajustar Protocolo de Voz:**
   - Mover `LEMBRETE_CONSULTAR`, `NOTA_CONSULTAR` e `MEMORIA_CONSULTAR` para o grupo de consultas diretas sem confirmação (`ITool` / `TOOL_NAMES` estendido).
   - Manter em `MUTATION_NAMES` apenas mutações de estado: `LEMBRETE_CRIAR`, `LEMBRETE_EDITAR`, `LEMBRETE_APAGAR`, `LEMBRETE_REAGENDAR`, `NOTA_CRIAR`, `NOTA_EDITAR`, `NOTA_APAGAR`, `MEMORIA_GUARDAR`, `MEMORIA_EDITAR`, `MEMORIA_ESQUECER`.

2. **Detalhar Máquina de Estados para Desambiguação:**
   - Adicionar interface `PendingDisambiguation` no `sessionManager.ts`.
   - Mapear fluxo de voz para escolha ordinal (*"a primeira"*, *"a segunda"*) ou por palavra-chave distintiva.

3. **Especificar `LEMBRETE_REAGENDAR`:**
   - Atualizar `relativeTimeParser.ts` com função `parseRescheduleQuery(input: string)` para isolar termo de busca e novo horário.

4. **Fortalecer o `JsonStore` e Injeção de `Clock`:**
   - Implementar escrita atômica (`.tmp` + `renameSync`).
   - Adicionar campo `updatedAt?: string` a `StoredItem`.
   - Definir e injetar `IClock` em todos os componentes de tempo/armazenamento.

5. **Formalizar Suíte de Testes (Harness):**
   - Especificar arquivos de teste em `src/backend/__tests__/f14Cycle.test.ts`.
   - Mapear os datasets automatizados para cobrir H14.1, H14.2, H14.3 e H14.4.

---

## 5. Conclusão da Auditoria

O plano da Fase 14 possui excelente embasamento de requisitos e metas bem calibradas com o roadmap. Com a aplicação dos ajustes identificados nesta auditoria na versão `docs/phase-14-v2.md`, o plano estará 100% apto para execução segura, garantindo alta confiabilidade no ciclo completo de notas, lembretes e memórias por voz.
