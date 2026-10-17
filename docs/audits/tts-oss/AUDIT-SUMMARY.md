# Auditoria TTS-OSS — resumo (2026-10-16)

## Rodadas

| Rodada | Ferramenta | Resultado |
|---|---|---|
| 1 | Cursor Agent | `plan-r1-cursor-agent.txt` — achados ALTA (licença, H2 hardware, loopback, contradição de gate) |
| 2 | Gemini CLI | `plan-r2-gemini.txt` — **falhou** (404 modelo 2.5-pro; depois 429 spend cap) |
| 3 | OpenCode (nemotron) | `plan-r3-opencode.txt` — confirma H2 falho; recomendação: Charon default |

## Mitigações aplicadas

1. Licença VoxCPM2 confirmada **Apache-2.0** no card HF `openbmb/VoxCPM2`.
2. Gate de loopback em `parseVoxCpmEnv` e em `scripts/audicao-tts-oss.mjs` (localhost → 127.0.0.1).
3. H2 medido no M5 16GB e declarado **não passado de forma consistente** (2,9–6,1 s).
4. Provider opcional; **default permanece Charon** até H1 (usuário ouve `.runtime/audicao-tts-oss/`).
5. Timeout default 8 s + fallback `say` + `onFallback`.

## Veredito de processo

Pronto para **manter** `TTS_ENGINE=voxcpm` / `CONFIGURAR_VOZ` como opção experimental local. **Não** trocar o default. H1 ainda exige o usuário ouvir e preencher `docs/phase-tts-oss-v1.md` §8.
