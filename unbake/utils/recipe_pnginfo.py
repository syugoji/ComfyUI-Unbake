# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""出力画像に埋め込むレシピ参照の読み書き。

## なぜ画像そのものへ書くのか

「この出力画像はどのレシピから生成したか」を後から辿るための土台。
ComfyUI の実行履歴（``/history``）にも ``extra_data`` は残るが、履歴は
再起動で消えるうえ、画像ファイルを別の場所へ移すと結び付きが切れる。
**画像自体に書いておけば、ファイルが残っている限り紐付けは失われない。**

## どこに書かれるか

投入側は ``/prompt`` の ``extra_data.extra_pnginfo`` へ入れる。
ComfyUI はこれを SaveImage 系ノードの ``EXTRA_PNGINFO`` として渡し、
**標準の SaveImage は extra_pnginfo のキーをすべて PNG テキストチャンクへ
書き出す**。したがって同梱の ``SaveImageLM`` を使っていなくても残る。
``SaveImageLM`` は既定でワークフローしか書かないので、こちらは明示的に書く。

``extra_data`` の直下に置いた任意キーは履歴にしか残らず、画像には書かれない。
ここを取り違えると「送っているのに画像から読めない」状態になる。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional
from ..utils.json_io import dump_json_strict, dumps_json_strict

logger = logging.getLogger(__name__)

# PNG テキストチャンクのキー名。**変えると既存の出力画像を読めなくなる。**
RECIPE_PNGINFO_KEY = "lora_manager_recipe"

# 中身のスキーマ識別子。フロント側 RecipePlaylistManager.js の
# RECIPE_PNGINFO_SCHEMA と一致していること。
RECIPE_PNGINFO_SCHEMA = "lora-manager.recipe-reference"

#: Unbake 自身が焼く印。**書いているのは `web/core/sweepRunner.js`。**
SWEEP_PNGINFO_KEY = "unbake_sweep"
SWEEP_PNGINFO_SCHEMA = "unbake.sweep"

#: フォーク（LoRA Manager）が焼いた印。**手元の出力に9枚実在する**ので読み続ける。
LEGACY_SWEEP_PNGINFO_KEY = "lora_manager_sweep"
LEGACY_SWEEP_PNGINFO_SCHEMA = "lora-manager.recipe-sweep-cell"

#: 試行（`recipeTrialRunner`）が焼く印（2026-09-01・走査9周目）。
#:
#: **周回8で直した所の、直っていない兄弟だった。** あちらで
#: `outputs.RAW_KEYS` と `web/core/outputAttribution.js` の表へ `unbake_trial` を
#: 足したが、**帰属の経路は2本ある**:
#:
#:   1. 生の走査 → JS の `attributeOutputs`（周回8で直した）
#:   2. サーバの索引 → `recipe_output_index.get_outputs(record_id)` ← **ここ**
#:
#: `routes.py` の `GET /unbake/outputs?id=…` は 2 を使うので、
#: **記録を開いたときの「この記録から出た絵」に試行の分が出ないまま**だった。
#: 片方だけ直すのがこのパッケージの繰り返す型で、今回は自分でそれをやっていた。
TRIAL_PNGINFO_KEY = "unbake_trial"
TRIAL_PNGINFO_SCHEMA = "unbake.trial"

#: 記録の id が入っている鍵。**JS は `record_id`、フォークは `recipe_id`。**
#:
#: ここが3点とも食い違っていた（実測 2026-08-20）:
#:
#:   ============  =======================  ==============================
#:   食い違い       JS が書く                 Python が読もうとしていた
#:   ============  =======================  ==============================
#:   チャンクの鍵   ``unbake_sweep``          ``lora_manager_sweep``
#:   スキーマ       ``unbake.sweep``          ``lora-manager.recipe-sweep-cell``
#:   id の名前      ``record_id``             ``recipe_id``
#:   ============  =======================  ==============================
#:
#: つまり **Unbake が焼いた3枚は Python から1枚も読めなかった**。
#: 「自分が Sweep で回した分が貯まる」という利得は、この状態では
#: **恒久に0件**であり、しかも例外もログも出ないので気づけない。
_RECORD_ID_KEYS = ("record_id", "recipe_id")


def build_recipe_reference(recipe_id: str) -> Dict[str, Any]:
    """埋め込む参照そのものを作る。"""
    return {
        "schema": RECIPE_PNGINFO_SCHEMA,
        "version": 1,
        "recipe_id": str(recipe_id),
    }


def extract_recipe_reference(extra_pnginfo: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """``extra_pnginfo`` からレシピ参照を取り出す。

    形が違うものは黙って無視する。ここで例外を投げると画像の保存自体が
    落ちるので、**紐付けの失敗が生成の失敗になってはいけない**。
    """
    if not isinstance(extra_pnginfo, dict):
        return None

    payload = extra_pnginfo.get(RECIPE_PNGINFO_KEY)
    if not isinstance(payload, dict):
        return None

    recipe_id = payload.get("recipe_id")
    if not recipe_id:
        return None

    if payload.get("schema") != RECIPE_PNGINFO_SCHEMA:
        # 別のスキーマ名で来たものは、こちらの想定と中身が違う可能性がある。
        # 読み違えて誤った紐付けを作るより、拾わないほうが安全。
        logger.debug(
            "Ignoring recipe reference with unexpected schema: %r",
            payload.get("schema"),
        )
        return None

    return {
        "schema": RECIPE_PNGINFO_SCHEMA,
        "version": payload.get("version", 1),
        "recipe_id": str(recipe_id),
    }


def serialize_recipe_reference(reference: Dict[str, Any]) -> str:
    """テキストチャンクへ書ける形にする。"""
    return dumps_json_strict(reference, ensure_ascii=False)


def parse_recipe_reference(raw: Any) -> Optional[Dict[str, Any]]:
    """画像から読み出した生の値をレシピ参照へ戻す。

    テキストチャンクは str で返るが、ComfyUI 側の経路によっては
    既に dict になっていることもあるので両方受ける。
    """
    if isinstance(raw, dict):
        return extract_recipe_reference({RECIPE_PNGINFO_KEY: raw})

    if not isinstance(raw, str) or not raw.strip():
        return None

    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return None

    return extract_recipe_reference({RECIPE_PNGINFO_KEY: payload})


def read_recipe_reference_from_image(path: str) -> Optional[Dict[str, Any]]:
    """画像ファイルからレシピ参照を読む。読めなければ None。

    対応は PNG のテキストチャンクのみ。JPEG/WebP の EXIF には
    任意キーを置く場所が無いため、書き込み側も PNG だけを対象にしている。
    """
    try:
        from PIL import Image
    except ImportError:  # pragma: no cover - Pillow は本体の依存
        return None

    try:
        with Image.open(path) as img:
            info = img.info or {}  # `.text` はファイル全体を読む（実測100倍遅い）
            raw = info.get(RECIPE_PNGINFO_KEY)
    except Exception:
        # 壊れた画像・権限・非対応形式。走査を止めない。
        return None

    return parse_recipe_reference(raw)


def extract_sweep_reference(extra_pnginfo: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Sweep のセル参照を取り出す。**両方の形を受ける。**

    返す形は1つに揃える（``record_id``）——受ける側で揃えないと、
    どちらの印から来たかで画面の分岐が増える。
    """
    if not isinstance(extra_pnginfo, dict):
        return None
    for key, schema in (
        (SWEEP_PNGINFO_KEY, SWEEP_PNGINFO_SCHEMA),
        (LEGACY_SWEEP_PNGINFO_KEY, LEGACY_SWEEP_PNGINFO_SCHEMA),
    ):
        payload = extra_pnginfo.get(key)
        if not isinstance(payload, dict) or payload.get("schema") != schema:
            continue
        record_id = ""
        for id_key in _RECORD_ID_KEYS:
            if payload.get(id_key):
                record_id = str(payload[id_key])
                break
        if not record_id:
            # **`record_id` が無ければ帰属できない。** ここだけは全部か無かでよい。
            continue
        # **残りが欠けても捨てない**（`I-20260831-71`）。
        #
        # 以前は4つのどれか1つでも空なら `continue` で、**`record_id` が正しくても
        # その画像の帰属ごと失って**いた。書き手（`sweepRunner.js` の
        # `buildSweepStamp`）は `String(x ?? "")` なので、元の値が無ければ空文字が
        # 入る——つまり**書き手が普通に作りうる形**を読み手が丸ごと捨てていた。
        #
        # 唯一の照合相手は `recipe_output_index` の `record_id` で、
        # 残り4つは画面へ渡すだけである。**「どの実験の何番目かは判らない」と
        # 言えるほうが、この道具の建前に合う。**
        #
        # ブラウザ側（`generationRecord.js`）は同じ刻印を
        # `parseJsonLoose` で素通しにしており、**同じ絵が画面からは読めて
        # Python からは読めない**状態だった。
        rest = ("template_id", "job_id", "cell_id", "signature")
        return {
            "schema": schema,
            "version": payload.get("version", 1),
            "record_id": record_id,
            **{name: str(payload.get(name) or "") for name in rest},
            # **欠けていることを言う。** 受け手が「揃っている」と思い込むと、
            # 空文字のセル id で並べ替えて黙って1箇所へ潰す。
            "complete": all(payload.get(name) for name in rest),
            "labels": payload.get("labels") if isinstance(payload.get("labels"), list) else [],
        }
    return None


def parse_sweep_reference(raw: Any) -> Optional[Dict[str, Any]]:
    """生の値から参照を取り出す。**どちらの鍵の下に居たかは問わない。**"""
    payload = raw
    if isinstance(raw, str):
        if not raw.strip():
            return None
        try:
            payload = json.loads(raw)
        except (ValueError, TypeError):
            return None
    if not isinstance(payload, dict):
        return None
    # 中身の `schema` で見分けるので、両方の鍵の下に置いて試す。
    return extract_sweep_reference({
        SWEEP_PNGINFO_KEY: payload,
        LEGACY_SWEEP_PNGINFO_KEY: payload,
    })


def read_sweep_reference_from_image(path: str) -> Optional[Dict[str, Any]]:
    try:
        from PIL import Image
        with Image.open(path) as img:
            info = img.info or {}  # `.text` はファイル全体を読む（実測100倍遅い）
    except Exception:
        return None
    for key in (SWEEP_PNGINFO_KEY, LEGACY_SWEEP_PNGINFO_KEY):
        reference = parse_sweep_reference(info.get(key))
        if reference is not None:
            return reference
    return None


def extract_trial_reference(extra_pnginfo: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """試行のセル参照を取り出す。**`record_id` が無ければ帰属できない。**

    返す形は sweep と揃えず、**試行固有の項目だけ**を持つ——揃えると
    「どの実験の何番目か」と「どの試行の何本目か」が同じ顔になる。
    共通なのは `record_id` だけで、それが照合に使う唯一の値である。
    """
    if not isinstance(extra_pnginfo, dict):
        return None
    payload = extra_pnginfo.get(TRIAL_PNGINFO_KEY)
    if not isinstance(payload, dict) or payload.get("schema") != TRIAL_PNGINFO_SCHEMA:
        return None
    record_id = ""
    for id_key in _RECORD_ID_KEYS:
        if payload.get(id_key):
            record_id = str(payload[id_key])
            break
    if not record_id:
        return None
    # **残りが欠けても捨てない**（`I-20260831-71` と同じ理由）。
    rest = ("job_id", "candidate_id")
    return {
        "schema": TRIAL_PNGINFO_SCHEMA,
        "version": payload.get("version", 1),
        "record_id": record_id,
        **{name: str(payload.get(name) or "") for name in rest},
        "candidate_index": payload.get("candidate_index"),
        "seed": payload.get("seed"),
        "seed_origin": str(payload.get("seed_origin") or ""),
        # **欠けていることを言う**（受け手が「揃っている」と思い込まないため）。
        "complete": all(payload.get(name) for name in rest),
    }


def parse_trial_reference(raw: Any) -> Optional[Dict[str, Any]]:
    """生の値から試行の参照を取り出す。"""
    payload = raw
    if isinstance(raw, str):
        if not raw.strip():
            return None
        try:
            payload = json.loads(raw)
        except (ValueError, TypeError):
            return None
    if not isinstance(payload, dict):
        return None
    return extract_trial_reference({TRIAL_PNGINFO_KEY: payload})


def read_trial_reference_from_image(path: str) -> Optional[Dict[str, Any]]:
    try:
        from PIL import Image
        with Image.open(path) as img:
            info = img.info or {}  # `.text` はファイル全体を読む（実測100倍遅い）
    except Exception:
        return None
    return parse_trial_reference(info.get(TRIAL_PNGINFO_KEY))
