# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**落とした先が、読み口の見る場所と一致すること。**

2026-08-26 に利用者の指示で実測して見つけた穴。Civitai の `type` を
そのまま置き場へ写すと、**Anima / Krea 2 / Z-Image が `models/checkpoints`
へ行く**——こちらが組むワークフローは `UNETLoader` を出すので、読み口が
見るのは `models/unet`。つまり**落とし終わった直後にまだ「不足」**になる。

置き場の間違いは**失敗として現れない**（転送は成功する）ので、
「落ちているのに使えない」という判りにくい形でしか気づけない。
"""
import re
import unittest
from pathlib import Path

from unbake.civitai import (
    resolve_version,
    DIFFUSION_MODEL_BASE_MODELS,
    KIND_OF_TYPE,
    _is_diffusion_model,
)
from unbake.download import ALLOWED_KINDS

ROOT = Path(__file__).resolve().parents[1]

#: ComfyUI 本体の読み口が、どの置き場を見るか（実測 2026-08-26・folder_paths.py）。
LOADER_READS = {
    "CheckpointLoaderSimple": "checkpoints",
    "LoraLoader": "loras",
    "VAELoader": "vae",
    "ControlNetLoader": "controlnet",
    "UpscaleModelLoader": "upscale_models",
    "HypernetworkLoader": "hypernetworks",
    "UNETLoader": "diffusion_models",
}


class ModelDestinationTest(unittest.TestCase):
    def test_決めた置き場は全部落とせる先になっている(self):
        # 対応表に在るのに `ALLOWED_KINDS` に無いと、**その型だけ静かに落とせない**。
        missing = sorted(set(KIND_OF_TYPE.values()) - set(ALLOWED_KINDS))
        self.assertEqual(missing, [], f"落とせない置き場を指している: {missing}")

    def test_読み口が見る置き場は全部落とせる先になっている(self):
        missing = sorted(set(LOADER_READS.values()) - set(ALLOWED_KINDS))
        self.assertEqual(missing, [], f"読み口は見るのに落とせない: {missing}")

    def test_Hypernetworkを拒まない(self):
        # 直す前は `None` になり「unsupported model type」で拒んでいた。
        self.assertEqual(KIND_OF_TYPE.get("hypernetwork"), "hypernetworks")

    def test_ファイルの種別が拡散モデルなら一覧より先に効く(self):
        # **一覧は人が足す物なので、新しい系統では必ず遅れる。**
        # 投稿された印がある時は、そちらを見る。
        version = {"baseModel": "まだ一覧に無い系統",
                   "files": [{"type": "Diffusion Model", "name": "x.safetensors"}]}
        self.assertTrue(_is_diffusion_model(version))
        self.assertTrue(_is_diffusion_model(
            {"baseModel": "", "files": [{"type": "UNet"}]}))

    def test_baseModelで拾う(self):
        for base in ("Anima", "Krea 2", "ZImageTurbo", "Flux.1 D", "Qwen", "Chroma"):
            with self.subTest(base=base):
                self.assertTrue(_is_diffusion_model({"baseModel": base, "files": []}))

    def test_ふつうのチェックポイントは動かさない(self):
        # **SDXL を `models/unet` へ送ると、こちらが壊す側になる。**
        for base in ("SDXL 1.0", "SD 1.5", "Illustrious", "Pony", "NoobAI"):
            with self.subTest(base=base):
                self.assertFalse(_is_diffusion_model(
                    {"baseModel": base, "files": [{"type": "Model"}]}))

    def test_JS側の系統がPython側の一覧に含まれている(self):
        """**2つの言語に同じ知識が在る。** 片方だけ足すと食い違う。

        `recipeWorkflowBuilder.js` が `UNETLoader` を出す系統は、こちらが
        `models/unet` へ落とす系統と**同じでなければならない**。ずれると
        「UNet 構成で組むのに checkpoints へ落とす」（＝落としても不足のまま）
        か、その逆（＝使わない場所へ置く）になる。
        """
        source = (ROOT / "web/core/recipeWorkflowBuilder.js").read_text(encoding="utf-8")
        block = source.split("const UNET_ARCHITECTURES = [", 1)[1].split("\n];", 1)[0]
        patterns = re.findall(r"family:\s*/(.+?)/i", block)
        self.assertGreaterEqual(len(patterns), 5, "JS 側の系統を読めていない")
        for pattern in patterns:
            with self.subTest(pattern=pattern):
                rx = re.compile(pattern, re.IGNORECASE)
                hit = [b for b in DIFFUSION_MODEL_BASE_MODELS if rx.search(b)]
                self.assertTrue(
                    hit,
                    f"JS は /{pattern}/i を UNet 系統として扱うのに、"
                    f"Python 側の一覧に該当が無い（落とし先が checkpoints になる）",
                )

    def test_resolve_versionが実際に置き場を振り替える(self):
        """**判定できることと、それが効いていることは別。**

        `_is_diffusion_model` だけを検査していたときは、`resolve_version` の
        分岐を `False` に潰しても検査は緑のままだった（変異検査で素通り）。
        落とし先を決めるのはここなので、**ここを通して測る**。
        """
        def fake(url, api_key="", **_):
            return {
                "id": 1, "name": "v1", "baseModel": "Anima",
                "model": {"type": "Checkpoint", "name": "Anima"},
                "files": [{
                    "type": "Model", "name": "anima_baseV10.safetensors",
                    "primary": True, "sizeKB": 1024,
                    "downloadUrl": "https://civitai.com/api/download/models/1",
                    "hashes": {"SHA256": "AB" * 32},
                }],
            }

        got = resolve_version("1", fetch=fake)
        self.assertTrue(got.get("ok"), got)
        self.assertEqual(got["kind"], "diffusion_models",
                         "Anima を checkpoints へ落とそうとしている"
                         "（読み口は UNETLoader＝models/unet を見る）")

    def test_ふつうのチェックポイントはresolve_versionでも動かない(self):
        def fake(url, api_key="", **_):
            return {
                "id": 2, "name": "v1", "baseModel": "SDXL 1.0",
                "model": {"type": "Checkpoint", "name": "何か"},
                "files": [{
                    "type": "Model", "name": "x.safetensors",
                    "primary": True, "sizeKB": 1024,
                    "downloadUrl": "https://civitai.com/api/download/models/2",
                    "hashes": {"SHA256": "CD" * 32},
                }],
            }

        got = resolve_version("2", fetch=fake)
        self.assertTrue(got.get("ok"), got)
        self.assertEqual(got["kind"], "checkpoints")


if __name__ == "__main__":
    unittest.main()
