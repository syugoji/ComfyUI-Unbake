# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**壊れた active marker の読み方を1つにする**（`I-20260831-50`）。

`D-20260831-01`（枠から落とした候補の選別）で拾った1件。

同じ壊れた marker に対して、`get_summary` は「有効な改変版は無い」
（``active: false`` / ``stale: false``）と答え、`resolve_active_recipe` は
**404 を投げて**いた。片方は「無い」と言い、片方は失敗する。

**枠から落ちた理由は「marker が壊れる経路を作れなかった」**——つまり
**筋書きを書けなかっただけで、害の不在は測っていない**。不一致そのものは
実在するので、読み方を1本にして構造から消す。

入口から到達しない層なので今日の利用者は踏まないが、
`tests/test_service_layer_defects.py` と同じ理由でここに検査を置く
——**配線した人が最初の1回で踏む**。
"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from unbake.services.recipes.revision_service import (
    ACTIVE_SCHEMA,
    RecipeRevisionError,
    RecipeRevisionService,
)

RECIPE_ID = "recipe-1"


def _run(coro):
    return asyncio.run(coro)


class BrokenActiveMarkerTest(unittest.TestCase):
    """壊れた marker で、2つの入口が同じ判断をすること。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.recipe_json = Path(self._tmp.name) / "r.recipe.json"
        self.recipe_json.write_text("{}", encoding="utf-8")
        self.service = RecipeRevisionService()
        self.paths = self.service._paths(RECIPE_ID, self.recipe_json)
        self.paths["active"].parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self._tmp.cleanup()

    def _write_marker(self, payload):
        self.paths["active"].write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )

    def _both(self):
        summary = _run(
            self.service.get_summary(RECIPE_ID, self.recipe_json, current_etag="etag")
        )
        recipe = {"id": RECIPE_ID, "title": "r"}
        try:
            resolved = _run(
                self.service.resolve_active_recipe(
                    recipe, self.recipe_json, current_etag="etag"
                )
            )
        except RecipeRevisionError as exc:  # 失敗した側も、失敗として持ち帰る
            resolved = exc
        return summary, resolved

    def test_schema_が違う_marker_で_両方とも無いと読む(self):
        self._write_marker(
            {"schema": "something-else", "recipe_id": RECIPE_ID, "revision_id": "rev1"}
        )
        summary, resolved = self._both()
        self.assertFalse(summary["active"], "get_summary が有効だと答えている")
        self.assertNotIsInstance(
            resolved,
            RecipeRevisionError,
            "get_summary が「無い」と答える marker で resolve が失敗している",
        )
        self.assertEqual(resolved["id"], RECIPE_ID)

    def test_recipe_id_が違う_marker_で_両方とも無いと読む(self):
        self._write_marker(
            {"schema": ACTIVE_SCHEMA, "recipe_id": "someone-else", "revision_id": "rev1"}
        )
        summary, resolved = self._both()
        self.assertFalse(summary["active"])
        self.assertNotIsInstance(resolved, RecipeRevisionError)
        self.assertEqual(resolved["id"], RECIPE_ID)

    def test_revision_id_が空の_marker_で_両方とも無いと読む(self):
        self._write_marker({"schema": ACTIVE_SCHEMA, "recipe_id": RECIPE_ID})
        summary, resolved = self._both()
        self.assertFalse(summary["active"])
        self.assertNotIsInstance(resolved, RecipeRevisionError)

    def test_対照_marker_が無ければ元のレシピがそのまま返る(self):
        summary, resolved = self._both()
        self.assertFalse(summary["active"])
        self.assertNotIsInstance(resolved, RecipeRevisionError)
        self.assertEqual(resolved["title"], "r")

    def test_対照_形は正しいが実体の無い_marker_は無い側へ倒れない(self):
        """**壊れていない marker まで飲み込まない。**

        schema も recipe_id も正しく、指している改変版だけが無い——これは
        「壊れた marker」ではなく「消えた改変版」なので、`get_summary` は
        ``stale`` を立て、`resolve_active_recipe` は失敗してよい。
        ここを区別しないと、この直しは**単に例外を握り潰しただけ**になる。
        """
        self._write_marker(
            {"schema": ACTIVE_SCHEMA, "recipe_id": RECIPE_ID, "revision_id": "missing"}
        )
        summary, resolved = self._both()
        self.assertFalse(summary["active"])
        self.assertTrue(summary["stale"], "消えた改変版が stale として出ていない")
        self.assertIsInstance(
            resolved,
            RecipeRevisionError,
            "実体の無い改変版まで「無い」と読んで、静かに元のレシピを返している",
        )


    def test_2つの入口が同じ判断をする_marker_の形すべてで(self):
        """**これが本体の不変条件。**

        ``get_summary`` が「何も無い」（``active: false`` かつ
        ``stale: false``）と答えるなら、``resolve_active_recipe`` は
        **元のレシピをそのまま返さなければならない**。逆に summary が
        ``stale`` を立てるなら、resolve は失敗してよい——
        「改変版を名指ししていない」と「名指しした先が消えている」は別の状態。

        個々の形ごとの検査は上に在るが、**次に marker の形が増えたとき**に
        効くのはこちらである。
        """
        shapes = {
            "schema が違う": {
                "schema": "x", "recipe_id": RECIPE_ID, "revision_id": "rev1",
            },
            "recipe_id が違う": {
                "schema": ACTIVE_SCHEMA, "recipe_id": "other", "revision_id": "rev1",
            },
            "revision_id が無い": {
                "schema": ACTIVE_SCHEMA, "recipe_id": RECIPE_ID,
            },
            "revision_id が空": {
                "schema": ACTIVE_SCHEMA, "recipe_id": RECIPE_ID, "revision_id": "  ",
            },
            "鍵がひとつも無い": {},
            "名指しした先が消えている": {
                "schema": ACTIVE_SCHEMA, "recipe_id": RECIPE_ID, "revision_id": "gone",
            },
        }
        for label, payload in shapes.items():
            with self.subTest(label):
                self._write_marker(payload)
                summary, resolved = self._both()
                nothing = not summary["active"] and not summary["stale"]
                failed = isinstance(resolved, RecipeRevisionError)
                self.assertEqual(
                    nothing,
                    not failed,
                    f"{label}: get_summary は nothing={nothing} と答えるのに "
                    f"resolve は failed={failed}（判断が食い違っている）",
                )


if __name__ == "__main__":
    unittest.main()
