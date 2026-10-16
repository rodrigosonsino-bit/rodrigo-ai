#!/usr/bin/env python3
"""
Baixa e materializa os modelos locais (LLM + STT + visão da Fase V), com um teto de
tamanho antes de baixar qualquer byte, e grava um manifesto com revisões/tamanhos
resolvidos.

Só roda durante `npm run setup:voice` (RODRIGO_VOICE_SETUP=1, HF_HUB_OFFLINE=0).
Nunca roda automaticamente ao iniciar uma sessão de voz.
"""
import json
import os
import sys
from pathlib import Path

from worker import VISION_MODEL_ID  # fonte única do ID (worker.py § handle_describe_screen usa o mesmo)

LLM_MODEL_ID = "mlx-community/Qwen3-4B-Instruct-2507-4bit"
STT_MODEL_ID = "mlx-community/whisper-small-mlx"
DOWNLOAD_LIMIT_BYTES = 8 * 1024 * 1024 * 1024  # 8 GiB


def total_size_bytes(api, repo_id: str) -> tuple[int, str]:
    info = api.model_info(repo_id, files_metadata=True)
    total = sum((f.size or 0) for f in info.siblings)
    return total, info.sha


def main() -> int:
    if os.environ.get("RODRIGO_VOICE_SETUP") != "1":
        print("Recuse-se a rodar fora do setup explícito (RODRIGO_VOICE_SETUP=1).", file=sys.stderr)
        return 1

    from huggingface_hub import HfApi

    api = HfApi()

    print(f"[setup] Consultando tamanho de {LLM_MODEL_ID}...")
    llm_size, llm_revision = total_size_bytes(api, LLM_MODEL_ID)
    print(f"[setup] Consultando tamanho de {STT_MODEL_ID}...")
    stt_size, stt_revision = total_size_bytes(api, STT_MODEL_ID)
    print(f"[setup] Consultando tamanho de {VISION_MODEL_ID}...")
    vlm_size, vlm_revision = total_size_bytes(api, VISION_MODEL_ID)

    projected_total = llm_size + stt_size + vlm_size
    print(f"[setup] Tamanho projetado total: {projected_total / (1024**3):.2f} GiB")

    if projected_total > DOWNLOAD_LIMIT_BYTES:
        print(
            f"[setup] ERRO: download projetado ({projected_total / (1024**3):.2f} GiB) "
            f"excede o limite de {DOWNLOAD_LIMIT_BYTES / (1024**3):.0f} GiB. Abortando sem baixar nada.",
            file=sys.stderr,
        )
        return 1

    print(f"[setup] Baixando {LLM_MODEL_ID}...")
    from mlx_lm import load as mlx_lm_load

    mlx_lm_load(LLM_MODEL_ID)
    print("[setup] LLM materializado.")

    print(f"[setup] Baixando {STT_MODEL_ID}...")
    from huggingface_hub import snapshot_download

    snapshot_download(STT_MODEL_ID)
    print("[setup] STT materializado.")

    print(f"[setup] Baixando {VISION_MODEL_ID}...")
    from mlx_vlm import load as mlx_vlm_load

    mlx_vlm_load(VISION_MODEL_ID)
    print("[setup] Visão materializada.")

    manifest = {
        "llm": {"repo": LLM_MODEL_ID, "revision": llm_revision, "size_bytes": llm_size},
        "stt": {"repo": STT_MODEL_ID, "revision": stt_revision, "size_bytes": stt_size},
        "vision": {"repo": VISION_MODEL_ID, "revision": vlm_revision, "size_bytes": vlm_size},
        "total_bytes": projected_total,
        "download_limit_bytes": DOWNLOAD_LIMIT_BYTES,
    }

    manifest_path = Path(os.environ.get("RODRIGO_VOICE_MANIFEST_PATH", ".runtime/models-manifest.json"))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[setup] Manifesto gravado em {manifest_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
