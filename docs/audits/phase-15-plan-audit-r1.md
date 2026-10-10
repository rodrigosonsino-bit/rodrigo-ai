# Auditoria Crítica e Rigorosa do Plano da Fase 15 (v1)

- **Data:** 2026-10-09
- **Objeto auditado:** `docs/phase-15-v1.md`
- **Documentos de referência:** `docs/roadmap-2026-10-09.md`, `docs/prompt-proxima-sessao-2026-10-02.md`
- **Autor da auditoria:** Subagente Auditor de Plano
- **Veredicto Final:** **REFAZER**

---

## 1. Resumo Executivo e Veredicto

A auditoria analisou o plano da Fase 15 (`docs/phase-15-v1.md`) confrontando-o rigorosamente com os requisitos estipulados em `docs/roadmap-2026-10-09.md` e com as regras gerais do projeto escritas em `docs/prompt-proxima-sessao-2026-10-02.md`.

O plano rascunho v1 apresenta uma estrutura conceitual válida, mas possui **falhas arquiteturais críticas**, **omissões de critérios de aceite mandatórios**, **incompatibilidade com o protocolo de barge-in em <= 350ms** e **ausência total de ancoragem em código existente (`file:line`)**.

Por esses motivos, o veredicto é **REFAZER**. O plano precisa ser reescrito na versão `docs/phase-15-v2.md` sanando todos os achados descritos abaixo antes de seguir para a fase de implementação.

---

## 2. Matriz de Conformidade com o Roadmap (`docs/roadmap-2026-10-09.md`)

| Requisito do Roadmap / Protocolo | Situação no Plano v1 | Status |
|---|---|---|
| **1. Coordenador e supervisor de subagentes (internos, ferramentas mutantes, OpenClaw)** | Mencionado no texto, mas a interface `ISubAgent` não possui suporte a cancelamento/ `AbortSignal` e não adapta a arquitetura existente. | ❌ INCOMPLETO |
| **2. Execução autônoma para leitura e consulta** | Assume "pesquisa" sem endereçar o envio de dados para a nuvem (violação de privacidade/regras de limite). | ❌ IRREGULAR |
| **3. Confirmação por voz estrita para mutação** | Mencionada, mas `runTask` retorna `needsConfirmation` *depois* ou *durante* a execução, correndo risco de mutação prévia. | ❌ FALHA DE DESIGN |
| **4. Proibição de ações financeiras/irreversíveis** | Mencionada na introdução, mas sem guarda no coordenador ou critério de teste de bloqueio. | ⚠️ PARCIAL |
| **5. Cancelamento por barge-in em <= 350ms p95 sem tarefas órfãs** | Exigido em H15.3, mas a interface `ISubAgent` não provê mecanismo de aborto/cancelamento. | ❌ IMPOSSÍVEL NA ARQUITETURA ATUAL |
| **6. Rastreabilidade de ações ("o que você fez?")** | Exigido em H15.4, mas sem especificação da estrutura de dados, persistência ou handler de consulta por voz. | ⚠️ PARCIAL |
| **7. Teto de orçamento e recursos (H15.5)** | Requisito do roadmap e prompt de sessão completamente omitido da tabela H15. | ❌ OMITIDO |
| **8. Ancoragem em código real (`file:line`)** | Nenhuma referência a arquivos ou linhas do projeto existente (`src/backend/`). | ❌ VIOLAÇÃO DO PROTOCOLO |

---

## 3. Lista Numerada de Achados da Auditoria

### Achado 1 [CRÍTICO]: Interface `ISubAgent` sem `AbortSignal` inviabiliza cancelamento por barge-in <= 350ms sem tarefas órfãs
- **Local:** `docs/phase-15-v1.md` §2.1 (`ISubAgent`) e §4 (H15.3).
- **Evidência:** A interface foi definida como:
  ```ts
  export interface ISubAgent {
    readonly id: string;
    readonly name: string;
    readonly capabilities: string[];
    runTask(task: string, context?: unknown): Promise<{ success: boolean; result: string; needsConfirmation?: boolean }>;
  }
  ```
- **Problema:** A função `runTask` não aceita um `AbortSignal` nem expõe um método de cancelamento. Quando o usuário interrompe por barge-in (interrupção <= 350ms), o `SubAgentCoordinator` não tem como abortar uma tarefa assíncrona em andamento (ex.: chamada HTTP para OpenClaw ou processamento no LLM). Isso gerará **tarefas órfãs** executando em segundo plano e consumindo recursos, violando o requisito H15.3 do roadmap.
- **Ação requerida:** Atualizar a assinatura para aceitar `signal?: AbortSignal` em `runTask` e definir o contrato de interrupção cooperativa obrigatoriamente em todos os subagentes.

---

### Achado 2 [CRÍTICO]: Omissão do Critério de Aceite H15.5 (Orçamento e Limites de Recursos)
- **Local:** `docs/phase-15-v1.md` §4 (Critérios de Aceite).
- **Evidência:** O roadmap (`docs/roadmap-2026-10-09.md` §3) estipula: *"nenhum plano excede o orçamento de chamadas/tempo definido"*. O protocolo base (`docs/prompt-proxima-sessao-2026-10-02.md` §7 F15) exige explicitamente: *"H15.5 orçamento: nenhum plano excede o teto de chamadas/tempo definido no plano (teste de estresse)"*. O plano v1 lista apenas H15.1 a H15.4.
- **Problema:** Omitir H15.5 reduz a rigorosidade do aceite e deixa o orquestrador vulnerável a loops infinitos de delegação entre subagentes ou estouro de cota/crédito do Gemini/OpenClaw.
- **Ação requerida:** Reinstaurar o critério **H15.5** na tabela de aceite, definindo os limites quantitativos exatos (ex.: máximo de N chamadas ao LLM por plano, timeout global de T segundos por plano, teto de tokens).

---

### Achado 3 [ALTO]: Falha de Segurança no Desenho do Gatekeeper de Mutação (`needsConfirmation` Pós-Execução)
- **Local:** `docs/phase-15-v1.md` §2.1 e §3 (Fatia 3).
- **Evidência:** A interface `ISubAgent` indica que `runTask` retorna `needsConfirmation?: boolean` no seu valor de retorno.
- **Problema:** Se `runTask` é quem avalia se precisa de confirmação *durante* ou *ao final* de sua execução, o subagente já pode ter executado a alteração no banco de dados / sistema de arquivos antes de sinalizar ao orquestrador que precisava de autorização. O gatekeeper de confirmação por voz precisa atuar **antes** da execução de qualquer método mutante (dry-run / pré-avaliação de capacidade mutante).
- **Ação requerida:** Separar explicitamente a fase de planejamento/inspeção de intenção (pré-execução) da fase de mutação. Subagentes devem expor suas capacidades mutantes e requerer confirmação *antes* do despacho final da ação mutante.

---

### Achado 4 [ALTO]: Ambiguidade de Privacidade na Camada Autônoma de Leitura e Falta de Alinhamento com a Decisão do Usuário
- **Local:** `docs/phase-15-v1.md` §1 (`Ex.: "Pesquisa X e salva um lembrete..."`) e §1 item 3.
- **Evidência:** O plano coloca "pesquisa" como exemplo de leitura autônoma imediata. Contudo, o roadmap (`docs/roadmap-2026-10-09.md` §3) registra explicitamente: *"Decisão pendente do usuário: quais capacidades entram na camada autônoma de leitura — 'tudo' foi dito em 2026-10-02, mas isso inclui busca na web (saída de dado para a nuvem) e ainda precisa de um plano nominal descrevendo exatamente o que sai..."*.
- **Problema:** A Regra 2 do projeto proíbe qualquer nova saída de dados para a nuvem sem aprovação explícita e plano nominal. Colocar busca na web como leitura autônoma sem detalhar o que sai para a nuvem viola a política de privacidade.
- **Ação requerida:** Classificar explicitamente o escopo da Leitura Autônoma em (a) *Leitura Local Autônoma* (notas, lembretes, memórias, BM25 local) e (b) *Leitura Externa sob Aprovação/Opt-in* (busca web, APIs externas), garantindo que nada saia para a nuvem sem o consentimento configurado.

---

### Achado 5 [ALTO]: Ausência Total de Ancoragem em Código Real (`file:line`)
- **Local:** `docs/phase-15-v1.md` (todo o documento).
- **Evidência:** Não há nenhuma menção a arquivos existentes em `src/backend/` ou `src/shared/`.
- **Problema:** O protocolo do projeto (`docs/prompt-proxima-sessao-2026-10-02.md` §6 - "Planejador") exige que o plano seja ancorado em código real (`file:line`). A falta dessa ancoragem torna o plano genérico e esconde dificuldades de integração com a arquitetura atual (`src/backend/voice/voiceRuntime.ts`, `src/backend/voice/sessionManager.ts`, `src/shared/extensions/registry.ts`).
- **Ação requerida:** Mapear no plano v2 exatamente onde as alterações e novos módulos serão inseridos (ex.: criação de `src/backend/orchestrator/`, integração em `voiceRuntime.ts`, reaproveitamento da `ExtensionRegistry` em `src/shared/extensions/registry.ts`).

---

### Achado 6 [MÉDIO]: Protocolo e Especificação da Ponte OpenClaw Incompletos
- **Local:** `docs/phase-15-v1.md` §2.2 (`OpenClawSubAgent`).
- **Evidência:** O plano menciona genericamente *"recrutar subagentes do OpenClaw via API local/socket"*.
- **Problema:** Não há definição sobre qual protocolo será utilizado (HTTP JSON API / WebSocket / CLI), porta padrão, autenticação (Gateway Token), limites de timeout, tratamento de erros para quando o OpenClaw estiver offline ou em falha, nem isolamento de sandbox/segurança.
- **Ação requerida:** Especificar no plano v2 os detalhes técnicos da integração com o OpenClaw, incluindo contrato da API, tratamento de reconexão e comportamento gracioso em caso de indisponibilidade do serviço OpenClaw.

---

### Achado 7 [MÉDIO]: Falta de Especificação da Rastreabilidade ("o que você fez?")
- **Local:** `docs/phase-15-v1.md` §4 (H15.4).
- **Evidência:** O critério H15.4 exige resposta por voz do histórico de passos, mas o plano não detalha como o log de rastreabilidade (`ExecutionTrace`) é construído, mantido em memória, exposto ou consultado via comando de voz.
- **Problema:** Sem uma especificação de estrutura de dados (ex.: id do plano, subagente utilizado, parâmetros, status de confirmação, resultado), a implementação corre o risco de ser feita de forma ad-hoc ou sem suporte a consulta por voz em tempo real.
- **Ação requerida:** Incluir a especificação do modelo de dados `ExecutionTrace` / `TaskStep` e como o intent de consulta ("o que você fez?") recupera e resume esse histórico para o gerador de resposta/TTS.

---

## 4. Requisitos Obrigatórios para o Plano v2 (`docs/phase-15-v2.md`)

Para que a v2 do plano seja aprovada, ela deverá:

1. **Atualizar a interface `ISubAgent`** para incluir `AbortSignal` em `runTask` e separar a fase de inspeção de mutação da fase de execução.
2. **Reinstaurar o critério H15.5** (orçamento, limite de chamadas LLM e timeout) na tabela de critérios de aceite.
3. **Ancorar todo o plano em arquivos e linhas do código atual** (`file:line`), cobrindo a integração com `voiceRuntime.ts`, `sessionManager.ts` e `ExtensionRegistry`.
4. **Respeitar a fronteira de privacidade**, esclarecendo nominalmente o escopo de leitura autônoma local versus consultas à nuvem.
5. **Detalhar a Ponte OpenClaw** com especificação de protocolo, autenticação, timeout e fallback.
6. **Especificar o modelo de dados de Rastreabilidade (`ExecutionTrace`)** e sua integração com a síntese de voz.
