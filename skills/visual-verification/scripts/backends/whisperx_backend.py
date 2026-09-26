#!/usr/bin/env python3
"""Normalize WhisperX transcription results behind the speech v1 contract."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import os
import sys
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "agent-verification-lab.speech.v1"


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def clean_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize_segments(raw_segments: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not isinstance(raw_segments, list):
        return normalized
    for position, segment in enumerate(raw_segments):
        if not isinstance(segment, dict):
            continue
        text = clean_text(segment.get("text"))
        start = finite_number(segment.get("start"))
        end = finite_number(segment.get("end"))
        if not text or start is None or end is None or end < start:
            continue
        segment_id = segment.get("id", position)
        normalized.append({"id": segment_id if isinstance(segment_id, int) else position, "text": text, "start": start, "end": end})
    return normalized


def normalize_words(raw_segments: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not isinstance(raw_segments, list):
        return normalized
    for segment in raw_segments:
        if not isinstance(segment, dict):
            continue
        raw_words = segment.get("words")
        if not isinstance(raw_words, list):
            continue
        for word in raw_words:
            if not isinstance(word, dict):
                continue
            text = clean_text(word.get("word", word.get("text")))
            start = finite_number(word.get("start"))
            end = finite_number(word.get("end"))
            if not text or start is None or end is None or end < start:
                continue
            item: dict[str, Any] = {"text": text, "start": start, "end": end}
            score = finite_number(word.get("score"))
            if score is not None:
                item["score"] = score
            normalized.append(item)
    return normalized


def package_version() -> str | None:
    try:
        return importlib.metadata.version("whisperx")
    except importlib.metadata.PackageNotFoundError:
        return None


def backend_provenance(args: argparse.Namespace, version: str | None, alignment: dict[str, Any] | None = None) -> dict[str, Any]:
    provenance: dict[str, Any] = {
        "name": "whisperx",
        "version": version,
        "device": args.device,
        "model": args.model,
        "model_cache_path": str(Path(args.model_cache_path).resolve()),
    }
    if alignment is not None:
        provenance["alignment"] = alignment
    return provenance


def emit_failure(
    args: argparse.Namespace,
    message: str,
    version: str | None = None,
    language: str | None = None,
    alignment: dict[str, Any] | None = None,
    segments: list[dict[str, Any]] | None = None,
    words: list[dict[str, Any]] | None = None,
) -> int:
    print(json.dumps({
        "schema_version": SCHEMA_VERSION,
        "status": "REQUIRES_BACKEND",
        "language": language,
        "backend": backend_provenance(args, version, alignment),
        "segments": segments or [],
        "words": words or [],
        "error": message,
    }, ensure_ascii=True, separators=(",", ":")))
    return 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-wav", required=True)
    parser.add_argument("--language")
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--model-cache-path", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_wav = Path(args.input_wav)
    if not input_wav.is_file():
        return emit_failure(args, f"Temporary WAV is unavailable: {input_wav}")

    cache_path = Path(args.model_cache_path).resolve()
    os.environ["HF_HOME"] = str(cache_path)
    os.environ["HF_HUB_CACHE"] = str(cache_path / "hub")
    os.environ["TRANSFORMERS_CACHE"] = str(cache_path / "transformers")

    try:
        import whisperx
    except Exception as error:  # The adapter must degrade instead of importing a global fallback.
        return emit_failure(args, f"WhisperX import failed: {type(error).__name__}: {error}", package_version())

    version = getattr(whisperx, "__version__", None) or package_version()
    try:
        cache_path.mkdir(parents=True, exist_ok=True)
        compute_type = "float16" if args.device.lower().startswith("cuda") else "int8"
        model = whisperx.load_model(
            args.model,
            args.device,
            compute_type=compute_type,
            language=args.language or None,
            download_root=str(cache_path),
        )
        audio = whisperx.load_audio(str(input_wav))
        transcription = model.transcribe(audio, batch_size=4, language=args.language or None)
    except Exception as error:
        return emit_failure(args, f"WhisperX transcription failed: {type(error).__name__}: {error}", version)

    raw_segments = transcription.get("segments", []) if isinstance(transcription, dict) else []
    language = clean_text(transcription.get("language")) if isinstance(transcription, dict) else ""
    language = language or (args.language or "und")
    transcribed_segments = normalize_segments(raw_segments)
    if not transcribed_segments:
        return emit_failure(
            args,
            "No usable word timestamps/speech detected: no normalized speech segments were detected.",
            version,
            language,
            {"status": "not_attempted", "reason": "No speech segments to align"},
        )

    aligned_segments = raw_segments
    try:
        try:
            align_model, metadata = whisperx.load_align_model(language_code=language, device=args.device, model_dir=str(cache_path))
        except TypeError:
            align_model, metadata = whisperx.load_align_model(language_code=language, device=args.device)
        aligned = whisperx.align(raw_segments, align_model, metadata, audio, args.device, return_char_alignments=False)
        candidate_segments = aligned.get("segments", []) if isinstance(aligned, dict) else []
        if not isinstance(candidate_segments, list):
            return emit_failure(
                args,
                "WhisperX alignment returned no segments.",
                version,
                language,
                {"status": "unavailable", "reason": "WhisperX alignment returned no segments"},
                transcribed_segments,
            )
        aligned_segments = candidate_segments
    except Exception as error:
        return emit_failure(
            args,
            f"WhisperX alignment failed: {type(error).__name__}: {error}",
            version,
            language,
            {"status": "unavailable", "reason": f"{type(error).__name__}: {error}"},
            transcribed_segments,
        )

    normalized_segments = normalize_segments(aligned_segments)
    normalized_words = normalize_words(aligned_segments)
    if not normalized_segments:
        return emit_failure(
            args,
            "WhisperX alignment returned no normalized speech segments.",
            version,
            language,
            {"status": "unavailable", "reason": "No normalized aligned segments"},
            transcribed_segments,
        )
    if not normalized_words:
        return emit_failure(
            args,
            "WhisperX alignment returned no usable word timestamps/speech detected.",
            version,
            language,
            {"status": "unavailable", "reason": "No finite normalized word timestamps"},
            normalized_segments,
        )

    result = {
        "schema_version": SCHEMA_VERSION,
        "status": "ok",
        "language": language,
        "backend": backend_provenance(args, version, {"status": "aligned"}),
        "segments": normalized_segments,
        "words": normalized_words,
    }
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
