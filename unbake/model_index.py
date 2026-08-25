# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""導入済みモデルを **hash と Civitai の id からも** 引けるようにする索引。

## なぜ要るか

記録はモデルを名前で持っているが、**その名前が手元のファイル名とは限らない。**
実測（2026-08-22・判定シート292件との突き合わせ）で、**人間が「再現できた」と
記録しているのに Unbake が「再現不可」と言っていた2件**が、どちらもこれだった:

===============  =========================================================
``43323642``     ``file_name: "prefectious_nsfw.fp16"`` は **Civitai の内部名**。
                 手元の実体は ``prefectiousXLNSFW_v10.safetensors`` で名前が違う。
                 ただし ``hash: "4286171e4b"`` を持っている。
``21490268``     checkpoint が**空の殻**（``file_name`` も ``hash`` も空・
                 ``isDeleted: true``）。手掛かりは ``id: "665047"`` だけ。
===============  =========================================================

名前でしか引かないと、前者は「未導入モデル」、後者は「情報がありません」で落ちる。
**どちらも手元に在るのに。**

## 何を索引するか

LoRA Manager がモデルの隣へ置く ``<モデル>.metadata.json`` を読む。実測で
checkpoint 103件中102件、LoRA 483件中479件が ``civitai.id`` を持ち、全件が ``sha256``
を持っていた。

**これは LoRA Manager が在る環境でしか効かない。** 置いているのはあちらなので、
入れていない利用者では索引が空になり、**今までと同じ挙動へ落ちる**（悪くはならない）。
「Unbake だけで動く」と読まれないよう、応答に ``sources`` と件数を入れて、
呼び手が「索引が空だった」と言えるようにする。

## 何を索引しないか

**モデルの中身は読まない。** ``sha256`` は metadata に書いてある値をそのまま使う
——数GBのファイルを起動のたびに読み直すのは割に合わない。
書いてある値が嘘だった場合は誤って解決するが、それは metadata を書いた側の問題で、
こちらで直せる場所ではない（**推測で読み直すと、遅いうえに直らない**）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

try:  # ComfyUI 本体が提供する。
    import folder_paths  # type: ignore
except ImportError:  # pragma: no cover - ComfyUI の外で読まれたとき
    folder_paths = None  # type: ignore

#: 索引する種別。**落とせるもの・消せるものと同じ並び**にしておく。
#: **`diffusion_models` を必ず入れる。** Flux 系は `models/checkpoints` に入らず
#: `unet` / `diffusion_models` に置かれる。ここを外すと、在るモデルが
#: 「未導入」に見えて記録が 再現不可 に落ちる（実データ2件で踏んだ）。
INDEXED_KINDS = (
    "checkpoints",
    "diffusion_models",
    "loras",
    "embeddings",
    "vae",
    "controlnet",
    "upscale_models",
)

#: 走査の上限。**黙って打ち切らない**——超えたら応答に載せる。
MAX_FILES = 20000

#: 走る深さ。LoRA はサブフォルダに入っていることが多い（実測 482本中399本）。
MAX_DEPTH = 6

_cache: Optional[Dict[str, Any]] = None


def _roots(kind: str) -> List[Path]:
    if folder_paths is None:
        return []
    try:
        return [Path(p) for p in (folder_paths.get_folder_paths(kind) or [])]
    except Exception:  # pragma: no cover - 本体側の事情
        return []


def _walk(root: Path, depth: int = 0):
    if depth > MAX_DEPTH:
        return
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for entry in entries:
        if entry.is_dir():
            yield from _walk(Path(entry.path), depth + 1)
        elif entry.name.endswith(".metadata.json"):
            yield Path(entry.path)


#: 名前を引くときに落とす拡張子。**`.fp16` のような「名前の一部」は落とさない**
#: ——実データに ``re-mixmain.fp16`` という checkpoint 名が在り、
#: 「点より後ろを切る」と別のモデルの鍵になってしまう。
MODEL_SUFFIXES = (".safetensors", ".ckpt", ".sft", ".pt", ".pth", ".gguf", ".bin")


def name_key(value: Any) -> str:
    """モデル名を引くための鍵。**フォルダと拡張子を落として小文字にする。**

    記録側は ``Illustrious\\anime\\waiIllustriousSDXL_v150.safetensors`` のように
    フォルダ込みで持ち、metadata 側は ``file_name: "waiIllustriousSDXL_v150"`` と
    拡張子なしで持つ——**どちらかに寄せないと、在るのに引けない。**
    """
    text = str(value or "").strip().replace("\\", "/").split("/")[-1]
    lowered = text.lower()
    for suffix in MODEL_SUFFIXES:
        if lowered.endswith(suffix):
            text = text[: -len(suffix)]
            break
    return text.strip().lower()


def _read(path: Path) -> Optional[Dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def build(kinds=INDEXED_KINDS) -> Dict[str, Any]:
    """索引を作る。**引けなかったことと空であることを混ぜない。**

    Returns:
        ``{"kinds": {種別: {"byVersionId": {...}, "byModelId": {...}, "bySha10": {...},
        "count": n}}, "files": n, "truncated": bool}``
    """
    out: Dict[str, Any] = {"kinds": {}, "files": 0, "truncated": False}
    seen = 0
    for kind in kinds:
        by_version: Dict[str, str] = {}
        by_model: Dict[str, str] = {}
        by_sha: Dict[str, str] = {}
        by_base: Dict[str, str] = {}
        for root in _roots(kind):
            for path in _walk(root):
                if seen >= MAX_FILES:
                    out["truncated"] = True
                    break
                seen += 1
                data = _read(path)
                if data is None:
                    continue
                # **名前は metadata の `file_name` を正とする。** ファイル名から
                # 組み立てると、拡張子つき/なしがここで割れる。
                name = str(data.get("file_name") or path.name[: -len(".metadata.json")]).strip()
                if not name:
                    continue
                civitai = data.get("civitai") if isinstance(data.get("civitai"), dict) else {}
                version_id = civitai.get("id")
                model_id = civitai.get("modelId")
                sha = str(data.get("sha256") or "").strip().lower()
                if version_id is not None:
                    by_version.setdefault(str(version_id), name)
                if model_id is not None:
                    # **同じ model の別の版が複数在ることがある。** 先に見つけた1つだけを
                    # 持つ——版が違えば絵も違うので、ここで当てるのは最後の手段。
                    by_model.setdefault(str(model_id), name)
                # **土台のモデルは metadata に書いてある値をそのまま持つ。**
                # 記録が `base_model` を持たないことが実測で 350件中17件あり、
                # タイルの左上の札が空のままだった（2026-08-25 実機）。
                # ファイル名から「Illustrious っぽい」と当てるのは推測で、
                # **ここに在るのは実際にそのモデルの隣に書かれた値**なので当てなくてよい。
                base = str(data.get("base_model") or civitai.get("baseModel") or "").strip()
                if base:
                    by_base.setdefault(name_key(name), base)
                if len(sha) >= 10:
                    # Civitai の AutoV2 は sha256 の**先頭10桁**。記録が持つのはこの形。
                    by_sha.setdefault(sha[:10], name)
        out["kinds"][kind] = {
            "byVersionId": by_version,
            "byModelId": by_model,
            "bySha10": by_sha,
            "baseByName": by_base,
            "count": len(set(list(by_version.values()) + list(by_sha.values()))),
        }
    out["files"] = seen
    # **索引の出どころを言う。** 置いているのは LoRA Manager なので、
    # 入れていない環境では空になる——「壊れている」と読まれないため。
    out["source"] = "sidecar-metadata"
    return out


def get(refresh: bool = False) -> Dict[str, Any]:
    """索引（プロセス内で1回だけ作る）。

    **起動のたびに全部読み直さない。** 実測で checkpoint 103 + LoRA 483 の
    metadata を読む走査なので、押すたびに走らせると画面が待つ。
    モデルを足した直後は ``refresh=True`` で作り直す。
    """
    global _cache
    if refresh or _cache is None:
        _cache = build()
    return _cache


#: 土台のモデルを引く種別。**LoRA は見ない**——記録の checkpoint と同じ名前の
#: LoRA が在ったときに、LoRA 側の土台で答えてしまう。
BASE_KINDS = ("checkpoints", "diffusion_models", "unet")


def base_model_for(name: Any, index: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """checkpoint の名前から、**手元に書いてある土台のモデル**を引く。

    引けなければ ``None``。**「無い」と「判らない」を混ぜない**ので、
    呼び手は「補えなかった」と言える（推測した値では埋めない）。
    """
    key = name_key(name)
    if not key:
        return None
    kinds = ((index if index is not None else get()).get("kinds") or {})
    for kind in BASE_KINDS:
        hit = ((kinds.get(kind) or {}).get("baseByName") or {}).get(key)
        if hit:
            return str(hit)
    return None


def reset() -> None:
    """索引を捨てる（検査と、モデルを足した直後のため）。"""
    global _cache
    _cache = None
