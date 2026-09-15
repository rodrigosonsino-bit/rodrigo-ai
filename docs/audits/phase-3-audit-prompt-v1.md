# Prompt de auditoria adversarial — Fase 3 v1 (Rodrigo AI)

Você é um auditor adversarial independente. Seu único objetivo é achar o que está ERRADO neste plano antes que qualquer código seja escrito — não confirme, não elogie, não reescreva o plano. Se não encontrar problemas reais em alguma seção, diga isso explicitamente em vez de inventar um achado fraco só para preencher espaço.

## Objetivo declarado pelo implementador (não é uma pergunta aberta)
Transformar a IA de voz da Fase 2 (aceita e em uso real pelo usuário) num orquestrador: antes de gerar a resposta falada, classificar a intenção do usuário numa de 4 categorias (`GERAL`, `TEOLOGIA`, `VIRTOLOGIA`, `AMBIGUO`) e expor essa decisão via evento SSE + indicador na UI. A Fase 4 (especialistas reais) NÃO está sendo implementada agora — toda categoria continua sendo respondida pelo mesmo LLM geral da Fase 2; a Fase 3 entrega só o mecanismo de decisão e sua transparência, nunca fingindo que um especialista respondeu quando não respondeu. "Pronto" exige: classificação correta nos exemplos do roteiro original + casos extras, latência adicional medida e dentro da meta já aceita da Fase 2 (mediana ≤4s fim-da-fala→primeiro áudio), evento de roteamento visível no cliente, cancelamento cooperativo funcionando durante a classificação, e nenhuma promessa de capacidade que não existe (sem especialista real, sem ferramenta, sem memória entre sessões).

## Posição já tomada pelo implementador (audite esta decisão, não peça pra escolher outra)
- Reaproveita o LLM já carregado no worker (`Qwen3-4B-Instruct-2507-4bit`) para classificar — não carrega segundo modelo.
- Novo comando de protocolo `classify` no worker Python (`scripts/worker/worker.py`), separado do `generate` já existente — decisão explícita contra reaproveitar `generate` e filtrar a "frase" de classificação antes do TTS (considerado e descartado no plano).
- `classify` usa `stream_generate` com `temp=0.0`, `max_tokens=8`, mesma fila de trabalho (tamanho 1) e mesmo mecanismo de cancelamento cooperativo (`cancel_event` por turnId/epoch) que `generate`/`transcribe` já usam.
- Normalização do rótulo por substring match contra `CLASSIFICATION_LABELS`, com fallback pra `AMBIGUO` se nada bater.
- Nenhuma ramificação de comportamento real por rótulo ainda — só emite o evento `routing` informativo; a geração da resposta sempre segue o caminho `GERAL` já existente.
- Dois campos reservados no contrato do evento (`requiresConfirmation`, `secondaryLabels`) — declarados como scaffolding inerte para Fase 5+/Fase 4, documentados como tal, sem lógica associada ainda.

## O que auditar
1. **Design do protocolo `classify`**: a fila de tamanho 1 compartilhada com `generate`/`transcribe` é segura aqui? Se uma classificação está em andamento e o usuário manda um novo turno (preempção de sessão, não barge-in), o que acontece com a entrada antiga na fila/no `_current`? Revise `handle_classify` e o `stdin_reader_loop`/`work_loop` propostos linha a linha contra o `worker.py` real já implementado (arquivo no repo) — o pseudocódigo do plano é consistente com as estruturas (`GenerationHandle`, `_current_lock`, `emit`, `log_diag`) que já existem no código de verdade, ou diverge em algum detalhe que quebraria a integração?
2. **Robustez da classificação**: `max_tokens=8` é suficiente pra sempre capturar um rótulo completo (o maior, "VIRTOLOGIA", tem quantos tokens tipicamente nesse tokenizer)? O que acontece se o modelo devolver texto vazio, ou uma palavra que contém acidentalmente uma substring de outro rótulo (ex.: nenhum rótulo é substring de outro aqui, mas vale confirmar)? A normalização por substring é robusta o suficiente, ou um LLM com `temp=0.0` ainda pode divergir do formato pedido de formas que quebram isso?
3. **Latência**: o plano estima "~300-500ms" adicionais por causa da classificação. Isso é plausível dado que o benchmark real da Fase 2 mediu ~200-800ms pro STT sozinho e o LLM já está aquecido? Considere que a classificação e a geração da resposta são DUAS chamadas sequenciais ao mesmo `stream_generate` agora (antes era uma) — isso ameaça a meta de mediana ≤4s já aceita?
4. **Cancelamento e concorrência**: o plano diz que barge-in durante a classificação cancela "igual à geração" — mas a classificação não emite frases/áudio, então o `sessionManager.runTurn()` não tem o mesmo padrão de `pendingSynthesis` esperando. Reveja a integração proposta em `SessionManager.runTurn()` contra o código real (`src/backend/voice/sessionManager.ts`) — falta algum `if (session.activeTurn !== turn) return` em algum ponto entre a chamada de `classify()` e o uso do resultado? O `turn.abortController` existente serve pra abortar a classificação também, ou só é usado hoje pro `signal` do TTS?
5. **Honestidade do evento `routing`**: o plano exige que a UI nunca "finja que um especialista respondeu". Revise o texto proposto pro frontend — há algum caminho em que o usuário pode ser enganado a achar que recebeu uma resposta especializada quando não recebeu?
6. **Escopo**: algo no plano já é trabalho de Fase 4 (especialistas reais), Fase 5 (ferramentas) ou Fase 6 (memória) disfarçado de Fase 3? Os campos reservados (`requiresConfirmation`, `secondaryLabels`) são scaffolding aceitável ou já são complexidade prematura que deveria esperar a fase que os usa de verdade?
7. **Testabilidade sem MLX**: o plano promete que `FakeVoiceEngine.classify()` mantém os testes automatizados independentes de Python (mesmo princípio da Fase 2, B2). Isso é suficiente, ou falta algo pra cobrir C5 (cancelamento durante classificação) de forma determinística?

## Saída exigida
Para cada achado: **Achado**, **Evidência** (arquivo:linha do plano em `docs/phase-3-v1.md` e/ou do código real em `src/`/`scripts/worker/worker.py`), **Gravidade** (alta/média/baixa), **Confiança** (alta/média/baixa), **Ação recomendada**. Ao final: **APROVADO SEM RESSALVAS**, **APROVADO COM AJUSTES MENORES**, ou **REJEITADO** (com motivo).

## Arquivos relevantes
- `docs/phase-3-v1.md` — o plano sendo auditado.
- `docs/implementation-phase-2.md`, `CLAUDE.md` — estado real e aceito da Fase 2 (código já em produção, não hipotético).
- `scripts/worker/worker.py` — worker real da Fase 2 (o `classify` proposto deve se integrar a ele, não substituí-lo).
- `src/backend/voice/engine.ts`, `mlxWorkerEngine.ts`, `fakeEngine.ts`, `sessionManager.ts` — código real da Fase 2 que o plano propõe estender.
- `src/shared/voiceProtocol.ts` — contratos de evento existentes.
