# Relatório de Implementação — Rodrigo AI Fase 2 (v0.1.0)

**Data:** 2026-09-12 (implementação) / 2026-09-14 (confirmação humana)
**Status:** Implementado, verificado automaticamente, e **confirmado pelo usuário com microfone real no navegador em 2026-09-14** ("funcionou com voz robótica"). No mesmo dia, o usuário comparou 4 opções de voz de ponta a ponta (compacta `say`/Luciana, `Luciana (Enhanced)`, `Felipe (Enhanced)`, Kokoro) e escolheu **`Felipe (Enhanced)`** como padrão — melhor naturalidade que a compacta, sem o custo de latência do Kokoro (~0,5s vs ~1,2s). `SAY_VOICE` (novo) torna a voz configurável sem editar código; Kokoro continua disponível via `TTS_ENGINE=kokoro`.
**Documentos de referência:** `docs/phase-2-v2.md`, `docs/phase-2-v2-addendum.md`, `docs/audits/phase-2-audit-result-v1.log` (v1 REJEITADA), `docs/audits/phase-2-audit-result-v2.log` (v2 APROVADO COM AJUSTES MENORES), `docs/audits/ask-chatgpt-realtime-voice.log`, `docs/audits/ask-gemini-realtime-voice.log`.

---

## 1. Resumo da Entrega

A Fase 2 adiciona conversa por voz em PT-BR **100% local** ao Rodrigo AI: captura de microfone com VAD, transcrição (MLX Whisper), resposta (MLX LM, Qwen3-4B-Instruct 4-bit) e síntese de voz (`say` ou Kokoro), sem nenhuma API paga e sem chamada de rede durante a conversa. A Fase 1 continua intacta e testável sem depender de Python.

O plano passou por auditoria adversarial em duas rodadas (Antigravity CLI `agy` 1.2.1, modo plan): a v1 foi **rejeitada** por 3 achados de gravidade alta (reinício do worker matando o barge-in, sessão travando 10min num F5, injeção de argumento no `say`); a v2, corrigindo esses e mais 6 médios/4 baixos, foi **aprovada com ajustes menores** — todos os 10 ajustes foram incorporados na implementação. Consultas adicionais ao Codex CLI (GPT-5.6) e Gemini sobre a arquitetura real da Realtime API da OpenAI e da Live API do Google trouxeram 2 refinamentos extras, também incorporados (histórico só confirma o que foi realmente ouvido; canal de cancelamento com thread dedicada).

Durante a verificação real (não só testes automatizados com mock), a auditoria própria desta sessão encontrou e corrigiu **3 problemas adicionais** que nenhuma rodada anterior tinha pego, porque só apareceram rodando o pipeline de verdade:
1. **Race de finalização de turno**: `turn_done` podia ser emitido antes de toda síntese de frase pendente terminar.
2. **`markPlayed` sem validação de turno**: uma confirmação de reprodução de um turno já superado por barge-in podia injetar texto obsoleto no histórico do LLM.
3. **Markdown e emoji vazando pro TTS**: o LLM gerava `"2 mais 2 é **4**."` e um turno inteiro só com `"😊"` — corrigido com um system prompt instruindo respostas faláveis e uma limpeza defensiva antes da síntese.

Também foi corrigido um problema de encerramento que travava tanto os testes quanto (potencialmente) o `Ctrl+C` real: `http.Server.close()` espera conexões abertas (como uma sessão SSE de voz) fecharem sozinhas; `closeAllConnections()` + `closeIdleConnections()` foram adicionados ao shutdown de produção.

---

## 2. Estrutura de Arquivos Implementados

- `src/backend/voice/`: `engine.ts` (interface), `mlxWorkerEngine.ts` (worker Python real via NDJSON), `fakeEngine.ts` (determinístico p/ testes), `ttsProviders.ts` (`SayVoiceProvider`/`KokoroVoiceProvider`), `sessionManager.ts` (sessão única com preempção síncrona, cancelamento cooperativo, histórico confirmado por reprodução), `audioStore.ts`, `wav.ts`, `routes.ts` (REST+SSE), `voiceRuntime.ts`.
- `scripts/worker/`: `worker.py` (worker persistente MLX LM + MLX Whisper, thread dedicada de cancelamento, segmentador de frases PT-BR), `kokoro_synth.py`, `setup_models.py`.
- `scripts/setup-voice.mjs`: cria `.runtime/.venv`, instala dependências, baixa modelos com teto de 8 GiB verificado antes de baixar qualquer byte, grava manifesto e lockfile de versões resolvidas.
- `scripts/bench-voice.mjs`: benchmark de latência real com 10 perguntas sintetizadas via `say`.
- `src/frontend/voice.ts` + `vad-processor.js`: captura de microfone, VAD com histerese/pre-roll/piso mínimo, fila de playback com invalidação por `turnId`, barge-in.
- `src/shared/voiceProtocol.ts`: contratos do protocolo (eventos SSE, limites).
- `src/backend/__tests__/voice.test.ts`: 6 testes de sessão/preempção/cancelamento/limites/histórico, com engine e TTS fake (sem depender de Python).
- Extensão de `src/backend/index.ts` (shutdown do worker antes do servidor HTTP), `scripts/dev.mjs` (timeout de force-kill 400ms→3500ms), `src/shared/extensions/voice.ts` (`synthesize()`), `src/shared/extensions/registry.ts` (status honesto dependente de registro real).

---

## 3. Comandos Executados e Evidências Reais

### 3.1 Verificação estática
```
$ npm run typecheck   # 0 erros
$ npm run build       # backend + frontend, sem erros
$ npm audit --omit=dev
found 0 vulnerabilities
```

### 3.2 Suíte automatizada (`npm test`) — sem depender de Python
```
ℹ tests 29
ℹ suites 7
ℹ pass 29
ℹ fail 0
ℹ duration_ms ~5200
```
Inclui os 23 testes da Fase 1 (todos continuam passando) + 6 novos de voz.

### 3.3 Setup real (`npm run setup:voice`)
```
[setup] Tamanho projetado total: 2.57 GiB (teto: 8 GiB — verificado antes de baixar)
[setup] LLM materializado. [setup] STT materializado.
```
Manifesto (`​.runtime/models-manifest.json`): `mlx-community/Qwen3-4B-Instruct-2507-4bit` rev `50d42775…`, `mlx-community/whisper-small-mlx` rev `45f39159…`, total 2.76 GB.

### 3.4 Smoke test real de ponta a ponta (não é o teste humano de B3 — automatizado, áudio sintético via `say`)
Sessão real → aquecimento (6,8–29s) → áudio "Quanto é dois mais dois?" → STT real (`"quanto é 2 mais 2?"`) → LLM real (`"quatro"`, após correção de markdown/emoji) → TTS real → WAV válido servido (mono, 22050Hz, 0,54s). Shutdown via `SIGTERM` real confirmado limpo (`ps`/`lsof` sem processos remanescentes, arquivos temporários apagados).

### 3.5 Benchmark real (`npm run bench:voice`) — B6
```
Mediana (fim da fala -> 1º áudio): 3205ms (meta: <=4000ms)
p95: 3799ms (meta: <=8000ms)
Veredito: DENTRO DA META
```
Relatório completo: `docs/audits/voice-benchmark-latest.json`.

---

## 4. Matriz de Critérios de Aceite (B1–B8)

| Critério | Status | Evidência |
|---|---|---|
| B1 Fase 1 preservada | ✅ Verificado | 23/23 testes Fase 1 continuam passando; health retorna `0.1.0`; registros de agentes/tools continuam vazios |
| B2 Setup isolado, sem chaves, diagnóstico honesto | ✅ Verificado | `setup:voice` real executado; teto de 8 GiB checado antes de baixar; `RODRIGO_VOICE_DISABLE`/ausência de `.runtime` retorna 503 PT-BR sem quebrar o resto |
| B3 Sessão real mic→STT→LLM→TTS→playback, 3 turnos coerentes | ✅ Confirmado (2026-09-14) | Pipeline validado via áudio sintético nesta sessão + **usuário testou com microfone real no navegador e confirmou que funcionou** |
| B4 Início/fim/erros/reconexão/cancelamento sem vazamento | ✅ Verificado | Testes automatizados (preempção, cancelamento) + shutdown real via SIGTERM confirmado sem processos órfãos |
| B5 VAD/barge-in com microfone real no navegador | ✅ Confirmado (2026-09-14) | Lógica testada com mocks determinísticos + **validado com microfone físico real pelo usuário** |
| B6 Benchmark ≥10 perguntas, metas de latência | ✅ Dentro da meta e voz aprovada | Mediana 3205ms/p95 3799ms medidos de verdade (ver 3.5, com a voz compacta original — `Felipe (Enhanced)` tem a mesma ordem de latência, ~0,5s por frase, confirmado em teste isolado). **Naturalidade avaliada pelo usuário em 2026-09-14**: comparou 4 vozes e escolheu `Felipe (Enhanced)` como padrão |
| B7 Segurança (Origin/Host/token/limites/shell injection) | ✅ Verificado | Testes automatizados cobrem Origin cross-origin, token ausente/incorreto, payload grande (413), WAV malformado (400); `say`/`ffmpeg` com `--`/`-y -nostdin` |
| B8 Relatório com evidências e pendências | ✅ Este documento | — |

---

## 5. Pendências

1. ~~Teste humano real (B3/B5)~~ — **feito em 2026-09-14**: usuário confirmou funcionamento com microfone real.
2. ~~Avaliação subjetiva de naturalidade da voz (B6)~~ — **feita em 2026-09-14**: usuário comparou 4 vozes de ponta a ponta e escolheu `Felipe (Enhanced)`, agora o padrão.
3. **Nenhuma pendência conhecida.** Todos os critérios B1–B8 confirmados, inclusive os dois que dependiam do usuário. Fase 2 pronta para aceite final.

## 6. Rastreabilidade
- Plano v2 hash: `a3fb4cbc22d6123e463c58b69fa5818a457f8eb9fa2f759bb35bc1d8f68c7e5c`.
- Auditoria v1: `agy` 1.2.1, modo plan, effort high — REJEITADA (3 altos).
- Auditoria v2: `agy` 1.2.1, modo plan, effort high — APROVADO COM AJUSTES MENORES.
- Consultas externas: Codex CLI `gpt-5.6-sol` e Gemini `gemini-flash-latest` (via AI Studio), 2026-09-12, sobre arquitetura de Realtime/Live APIs de referência.
- Implementação: Claude (Sonnet 5), 2026-09-12, nesta sessão.
