# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""キャンバスノード。**この1個だけ**（`D-20260829-02`）。

## なぜ 0 個をやめたのか

ComfyUI で**利用者が勝手に増える経路は1本しか無い**（2026-08-29 実測）:

    ワークフロー JSON を共有 → 開いた人の画面に赤いノードが出る
    → ComfyUI Manager が「これを入れろ」と言う

Manager の `getMissingNodes()` が見るのは `node.type` と
`node.properties.cnr_id / aux_id` だけである。**キャンバスノードを 0 個しか
持たない拡張は、保存された workflow.json に一度も現れない**——だからこの連鎖に
原理的に乗れず、拡がりは「人間が宣伝した量」に完全比例して、止めた瞬間ゼロになる。

## なぜ「値を供給する」形なのか

**組み上げて消える道具にすると、増殖経路は開かない。** 共有された JSON の中に
Unbake のノードが残っていなければ、受け取った人の画面に赤いノードは出ない。

だからこのノードは**グラフの先頭に残り、下流へ値を流す**。引き換えに、
組み上がったグラフは Unbake に依存する（「Unbake 抜きでも動く素のグラフ」は
出せなくなる）。**両立しない**ので、増殖経路のほうを採った。

副作用ではなく、これ自体が正しい形でもある——**画像を差し替えると、
グラフ全体がその画像の条件で動き直す。** 値をノードへ焼き込む形だとこれができない。

## 持っているのは「値の束」であって記録そのものではない

`recipe` の欄に入るのは、抽出器が出した**平らな値の束**（下の `FIELDS`）である。
記録まるごとを widget へ入れると、**共有される workflow.json が記録の重さになる**
——数百 KB の埋め込みグラフや LoRA の一覧まで JSON へ乗る。

形を揃える責任は**フロント側の境界**（`web/core/extractedParams.js` が
`toRecipeShape()` を1度通す）に置いてある。ここで形を推測し直さない
——同じ食い違いを既に4回踏んでおり、そのたび**値が在るのに画面が空**になった。

## 依存を足していない

`folder_paths` は ComfyUI 本体の module で、pip の依存ではない
（`pyproject.toml` の `dependencies = []` は壊れない）。**輸入は守る**——
検査や道具から素で読み込まれたときに、ここで例外を出して全部を止めない。
"""
from __future__ import annotations

import json
from typing import Any

#: 供給する値。**並びが出力の並び**（`RETURN_NAMES` と1対1）。
#:
#: `sampler` / `scheduler` / `checkpoint` は文字列で出す。ComfyUI 側の
#: 受け口は選択肢（COMBO）なので直結はできないが、**値としては下流の
#: 別のノードやメモ書きから読める**。ここを選択肢型にすると、
#: 選択肢の中身を輸入時に取りに行くことになり（`folder_paths` の一覧を
#: クラス定義の時点で確定させる形）、**起動順によっては空で固まる**。
FIELDS = (
    ("prompt", "STRING", ""),
    ("negative", "STRING", ""),
    ("seed", "INT", 0),
    ("steps", "INT", 20),
    ("cfg", "FLOAT", 7.0),
    ("sampler", "STRING", ""),
    ("scheduler", "STRING", ""),
    ("checkpoint", "STRING", ""),
)


def _input_images() -> list:
    """`input/` に在る画像の一覧。**取れなくても落ちない。**

    ComfyUI の外（検査・道具）から読み込まれたときは空で返す。ここで例外を
    投げると、ノードの一覧を作る側が丸ごと倒れる。
    """
    try:
        import folder_paths  # ComfyUI 本体。pip の依存ではない。
    except Exception:
        return []
    try:
        directory = folder_paths.get_input_directory()
    except Exception:
        return []
    import os

    try:
        names = [
            name for name in os.listdir(directory)
            if os.path.isfile(os.path.join(directory, name))
        ]
    except OSError:
        return []
    return sorted(names)


def _coerce(value: Any, kind: str, fallback: Any) -> Any:
    """束の値を、出力の型へ寄せる。**読めない値は既定へ落とす。**

    ここで例外にすると、**1項目が欠けただけでグラフ全体が動かなくなる**。
    抽出は元々「取れた項目だけ」を返す造りなので、欠けは異常ではない。
    """
    if value is None:
        return fallback
    try:
        if kind == "INT":
            return int(float(value))
        if kind == "FLOAT":
            return float(value)
    except (TypeError, ValueError):
        return fallback
    if kind == "STRING":
        return value if isinstance(value, str) else str(value)
    return fallback


class UnbakeRecipeSource:
    """画像から読み取った生成の条件を、下流へ供給する。

    画面側（`web/unbake.js`）が、選ばれた画像から値を抽出して `recipe` へ書き、
    そこからグラフを組み立てる。**このクラスが実行時にやるのは、書かれた束を
    読んで型どおりに出すことだけ**——抽出器を Python 側へ二重に作らない。
    """

    CATEGORY = "Unbake"
    FUNCTION = "supply"
    RETURN_TYPES = tuple(kind for _name, kind, _default in FIELDS)
    RETURN_NAMES = tuple(name for name, _kind, _default in FIELDS)
    DESCRIPTION = (
        "Reads how a picture was made and feeds those settings into the graph. "
        "Swap the image and the whole graph follows it."
    )

    @classmethod
    def INPUT_TYPES(cls) -> dict:
        return {
            "required": {
                # 一覧は**呼ばれるたび**に取る。クラス定義の時点で固定すると、
                # 起動直後に空だった一覧がそのまま残る。
                "image": (_input_images(), {"image_upload": True}),
                # **絵の URL からも組める**（利用者の要望・2026-08-29）。
                # ここが空でなければ画像より優先する。振り分けはサイドバーと
                # **同じ1本**（`routeDrop` → `ingest`）を通すので、パネルで
                # 通る URL はここでも通り、通らない URL はここでも通らない。
                "url": ("STRING", {"multiline": False, "default": ""}),
                # 画面が書き込む値の束。人が直に触ることもできる。
                "recipe": ("STRING", {"multiline": True, "default": ""}),
            },
        }

    def supply(self, image: str = "", url: str = "", recipe: str = "") -> tuple:
        # 実行時には使わない（束は既に `recipe` へ書かれている）。**それでも
        # 入力として持つ**——どちらの絵から組んだかが共有された JSON に残り、
        # 受け取った人が差し替えの起点にできる。
        del image, url
        bundle = self._bundle(recipe)
        return tuple(
            _coerce(bundle.get(name), kind, default)
            for name, kind, default in FIELDS
        )

    @staticmethod
    def _bundle(recipe: str) -> dict:
        """束を読む。**空でも例外にしない。**

        空で落とすと、置いただけのノードでグラフ全体が実行不能になる
        ——「まだ画像を選んでいない」は異常ではなく、途中の状態である。
        """
        if not recipe or not recipe.strip():
            return {}
        try:
            parsed = json.loads(recipe)
        except (TypeError, ValueError):
            return {}
        return parsed if isinstance(parsed, dict) else {}


#: **ここが表の正本。** `__init__.py` は輸入するだけで、自前で組み直さない
#: （組み直すと、こちらを直しても ComfyUI へ届かない）。
#:
#: **1個だけ。** 機能ごとに増やさないことを `tests/comfy_package_test.mjs` が
#: 固定している（0個へ戻す・2個へ増やす・改名する、のどれでも赤くなる）。
NODE_CLASS_MAPPINGS: dict[str, type] = {
    "UnbakeRecipeSource": UnbakeRecipeSource,
}

#: 表示名は英語で置く。**画面での見出しは JS 側が 12 言語で差し替える**
#: （`web/i18n/locales/` の `node.recipeSource.*`）。ここは差し替えが
#: 効かなかったときに出る土台で、既定を英語にするのは全体の方針と同じ
#: ——発見経路が ComfyUI Manager なので、最初に読まれるのは英語である。
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {
    "UnbakeRecipeSource": "Unbake — Recipe from Image",
}

__all__ = [
    "FIELDS",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "UnbakeRecipeSource",
]
