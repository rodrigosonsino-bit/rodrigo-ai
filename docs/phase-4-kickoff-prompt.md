# Prompt de handoff — continuar o Rodrigo AI na Fase 4

Cole isto no início de uma sessão nova do Claude Code, apontada pro diretório:
`/Users/rodrigosonsino/Documents/Codex/2026-09-11/referenced-chatgpt-conversation-this-is-an/outputs/rodrigo-ai`

---

Você está continuando o desenvolvimento do **Rodrigo AI**, um orquestrador de voz pessoal local (sem API paga, 100% offline depois do setup). Antes de fazer qualquer coisa, leia `CLAUDE.md` na raiz do projeto — é a fonte de verdade sobre arquitetura, comandos e o fluxo de trabalho deste repositório. Leia também `docs/implementation-phase-3.md` (o relatório de aceite mais recente) pra entender o estado atual.

## Estado atual (confirmado, não hipotético)
- Fase 1 (fundação), Fase 2 (voz local: STT/LLM/TTS via MLX + worker Python) e Fase 3 (orquestrador: classificação de intenção em `GERAL`/`TEOLOGIA`/`VIRTOLOGIA`/`AMBIGUO`, com transparência via evento `routing`) estão implementadas, testadas (build/typecheck/testes automatizados + verificação real com MLX) e **confirmadas pelo usuário com microfone real**.
- `Rodrigo AI v0.2.0`. Nenhuma pendência aberta.
- A Fase 3 já classifica corretamente a intenção, mas **toda categoria ainda é respondida pelo mesmo LLM geral** — não existe nenhum especialista de verdade ainda. Em `src/backend/voice/sessionManager.ts`, `handled` é `label === 'GERAL'` (sempre `false` pra TEOLOGIA/VIRTOLOGIA/AMBIGUO), e a UI mostra honestamente "Classificado como: X (especialista ainda não implementado — Fase 4)".

## O que é a Fase 4 (do roteiro original do usuário)
> Objetivo: provar que uma única interface de voz consegue coordenar diferentes inteligências.
> Começar somente com: Agente Geral, Agente Teológico, Agente Virtologia.
> Cada especialista terá suas próprias instruções, limites, metodologia e contexto.
> Critério de conclusão: o usuário conversa só com o Rodrigo AI e o sistema seleciona corretamente o especialista sem precisar dizer qual agente usar.
> Resultado: `Rodrigo AI v0.3 — Multi-Agent`.

**Escopo desta fase — só isto:** dar a cada rótulo já classificado (GERAL/TEOLOGIA/VIRTOLOGIA) seu próprio system prompt/instruções/metodologia/limites, e fazer o roteamento real acontecer (hoje só é decorativo). **Fora de escopo, mesmo que pareça natural:** bases de conhecimento externas, RAG, busca em documentos (isso é Fase 5 — "Ferramentas e conhecimento especializado"), ferramentas do sistema, memória entre sessões (Fase 6), integrações externas (Fase 7+). Não construa essas coisas agora, nem como "preparação".

## Antes de escrever qualquer código
1. **Pergunte ao usuário** quais são as instruções/metodologia/limites específicos dos agentes Teológico e Virtologia — isso não está definido em nenhum lugar do código ou da documentação existente, e "Virtologia" é uma área/metodologia própria do usuário que esta sessão não tem contexto sobre. Não invente.
2. Escreva um plano (`docs/phase-4-v1.md`), seguindo o mesmo formato de `docs/phase-3-v2.md` (objetivo declarado, decisões já tomadas — não perguntas em aberto pro auditor, pseudocódigo completo sem reticências, critérios de aceite mensuráveis).
3. Submeta o plano pra auditoria adversarial (Codex CLI `codex exec -s read-only` e/ou Antigravity CLI `agy --mode plan`) — skill `auditoria-plano-codex`. Só implemente depois de aprovado sem achados de gravidade alta pendentes.
4. Implemente, rode a suíte de testes (mantém B1-B8 da Fase 2 e C1-C6 da Fase 3 sem regressão), valide com áudio real (MLX real, não só mock) pros 3 exemplos do roteiro:
   - "Quanto é 17% de 850?" → Geral
   - "Faça uma análise exegética de Hebreus 5" → Teológico (respondido com a metodologia própria dele, não genérica)
   - "Explique a Aceitação dentro da Virtologia" → Virtologia (idem)
5. Escreva `docs/implementation-phase-4.md` com evidências reais, e peça pro usuário confirmar com microfone de verdade antes de considerar a fase aceita — nenhuma fase anterior foi aceita sem esse passo, não pule aqui.

## Pontos técnicos que vão te poupar tempo
- O worker Python (`scripts/worker/worker.py`) já tem os comandos `transcribe`, `classify` e `generate` — os 3 agentes provavelmente só precisam de `generate()` sendo chamado com um `system prompt` diferente por rótulo, não um comando novo.
- `src/shared/extensions/agents.ts` já declara a interface `IAgent` (id/name/role/isAvailable) — provavelmente vale implementá-la e registrar os 3 agentes no `ExtensionRegistry`, no mesmo padrão que `IVoiceProvider` foi implementado na Fase 2 (`src/backend/voice/ttsProviders.ts` + registro em `voiceRuntime.ts`).
- `docs/audits/` tem o histórico completo de decisões já auditadas — confira antes de reabrir uma discussão já resolvida (ex.: por que o cancelamento é resolvido no Node sem esperar o worker).
