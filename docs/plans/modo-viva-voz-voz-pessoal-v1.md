# Plano v1 — Modo viva-voz / voz pessoal

- **Status:** PROPOSTA (aguardando auditoria adversarial; sem código até veredito apto)
- **Baseline:** `cf16496` (`main` do worktree principal)
- **Pedido:** “quero o app ouça e foque na minha voz, quero usá-lo sem fone”
- **Definição de pronto:** (1) com alto-falante + mic do Mac, o TTS do assistente **não** dispara turno novo nem confirma mutação por eco em um smoke de 10 respostas; (2) com “voz pessoal” enrolada, fala de outra pessoa (ou ruído) **não** inicia turno enquanto o modo estiver ligado, e a voz enrolada continua iniciando; (3) áudio e perfil de voz **nunca** saem da máquina; (4) typecheck + testes novos verdes.

---

## 0. Fatos verificados (não hipóteses)

| Fato | Onde |
|---|---|
| `getUserMedia` já pede `echoCancellation: true` e `noiseSuppression: true` | `src/frontend/voice.ts` ~199–201 |
| Durante `falando`, limiar RMS sobe de `0.012` → `0.045` e barge-in exige 250 ms | `voice.ts` `RMS_THRESHOLD*`, `BARGE_IN_HYSTERESIS_MS` |
| Durante `falando` o cliente **não** grava segmento para STT — só avalia barge-in | `processAudioBlock` retorna cedo se `speaking` |
| Eco acústico é risco declarado da T8 (categoria 5, meta 0/60) | `docs/t8-roteiro-baseline-voz.md` |
| Ativação por palavra de despertar / always-on mic está **fora de escopo** (decisão OpenJarvis #6) | plano v2.6 §6 |
| Áudio do usuário nunca vai à nuvem (STT local) | inventário / Fase 12 |

**Hipótese (a medir, não afirmação):** no WKWebView do painel desktop, o VPIO do macOS aplica AEC de verdade quando `echoCancellation: true`. O plano **verifica** via `track.getSettings()` / `getConstraints()` e falha fechado se o modo viva-voz estiver ligado e AEC vier `false`.

---

## 1. Escopo em duas fatias (decisão tomada neste plano)

### Fatia A — Modo viva-voz (obrigatória nesta entrega)

Toggle **opt-in** “Viva-voz” (padrão **desligado**; quem usa fone não muda comportamento).

Quando ligado:

1. **Constraints reforçadas** no `getUserMedia` / `applyConstraints`:
   - `echoCancellation: true`
   - `noiseSuppression: true`
   - `autoGainControl: true`
   - Após obter o track: ler `getSettings()`. Se `echoCancellation === false`, **não** fingir sucesso: UI mostra “Cancelamento de eco indisponível neste microfone; viva-voz pode falhar” e o modo continua (aviso, não aborta a sessão).
2. **Perfis de VAD** (constantes nomeadas, não mágicas espalhadas):
   - `RMS_THRESHOLD_SPEAKERPHONE = 0.020` (ouvindo)
   - `RMS_THRESHOLD_WHILE_SPEAKING_SPEAKERPHONE = 0.070`
   - `BARGE_IN_HYSTERESIS_SPEAKERPHONE_MS = 350`
   - `POST_TTS_COOLDOWN_MS = 400` — após o fim da última frase (`onended` / drain vazio), ignorar onset de fala por 400 ms (corta o eco residual que vira “turno fantasma”).
3. **Duck de playback**: volume do `AudioBufferSourceNode` (ou gain node no caminho de TTS) em `0.85` no modo viva-voz (só playback; não altera a captura). Objetivo: reduzir energia no alto-falante sem “sumir” a voz.
4. **Persistência do toggle:** `localStorage` chave `rodrigo.voice.speakerphone` (`"0"|"1"`). Sem cookie, sem nuvem.
5. **UI:** botão `Viva-voz` ao lado do mute (`aria-pressed`), texto de estado quando ligado: “Viva-voz — alto-falante; eco filtrado pelo sistema”.
6. **Desktop:** o menu do ícone ganha “Viva-voz” espelhando `window.__toggleSpeakerphone()` (mesmo padrão do mute). Sem mudar Host/rede.

### Fatia B — Voz pessoal (obrigatória nesta entrega, com honestidade de limite)

**Não** é biometria forense nem diarização multi-falante de reunião. É um **gate local opt-in** que compara a fala candidata a um perfil gravado pelo próprio Rodrigo.

1. **Enrolamento (uma vez por máquina/navegador):**
   - Botão “Gravar minha voz” → UI pede 3 frases curtas (≥ 1,0 s de voz cada, silêncio 1,0 s entre elas).
   - Para cada frase, extrair um **vetor de perfil** local (ver §2) e guardar a **média** normalizada.
   - Armazenamento: `localStorage` / `IndexedDB` no origin do app (`rodrigo.voice.personalProfile`), **nunca** enviado a Gemini/Anthropic/worker. Doctor e cartão de privacidade: “perfil de voz fica neste computador”.
2. **Uso:**
   - Toggle “Voz pessoal” só habilita se existir perfil.
   - Em `beginRecording` (onset) e em `triggerBargeIn`: se o modo estiver ligado, calcular similaridade cosseno entre o trecho candidato (pré-roll + início) e o perfil. Se `< SIMILARITY_MIN` (padrão `0.72`, constante), **descartar** o onset/barge-in (não cancela TTS por eco de outra pessoa; não abre turno).
   - Se `≥` limiar, comportamento atual.
3. **Apagar perfil:** botão “Esquecer minha voz” limpa o storage.
4. **Limite declarado na UI:** “Isto reduz vozes e ruídos muito diferentes da sua; não é reconhecimento forense e pode falhar com gripe, microfone novo ou ambiente muito ruidoso.”

**Fora de escopo (explícito):** palavra de despertar, mic sempre ligado com app fechado, modelo de embedding em nuvem, dependência nova (ONNX/transformers), fine-tune, PersonaPlex.

---

## 2. Perfil de voz — algoritmo local (sem dependência nova)

Implementação em `src/frontend/voiceProfile.ts` (puro, testável em Node com FFT sintético):

1. Entrada: `Float32Array` PCM mono (já 16 kHz do `AudioContext`).
2. Dividir em janelas de 512 amostras, hop 256; janelas com energia abaixo de piso são ignoradas.
3. Em cada janela: magnitude de FFT (implementação Cooley–Tukey radix-2 inline, ≤ 80 linhas, sem lib).
4. Agrupar em **24 bandas log** de ~80 Hz–7 kHz; média das magnitudes → vetor 24-D; L2-normalizar.
5. Média dos vetores das 3 frases de enrolamento → perfil.
6. Similaridade: cosseno entre perfil e vetor do trecho candidato (mesmo pipeline).

**Por que não um modelo de speaker embedding:** seria dependência nova + download de pesos + auditoria de supply chain. O pedido é usável sem fone agora; o gate espectral local é a menor mudança que cumpre “focar na minha voz” com honestidade de limite.

---

## 3. Arquivos afetados

| Arquivo | Mudança |
|---|---|
| `src/frontend/voice.ts` | toggles, constraints, cooldown, duck, hooks do gate |
| `src/frontend/voiceProfile.ts` | **novo** — FFT/bandas/similaridade + serialize |
| `src/frontend/main.ts` | botões, wired `__toggleSpeakerphone`, enrolamento |
| `src/frontend/index.html` + `style.css` | botões e notas PT-BR |
| `desktop/main.swift` | item de menu Viva-voz + bridge JS |
| `src/frontend/__tests__/voiceProfile.test.ts` | **novo** — similaridade alta no mesmo sinal, baixa em ruído/outro espectro; serialize round-trip |
| `src/backend/__tests__/…` | só se aparecer contrato novo; preferir testes de frontend puros |
| `docs/inventario-canais-nuvem.md` | uma linha: perfil de voz local, nunca sai |
| `.env.example` / `privacy.ts` | **sem** novo canal de nuvem |

Nenhuma mudança no worker Python, Gemini, ou confirmação de mutação: o gate age **antes** de qualquer POST `/audio`.

---

## 4. Pseudocódigo (completo)

### 4.1 Ativar viva-voz

```
function setSpeakerphone(on: boolean): void {
  speakerphone = on
  localStorage.setItem('rodrigo.voice.speakerphone', on ? '1' : '0')
  applyVadProfile()
  if (mediaStream) await reinforceConstraints(mediaStream)
  setPlaybackDuck(on ? 0.85 : 1.0)
  notifyUi()
}

async function reinforceConstraints(stream: MediaStream): Promise<void> {
  const track = stream.getAudioTracks()[0]
  if (!track) return
  try {
    await track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    })
  } catch (e) { console.warn('[viva-voz] applyConstraints', e) }
  const s = track.getSettings()
  aecActive = s.echoCancellation === true
  // UI lê aecActive; se false, mostra aviso
}

function applyVadProfile(): void {
  if (speakerphone) {
    rmsListen = 0.020; rmsSpeak = 0.070; bargeMs = 350
  } else {
    rmsListen = 0.012; rmsSpeak = 0.045; bargeMs = 250
  }
}
```

### 4.2 Cooldown pós-TTS

```
// no onended da última frase / quando a fila esvazia e estado efetiva → ouvindo:
postTtsCooldownUntil = performance.now() + (speakerphone ? 400 : 0)

// em processAudioBlock, ramo !recording:
if (performance.now() < postTtsCooldownUntil) {
  // ainda enche ring buffer, mas NÃO acumula continuousVoiceMs / NÃO beginRecording
  pushRing(...); return
}
```

### 4.3 Gate de voz pessoal

```
async function maybeAcceptVoice(samples: Float32Array, kind: 'onset' | 'barge'): Promise<boolean> {
  if (!personalVoiceEnabled || !profile) return true
  const v = computeBandVector(samples)
  if (!v) return false
  return cosine(profile, v) >= 0.72
}

// beginRecording: só chama se await maybeAcceptVoice(concat(ring+current), 'onset')
// triggerBargeIn: só cancela TTS se await maybeAcceptVoice(últimos ~800ms, 'barge')
```

### 4.4 Enrolamento

```
async function enrollPersonalVoice(): Promise<void> {
  // UI: 3 prompts; para cada um, gravar até silence 1000ms com min 1000ms de voz
  const vectors = []
  for (i in 0..2) {
    const pcm = await captureUtterance()
    const v = computeBandVector(pcm)
    if (!v) throw 'frase inaudível'
    vectors.push(v)
  }
  profile = averageNormalize(vectors)
  saveProfile(profile) // IndexedDB preferido; localStorage fallback base64
}
```

---

## 5. Testes e aceite

| ID | Caso | Esperado |
|---|---|---|
| H-VV.1 | `computeBandVector` no mesmo sinal vs ruído branco | cosseno alto (≥ 0,9) vs baixo (≤ 0,5) |
| H-VV.2 | serialize/deserialize do perfil | bytes idênticos em cosseno (±1e-6) |
| H-VV.3 | cooldown: com speakerphone, onset 200 ms após TTS | `beginRecording` **não** chamado |
| H-VV.4 | viva-voz off: limiares iguais aos atuais | regressão numérica |
| H-VV.5 | voz pessoal on + perfil; candidato com cosseno 0,4 | barge-in e onset bloqueados |
| H-VV.6 | voz pessoal on; cosseno 0,85 | onset permitido |
| Smoke humano (Rodrigo) | 10 respostas no alto-falante, viva-voz on | 0 turno fantasma por eco; anotar no doc se falhar |

`npm run typecheck` e testes novos verdes. Smoke humano **não** baixa meta se falhar — vira dívida registrada (mesma honestidade T8).

---

## 6. Privacidade e segurança

- Perfil e toggles só no origin local; inventário atualizado.
- Nenhum envio ao worker/Gemini.
- Enrolamento exige clique explícito; apagar é um clique.
- Não usar o perfil para autenticação de mutação: a confirmação falada (`markPlayed` + classificador) **permanece** a garantia; o gate só evita eco/outras vozes abrirem turno.

---

## 7. Decisões do Rodrigo (se discordar, pare antes do código)

1. **D-VV1:** aceita o gate espectral local (24 bandas) como “voz pessoal v1”, com o aviso de limite na UI, em vez de esperar um modelo de embedding?
2. **D-VV2:** toggles padrão **desligados** (opt-in)?
3. **D-VV3:** menu do painel desktop espelha só “Viva-voz” nesta fatia; enrolamento fica na UI web do painel?

Recomendação do autor: **sim / sim / sim**.

---

## 8. Ordem de implementação (após auditoria apta)

1. `voiceProfile.ts` + testes H-VV.1/2  
2. Hooks em `voice.ts` (speakerphone + cooldown + duck + gate) + H-VV.3–6  
3. UI HTML/CSS/`main.ts`  
4. Menu Swift  
5. inventário + typecheck  

Estimativa: 4–8 h de implementação + auditoria. Não inclui a bateria T8 de 60×5.
