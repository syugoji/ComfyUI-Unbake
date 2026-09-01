# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""出力画像に埋め込まれたレシピ参照の索引。

``unbake/utils/recipe_pnginfo.py`` が書いた参照を出力フォルダから拾い集め、
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
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..utils.recipe_pnginfo import (
    read_recipe_reference_from_image,
    read_sweep_reference_from_image,
    read_trial_reference_from_image,
)

logger = logging.getLogger(__name__)

# 参照を書けるのは PNG のテキストチャンクだけ（書き込み側と対）。
SUPPORTED_SUFFIXES = (".png",)


def _record_id_of(marks: Optional[Dict[str, Any]]) -> str:
    """焼いた印から記録の id を取る。**印の種類を問わない。**

    sweep も trial も `record_id` を持つ（`recipe_pnginfo` が形を揃えている）。
    **引く所と数える所で同じ1本を使う**——周回7で数える側だけが取り残された
    のと同じことを、印が増えるたびに繰り返さないため。
    """
    return str((marks or {}).get("record_id") or "")


def _has_reference(entry: Tuple[float, Optional[str], Optional[Dict[str, Any]]]) -> bool:
    """この控えは「参照を持っている」か。**数える所と引く所で規則を1つにする。**

    `get_outputs` は 2026-08-26 に **Sweep の印も照合に使う**ようになった
    （それまで「Unbake 自身が出した絵は Unbake の口から1枚も引けなかった」）。
    ところが**件数を数える2箇所は `recipe_id` しか見ていなかった**
    （2026-09-01・走査7周目）——引ける絵が `indexed` に入らないので、
    「索引が空だ」と読める数を返す。**引ける物の数と、引ける物の定義を分けない。**
    """
    _mtime, recipe_id, marks = entry
    if recipe_id:
        return True
    return bool(_record_id_of(marks))


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
        # **鍵を2本に分ける**（2026-08-31・監査 I-20260831-14）。
        #
        # `routes.py` の `/unbake/outputs` は `asyncio.to_thread` でここを
        # スレッドプールへ流すので、**2本同時に走るのが普通**である。
        # 素の dict を書きながら回すと `RuntimeError: dictionary changed size
        # during iteration` で 500 になっていた。
        #
        # `_entries_lock` … 索引の差し替えと読み出しだけを守る。**短く持つ。**
        # `_scan_lock`    … 走査どうしを直列化する。**長く持つが、索引は塞がない**
        #                   ——走査は遅い I/O を含むので、これを `_entries_lock` で
        #                   兼ねると読む側が丸ごと待たされる。
        self._entries_lock = threading.Lock()
        self._scan_lock = threading.Lock()

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

        # **走査どうしは直列化する**（I-20260831-14）。並べて走らせると、
        # 後から始まった方が古い写しを元に組んだ索引で先の結果を上書きし、
        # その間に増えた絵を次の走査まで取りこぼす。
        with self._scan_lock:
            # **古い索引は写しの参照だけ取り、以後1バイトも書き換えない。**
            # ここで書き換えると、読む側が回している最中の dict を触ることになる。
            with self._entries_lock:
                previous = self._entries

            seen: set[str] = set()
            read_count = 0
            # **新しい索引は手元で組む。** 走査は遅い I/O を含むので、
            # この間ずっと鍵を持つわけにはいかない。
            fresh: Dict[str, Tuple[float, Optional[str], Optional[Dict[str, Any]]]] = {}

            for path in self._iter_image_paths(root):
                seen.add(path)
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    # 走査中に消えた。次回に拾う。
                    continue

                cached = previous.get(path)
                if cached is not None and cached[0] == mtime:
                    # **差分走査の意味を落とさない。** 開き直さずに写しを持ち越す。
                    fresh[path] = cached
                    continue

                reference = read_recipe_reference_from_image(path)
                # **試行の印も読む**（2026-09-01・走査9周目）。
                # 周回8で生の走査の側は直したが、**索引の側は試行を知らないまま**
                # だった——`GET /unbake/outputs?id=…` はこちらを使うので、
                # 記録を開いても試行の絵が1枚も出なかった。
                sweep = (read_sweep_reference_from_image(path)
                         or read_trial_reference_from_image(path))
                read_count += 1
                fresh[path] = (
                    mtime,
                    reference.get("recipe_id") if reference else None,
                    sweep,
                )

            # 消えたファイルは `fresh` に入らないので、落とす操作は要らない。
            # 数だけ、古い写しと突き合わせて数える。
            removed = [path for path in previous if path not in seen]

            # **差し替えは一瞬。** 読む側はこの前か後のどちらかを見る。
            with self._entries_lock:
                self._entries = fresh
                self._last_scan_at = time.time()

        indexed = sum(1 for entry in fresh.values() if _has_reference(entry))
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
        # **回す前に写しを1回取る**（I-20260831-14）。この下は
        # `os.path.getsize` で1件ずつ disk を叩くので、その間ずっと鍵を
        # 持つわけにはいかない。写しなら、走査が差し替えても壊れない。
        with self._entries_lock:
            snapshot = list(self._entries.items())
        for path, (mtime, rid, sweep) in snapshot:
            # **Sweep の印も照合に使う**（2026-08-26 実機で判明）。
            #
            # ここは `recipe_id`（LoRA Manager が焼く参照）としか比べていなかった。
            # `sweep` は読んで控えにも入れているのに**一度も照合に使っていない**ので、
            # **Unbake 自身が出した絵は、Unbake の口から1枚も引けなかった**
            # ——この関数の説明が「自分が Sweep で回した分がここに貯まる」と
            # 言っているまさにその分が、丸ごと落ちていた。
            #
            # 実測: `civitai_137684933_00002_.png` は
            # `unbake_sweep = {..., "record_id": "137684933"}` を持つのに、
            # `/unbake/outputs?id=137684933` は 0 件を返した。
            if rid != wanted and _record_id_of(sweep) != wanted:
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
        # 2つの数を**同じ索引から**数える（I-20260831-14）。鍵の外で数えると、
        # 途中で差し替わって `tracked` と `indexed` が別の索引の値になる。
        with self._entries_lock:
            entries = self._entries
            return {
                "tracked": len(entries),
                "indexed": sum(1 for entry in entries.values() if _has_reference(entry)),
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
