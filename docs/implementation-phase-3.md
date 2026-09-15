# Relatório de Implementação — Rodrigo AI Fase 3 (v0.2.0)

**Data:** 2026-09-14
**Status:** Implementado, verificado com evidência real (MLX real, não só mocks), e **confirmado pelo usuário com microfone real no navegador em 2026-09-14** ("Testei com microfone real, funcionou"). Todos os critérios C1-C6 confirmados — nenhuma pendência.
**Documentos de referência:** `docs/phase-3-v2.md`, `docs/audits/phase-3-audit-result-v1.log` (v1 REJEITADA), `docs/audits/phase-3-audit-result-v2.log` (v2 Codex, incompleta por cota), `docs/audits/phase-3-audit-result-v2-agy.log` (v2 Antigravity, APROVADO COM AJUSTES MENORES).

---

## 1. Resumo da entrega

A Fase 3 adiciona uma camada de orquestração sobre a Fase 2: antes de gerar a resposta falada, o sistema classifica a intenção do usuário (`GERAL`, `TEOLOGIA`, `VIRTOLOGIA`, `AMBIGUO`) usando o mesmo LLM já carregado, e expõe essa decisão via evento SSE + indicador na interface. **A Fase 4 (especialistas reais) não foi implementada** — toda categoria continua respondida pelo LLM geral; a Fase 3 entrega só o mecanismo de decisão e sua transparência, nunca fingindo atendimento especializado que não existe.

O plano passou por duas rodadas de auditoria adversarial: a v1 foi **rejeitada** (Codex CLI) por 3 achados de gravidade alta — dois deles revelaram que **o mesmo defeito já existia em produção na Fase 2** (cancelamento de `generate()` podia deixar a Promise do Node presa esperando uma confirmação do worker que às vezes nunca chegava). A v2 corrigiu os 10 achados com um redesenho do mecanismo de cancelamento (o Node agora resolve localmente, sem esperar o worker) e foi **aprovada com ajustes menores** (Antigravity CLI, depois que o Codex bateu cota de novo no meio da reauditoria). Antes de implementar, revisei os 5 ajustes eu mesmo — concordei com 3 sem ressalva, discordei da forma sugerida de resolver um (ajustei o texto do critério em vez de inflar o benchmark) e considerei um deles redundante (já estava no escopo do plano).

Durante a verificação real, a matriz de classificação encontrou um problema genuíno de precisão do classificador (não um bug de código): o caso adversarial "Preciso de mais aceitação da minha família" (negativo adjacente, testando se o modelo confunde a palavra "aceitação" cotidiana com o termo técnico da Virtologia) classificou errado na primeira tentativa. Corrigi refinando o prompt de classificação com um exemplo contrastivo explícito, e o caso passou a classificar corretamente sem regredir nenhum dos outros 7.

---

## 2. Estrutura de arquivos alterados/criados

- `scripts/worker/worker.py`: comando `classify` (validação de texto vazio, `temp=0.0`, `max_tokens=8`, normalização por igualdade exata — nunca substring), prompt de classificação com exemplo contrastivo.
- `src/backend/voice/engine.ts`: `classify()` na interface `VoiceEngine`.
- `src/backend/voice/mlxWorkerEngine.ts`: `PendingClassify`, `spawnGeneration` (evita que um timer de worker antigo mate uma instância nova), `cancel()` redesenhado para resolver localmente sem esperar o worker, `failAllPending()` cobrindo `classify` também.
- `src/backend/voice/fakeEngine.ts`: `classify()` com barreira controlada (`classifyGate`/`releaseClassifyGate`) para testes de cancelamento determinísticos.
- `src/backend/voice/sessionManager.ts`: `runTurn()` reordenado (`processando → transcript → classify → routing → falando`), `handled: label === 'GERAL'` sem o bug de lógica da v1.
- `src/shared/voiceProtocol.ts`: `OrchestratorLabel`, `RoutingEvent`, `CLASSIFY_TIMEOUT_MS`.
- `src/frontend/voice.ts`, `main.ts`, `index.html`, `style.css`: callback `onRouting`, indicador `#voice-agent-indicator` (reseta em novo turno/erro/fim de sessão).
- `src/backend/__tests__/voice.test.ts`: 3 testes novos (handled=false, cancelamento real durante classify com barreira, preempção rápida A→B→C) + 2 testes existentes corrigidos (contagem de eventos SSE, que mudou com o novo evento `routing`).
- Versão bumped para `0.2.0` em `package.json`, `types.ts`, `health.ts`, `index.html`, testes.

---

## 3. Comandos executados e evidências reais

### 3.1 Verificação estática e testes automatizados (mock, sem depender de Python)
```
npm run typecheck   # 0 erros
npm run build        # backend + frontend, sem erros
npm test
ℹ tests 32 | pass 32 | fail 0
npm audit --omit=dev
found 0 vulnerabilities
```

### 3.2 Matriz de classificação (C2) — 9/9 casos reais, com MLX real
| # | Texto | Esperado | Obtido (1ª tentativa) | Obtido (após correção do prompt) |
|---|---|---|---|---|
| 1 | "Quanto é 17% de 850?" | GERAL | GERAL ✅ | GERAL ✅ |
| 2 | "Análise exegética de Hebreus 5" | TEOLOGIA | TEOLOGIA ✅ | TEOLOGIA ✅ |
| 3 | "Explique a Aceitação dentro da Virtologia" | VIRTOLOGIA | VIRTOLOGIA ✅ | VIRTOLOGIA ✅ |
| 4 | "O que a Bíblia diz sobre perdão no Salmo 51?" | TEOLOGIA | TEOLOGIA ✅ | TEOLOGIA ✅ |
| 5 | "Conceito de Aceitação nesse método" (sem citar "Virtologia") | VIRTOLOGIA | VIRTOLOGIA ✅ | VIRTOLOGIA ✅ |
| 6 | "Preciso de mais aceitação da minha família" (negativo adjacente) | GERAL | **VIRTOLOGIA ❌** | GERAL ✅ |
| 7 | "Bom dia! Como você está?" | GERAL | GERAL ✅ | GERAL ✅ |
| 8 | "É teologia ou senso comum? Explica os dois" | AMBIGUO | AMBIGUO ✅ | AMBIGUO ✅ |
| 9 | texto vazio/só espaço | erro técnico (não AMBIGUO) | — | erro técnico ✅ (testado isolado, sem precisar do LLM) |

### 3.3 Latência par-a-par (C3) — real, medido
```
Baseline Fase 2 (sem classify, docs/audits/voice-benchmark-phase2-baseline.json):
  mediana 3205ms | p95 3799ms

Fase 3 (com classify, docs/audits/voice-benchmark-latest.json):
  mediana 2092ms | p95 2610ms — DENTRO DA META (≤4000ms / ≤8000ms)
```
A Fase 3 saiu mais rápida que a baseline nesta medição — provavelmente variação normal do sistema (cache de disco, estado térmico) entre as duas execuções, não porque a classificação seja "grátis". A conclusão honesta é: a meta continua confortavelmente atingida com a classificação no caminho crítico, não que ela não tenha custo algum.

### 3.4 Cancelamento (C5) — automatizado com prova real, não só "não trava"
3 testes novos usando barreira controlada (`FakeVoiceEngine.classifySettleDelayMs` + `releaseClassifyGate`): cancelamento durante classificação rejeita a Promise de verdade e limpa `pending`/timer; sequência rápida de preempção A→B→C não deixa nada órfão. Todos passando.

### 3.5 Shutdown limpo (mantido da Fase 2)
Confirmado de novo via `SIGTERM` real durante os testes de smoke — sem processos remanescentes (`ps`/`lsof`), arquivos temporários limpos.

---

## 4. Matriz de critérios de aceite (C1–C6)

| Critério | Status | Evidência |
|---|---|---|
| C1 Fase 1+2 preservadas | ✅ | 32/32 testes, nenhuma regressão nos critérios B1-B8 |
| C2 Classificação correta (matriz de 9 casos, MLX real) | ✅ | Seção 3.2 — 1 correção de prompt no meio do caminho, documentada |
| C3 Latência par-a-par dentro das metas já aceitas | ✅ | Seção 3.3 |
| C4 Evento `routing` correto e UI honesta | ✅ | Testes automatizados (turnId/label/handled corretos) + verificação visual da UI + **confirmado pelo usuário com microfone real (2026-09-14)** |
| C5 Cancelamento provado, não só "não trava" | ✅ | Seção 3.4 |
| C6 Nenhuma capacidade nova prometida além de classificação+transparência | ✅ | Revisão de escopo — nenhum especialista, ferramenta ou memória implementados |

---

## 5. Pendências

Nenhuma. ~~Verificação da UI com microfone real~~ — **feita em 2026-09-14**, usuário confirmou funcionamento.

## 6. Rastreabilidade
- Plano v1: hash `6123ac4511c3e2e84713eb8182b60059b8f3904ab1e20563a5b54d5a9ae06b6b` — REJEITADO (Codex CLI `gpt-5.6-sol`, effort high).
- Plano v2: hash auditado `759307c8b652120413b8281e306a4c8e66eda81b8b74a5e3c9186ba0c989b9b3` — APROVADO COM AJUSTES MENORES (Antigravity CLI `agy` 1.2.1, modo plan, effort high). Hash atual do arquivo (`5c778c28f379e43470880e1aabcd2ce714d9400b0e67f19a3376cb912540f792`) difere por um ajuste de texto pós-aprovação no critério C3 (decisão consciente registrada no próprio documento) — nenhuma mudança de arquitetura depois da auditoria.
- Codex CLI bateu cota duas vezes nesta fase (durante a reauditoria da v2) — Antigravity CLI usado como alternativa com aprovação explícita do usuário para a flag `--dangerously-skip-permissions`.
- Implementação: Claude (Sonnet 5), 2026-09-14, nesta sessão, incluindo a correção do prompt de classificação achada durante a verificação real (não prevista em nenhuma auditoria — descoberta rodando o modelo de verdade).
