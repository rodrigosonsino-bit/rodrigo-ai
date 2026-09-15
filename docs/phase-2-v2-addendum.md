# Adendo ao Fase 2 v2 — refinamentos vindos de consulta a Codex CLI (GPT-5.6) e Gemini (AI Studio)
Data 2026-09-12. Não altera o veredito da auditoria (`docs/audits/phase-2-audit-result-v2.log`, APROVADO COM AJUSTES MENORES). Este documento acrescenta 2 refinamentos arquiteturais confirmados por ambas as consultas e registra 2 otimizações candidatas para depois do benchmark inicial.

## Refinamento 1 — Histórico do LLM só confirma o que foi realmente ouvido
**Fonte:** Codex CLI (baseado em `conversation.item.truncate` da Realtime API da OpenAI), reforçado pelo Gemini (que reconhece ter até 300ms de margem de erro no lado servidor sem confirmação do cliente).
**Decisão:** o cliente emite um evento `chunk_played` (ou equivalente) ao terminar de reproduzir cada frase de áudio. O backend só adiciona essa frase ao histórico de contexto enviado ao worker MLX **depois** de receber essa confirmação. Uma frase interrompida no meio do playback (ou ainda na fila, nunca tocada) NÃO entra no histórico — descartada, não editada/truncada por palavra.
**Onde entra no plano:** seção "Transporte e sessão" do `phase-2-v2.md`, junto ao mecanismo de `turnId` já existente.

## Refinamento 2 — Canal de cancelamento com thread dedicada + limpeza sem `mx.eval()`
**Fonte:** ambas as consultas, independentemente, convergiram no mesmo ponto técnico (GIL do CPython bloqueia checagem de flag na mesma thread presa em `stream_generate`).
**Decisão:** o worker Python roda uma thread dedicada (ou `asyncio` sobre o pipe de controle) que só lê comandos de cancelamento e nunca bloqueia na geração. Ao cancelar: `cancel_event.set()`, descartar os tensores pendentes **sem chamar `mx.eval()`** neles, e rodar `mx.metal.clear_cache()` — evita recarregar os pesos e libera memória unificada imediatamente.
**Onde entra no plano:** substitui o texto mais genérico da "Correção 1" em `phase-2-v2.md` por esta versão mais específica.

## Candidatas a otimização (NÃO implementar agora — só se o benchmark B6 não bater a meta)
1. **Speculative decoding** (draft model pequeno, ex. 0.5B, guiando o Qwen3-4B via `mlx-examples`) — pode dobrar o throughput de geração no M5.
2. **Pré-computar o KV-cache do system prompt** uma vez na inicialização do worker, reaproveitado em todo turno, eliminando prefill repetido.

Justificativa para não implementar já: adicionam complexidade e superfície de bug antes de sabermos se a baseline simples já bate a meta de latência (B6). Se o benchmark inicial (10 perguntas, mediana/p95) não atingir ≤4s/≤8s, essas são as duas primeiras otimizações a tentar, nessa ordem, antes de considerar trocar de arquitetura ou aceitar serviço pago.

## Rastreabilidade
- Consulta 1: Codex CLI (`gpt-5.6-sol`), 2026-09-12, log em `docs/audits/ask-chatgpt-realtime-voice.log`.
- Consulta 2: Gemini (`gemini-flash-latest` via AI Studio/opencode), 2026-09-12, log em `docs/audits/ask-gemini-realtime-voice.log`.
- Nenhuma das duas consultas teve acesso de escrita ao projeto (Codex em `-s read-only`; Gemini via `opencode run` sem ferramentas de edição neste prompt).
