# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Strip model file extensions to build comparison keys — the single place.

A 2026-08-16 inventory found the same rule hand-written in **nine places with
five different lists** (``_measurements/normalization_inventory_2026-08-16.md``).
Every one of them was missing ``.sft``, and ``.pt2`` / ``.pkl`` appeared nowhere.
The damage was real: a recipe recording ``ae.sft`` failed to match the installed
``ae.safetensors`` and had its whole prompt rejected.

**Declaring a shared rule is not checking it.** The comment on
``recipeMissingModels.js`` said "same rule as the backend ``normalize_model_name``"
while the two lists differed. Equality between the JavaScript and Python sides is
pinned by ``tests/utils/test_model_file_names.py``, which reads both files.

This module is about *names*. Whether a file's bytes really are that model is a
different question, answered by ``py.utils.model_file_validation`` — which
excludes extensions such as ``.onnx`` that carry no container contract here.
"""

from __future__ import annotations

import re
from typing import Any, Tuple

#: ComfyUI's ``folder_paths.supported_pt_extensions`` (measured against 0.27.0)
#: plus ``onnx``, which some custom nodes use.
#:
#: Order matters: ``pt2`` must precede ``pt`` so the alternation does not split
#: ``model.pt2`` into ``model.`` + ``2``.
MODEL_FILE_EXTENSIONS: Tuple[str, ...] = (
    "safetensors", "sft", "ckpt", "pt2", "pt", "pth", "bin", "pkl", "onnx",
)

#: The ComfyUI side on its own (no ``onnx``). Tests compare this to the measured set.
COMFYUI_SUPPORTED_PT_EXTENSIONS: Tuple[str, ...] = (
    "ckpt", "pt", "pt2", "bin", "pth", "safetensors", "pkl", "sft",
)

MODEL_EXTENSION_PATTERN = re.compile(
    r"\.(?:%s)$" % "|".join(MODEL_FILE_EXTENSIONS), re.IGNORECASE
)

_NON_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")


def model_basename(value: Any) -> str:
    """Basename after normalising separators; records arrive with both ``\\`` and ``/``."""

    return str(value or "").replace("\\", "/").rsplit("/", 1)[-1]


def strip_model_extension(value: Any) -> str:
    """Drop only a trailing model extension (no basename step)."""

    return MODEL_EXTENSION_PATTERN.sub("", str(value or ""))


def model_stem(value: Any) -> str:
    """Basename with the model extension removed."""

    return strip_model_extension(model_basename(value))


def compact_model_name(value: Any) -> str:
    """Comparison key that survives spelling differences.

    Recipes spell the same upscaler as ``R-ESRGAN 4x+ Anime6B`` while ComfyUI
    lists it as ``RealESRGAN_x4plus_anime_6B.pth``; only the alphanumerics
    survive both spellings.
    """

    return _NON_ALPHANUMERIC.sub("", model_stem(value).casefold())
