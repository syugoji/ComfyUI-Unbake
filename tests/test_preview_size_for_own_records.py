# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**自分で書いた記録の見本も測れる**（`I-20260830-29`）。

`_preview_size` は `file_path` か `preview_path` しか見ていなかった。ところが
`preview_path` は**この repo に書き手が1つも無い幽霊の鍵**で、Unbake が書く
`.unbake.json` は `file_path` を持たない——つまり**自分で作った記録には辿れる
手掛かりがゼロ**だった。材料はディスクに在る（同じ名前の画像が隣に在り、
`/unbake/record-preview` はそれを返している）のに、読む経路だけが繋がっていない。

結果、寸法の無いレシピは組み立て側が手掛かりを全部外して**1024x1216 ではなく
1024x1024 の正方形**へ落ちる。判定は「再現性・高」のまま**縦横比の違う別の絵**
が出るので、利用者からは「再現したと言っているのに形が違う」に見える。

## なぜ既存の検査が素通りしたか

`python_library_test.mjs` の見本は `p.recipe.json` / `q.recipe.json` の2件だけで、
**どちらも `file_path` を直に持つ LoRA Manager 形**。Unbake が実際に書く形を
通す検査が0本だった。

**だから拡張子を手で並べない。** `library.py` が対応する組み合わせを読んで
全部回す——1つ足した人の分が自動で守られる（今の形だと「LoRA Manager 形だけ
緑」がまた起こる）。
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from unbake import library as library_module  # noqa: E402
from unbake import routes as routes_module  # noqa: E402


def write_image(path: Path, size) -> None:
    """見本を1枚書く。**縦横が違う寸法**にする（正方形だと落ちても気づけない）。"""
    from PIL import Image

    Image.new("RGB", size, (9, 9, 9)).save(path)


class PreviewSizeForOwnRecords(unittest.TestCase):
    """記録の形と見本の拡張子の**全組み合わせ**を回す。"""

    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)

    def _library_for(self, folder: Path):
        """その置き場を見る書庫を1つ作り、`routes` に差し替える。

        書庫は**設定の器**を受ける（フォルダの一覧ではない）。ここを取り違えると
        `source_dirs()` が落ちる——最初その形で書いて9件落ちた。
        """
        settings = _Settings({"record_source_dirs": [str(folder)]})
        lib = library_module.RecordLibrary(settings)
        routes_module.get_library = lambda: lib  # type: ignore[assignment]
        self.addCleanup(lambda: setattr(routes_module, "get_library", _ORIGINAL_GET_LIBRARY))
        return lib

    def test_every_recipe_and_preview_suffix_is_measurable(self) -> None:
        suffixes = [library_module.RECIPE_SUFFIX, library_module.UNBAKE_SUFFIX]
        previews = list(library_module.PREVIEW_SUFFIXES)
        # **空振り検出。** 組み合わせが痩せたら、この検査は何も測らずに緑になる。
        self.assertGreaterEqual(len(suffixes), 2, "記録の形が1種類しか読めていない")
        self.assertGreaterEqual(len(previews), 2, "見本の拡張子が1種類しか読めていない")

        for recipe_suffix in suffixes:
            for preview_suffix in previews:
                with self.subTest(recipe=recipe_suffix, preview=preview_suffix):
                    folder = self.root / f"case{abs(hash((recipe_suffix, preview_suffix)))}"
                    folder.mkdir(parents=True, exist_ok=True)
                    record_id = "sample"
                    stem = folder / record_id
                    # **`file_path` を持たない**——Unbake が実際に書く形。
                    body = {"id": record_id, "gen_params": {}}
                    Path(str(stem) + recipe_suffix).write_text(
                        json.dumps(body), encoding="utf-8")
                    write_image(Path(str(stem) + preview_suffix), (480, 695))

                    self._library_for(folder)
                    size = routes_module._preview_size({"id": record_id})
                    self.assertEqual(
                        size, {"width": 480, "height": 695},
                        f"{recipe_suffix} + {preview_suffix} の見本を測れていない"
                        "（寸法の無いレシピが正方形へ落ちる）")

    def test_file_path_still_wins(self) -> None:
        """[対照] `file_path` を持つ形（LoRA Manager 由来）は今までどおり。"""
        folder = self.root / "lm"
        folder.mkdir()
        image = folder / "direct.png"
        write_image(image, (300, 100))
        self._library_for(folder)
        size = routes_module._preview_size({"id": "nothing", "file_path": str(image)})
        self.assertEqual(size, {"width": 300, "height": 100})

    def test_unknown_id_is_quiet(self) -> None:
        """[対照] 手掛かりが無ければ黙って諦める（取得そのものを失敗させない）。"""
        folder = self.root / "empty"
        folder.mkdir()
        self._library_for(folder)
        self.assertIsNone(routes_module._preview_size({"id": "missing"}))
        self.assertIsNone(routes_module._preview_size({}))

    def test_dead_key_is_gone(self) -> None:
        """書き手のいない `preview_path` を読みに戻らない（幽霊を復活させない）。"""
        source = Path(routes_module.__file__).read_text(encoding="utf-8")
        body = source.split("def _preview_size", 1)[1].split("\ndef ", 1)[0]
        code = "\n".join(
            line for line in body.splitlines()
            if not line.strip().startswith("#") and '``' not in line)
        self.assertNotIn('record.get("preview_path")', code,
                         "書き手のいない鍵を読みに戻っている")


class _Settings:
    """書庫が読む最小の設定。**実物と同じ `get(key, default)` だけ持つ。**"""

    def __init__(self, values):
        self._values = dict(values)

    def get(self, key, default=None):
        return self._values.get(key, default)


_ORIGINAL_GET_LIBRARY = routes_module.get_library


if __name__ == "__main__":
    unittest.main()
