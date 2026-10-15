# Plano v3-min — Modo viva-voz (fatia mínima)

- **Status:** IMPLEMENTADO (2026-10-15; ressalvas da auditoria aplicadas)
- **Por quê min:** v1 BLOQUEADA (voz pessoal); v2 BLOQUEADA (cooldown heurístico + aceite frouxo). Esta fatia **remove** cooldown e voz pessoal; só endurece captura/playback com o que já existe (`playbackActive`).
- **Baseline:** `cf16496`
- **Pronto:** toggle Viva-voz opt-in; com ligado: limiares altos + duck 0,85 + constraints AEC/NS/AGC; VAD de barge-in usa `playbackActive` (fonte tocando / drain ativo), não SSE `falando` sozinho; AEC `false` ⇒ aviso honesto; persistência UserDefaults no app / localStorage no browser; `npm test` + typecheck verdes. Smoke de eco = dívida T8 (não bloqueia merge; documentar).

## Fora de escopo

- Voz pessoal / enrolamento / embedding
- Cooldown pós-TTS / campo novo no protocolo SSE
- Mudança do worker / privacy env
- Meta T8 0/60 nesta entrega

## Comportamento

1. Toggle padrão **off**. Botão UI + menu desktop.
2. Ligado ⇒ `applyConstraints({ echoCancellation, noiseSuppression, autoGainControl: true })`; se `getSettings().echoCancellation !== true`, status: “sem cancelamento de eco do sistema — risco de eco” (nunca “eco filtrado”).
3. Limiares (só com toggle on): listen `0.020`, while `playbackActive` `0.070`, barge `350` ms. Off = valores atuais.
4. `processAudioBlock`: `speakingForVad = this.playbackActive` (já existe no `VoiceController`).
5. Duck: `GainNode` entre source e destination, gain `0.85` se viva-voz else `1`.
6. Persistência: Swift `UserDefaults` `rodrigo.voice.speakerphone` via handlers `speakerphoneGet`/`speakerphoneSet`; browser `localStorage`.
7. `playChunk`: identity check no `onended` — só zera `currentSource` se `source === this.currentSource` (corrida A2 da v2).

## Arquivos

- `src/shared/speakerphoneProfile.ts` + `src/backend/__tests__/speakerphoneProfile.test.ts`
- `src/frontend/voice.ts`, `main.ts`, `index.html`, `style.css`
- `desktop/main.swift`
- `docs/inventario-canais-nuvem.md` (uma linha)

## Testes (obrigatórios no `npm test` / harness Node)

| ID | O que cobre | Como |
|---|---|---|
| H-VV.M1 | limiares on > off | `vadThresholds(true/false, …)` |
| H-VV.M2 | barge-in usa playback, não SSE | `speakingForVad(playbackActive)` true só com playback |
| H-VV.M3 | corrida `onended` | helper `shouldClearSource(ended, current)` — só limpa se identidade igual |
| H-VV.M4 | texto de aviso AEC | `aecStatusMessage(true/false)` — false **nunca** contém “filtrado” |
| H-VV.M5 | duck | `playbackDuckGain(speakerphone)` → 0.85 / 1.0 |
| H-VV.M6 | persistência parse | `parseSpeakerphoneFlag('1'|'0'|lixo)` |
| typecheck | 0 erros | `npm run typecheck` |

Constraints/`applyConstraints` no browser: smoke manual do Rodrigo (dívida T8); o teste automatizado cobre a **mensagem** e o **parse** do resultado de `getSettings`, não o CoreAudio.

## Ressalvas aceitas (explícitas; não bloqueiam se os H-VV.M* passarem)

- Não prova AEC acústico real.
- Eco residual sem cooldown pode ainda abrir turno — T8 categoria 5.
- Voz pessoal fora.
