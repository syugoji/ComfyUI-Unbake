# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**書いた保証が本当に効いていること**（2026-09-01・走査9周目）。

2件とも「**守っていると書いてあるのに、守る物がその経路に無い**」形だった。

1. `unbake/utils/json_io.py` は「非有限の float をディスクへ出さない」ための
   モジュールで、docstring が「**API 層は自分で守っている
   （`recipe_handlers._json_safe`）**」と書いていた。ところが
   **`recipe_handlers` はこのリポジトリに無い**（フォークの名前）。
   実測で `routes.py` の `web.json_response` 46箇所はすべて既定の
   `json.dumps`（`allow_nan=True`）で、`read_record` は PNG の `prompt` を
   `json.loads` する（**`json.loads` は `NaN` を受ける**）。
   つまり `NaN` を含む記録は**本文が `JSON.parse` で落ちて開けない**。
2. `recipe_pnginfo` が `unbake_trial` を知らず、**索引の経路
   （`GET /unbake/outputs?id=…`）から試行の絵が引けない**ままだった
   ——周回8で生の走査の側だけを直した、その兄弟。

**綴りではなく挙動で見る。**
"""

from __future__ import annotations

import json
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from unbake.utils.json_io import dumps_json_strict  # noqa: E402
from unbake.utils.recipe_pnginfo import (  # noqa: E402
    extract_trial_reference,
    parse_trial_reference,
)
from unbake.services import recipe_output_index as index_module  # noqa: E402


class 非有限の値が本文へ出ない(unittest.TestCase):
    """`JSON.parse` が落ちる literal を作らないこと。"""

    #: `IS_CHANGED` を毎回変える系のノードが実際に返す形。
    RECORD = {"id": "r", "comfy_prompt": {"3": {"inputs": {"is_changed": float("nan")}}}}

    def test_既定の_dumps_なら_NaN_が出る(self):
        """**対照。** ここが変わったら、この検査の前提が崩れている。"""
        self.assertIn("NaN", json.dumps(self.RECORD))

    def test_厳密な_dumps_は_NaN_を出さない(self):
        text = dumps_json_strict(self.RECORD)
        self.assertNotIn("NaN", text)
        self.assertNotIn("Infinity", text)
        # **`null` にする。** `0` にすると、取っていない測定値を主張することになる。
        self.assertIsNone(json.loads(text)["comfy_prompt"]["3"]["inputs"]["is_changed"])

    def test_無限大も同じ扱い(self):
        text = dumps_json_strict({"a": float("inf"), "b": float("-inf")})
        self.assertEqual(json.loads(text), {"a": None, "b": None})

    def test_有限の値は変えない(self):
        payload = {"a": 0.0, "b": -1.5, "c": 1e308, "d": [1, 2, 3], "e": "x"}
        self.assertEqual(json.loads(dumps_json_strict(payload)), payload)

    def test_口が厳密な_dumps_を使っている(self):
        """**仕掛けが在ることと、使われていることは別。**

        `register_routes` を**偽の `PromptServer` へ実際に登録**して、
        `GET /unbake/record` の応答本文を見る。包みを通っていなければ
        本文に `NaN` が出て、ブラウザの `JSON.parse` はそこで落ちる。
        """
        try:
            import aiohttp  # noqa: F401
        except ImportError:  # pragma: no cover - ComfyUI 外
            self.skipTest("aiohttp が無い")

        import asyncio
        import types
        from unittest import mock

        from unbake import routes

        collected = {}

        class FakeRoutes:
            def get(self, path):
                def deco(fn):
                    collected[("GET", path)] = fn
                    return fn
                return deco

            def post(self, path):
                def deco(fn):
                    collected[("POST", path)] = fn
                    return fn
                return deco

        fake_server = types.ModuleType("server")
        fake_server.PromptServer = types.SimpleNamespace(
            instance=types.SimpleNamespace(routes=FakeRoutes()))

        with mock.patch.dict(sys.modules, {"server": fake_server}),                 mock.patch.object(routes, "install_default_environment", lambda: None):
            self.assertTrue(routes.register_routes(), "口を登録できない")

        handler = collected.get(("GET", "/unbake/record"))
        self.assertIsNotNone(handler, "/unbake/record が登録されていない")

        request = types.SimpleNamespace(query={"id": "r"})
        with mock.patch.object(routes, "read_record", lambda _id: self.RECORD):
            response = asyncio.run(handler(request))

        body = response.body.decode("utf-8")
        self.assertNotIn(
            "NaN", body,
            "本文に NaN が出ている（ブラウザの JSON.parse が落ちて記録が開けない）",
        )
        self.assertIsNone(
            json.loads(body)["comfy_prompt"]["3"]["inputs"]["is_changed"])


class 試行の印が索引の経路でも引ける(unittest.TestCase):
    """周回8で直した兄弟——`?id=` の経路。"""

    STAMP = {
        "schema": "unbake.trial",
        "version": 1,
        "job_id": "job-1",
        "record_id": "137684933",
        "candidate_id": "c-1",
        "candidate_index": 2,
        "seed": 42,
        "seed_origin": "original",
    }

    def test_印から記録の_id_を取れる(self):
        got = extract_trial_reference({"unbake_trial": self.STAMP})
        self.assertIsNotNone(got, "試行の印を索引側が読めない")
        self.assertEqual(got["record_id"], "137684933")
        self.assertEqual(got["candidate_index"], 2)
        self.assertTrue(got["complete"])

    def test_文字列で載っていても読める(self):
        self.assertEqual(
            parse_trial_reference(json.dumps(self.STAMP))["record_id"], "137684933")

    def test_record_id_が無ければ帰属しない(self):
        stamp = {**self.STAMP}
        stamp.pop("record_id")
        self.assertIsNone(extract_trial_reference({"unbake_trial": stamp}),
                          "record_id の無い印から帰属を捏造している")

    def test_残りが欠けても帰属は捨てない(self):
        """`I-20260831-71` と同じ理由——落ちるのは詳細で、帰属ではない。"""
        got = extract_trial_reference({"unbake_trial": {
            "schema": "unbake.trial", "record_id": "137684933"}})
        self.assertIsNotNone(got)
        self.assertFalse(got["complete"], "欠けていることを言っていない")

    def test_別スキーマの印は読まない(self):
        self.assertIsNone(extract_trial_reference(
            {"unbake_trial": {"schema": "something-else", "record_id": "x"}}))

    def test_索引が引く所と数える所で同じ答えを出す(self):
        service = index_module.RecipeOutputIndex(output_dir_getter=lambda: "")
        trial = extract_trial_reference({"unbake_trial": self.STAMP})
        service._entries = {
            "a.png": (1.0, None, trial),                       # 試行の印だけ
            "b.png": (2.0, None, {"record_id": "137684933"}),  # Sweep の印だけ
            "c.png": (3.0, "137684933", None),                 # レシピ参照だけ
            "d.png": (4.0, None, None),                        # 何も無い
        }
        self.assertEqual(service.get_status()["indexed"], 3,
                         "引ける絵の数と、引ける絵の定義がずれている")


if __name__ == "__main__":
    unittest.main()
