# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""出力画像に埋め込まれたレシピ参照の索引。

``py/utils/recipe_pnginfo.py`` が書いた参照を出力フォルダから拾い集め、
「このレシピで生成した画像」を引けるようにする。

## 差分走査にしている理由

参照は PNG のテキストチャンクにしか無いので、読むには1ファイルずつ開く
必要がある。Pillow はヘッダだけを遅延読み込みするので1枚あたりは軽いが、
枚数は増え続ける（実測 2026-08-09 時点で 635 枚）。
**前回見たときから mtime が変わっていないファイルは開き直さない。**

索引はプロセス内のメモリにだけ持つ。永続化しないのは、
- 参照の実体は画像側にあり、索引は再構築できる派生物にすぎない
- 出力フォルダは外から自由に触られる（手で消す・移す）ので、
  永続索引は «実体と食い違ったまま古い答えを返す» 側の危険が大きい
ため。再起動後の初回だけ全走査になるが、それは払える。
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..utils.recipe_pnginfo import (
    read_recipe_reference_from_image,
    read_sweep_reference_from_image,
)

logger = logging.getLogger(__name__)

# 参照を書けるのは PNG のテキストチャンクだけ（書き込み側と対）。
SUPPORTED_SUFFIXES = (".png",)


def _default_output_dir() -> str:
    try:
        import folder_paths  # type: ignore

        return folder_paths.get_output_directory()
    except Exception:  # pragma: no cover - ComfyUI 外での実行
        return ""


class RecipeOutputIndex:
    """出力画像 → レシピID の索引。"""

    def __init__(
        self,
        output_dir_getter: Optional[Callable[[], str]] = None,
        logger_override: Optional[logging.Logger] = None,
    ) -> None:
        self._output_dir_getter = output_dir_getter or _default_output_dir
        self._logger = logger_override or logger
        # path -> (mtime, recipe_id or None, sweep metadata or None)
        # recipe_id が None のエントリも覚える。**覚えないと、参照を持たない
        # 画像を毎回開き直すことになり、差分走査の意味が無くなる。**
        self._entries: Dict[
            str, Tuple[float, Optional[str], Optional[Dict[str, Any]]]
        ] = {}
        self._last_scan_at: Optional[float] = None

    # -- 走査 ---------------------------------------------------------

    def _iter_image_paths(self, root: str):
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.lower().endswith(SUPPORTED_SUFFIXES):
                    yield os.path.join(dirpath, name)

    def refresh(self) -> Dict[str, Any]:
        """出力フォルダを差分走査して索引を更新する。

        Returns:
            {"scanned": 見たファイル数, "read": 実際に開いた数,
             "indexed": 参照を持つ数, "removed": 消えていた数,
             "elapsed_ms": 所要}
        """
        started = time.monotonic()
        root = (self._output_dir_getter() or "").strip()
        if not root or not os.path.isdir(root):
            self._logger.debug("Output directory not available: %r", root)
            return {"scanned": 0, "read": 0, "indexed": 0, "removed": 0, "elapsed_ms": 0}

        seen: set[str] = set()
        read_count = 0

        for path in self._iter_image_paths(root):
            seen.add(path)
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                # 走査中に消えた。次回に拾う。
                continue

            cached = self._entries.get(path)
            if cached is not None and cached[0] == mtime:
                continue

            reference = read_recipe_reference_from_image(path)
            sweep = read_sweep_reference_from_image(path)
            read_count += 1
            self._entries[path] = (
                mtime,
                reference.get("recipe_id") if reference else None,
                sweep,
            )

        # 消えたファイルを索引から落とす。
        removed = [path for path in self._entries if path not in seen]
        for path in removed:
            self._entries.pop(path, None)

        self._last_scan_at = time.time()
        indexed = sum(1 for _mtime, rid, _sweep in self._entries.values() if rid)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        self._logger.debug(
            "Recipe output index refreshed: %d files, %d read, %d with references (%d ms)",
            len(seen),
            read_count,
            indexed,
            elapsed_ms,
        )
        return {
            "scanned": len(seen),
            "read": read_count,
            "indexed": indexed,
            "removed": len(removed),
            "elapsed_ms": elapsed_ms,
        }

    # -- 参照 ---------------------------------------------------------

    def get_outputs(self, recipe_id: str, *, refresh: bool = True) -> List[Dict[str, Any]]:
        """レシピIDに紐付く出力画像を新しい順で返す。

        **絶対パスは返さない。** 返すのは出力フォルダからの相対位置
        （``subfolder`` + ``filename``）だけ。これは ComfyUI の
        ``/view?filename=..&subfolder=..&type=output`` にそのまま渡せる形であり、
        画面へ出す値に利用者のフォルダ構成を混ぜないためでもある。
        """
        if not recipe_id:
            return []
        if refresh:
            self.refresh()

        root = (self._output_dir_getter() or "").strip()
        wanted = str(recipe_id)
        results = []
        for path, (mtime, rid, sweep) in self._entries.items():
            if rid != wanted:
                continue
            try:
                size = os.path.getsize(path)
            except OSError:
                continue

            subfolder = ""
            if root:
                try:
                    relative = os.path.relpath(os.path.dirname(path), root)
                    subfolder = "" if relative == "." else relative.replace(os.sep, "/")
                except ValueError:
                    # 別ドライブなど、相対にできない場合は出力扱いにしない。
                    continue

            result = {
                    "filename": os.path.basename(path),
                    "subfolder": subfolder,
                    "modified": mtime,
                    "size": size,
                }
            if sweep:
                result["sweep"] = sweep
            results.append(result)

        results.sort(key=lambda item: item["modified"], reverse=True)
        return results

    def get_status(self) -> Dict[str, Any]:
        return {
            "tracked": len(self._entries),
            "indexed": sum(1 for _mtime, rid, _sweep in self._entries.values() if rid),
            "last_scan_at": self._last_scan_at,
        }


_instance: Optional[RecipeOutputIndex] = None


def get_recipe_output_index(**kwargs: Any) -> RecipeOutputIndex:
    global _instance
    if _instance is None:
        _instance = RecipeOutputIndex(**kwargs)
    return _instance


def reset_recipe_output_index() -> None:
    """テスト用。プロセス内シングルトンを捨てる。"""
    global _instance
    _instance = None
