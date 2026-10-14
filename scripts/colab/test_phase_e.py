#!/usr/bin/env python3
"""Validation suite for Phase E: audio-transcriber benchmark and WER/CER pipeline."""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "colab"))
from lib.audio_eval import (  # noqa: E402
    calculate_cer,
    calculate_wer,
    edit_distance,
    execute_audio_evaluation,
    generate_synthetic_wav,
    inspect_offline_whisper_weights,
    normalize_transcript,
)
from lib.contract import ContractError, validate_result  # noqa: E402


def test_edit_distance_and_normalization() -> None:
    # Character edit distance
    assert edit_distance(list("kitten"), list("sitting")) == 3
    # Word edit distance
    assert edit_distance(["ola", "mundo"], ["ola", "amigo"]) == 1

    # Text normalization
    raw = "Olá, Mundo!   TESTE... 123"
    assert normalize_transcript(raw) == "olá mundo teste 123"


def test_wer_and_cer_untruncated() -> None:
    # Exact match
    assert calculate_wer("bom dia", "bom dia") == 0.0
    assert calculate_cer("bom dia", "bom dia") == 0.0

    # Single substitution: 1 error in 4 words -> 0.25
    assert math.isclose(calculate_wer("o gato bebe leite", "o rato bebe leite"), 0.25, abs_tol=1e-4)

    # Deletion: 1 deletion in 3 words -> 1/3
    assert math.isclose(calculate_wer("um dois tres", "um tres"), 1.0 / 3.0, abs_tol=1e-4)

    # Untruncated WER: 2 insertions on 1 word -> 2.0 (never clamped to 1.0)
    wer_excess = calculate_wer("casa", "casa bonita grande")
    assert math.isclose(wer_excess, 2.0, abs_tol=1e-4)
    assert wer_excess > 1.0


def test_synthetic_wav_pipeline() -> None:
    with tempfile.TemporaryDirectory() as temp:
        wav_path = Path(temp) / "test_pipeline.wav"
        info = generate_synthetic_wav(wav_path, duration_seconds=0.5, sample_rate=16000, frequency_hz=440.0)
        assert wav_path.exists()
        assert info["channels"] == 1
        assert info["sample_rate"] == 16000
        assert info["sample_width_bytes"] == 2

        with wave.open(str(wav_path), "rb") as wf:
            assert wf.getnchannels() == 1
            assert wf.getsampwidth() == 2
            assert wf.getframerate() == 16000
            assert wf.getnframes() == 8000  # 0.5s * 16000


def test_offline_weights_presence() -> None:
    weights = inspect_offline_whisper_weights()
    assert weights["exists"] is True, f"Whisper weights missing offline: {weights.get('reason')}"
    assert weights["size_bytes"] > 400_000_000, f"Unexpectedly small weights size: {weights['size_bytes']}"


def test_runner_and_contract() -> None:
    with tempfile.TemporaryDirectory() as temp:
        out_dir = Path(temp) / "run_audio"
        cmd = [
            sys.executable,
            str(ROOT / "scripts/colab/run-evaluation.py"),
            "audio-transcriber",
            "--seed", "7",
            "--run-id", "phase-e-success",
            "--output", str(out_dir),
        ]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        assert proc.returncode == 0, f"run-evaluation failed: {proc.stderr}"
        res_file = out_dir / "result.json"
        assert res_file.exists()
        result_data = json.loads(res_file.read_text(encoding="utf-8"))
        validate_result(result_data)
        assert result_data["status"] == "success"
        assert result_data["metrics"]["gpu_available"] == 0.0
        assert result_data["metrics"]["model_size_bytes"] > 400_000_000
        assert result_data["metrics"]["peak_memory_bytes"] > 0.0
        assert result_data["metrics"]["audio_duration_seconds"] > 0.0


def main() -> int:
    test_edit_distance_and_normalization()
    test_wer_and_cer_untruncated()
    test_synthetic_wav_pipeline()
    test_offline_weights_presence()
    test_runner_and_contract()
    print("phase E: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
