#!/usr/bin/env python3
"""
Síntese de voz via Kokoro-82M, apenas gravando um arquivo WAV — NUNCA toca áudio
(Achado v2-4: o servidor MCP existente em ~/.venvs/tts-say usa `afplay` e apaga o
arquivo, o que violaria a regra "só o navegador toca som" da Fase 2. Este script é
um caminho dedicado, sem afplay, reaproveitando os mesmos modelos/pesos já baixados).

Uso: chamado pelo Node via `~/.venvs/tts-say/bin/python3 kokoro_synth.py <output.wav>`,
com o texto enviado por stdin (não por argv) para não depender de nenhuma convenção de
parsing de flags do texto dinâmico gerado pelo LLM.

Requer o venv ~/.venvs/tts-say já existente e populado (não faz parte do setup da Fase 2;
se não existir ou faltar dependência, o KokoroVoiceProvider.isAvailable() retorna false
e o Rodrigo AI usa o SayVoiceProvider como padrão sem quebrar).
"""
import sys
from pathlib import Path

MODELS_DIR = Path.home() / ".venvs" / "tts-say" / "models"

# As 3 vozes pt-BR do voices-v1.0.bin; espelha KOKORO_VOICES em ttsProviders.ts.
VOICES = ("pf_dora", "pm_alex", "pm_santa")


def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("Uso: kokoro_synth.py <output.wav> [pf_dora|pm_alex|pm_santa]", file=sys.stderr)
        return 1

    output_path = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) == 3 else "pf_dora"
    if voice not in VOICES:
        print(f"Voz desconhecida: {voice}", file=sys.stderr)
        return 1
    text = sys.stdin.read()
    if not text.strip():
        print("Texto vazio recebido via stdin.", file=sys.stderr)
        return 1

    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    EspeakWrapper.set_library(espeakng_loader.get_library_path())

    from kokoro_onnx import Kokoro
    import soundfile as sf

    kokoro = Kokoro(
        str(MODELS_DIR / "kokoro-v1.0.fp16.onnx"),
        str(MODELS_DIR / "voices-v1.0.bin"),
    )

    samples, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang="pt-br")
    sf.write(output_path, samples, sample_rate)
    return 0


if __name__ == "__main__":
    sys.exit(main())
