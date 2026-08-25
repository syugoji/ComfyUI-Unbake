# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Lossless helpers for replaying image generation metadata."""

from __future__ import annotations

import math
from typing import Any, Mapping


_A1111_MARKERS = ("\nSteps:", "\nNegative prompt:")


def normalize_metadata_text(value: str) -> str:
    """Repair common EXIF UTF-16 decoding mistakes without changing valid text."""
    if not isinstance(value, str) or not value:
        return value

    candidates = [value.replace("\x00", "") if "\x00" in value else value]
    for source_encoding, target_encoding in (
        ("utf-16be", "utf-16le"),
        ("utf-16le", "utf-16be"),
    ):
        try:
            candidates.append(value.encode(source_encoding).decode(target_encoding))
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass

    def score(text: str) -> tuple[int, int, int]:
        marker_score = sum(marker in text for marker in _A1111_MARKERS)
        printable_ascii = sum(32 <= ord(char) < 127 or char in "\r\n\t" for char in text)
        suspicious = text.count("\x00") + sum(ord(char) > 0x2FFF for char in text)
        return marker_score, printable_ascii, -suspicious

    best = max(candidates, key=score)
    return best if score(best) > score(value) else value


def json_safe_copy(value: Any) -> Any:
    """Return a JSON-safe copy while retaining every representable field."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): json_safe_copy(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe_copy(item) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    return str(value)


_OPTION_ALIASES = (
    ("Steps", ("Steps", "steps")),
    ("Sampler", ("Sampler", "sampler")),
    ("Schedule type", ("Schedule type", "scheduler", "scheduleType")),
    ("CFG scale", ("CFG scale", "cfgScale", "cfg_scale", "cfg")),
    ("Seed", ("Seed", "seed")),
    ("Size", ("Size", "size")),
    ("Model", ("Model", "model", "checkpoint")),
    ("Model hash", ("Model hash", "modelHash", "model_hash", "checkpoint_hash")),
    ("VAE", ("VAE", "vae")),
    ("VAE hash", ("VAE hash", "vaeHash", "vae_hash")),
    ("Clip skip", ("Clip skip", "clipSkip", "clip_skip")),
    ("Denoising strength", ("Denoising strength", "denoisingStrength", "denoising_strength")),
    ("Hires CFG Scale", ("Hires CFG Scale", "Hires CFG scale", "hiresCfgScale", "hires_cfg_scale")),
    ("Hires upscale", ("Hires upscale", "hiresUpscale", "hires_upscale")),
    ("Hires resize", ("Hires resize", "hiresResize", "hires_resize")),
    ("Hires steps", ("Hires steps", "hiresSteps", "hires_steps")),
    ("Hires upscaler", ("Hires upscaler", "hiresUpscaler", "hires_upscaler")),
)


def _first(metadata: Mapping[str, Any], aliases: tuple[str, ...]) -> Any:
    for key in aliases:
        value = metadata.get(key)
        if value not in (None, ""):
            return value
    return None


def build_a1111_parameters(metadata: Mapping[str, Any]) -> str | None:
    """Create an A1111-compatible replay string from Civitai Generation Data."""
    if not isinstance(metadata, Mapping):
        return None
    inner = metadata.get("meta")
    source = inner if isinstance(inner, Mapping) else metadata

    prompt = _first(source, ("prompt", "positivePrompt", "positive_prompt", "positive"))
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    negative = _first(source, ("negativePrompt", "negative_prompt", "negative"))
    negative = negative if isinstance(negative, str) else ""

    used: set[str] = {
        "prompt", "positivePrompt", "positive_prompt", "positive",
        "negativePrompt", "negative_prompt", "negative",
    }
    options: list[str] = []
    for label, aliases in _OPTION_ALIASES:
        value = _first(source, aliases)
        used.update(aliases)
        if value in (None, ""):
            continue
        options.append(f"{label}: {value}")

    if not any(option.startswith("Size:") for option in options):
        width, height = source.get("width"), source.get("height")
        if width not in (None, "") and height not in (None, ""):
            options.append(f"Size: {width}x{height}")
        used.update(("width", "height"))

    hashes = source.get("hashes")
    if isinstance(hashes, Mapping):
        lora_hashes = []
        ti_hashes = []
        for key, value in hashes.items():
            key_text = str(key)
            if key_text.lower().startswith("lora:"):
                lora_hashes.append(f"{key_text.split(':', 1)[1]}: {value}")
            elif key_text.lower().startswith(("ti:", "embedding:")):
                ti_hashes.append(f"{key_text.split(':', 1)[1]}: {value}")
        if lora_hashes:
            options.append(f"Lora hashes: {', '.join(lora_hashes)}")
        if ti_hashes:
            options.append(f"TI hashes: {', '.join(ti_hashes)}")
    used.add("hashes")

    ignored = {
        "resources", "civitaiResources", "additionalResources", "modelVersionIds",
        "browsingLevel", "nsfwLevel", "meta",
    }
    for key, value in source.items():
        if key in used or key in ignored or value in (None, ""):
            continue
        if isinstance(value, (str, int, float, bool)):
            options.append(f"{key}: {value}")

    if not options:
        return None
    return f"{prompt.rstrip()}\nNegative prompt: {negative.rstrip()}\n{', '.join(options)}"
