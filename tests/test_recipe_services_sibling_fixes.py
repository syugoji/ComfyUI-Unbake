# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**直した規則が、兄弟にも当たっていること**（2026-09-01・走査6周目）。

`services/recipes/` の3件は**同じ形**だった——**既に文書化された直しが、
その規則を要する兄弟のうち一部にしか当たっていない**。

1. `I-20260831-36` は `_probe` に「**口が無いなら、無いと言う**」を入れたが、
   2つ上の `_resolve_one` の `except Exception` が `NotImplementedError` を
   飲んで `unknown` へ潰していた。既存の検査は `_probe` を**直接**呼ぶので
   この経路を通っていなかった。
2. `I-20260831-50` は active marker の「読み方を1つにする」ために
   `_read_active_marker` を作ったが、**4人目の読み手**
   （`get_active_prompt_recipe_ids`）が `schema` しか見ていなかった。
3. `I-20260831-57` は「**強度が読めなくても、その LoRA を無かったことにしない**」を
   `_embedded_lora_evidence` へ入れたが、兄弟の `_a1111_resource_evidence` は
   `weight` が読めないと今も落としていた。

**この層は入口から到達しない**（`tests/test_python_reachability.py`）。それでも直すのは
`tests/test_service_layer_defects.py` と同じ理由——**配線した瞬間に生きるし、
どれも静かに壊れる形だから**。

**綴りではなく挙動で見る。** 「同じ関数を呼んでいる」ではなく
「**同じ入力に対して2つの口が同じ答えを返す**」を見る。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake.services.recipes.replay_manifest_service import ReplayManifestService  # noqa: E402
from unbake.services.recipes.resource_availability_service import (  # noqa: E402
    ResourceAvailabilityService,
)
from unbake.services.recipes.revision_service import (  # noqa: E402
    ACTIVE_SCHEMA,
    RecipeRevisionService,
)


def _availability(getter):
    """**組み立て器を通さずに起こす**（`test_service_layer_defects.py` と同じ形）。"""
    service = ResourceAvailabilityService.__new__(ResourceAvailabilityService)
    service._client_getter = getter
    return service


class 口が無いことが呼び手まで届く(unittest.TestCase):
    """`I-20260831-36` の宣言を、`_resolve_one` が取り消さないこと。"""

    def test_口の無いクライアントは_不明に潰されない(self):
        service = _availability(lambda: object())   # probe_* を持たない
        with self.assertRaises(NotImplementedError):
            asyncio.run(service._resolve_one(123, 456))

    def test_対照_問い合わせが失敗したときは今までどおり不明(self):
        class Client:
            async def probe_model(self, _model_id):
                raise RuntimeError("network down")

            async def probe_model_version(self, _version_id):
                raise RuntimeError("network down")

        got = asyncio.run(_availability(lambda: Client())._resolve_one(123, 456))
        self.assertEqual(got["verdict"], "unknown")
        self.assertIn("判定できませんでした", got["reason"])


class 有効な改変版の読み方が1つ(unittest.TestCase):
    """`I-20260831-50` の規則が、4人目の読み手にも当たること。"""

    @staticmethod
    def _plant(root: Path, marker: dict) -> tuple[RecipeRevisionService, Path, str]:
        """レシピ1件ぶんの置き場を作り、active marker を置く。"""
        service = RecipeRevisionService()
        recipe_json = root / "r.recipe.json"
        recipe_json.write_text("{}", encoding="utf-8")
        paths = service._paths("recipe-1", recipe_json)
        paths["active"].parent.mkdir(parents=True, exist_ok=True)
        paths["active"].write_text(json.dumps(marker), encoding="utf-8")
        return service, recipe_json, "recipe-1"

    def _both_answers(self, marker: dict) -> tuple[bool, bool]:
        """同じ marker について、2つの口が何と答えるか。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            service, recipe_json, recipe_id = self._plant(root, marker)
            summary = asyncio.run(
                service.get_summary(recipe_id, recipe_json, current_etag="x")
            )
            scanned = asyncio.run(service.get_active_prompt_recipe_ids(root))
            return bool(summary.get("active")), recipe_id in scanned

    def test_改変版を名指ししていない_marker_は両方が無効と読む(self):
        summary_active, scanned = self._both_answers({
            "schema": ACTIVE_SCHEMA,
            "recipe_id": "recipe-1",
            "revision_id": "",          # 名指ししていない＝壊れている側
        })
        self.assertFalse(summary_active)
        self.assertFalse(
            scanned,
            "同じ marker を、片方は「無効」・片方は「有効な改変版が在る」と数えている",
        )

    def test_対照_名指しした先が消えているだけなら_在るとは数える(self):
        # `get_summary` は `stale: True` で「在るが古い」と答える。
        # 走査側は「このレシピには改変版が在る」と数えてよい——**名指ししていない**のと
        # **名指しした先が消えている**のは別の状態だから。
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            service, recipe_json, recipe_id = self._plant(root, {
                "schema": ACTIVE_SCHEMA,
                "recipe_id": "recipe-1",
                "revision_id": "a" * 32,   # 形は正しいが実体が無い
            })
            summary = asyncio.run(
                service.get_summary(recipe_id, recipe_json, current_etag="x")
            )
            scanned = asyncio.run(service.get_active_prompt_recipe_ids(root))
        self.assertFalse(summary.get("active"))
        self.assertTrue(summary.get("stale"), "名指しした先が消えていることを stale で言っていない")
        self.assertIn(recipe_id, scanned)

    def test_対照_別スキーマの_marker_は両方が無視する(self):
        summary_active, scanned = self._both_answers({
            "schema": "something-else",
            "recipe_id": "recipe-1",
            "revision_id": "a" * 32,
        })
        self.assertFalse(summary_active)
        self.assertFalse(scanned)


class 強度が読めなくても_LoRA_を消さない(unittest.TestCase):
    """`I-20260831-57` の規則が、A1111 側の証拠にも当たること。"""

    @staticmethod
    def _manifest(resources_json: str) -> dict:
        return ReplayManifestService().build({
            "id": "r",
            "loras": [{"file_name": "myLora.safetensors", "modelVersionId": 999}],
            "a1111_parameters": f"masterpiece\nCivitai resources: {resources_json}",
        })

    def test_weight_が無くても必須_LoRA_として残る(self):
        out = self._manifest(
            '[{"type":"lora","modelVersionId":999,"modelName":"myLora"}]'
        )
        required = out["required_resources"]
        self.assertEqual(len(required), 1, "強度が読めないだけで必須 LoRA が消えている")
        # **`null` を置かない。** 下流の `Number(null)` は 0 になり「強度0で積む」嘘になる。
        self.assertEqual(required[0]["expected"], {})

    def test_対照_weight_が在れば今までどおり強度を載せる(self):
        out = self._manifest(
            '[{"type":"lora","modelVersionId":999,"modelName":"myLora","weight":0.7}]'
        )
        required = out["required_resources"]
        self.assertEqual(len(required), 1)
        self.assertEqual(required[0]["expected"]["strength_model"], 0.7)

    def test_強度の判っている証拠が在れば_そちらを採る(self):
        """判らない証拠を先頭に置くと「判っている値が在るのに使わない」ことになる。"""
        out = ReplayManifestService().build({
            "id": "r",
            "loras": [{"file_name": "myLora.safetensors", "modelVersionId": 999}],
            "gen_params": {"prompt": "<lora:myLora:0.4>"},
            "a1111_parameters":
                'x\nCivitai resources: [{"type":"lora","modelVersionId":999,"modelName":"myLora"}]',
        })
        required = out["required_resources"]
        self.assertEqual(len(required), 1)
        self.assertEqual(required[0]["expected"]["strength_model"], 0.4)

    def test_読めない強度は競合に数えない(self):
        """`_strengths_conflict` が `None` を「別の値」と読まないこと。"""
        out = ReplayManifestService().build({
            "id": "r",
            "loras": [{"file_name": "myLora.safetensors", "modelVersionId": 999}],
            "gen_params": {"prompt": "<lora:myLora:0.4>"},
            "a1111_parameters":
                'x\nCivitai resources: [{"type":"lora","modelVersionId":999,"modelName":"myLora"}]',
        })
        codes = {error["code"] for error in out["errors"]}
        self.assertNotIn("LORA_STRENGTH_CONFLICT", codes)


if __name__ == "__main__":
    unittest.main()
