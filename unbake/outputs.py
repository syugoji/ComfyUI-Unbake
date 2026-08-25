# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""出力フォルダの**生の値**を、そのまま画面へ渡す。

## ここが解釈しない理由

指紋（どの画像がどの記録から出たか）は **JS 側の1本の抽出器**で計算する。
Python にも同じ規則を持たせると、**必ず食い違う**——しかも食い違いは
「どちらかが壊れている」ようには見えず、件数が少し違うだけなので、
どちらが正しいのかを毎回人間が決めることになる。

実際にこのパッケージで起きている（実測 2026-08-20）: Sweep の印は
JS が ``unbake_sweep`` / ``unbake.sweep`` / ``record_id`` で書き、Python は
``lora_manager_sweep`` / ``lora-manager.recipe-sweep-cell`` / ``recipe_id`` で
読もうとしていた。**3点とも違うので、焼いた3枚は1枚も読めなかった。**

だからここは:

- PNG のテキストチャンクを**そのままの文字列で**返す（``json.loads`` すらしない）
- どの鍵を返すかは**宣言した一覧だけ**（呼び手が増やせない）
- 解釈・正規化・比較は**一切しない**

## 大きさと所要（実測 2026-08-20・この環境）

出力 **4,275枚**、``prompt`` チャンクを持つのが **4,257枚（99.6%）**、
生の合計 **18.2 MiB**（中央値 3.8 KiB / 最大 5.8 KiB）。
ヘッダだけ読む冷えた全走査は **22.9秒**（5.4ms/枚）。

**全部を1回で返さない。** 22.9秒待たせる口は「壊れている」と見分けが付かないし、
18.2 MiB を一度に渡すと画面が固まる。ページで返し、**そのページのファイルしか開かない**
（200枚なら約1.1秒）。一度読んだものは mtime が変わるまで開き直さない。

## パスを返さない

``/unbake/records`` が全記録の絶対パスを返していた件と同じ理由で、
返すのは出力フォルダからの相対位置（``subfolder`` + ``filename``）だけにする。
これは ComfyUI の ``/view?filename=..&subfolder=..&type=output`` にそのまま渡せる形でもある。
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

#: 走査する拡張子。テキストチャンクを持てるのは PNG だけ。
SUPPORTED_SUFFIXES = (".png",)

#: 返してよい生の鍵。**呼び手が増やせない。**
#:
#: ``workflow``（画面のグラフ）は入れていない——実測で 532枚が持っているが
#: 1枚あたりが大きく、指紋には要らない。要るようになったらここへ足す。
RAW_KEYS: Tuple[str, ...] = (
    # 実行された API グラフ。**指紋の材料はこれ1つ。**
    "prompt",
    # 焼いた印（在れば指紋より強い証拠になる）。
    "unbake_sweep",
    "lora_manager_sweep",
    "lora_manager_recipe",
)

#: 1回に返す上限。
MAX_LIMIT = 500


def recover_graph(source_path: Any) -> Optional[Dict[str, Any]]:
    """記録の出どころのファイルから、**焼き込まれたグラフを拾い直す。**

    **記録がグラフを持っていなくても、元の絵が持っていることがある。**
    実測（2026-08-22）: `ComfyUI_00183_` は記録側の `comfy_prompt` が空で
    「再現に必要なチェックポイント情報がありません」と出ていたが、
    出どころの PNG は `prompt` チャンクを持っていて、そこに
    `Illustrious\\anime\\waiIllustriousSDXL_v150.safetensors` が入っていた。
    **取り込み損ねただけで、材料はディスクに残っていた。**

    **出力フォルダの中しか読まない。** `source_path` は記録に書かれた文字列で、
    こちらが検証していない値である。ComfyUI の出力フォルダの中に在ることを
    **実際のパスで**確かめてからでないと開かない——ここを緩めると、
    記録を1つ置くだけで任意のファイルを読ませる口になる。

    Returns:
        ``{"comfy_prompt": {...}}`` 相当の辞書、または拾えなければ ``None``。
    """
    text = str(source_path or "").strip()
    if not text or text.lower().startswith(("http://", "https://")):
        return None
    root = _default_output_dir()
    if not root:
        return None
    try:
        target = Path(text).resolve()
        base = Path(root).resolve()
    except OSError:
        return None
    try:
        if os.path.commonpath([str(base), str(target)]) != str(base):
            return None
    except ValueError:
        # ドライブが違う＝出力フォルダの外。
        return None
    if not target.is_file() or target.suffix.lower() != ".png":
        return None

    scanner = get_output_scanner()
    raw = scanner._read_raw(str(target), ("prompt", "workflow"))  # noqa: SLF001
    if not raw:
        return None
    out: Dict[str, Any] = {}
    for key, field in (("prompt", "comfy_prompt"), ("workflow", "comfy_workflow")):
        value = raw.get(key)
        if not value:
            continue
        try:
            parsed = json.loads(value)
        except ValueError:
            continue
        if isinstance(parsed, dict) and parsed:
            out[field] = parsed
    return out or None


def _default_output_dir() -> str:
    try:
        import folder_paths  # type: ignore

        return folder_paths.get_output_directory()
    except Exception:  # pragma: no cover - ComfyUI 外での実行
        return ""


class OutputScanner:
    """出力 PNG の生のテキストチャンクを、ページで返す。"""

    def __init__(self, output_dir_getter=None) -> None:
        self._output_dir_getter = output_dir_getter or _default_output_dir
        #: path -> (mtime, size, 要求した鍵, {見つかった鍵: 生の文字列})
        #:
        #: **要求した鍵を控える。** 見つかった鍵と比べると、チャンクを持たない
        #: 画像がキャッシュに当たらず**毎回開き直す**（実測: 2回目も 6.06秒のまま
        #: だった。列挙自体は 0.11秒しかかからないので、全部が読み直しだった）。
        self._cache: Dict[str, Tuple[float, int, Tuple[str, ...], Dict[str, str]]] = {}
        self._last_scan_at: Optional[float] = None

    # -- 走査 ---------------------------------------------------------

    def root(self) -> str:
        return (self._output_dir_getter() or "").strip()

    def _all_entries(self, root: str) -> List[Tuple[str, float, int]]:
        """開かずに並べて属性まで取る。**ここは速い**（実測 4,275件で 0.11秒未満）。

        `os.walk` + 個別 `os.stat` ではなく `os.scandir` で取る——後者は
        ディレクトリ項目に載っている属性をそのまま使うので、当たり直しが要らない。
        """
        found: List[Tuple[str, float, int]] = []
        for dirpath, _dirs, _files in os.walk(root):
            try:
                with os.scandir(dirpath) as entries:
                    for entry in entries:
                        if not entry.name.lower().endswith(SUPPORTED_SUFFIXES):
                            continue
                        try:
                            if not entry.is_file():
                                continue
                            info = entry.stat()
                        except OSError:
                            continue
                        found.append((entry.path, info.st_mtime, info.st_size))
            except OSError:
                continue
        return found

    def _read_raw(self, path: str, keys: Tuple[str, ...]) -> Optional[Dict[str, str]]:
        """テキストチャンクを**そのままの文字列で**読む。"""
        try:
            from PIL import Image  # type: ignore

            # **`.text` を見ない。** Pillow の `text` は IDAT より後ろの
            # テキストチャンクまで拾うために**ファイル全体を読む**。
            # 実測（2026-08-20・出力200枚）で **30.9ms/枚 対 0.3ms/枚＝100倍**、
            # しかも拾えた件数は **200件で同じ**だった。全走査に直すと
            # 132秒 対 1.3秒 で、口の作り方が変わるほどの差になる。
            #
            # ComfyUI は `Image.save(pnginfo=...)` で書くので、チャンクは
            # **IDAT より前**に載る＝`.info` で足りる。IDAT の後ろへ書く
            # 書き手が現れたら、そのぶんは見落とす。
            with Image.open(path) as image:
                info = image.info or {}
        except Exception:
            # 読めないファイルで走査ごと止めない。**次回に拾う。**
            return None
        raw: Dict[str, str] = {}
        for key in keys:
            value = info.get(key)
            if isinstance(value, str) and value:
                raw[key] = value
            elif value is not None:
                # 文字列でない形で入っていることがある。**加工せず文字列にするだけ。**
                raw[key] = str(value)
        return raw

    def page(
        self,
        *,
        offset: int = 0,
        limit: int = 200,
        keys: Optional[Tuple[str, ...]] = None,
    ) -> Dict[str, Any]:
        """新しい順に1ページぶん返す。**そのページのファイルしか開かない。**"""
        started = time.monotonic()
        root = self.root()
        if not root or not os.path.isdir(root):
            return {
                "outputs": [], "total": 0, "offset": 0, "root": bool(root),
                "keys": list(keys or RAW_KEYS), "elapsedMs": 0,
                # **「設定が無い」と「0件」を混ぜない。**
                "unavailable": "output-dir-missing",
            }

        wanted = tuple(key for key in (keys or RAW_KEYS) if key in RAW_KEYS) or RAW_KEYS
        stated = self._all_entries(root)
        # 新しい順。**同じ mtime でも順序が動かないよう path を第2キーにする**
        # ——動くとページ送りが同じ画像を2回返したり飛ばしたりする。
        stated.sort(key=lambda item: (-item[1], item[0]))

        total = len(stated)
        start = max(0, int(offset))
        end = start + max(0, min(int(limit), MAX_LIMIT))
        window = stated[start:end]

        rows: List[Dict[str, Any]] = []
        opened = 0
        for path, mtime, size in window:
            cached = self._cache.get(path)
            if cached is not None and cached[0] == mtime and set(wanted) <= set(cached[2]):
                raw = {key: cached[3][key] for key in wanted if key in cached[3]}
            else:
                read = self._read_raw(path, wanted)
                if read is None:
                    continue
                opened += 1
                self._cache[path] = (mtime, size, tuple(wanted), read)
                raw = read

            subfolder = ""
            try:
                relative = os.path.relpath(os.path.dirname(path), root)
                subfolder = "" if relative == "." else relative.replace(os.sep, "/")
            except ValueError:
                # 別ドライブなど、相対にできないものは出力扱いにしない。
                continue

            rows.append({
                "filename": os.path.basename(path),
                "subfolder": subfolder,
                "modified": mtime,
                "size": size,
                # **生のまま。** 解釈は呼び手（JS の抽出器1本）がやる。
                "raw": raw,
            })

        self._last_scan_at = time.time()
        return {
            "outputs": rows,
            "total": total,
            "offset": start,
            "root": True,
            "keys": list(wanted),
            "opened": opened,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "unavailable": None,
        }

    def status(self) -> Dict[str, Any]:
        root = self.root()
        return {
            "root": bool(root and os.path.isdir(root)),
            "cached": len(self._cache),
            "lastScanAt": self._last_scan_at,
            "keys": list(RAW_KEYS),
        }


_instance: Optional[OutputScanner] = None


def get_output_scanner(**kwargs: Any) -> OutputScanner:
    global _instance
    if _instance is None:
        _instance = OutputScanner(**kwargs)
    return _instance


def reset_output_scanner() -> None:
    global _instance
    _instance = None


def delete_output(filename: str, subfolder: str = "") -> Dict[str, Any]:
    """出た絵を1枚消す。**出力フォルダの中だけ。**

    取り消しは**呼び手が持つ**（面が猶予のあいだ呼ばない）。ここへ着いた時点で
    戻せないので、**置き場の外は必ず断る**——`..` や絶対パスで抜けられると、
    「出た絵を消す」口がライブラリを消す口になる。

    Args:
        filename: ファイル名だけ（区切りを含めない）。
        subfolder: 出力フォルダからの相対。空でよい。

    Returns:
        ``{"ok": True, "path": …}`` または ``{"ok": False, "error": …}``。
        **投げない**（呼び手が理由を画面へ出す）。
    """
    name = str(filename or "").strip()
    if not name or name in (".", ".."):
        return {"ok": False, "error": "no filename"}
    # **区切りは名前に混ぜない。** 混ぜられると下の判定より先に置き場を抜ける。
    if "/" in name or "\\" in name or os.path.isabs(name):
        return {"ok": False, "error": "filename must not contain a path"}

    root = (_default_output_dir() or "").strip()
    if not root or not os.path.isdir(root):
        return {"ok": False, "error": "no output directory"}

    relative = str(subfolder or "").strip().replace("\\", "/").strip("/")
    target = os.path.normpath(os.path.join(root, relative, name))
    # **正規化した後で確かめる。** 前に確かめると `a/../..` を通してしまう。
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    if target_real != root_real and not target_real.startswith(root_real + os.sep):
        return {"ok": False, "error": "outside the output directory"}
    if not os.path.isfile(target_real):
        # **無いことを失敗と混ぜない。** 二度押しや、既に消えている分が在る。
        return {"ok": True, "path": target_real, "missing": True}
    try:
        os.remove(target_real)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "path": target_real, "missing": False}
