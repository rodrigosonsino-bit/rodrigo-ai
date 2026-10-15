# Plano v2 — Modo viva-voz (sem voz pessoal)

- **Status:** PROPOSTA (reauditoria necessária)
- **Substitui:** Fatia A de `modo-viva-voz-voz-pessoal-v1.md` (hash `6b390f6e…`); Fatia B **fora** desta entrega (auditoria v1 BLOQUEOU)
- **Baseline:** `cf16496`
- **Definição de pronto:** toggle Viva-voz opt-in; com modo ligado, limiares/cooldown/duck ativos; VAD de barge-in e cooldown usam **playback real** (`outputPlaying`), não só SSE `falando`; confirmação de mutação **não** é engolida pelo cooldown; AEC verificado sem propaganda falsa; typecheck + testes no `npm test` verdes; inventário atualizado.

---

## 0. Achados da v1 que esta v2 corrige

| Achado v1 | Correção nesta v2 |
|---|---|
| A1 SSE `ouvindo` antes do fim do áudio | Flag local `outputPlaying` / `playbackActive` no `VoiceController`; VAD e cooldown leem isso |
| A4 cooldown engole “sim” | Cooldown **só** se a última frase falada **não** era pergunta de confirmação (`SpeechKind`/`dictated` de mutação **ou** texto que termina com `?` da prévia). Na dúvida: cooldown 0 quando `pendingMutation`/`armedMutation` poderiam existir — heurística cliente: se o texto da frase tocada contém `Pode ser?` / `Posso confirmar?` / `Diga só sim ou não`, cooldown = 0 |
| A5 barge-in async | Sem gate de voz pessoal → barge-in permanece síncrono; sem “últimos 800 ms” inventados |
| A6 AEC contraditório | Modo degradado explícito: se `getSettings().echoCancellation !== true`, UI: “Viva-voz sem cancelamento de eco do sistema — risco alto de eco”; **não** dizer “eco filtrado” |
| A7 localStorage no painel | Preferir `window.webkit.messageHandlers` para persistir no Swift (`UserDefaults`), com fallback `localStorage` no browser; se bridge ausente, toggle vale só na sessão e a UI avisa |
| A9 testes fora do npm test | Lógica pura em `src/backend/voice/speakerphoneProfile.ts` (ou `src/shared/`) testada em `src/backend/__tests__/speakerphoneProfile.test.ts` via `npm test` |
| Fatia B | Removida |

---

## 1. Comportamento

### Toggle (padrão off)

- UI botão `Viva-voz` (`aria-pressed`).
- Desktop menu espelha via `__getSpeakerphone` / `__setSpeakerphone`.
- Persistência: Swift `UserDefaults` chave `rodrigo.voice.speakerphone` quando no WKWebView; senão `localStorage`; senão só sessão.

### Quando ligado

1. `applyConstraints({ echoCancellation, noiseSuppression, autoGainControl: true })` no track ativo.
2. Ler `getSettings()` → `aecOk`. Texto de UI conforme A6.
3. Limiares:
   - listen RMS `0.020`
   - while-output-playing RMS `0.070`
   - barge hysteresis `350` ms
4. **Duck:** `GainNode` no caminho de playback em `0.85` (criar se ainda não houver; hoje o source vai direto — inserir gain).
5. **Cooldown pós-playback:** após `outputPlaying` passar a false **e** fila vazia, se a última frase **não** era confirmação (§0), bloquear onset por `400` ms (ring buffer continua; `continuousVoiceMs` não acumula).

### `outputPlaying` (obrigatório)

```
// playChunk: após source.start com sucesso → outputPlaying = true; setState efetivo de fala local
// source.onended / stop por barge-in → se fila vazia e nenhum source ativo → outputPlaying = false;
//   então arma cooldown se aplicável
// processAudioBlock: speakingForVad = outputPlaying  // NÃO this.state === 'falando' sozinho
```

Regressão crítica da auditoria de playback: não anunciar “ouvindo” na UI enquanto `outputPlaying` (já havia plano `voice-playback-repair`; esta v2 **não** reabre aquele escopo além do necessário para o VAD).

---

## 2. Arquivos

| Arquivo | Mudança |
|---|---|
| `src/shared/speakerphoneProfile.ts` | **novo** — constantes + `shouldApplyPostTtsCooldown(lastSpokenText)` + limiares |
| `src/backend/__tests__/speakerphoneProfile.test.ts` | H-VV: cooldown off em frases de confirmação; limiares do perfil |
| `src/frontend/voice.ts` | toggle, constraints, duck, `outputPlaying`, cooldown |
| `src/frontend/main.ts` + `index.html` + `style.css` | botão + aviso AEC |
| `desktop/main.swift` | menu + UserDefaults bridge |
| `docs/inventario-canais-nuvem.md` | nota: viva-voz é só cliente local |

Sem worker, sem privacy env novo, sem voz pessoal.

---

## 3. Testes

| ID | Caso |
|---|---|
| H-VV.A1 | `shouldApplyPostTtsCooldown('Vou anotar café. Pode ser?') === false` |
| H-VV.A2 | `shouldApplyPostTtsCooldown('São três da tarde.') === true` |
| H-VV.A3 | limiares speakerphone > limiares default |
| typecheck | 0 erros |
| smoke (Rodrigo) | 10 respostas alto-falante; anotar ecos — não bloqueia merge se documentado |

---

## 4. Decisão pedida ao Rodrigo

**Implementar só viva-voz v2 agora** (voz pessoal fica para plano futuro com embedding/calibração).  
Se **não**, pare aqui.

Recomendação: **sim**.
