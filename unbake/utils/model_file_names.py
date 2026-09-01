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
pinned by ``tests/declared_tests_exist_test.mjs``, which reads both files.

(2026-08-28: this line named a test that did not exist. The same test now also
checks that every test named from source is real.)

This module is about *names*. Whether a file's bytes really are that model is a
different question, answered by ``unbake/utils/model_file_validation.py`` — which
excludes extensions such as ``.onnx`` that carry no container contract here.
"""

from __future__ import annotations

import re
from typing import Any, Tuple

#: ComfyUI's ``folder_paths.supported_pt_extensions`` (measured against 0.27.0)
#: plus ``onnx`` and ``gguf``, which custom nodes use.
#:
#: ``gguf`` was added on 2026-08-31 (``I-20260831-69``).  It was already treated
#: as a model extension by ``models.py`` and ``model_index.py`` -- which had
#: their own copies of this list -- but not here, so the two sides keyed the
#: same file differently: Python indexed ``x.gguf`` as ``x`` while the browser
#: looked it up as ``xgguf``.
#:
#: Order matters: ``pt2`` must precede ``pt`` so the alternation does not split
#: ``model.pt2`` into ``model.`` + ``2``.
MODEL_FILE_EXTENSIONS: Tuple[str, ...] = (
    "safetensors", "sft", "ckpt", "pt2", "pt", "pth", "bin", "pkl", "onnx", "gguf",
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


def model_lookup_key(value: Any) -> str:
    """索引を引くための鍵。**フォルダと本体の拡張子を落として小文字にする。**

    ここは長く**3箇所に手で書かれて**いた（``I-20260831-69``）——
    ``models.py`` の ``_stem`` / ``model_index.py`` の ``name_key`` /
    ``web/panel/modelsView.js`` の ``stemOf``。どれも同じことをしていたが、
    落とす拡張子の一覧が**それぞれ違って**いたので、境界で鍵が食い違った。

    **``os.path.splitext`` を使わない**（写しの側が書いていた理由をここへ移す）。
    あれは最後の ``.`` から後ろを落とすので、拡張子の付いていない名前が
    版番号のところで切れる:

        ``ink-style_A3.1_XL``              -> ``ink-style_a3``（``.1_XL`` を拡張子と誤読）
        ``ink-style_A3.1_XL.safetensors``  -> ``ink-style_a3.1_xl``

    左右で茎が食い違うので、**導入済みなのに「入っていない」**になる。
    ``re-mixmain.fp16`` のような「名前の一部」も、一覧に無いので落ちない。
    """

    return model_stem(value).strip().lower()


def compact_model_name(value: Any) -> str:
    """Comparison key that survives spelling differences.

    Recipes spell the same upscaler as ``R-ESRGAN 4x+ Anime6B`` while ComfyUI
    lists it as ``RealESRGAN_x4plus_anime_6B.pth``; only the alphanumerics
    survive both spellings.
    """

    return _NON_ALPHANUMERIC.sub("", model_stem(value).casefold())
