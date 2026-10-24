# Auditoria adversarial — `modo-viva-voz-voz-pessoal-v1.md`

- **Data:** 2026-10-15
- **Plano hash SHA-256:** `6b390f6e80c436f4784fe8a3c3498f8bf65d6e6d1d248a853dcfabe55a5b986d`
- **Auditor:** subagente independente (GPT) via Cursor Task
- **Veredito:** **BLOQUEADO**

## Achados aceitos (todos os altos + médias relevantes)

1. Estado `falando` SSE ≠ playback real → VAD/eco/barge-in precisam de `outputPlaying` local.
2. Gate espectral 24 bandas não demonstra identificação de falante; H-VV.1 (sinal vs ruído) é teste fraco.
3. Limiar 0.72 sem calibração.
4. Cooldown 400 ms pode engolir “sim/não” de confirmação.
5. Barge-in sem buffer dos “últimos 800 ms”; `await` no caminho síncrono do VAD.
6. Contradição fail-closed vs aviso com modo ligado sem AEC.
7. `WKWebsiteDataStore.nonPersistent()` → localStorage não persiste no painel.
8. Enrolamento sem isolar captura → risco de POST `/audio` durante gravação do perfil.
9. Testes frontend fora do `npm test` oficial.
10. Doctor/cartão prometidos sem arquivos no plano.

## Decisão pós-auditoria

- **Fatia B (voz pessoal)** sai desta entrega → plano próprio depois de calibração real.
- **Fatia A (viva-voz)** segue em `modo-viva-voz-v2.md` com mitigação dos achados 1, 4, 5 (parcial), 6, 7, 9.
