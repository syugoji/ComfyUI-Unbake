# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""導入済みモデルを引く・消す。**名前からパスへ落とすところが全部の要。**

## 記録はモデルを「名前」でしか持っていない

実データ346件の参照は ``princess_xl_v2`` の形で、**拡張子もフォルダも入っていない**。
一方、手元に導入済みの LoRA は **482本のうち 399本がサブフォルダの中**にある
（`Anima\\anime\\AnimaMythP0rtr4itStyleV1.safetensors` など）。
つまり消す前に**名前 → 実ファイル**の解決が要る。

実測（2026-08-21・稼働中 ComfyUI）:

===============  =========================================================
LoRA             406名 → 一意 346 / **曖昧 1** / 手元に無い 59
checkpoint       104名 → 一意  87 / 曖昧 0 / 手元に無い 17
===============  =========================================================

**曖昧が実際に在る。** ``DetailedEyes_V3`` は ``DetailedEyes_V3.safetensors`` と
``SDXL 1.0\\tool\\DetailedEyes_V3.safetensors`` の2箇所に在り、
**名前だけでは消す相手を決められない**。ここで片方を選ぶ実装にすると、
1件だけ静かに違うファイルが消える。だから **曖昧なら消さずに候補を返す。**

**上の「曖昧 1」は古い**（2026-08-31 実測）。同じツリー（LoRA 406ファイル）で
数え直すと **9組**だった。ただし**9組とも大きさが一致**しており、別フォルダへ
置いた**同じ物の複製**である——「別のモデルが同じ名前で並んでいる」わけではない。
**それでも消す相手は決められない**ので、扱いは変えない。
（`tests/test_pass3_round3.py` が、数字と実装の食い違いを留める。）

## 置き場の外を消さない

改造版 LoRA Manager の削除はパスの検証をしておらず（`model_lifecycle_service.py`）、
``..`` や絶対パスを渡せば置き場の外のファイルも消せる。**ここは意図的に違える**
——消す前に `folder_paths` が知っている置き場の**実際のパス**の中に在ることを確かめる。
画面からパスを受け取る口も作らない（受け取るのは種別と名前だけ）。

## 使われているかは、消す側が数える

同じ checkpoint を **39件の記録が共有している**（実測・`hassakuXLIllustrious_v13StyleA`）。
1件の画面から消せば、残り38件が壊れる。だから件数は必ず返す。
ただし**数えているのは書庫の記録だけ**で、手組みのワークフローや他の UI は数えていない
——「0件だから安全」と読まれないよう、呼び手はその範囲を画面へ書くこと。
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from .utils.model_file_names import model_lookup_key

logger = logging.getLogger(__name__)

try:  # ComfyUI 本体が提供する。
    import folder_paths  # type: ignore
except ImportError:  # pragma: no cover - ComfyUI の外で読まれたとき
    folder_paths = None  # type: ignore


class ModelError(Exception):
    """引けなかった・消せなかった理由。**握り潰さずに呼び手へ返す。**"""


#: 触ってよい種別。**`download.py` と同じ並び**——落とせるものだけ消せる、で揃える。
#: **`diffusion_models` を含める。** Flux 系の本体はここに在るので、
#: 外すと見本も使用件数も引けない（`models/checkpoints` には入らない）。
ALLOWED_KINDS = (
    "loras",
    "checkpoints",
    "diffusion_models",
    "embeddings",
    "vae",
    "controlnet",
    "upscale_models",
    # **落とせるのに消せない、を作らない**（2026-08-31・監査 I-20260831-34）。
    # 2026-08-26 に `civitai.py` の `KIND_OF_TYPE` へ hypernetwork を足したとき、
    # 落とす側（`download.ALLOWED_KINDS`）だけが更新されて**ここが取り残された**。
    # Civitai の Hypernetwork は落とせるのに、削除計画が `unsupported kind` で
    # 400 を返し、画面は「入っていません」と出して削除ボタンを押せなくする。
    # 上のコメントが「`download.py` と同じ並び」と書いていても守られなかったので、
    # `tests/test_kinds_and_coercion.py` が両者を突き合わせる。
    "hypernetworks",
    # **落とす口は1つではない**（2026-08-31・3周目）。
    #
    # 上の注記も `test_kinds_and_coercion.py` も **`download.py` との一致**しか
    # 見ていなかったが、既知モデル台帳（`services/known_model_catalog.py`）は
    # `download.ALLOWED_KINDS` を通らない**別の落とし口**
    # （`known_model_downloader.download_known_model` が `entry.folder` を直に使う）
    # を持っている。実測でその置き場は `text_encoders` **10件**・
    # `ultralytics_bbox` **1件**で、**どちらもここに無かった**——
    # つまり数GBのテキストエンコーダを落とせるのに、
    # `model-delete` も `model-delete-plan` も `usage` も
    # `unsupported kind` で断る＝**画面から消せない**。
    #
    # `I-20260831-34`（hypernetworks）と同じ形だが、**取り残したのは
    # 「両者の一致」を見る検査のほうだった**——宣言を2つ比べても、
    # 3つ目の書き手は見えない。検査を「**書く側すべて ⊆ ここ**」へ広げた。
    "text_encoders",
    # ComfyUI 本体は知らない置き場（Impact Pack が登録する）。**それでも入れる**
    # ——入れないと理由が `unsupported kind` になり、本当の理由
    #（「この環境にその置き場が無い」）が画面へ届かない。
    "ultralytics_bbox",
)

#: 本体と一緒に消す付随。**残すと孤児になる**（見本だけが置き場に残り続ける）。
COMPANION_SUFFIXES = (
    ".metadata.json",
    ".civitai.info",
    ".json",
    ".txt",
    ".preview.png",
    ".preview.jpg",
    ".preview.jpeg",
    ".preview.webp",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".mp4",
)


def _stem(name: str) -> str:
    """比べるための形。**規則は `utils/model_file_names` が1本で持つ。**

    ここには同じ規則が手で書かれていた（``I-20260831-69``）。落とす拡張子の
    一覧が正の一覧と違っており、``.pt2`` / ``.pkl`` を落とせず ``.gguf`` を
    余分に落としていた——**同じ名前が場所によって別の鍵になる。**
    理由（``splitext`` を使わない・``.fp16`` を落とさない）は寄せ先に書いてある。
    """
    return model_lookup_key(name)


def _roots(kind: str) -> List[Path]:
    if kind not in ALLOWED_KINDS:
        raise ModelError(f"unsupported kind: {kind}")
    if folder_paths is None:
        raise ModelError("folder_paths is not available (not running inside ComfyUI)")
    try:
        paths = folder_paths.get_folder_paths(kind)
    except Exception as error:  # pragma: no cover - 本体側の事情
        raise ModelError(f"ComfyUI could not list folders for {kind}: {error}") from error
    return [Path(p) for p in (paths or [])]


def installed(kind: str) -> List[str]:
    """導入済みの相対名。**ComfyUI に聞く**（自分でフォルダを歩かない）。"""
    if kind not in ALLOWED_KINDS:
        raise ModelError(f"unsupported kind: {kind}")
    if folder_paths is None:
        raise ModelError("folder_paths is not available (not running inside ComfyUI)")
    try:
        return list(folder_paths.get_filename_list(kind) or [])
    except Exception as error:  # pragma: no cover
        raise ModelError(f"ComfyUI could not list {kind}: {error}") from error


def resolve(kind: str, name: str) -> Dict[str, Any]:
    """名前から実ファイルを引く。**決められないときは決めない。**

    Returns:
        ``{"state": "one"|"none"|"many"|"unreadable", "matches": [相対名...],
        "path": 絶対パス|None}``——``many`` は候補を返すだけで、
        **呼び手が選ぶまで何もしない**。

    **``one`` はパスが引けたときだけ**（2026-08-31・走査3周目）。
    以前は ``full_path`` が ``None`` を返しても ``one`` を名乗っていた
    ——名前は1つに決まったのに実体へ辿れない状態で、呼び手は
    ``state != "one" or not path`` と**2つ見ないと**気づけなかった。
    しかも ``full_path`` は例外を握り潰しており、``models.py`` は
    ``logging`` を輸入すらしていなかったので、**理由がどこにも残らなかった**。
    """
    wanted = _stem(name)
    if not wanted:
        return {"state": "none", "matches": [], "path": None}
    matches = [item for item in installed(kind) if _stem(item) == wanted]
    if not matches:
        return {"state": "none", "matches": [], "path": None}
    if len(matches) > 1:
        return {"state": "many", "matches": sorted(matches), "path": None}
    path = full_path(kind, matches[0])
    if not path:
        # **名前は決まったが、実体へ辿れない。** 置き場の外に在る・
        # `get_full_path` が投げた・消えた直後、のどれか。
        # `none`（入っていません）と混ぜると、**在るのに「無い」**と出る。
        logger.warning(
            "%s/%s resolved to a single name but no readable path", kind, matches[0])
        return {"state": "unreadable", "matches": matches, "path": None}
    return {"state": "one", "matches": matches, "path": path}


def full_path(kind: str, relative: str) -> Optional[str]:
    """相対名を絶対パスへ。**置き場の中に在るときだけ返す。**"""
    if folder_paths is None:
        raise ModelError("folder_paths is not available (not running inside ComfyUI)")
    resolved = None
    try:
        resolved = folder_paths.get_full_path(kind, relative)
    except Exception as error:
        # **握るが、黙らない**（2026-08-31・走査3周目）。
        # ここが無言だったので、`resolve()` が `one` と言いながら
        # パスを持たない理由が**どこにも残らなかった**。
        logger.warning("get_full_path failed for %s/%s: %s", kind, relative, error)
        resolved = None
    if not resolved:
        return None
    path = Path(str(resolved))
    return str(path) if _inside(path, _roots(kind)) else None


def _inside(path: Path, roots: List[Path]) -> bool:
    """**実際のパスで**確かめる。文字列の前方一致はリンクと ``..`` で抜ける。"""
    try:
        target = path.resolve()
    except OSError:
        return False
    for root in roots:
        try:
            base = root.resolve()
        except OSError:
            continue
        try:
            if os.path.commonpath([str(base), str(target)]) == str(base):
                return True
        except ValueError:
            continue
    return False


def usage(library, name: str) -> Dict[str, Any]:
    """この名前を使っている**書庫の記録**を数える。

    **範囲を一緒に返す。** 数えているのは書庫の記録だけで、手組みの
    ワークフローも他の UI も見ていない——「0件だから消してよい」と
    読まれると、数えていない側が壊れる。
    """
    wanted = _stem(name)
    rows: List[Dict[str, str]] = []
    if wanted:
        for row in library.rows():
            if _stem(row.get("checkpoint") or "") == wanted:
                rows.append({"id": row["id"], "title": row.get("title") or row["id"], "as": "checkpoint"})
                continue
            if any(_stem(lora.get("file_name") or "") == wanted
                   for lora in (row.get("loras") or [])):
                rows.append({"id": row["id"], "title": row.get("title") or row["id"], "as": "lora"})
                continue
            # **プロンプトに直書きされた LoRA も数える**（2026-08-31・3周目）。
            #
            # 構造化された `loras` にしか現れない前提だったが、`<lora:名前:強さ>`
            # と本文へ書いただけの記録が在る。数え落とすと**使われているモデルが
            # 「使用0件」として消せてしまう**——外れる向きが一番悪い。
            if any(_stem(written) == wanted for written in (row.get("prompt_loras") or [])):
                rows.append({"id": row["id"], "title": row.get("title") or row["id"],
                             "as": "prompt-lora"})
    return {
        "name": str(name or ""),
        "count": len(rows),
        "records": rows[:50],
        "truncated": max(0, len(rows) - 50),
        # **数えた範囲。** 画面はこれをそのまま出す。
        #
        # 記録の `loras`（構造化）・`checkpoint`・**プロンプト直書きの
        # `<lora:…>`** の3つを見る。手組みのワークフローも他の UI も見ていない
        # ことは変わらない。
        "scope": "library-records-only",
    }


def plan_delete(kind: str, name: str) -> Dict[str, Any]:
    """**消さずに**、消す対象と合計サイズを返す。

    押す前に総量を出すのは、落とす側（`download-plan`）と同じ理由——
    実測で19件の待ち行列の10本目が 34 GB だった。消す側でも桁は同じ。
    """
    found = resolve(kind, name)
    if found["state"] != "one" or not found["path"]:
        return {"ok": False, "state": found["state"], "matches": found["matches"], "files": [], "bytes": 0}
    files = _targets(Path(found["path"]))
    total = 0
    listed = []
    for path in files:
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        total += size
        listed.append({"name": path.name, "bytes": size})
    return {
        "ok": True,
        "state": "one",
        "matches": found["matches"],
        "path": found["path"],
        "files": listed,
        "bytes": total,
    }


def _targets(main: Path) -> List[Path]:
    """本体と付随。**同じ茎を持つものだけ**——前方一致では隣の別モデルを巻き込む。

    `princess_xl_v2` を消すときに `princess_xl_v2_extra.safetensors` を
    巻き込まないよう、比べるのは**拡張子を除いた茎の完全一致**にする。
    """
    out: List[Path] = []
    if main.is_file():
        out.append(main)
    stem = main.name[: -len(main.suffix)] if main.suffix else main.name
    for suffix in COMPANION_SUFFIXES:
        candidate = main.with_name(stem + suffix)
        if candidate != main and candidate.is_file() and candidate not in out:
            out.append(candidate)
    return out


def delete(kind: str, name: str) -> Dict[str, Any]:
    """モデルを1つ消す。**完全に消す**（ゴミ箱へは送らない・2026-08-21 ユーザー決定）。

    消す前に3つを確かめる: 種別が許してある・名前が**1つに**決まる・
    そのパスが置き場の**中に在る**。1つでも欠けたら何も触らない。
    """
    found = resolve(kind, name)
    if found["state"] == "none":
        raise ModelError(f"not installed: {name}")
    if found["state"] == "unreadable":
        # **「無い」と混ぜない。** 在るのに辿れないので、打つ手が違う。
        raise ModelError(f"found the name but not the file: {name}")
    if found["state"] == "many":
        # **選ばない。** 実データで1件（`DetailedEyes_V3`）が該当する。
        raise ModelError(
            "the name matches more than one file: " + ", ".join(found["matches"])
        )
    path = Path(str(found["path"]))
    if not _inside(path, _roots(kind)):  # pragma: no cover - resolve が既に確かめている
        raise ModelError("refusing to delete outside the model folder")

    removed: List[str] = []
    failed: List[str] = []
    freed = 0
    for target in _targets(path):
        try:
            size = target.stat().st_size
        except OSError:
            size = 0
        try:
            target.unlink()
            removed.append(target.name)
            freed += size
        except OSError as error:
            failed.append(f"{target.name}: {type(error).__name__}: {error}")
    if not removed:
        raise ModelError("nothing was removed")
    return {"ok": not failed, "kind": kind, "name": name, "removed": removed, "failed": failed, "bytes": freed}
