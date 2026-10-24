# Fase TTS-OSS — Vozes open-source naturais — v1

Versão: v1  
Data: 2026-10-16  
Status: **H1 fechado (2026-10-16).** Vencedor da audição = sistema **C** = **Gemini Charon**. Default inalterado. H2 do VoxCPM **não passou** de forma consistente (2,9–6,1 s). `TTS_ENGINE=voxcpm` / `CONFIGURAR_VOZ` ficam como opção local experimental. Licença VoxCPM2: Apache-2.0. Auditoria: `docs/audits/tts-oss/`.

## 1. Problema

O usuário pediu vozes mais naturais/humanas, preferindo opções **free / open source**. O default atual é Gemini TTS (`gemini-3.8-flash-lite-tts`, voz `Charon`) com reserva `say` / Kokoro. A Fase 13a já testou e rejeitou por latência o Qwen3-TTS VoiceDesign e o Chatterbox Multilingual (não Turbo) — ver `docs/phase-13a-v1.md` §2.

## 2. Shortlist (comunidade GitHub, 2026-10-16)

Filtro: português, licença permissiva nos pesos, Mac Apple Silicon, latência de assistente de voz.

| Projeto | Stars (aprox.) | Licença | PT | Mac | Decisão |
|---|---|---|---|---|---|
| OpenBMB/VoxCPM (VoxCPM2) | ~39k | **Apache-2.0** (card HF `openbmb/VoxCPM2`, confirmado 2026-10-16) | sim | MLX via `leoli-dev/tts-server-voxcpm`; medido neste Mac M5 16GB: **2,9–6,1 s**/frase (8-bit, timesteps=7) | **candidato nº 1** (opcional; H2 parcial) |
| resemble-ai/chatterbox | ~27k | MIT | sim (+ finetune pt-br) | sim; Multilingual medido aqui 5–11 s/frase (2026-10-07) | só **Turbo** na audição; Multilingual fora |
| fishaudio/fish-speech (S2) | ~33k | Research / NC nos pesos | tier-2 | pesado | **descartado** (armadilha de licença) |
| QwenLM/Qwen3-TTS | ~14k | Apache-2.0 | sim | rejeitado aqui (carga ~173 s) | fora salvo variante bem mais rápida |
| hexgrad/Kokoro | ~9k | Apache-2.0 | 3 presets | já no app (~1,2 s) | baseline local |
| Coqui XTTS / forks | legado alto | CPML NC permanente | sim | — | **não usar** |
| nari-labs/dia | ~19k | Apache | só inglês | — | fora |

Já no app: Gemini Charon, `say` Felipe (Enhanced), Kokoro (`TTS_ENGINE` + `CONFIGURAR_VOZ`).

## 3. Decisões deste plano

1. Gate obrigatório: audição às cegas em `.runtime/audicao-tts-oss/` (gitignorado), frases PT-BR do uso real.
2. Candidatos na audição: VoxCPM2-MLX 8-bit · Chatterbox Turbo (se couber no M5 16GB) · Kokoro · Gemini Charon (controle).
3. Integração só do vencedor local OSS como `IVoiceProvider`, `TTS_ENGINE=<id>`, preferência em `.runtime/voice-preference.json`, `CONFIGURAR_VOZ`.
4. Se Charon ganhar de novo: não troca o default; documenta “OSS avaliado, nuvem permanece default”.
5. Sem novo canal de nuvem. Servidor MLX só em `127.0.0.1`.
6. Auditoria adversarial (Cursor Agent → Gemini → OpenCode; **sem Codex** salvo pedido explícito) antes de implementar o provider.

## 4. Arquitetura alvo (se VoxCPM2 vencer ou passar H2 como opção)

```
sessionManager → DynamicVoiceProvider
  ├─ gemini (default se canal efetivo)
  ├─ voxcpm → HTTP loopback tts-server-voxcpm (MLX)
  ├─ kokoro
  └─ say (reserva)
```

Contrato `synthesize(text, outputPath, signal)` inalterado. VoxCPM não consome `TtsBudget` / RPD do Gemini.

### Variáveis

| Var | Default | Papel |
|---|---|---|
| `TTS_ENGINE` | `gemini` | Inclui `voxcpm` quando o servidor local estiver saudável |
| `RODRIGO_VOXCPM_URL` | `http://127.0.0.1:5077` | Base URL do servidor MLX (só loopback) |
| `RODRIGO_VOXCPM_VOICE` | (vazio / preset do servidor) | Nome de voz ou modo voice-design opcional |

## 5. Critérios de aceite

| Id | Critério |
|---|---|
| H1 | Audição às cegas gerada e ouvida pelo usuário; vencedor registrado por escrito neste doc (§8) |
| H2 | Se OSS for ativável: `TTS_ENGINE=<vencedor>` sintetiza frase PT-BR em ≤4 s até WAV pronto no M5 16GB (medido), com reserva `say` em falha |
| H3 | `CONFIGURAR_VOZ` troca e persiste; card/README não mentem sobre localidade |
| H4 | Testes unitários do provider (HTTP fake) + smoke de latência; `npm test` verde |

## 6. Fora de escopo

ElevenLabs / provedor pago; expandir só o catálogo Gemini (follow-up se OSS perder); clonagem de voz de terceiros sem consentimento; Fish S2 / XTTS.

## 7. Mediões prévias (herdadas)

- 2026-09-14: usuário preferiu `say` Felipe (Enhanced) a Kokoro/compacta (antes do Gemini).
- 2026-10-07: usuário preferiu Gemini Charon na audição F13a; Qwen3-TTS e Chatterbox Multilingual rejeitados por latência (`docs/phase-13a-v1.md` §2).

## 8. Registro do vencedor (H1)

- Data da audição: **2026-10-16** (amostras geradas no mesmo dia; escolha do usuário: sistema **C**)
- Pasta: `.runtime/audicao-tts-oss/` (`index.html` + `key.json`)
- Sistemas na audição: A=Kokoro · B=VoxCPM2-MLX · C=Gemini Charon · D=say Felipe (Chatterbox Turbo **pulado**: H2 já marginal e sem critério de RAM livre — achado auditoria #8)
- Vencedor: **Gemini Charon** (letra C)
- Também bom na audição (2º na época): **VoxCPM2-MLX** (letra B) — **rebaixado em uso real (2026-10-16):** usuário reportou qualidade ruim ao testar no app; só Charon permanece “realmente boa”
- Audição Rápido (2026-10-16, `.runtime/audicao-tts-rapido/`): vencedor letra **C** = **Gemini Charon** de novo; Rápido TTS e Kokoro perderam
- Default do app após a audição: **mantém Charon** (já era o default; sem troca)
- Latência medida do OSS (H2): VoxCPM smoke 4,3–6,1 s; na audição 2,9–4,5 s. **H2 ≤4 s: NÃO PASSADO de forma consistente.** VoxCPM permanece opção local (`TTS_ENGINE=voxcpm` / `CONFIGURAR_VOZ`), não default.
- Conclusão: OSS avaliado e aprovado em qualidade (B); nuvem (Charon) permanece default por latência/cota — alinhado ao §3 item 4.

## 10. Auditoria (2026-10-16)

- Rodada 1: Cursor Agent → `docs/audits/tts-oss/plan-r1-cursor-agent.txt` (ACHADOS ALTA tratados: licença confirmada; loopback no script+provider; H2 medido e declarado; Charon permanece default).
- Rodada 2 Gemini: **429 spend cap** / modelo 2.5-pro 404 — ver `plan-r2-gemini.txt`.
- Rodada 3 OpenCode: tentativa em `plan-r3-opencode.txt` (se o CLI responder).

Mitigações aplicadas no código: `parseVoxCpmEnv` só loopback (localhost→127.0.0.1); timeout default 8 s com fallback `say` + `onFallback`; `scripts/audicao-tts-oss.mjs` com o mesmo gate.

## 9. Implementação prevista (após auditoria)

1. Script `scripts/audicao-tts-oss.mjs` gera WAV + `index.html` com rótulos cegos.
2. `VoxCpmVoiceProvider` em `src/backend/voice/ttsProviders.ts` (ou arquivo dedicado) — healthcheck em `RODRIGO_VOXCPM_URL`, POST OpenAI-style `/v1/audio/speech` ou endpoint documentado pelo servidor.
3. Estender `VoicePreferenceRecord.engine` com `'voxcpm'`.
4. Testes em `src/backend/voice/__tests__/` / `__tests__/voxcpmVoiceProvider.test.ts`.
5. README / `.env.example` / card de privacidade: “voz local VoxCPM (opcional; requer servidor MLX no loopback)”.
