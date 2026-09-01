"""HTTP の口。**ここまで `unbake/` は誰からも呼ばれていなかった。**

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

切り出した Python は7ファイル在ったが、ルートを1本も登録していなかったので
**実際には死んでいた**（読み込まれるだけで、画面からは届かない）。ここが最初の
呼び手になる。

登録する経路は下のとおり。**この表と ``registered_paths()`` と、実際の
``@routes.*`` の三者が食い違ったら検査が赤くなる**
——文書と実物がずれるのは、実際にこのパッケージで何度も起きた。

**三者にしたのは 2026-08-31**（``I-20260831-61``）。それまで検査は
**表と ``registered_paths()`` という宣言同士**しか比べておらず、
``@routes.*`` の現物とは一度も突き合わせていなかった。だから
**両方から同時に漏れていた ``output-raw`` と ``output-delete`` は検査の外**に在り、
消しても改名しても赤くならなかった。宣言だけを見る検査は、宣言が揃って
間違っているときに黙る。

=====================================  =========================================
``GET  /unbake/settings``              設定を読む。**秘密の値は返さない**
``POST /unbake/settings``              設定を書く。空文字を送ると消える
``GET  /unbake/records``               記録の一覧（要約のみ・ページ送り）
``GET  /unbake/record``                記録1件の本体
``GET  /unbake/record-preview``        記録の参照画像（**id でしか引けない**）
``GET  /unbake/record-original``       元画像の原寸（**押されたときだけ1枚取りに行く**）
``GET  /unbake/model-preview``         導入済みモデルの見本画像
                                       （**種類と名前で引く**・パスは受けない）
``GET  /unbake/outputs``               出力画像。``?id=`` で印つきの分、
                                       無ければ**生の値**をページで返す
``POST /unbake/output-raw``            名指しした絵だけ、生の値を返す（**500件まで**）
``POST /unbake/output-delete``         出た絵を1枚消す（**取り消せない**）
``GET  /unbake/raindrop``              「あとで読む箱」の一覧（**読むだけ**）
``GET  /unbake/model-companions``      この系統が本体のほかに要るもの（**落とさない**）
``POST /unbake/download-model-companions`` 足りない伴走を落とす
``GET  /unbake/download-plan``         落とす前に大きさを調べる（**落とさない**）
``POST /unbake/download``              モデルを1つ落とす（**版IDだけを受ける**）
``GET  /unbake/download``              進み具合
``POST /unbake/download-cancel``       取り消す
``POST /unbake/record-save``           記録を1件ディスクへ残す（**上書きしない**）
``POST /unbake/record-delete``         記録を1件消す（**索引が知るパスだけ**）
``GET  /unbake/model-usage``           この名前を使っている記録を数える（**消さない**）
``GET  /unbake/model-delete-plan``     消す対象と合計サイズ（**消さない**）
``POST /unbake/model-delete``          モデルを1つ消す（**取り消せない**）
``GET  /unbake/model-index``           hash と Civitai の id から導入済みモデルを引く索引
``GET  /unbake/civitai-version``       版IDから本当のファイル名と SHA256（**落とさない**）
=====================================  =========================================

**消す口は `POST` にする。** `DELETE` を使わないのは、ComfyUI の前に置かれる
リバースプロキシや拡張が `DELETE` を落とすことがあり、**届かなかったのか
拒まれたのかが呼び手から見分けられない**ため。動詞ではなく経路名で意図を示す。

**パスを受け取る口を作らない。** 参照画像は ``?id=`` で引く。``?path=`` を
受けた瞬間に、それは走査対象の外を読ませる口になる（``../``・UNC・シンボリック
リンク）。塞ぐより、渡さない方が確実である。

**プレフィクスは ``/unbake/``。** フォークの ``/api/lm/`` とも ComfyUI 本体の
``/api/`` とも重ならない——重ねると、どちらが応答したのか判らない不具合が出る。
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .civitai import resolve_version
from .download import ALLOWED_KINDS as ALLOWED_MODEL_KINDS, DownloadError, download_model
from .library import RecordLibrary
from . import model_index
from .models import ModelError, delete as delete_model_file, plan_delete, usage as model_usage
from .records import RecordError, delete_record, save_record
from .model_previews import cached_miss, cached_preview, fetch_preview, still_for
from . import originals
from .outputs import (RAW_KEYS, delete_output, get_output_scanner, read_raw_for,
                      recover_graph)
from .raindrop import list_bookmarks
from .services.recipe_output_index import get_recipe_output_index
from .environment import (
    UnbakeEnvironment,
    has_environment,
    install_environment,
)
from .settings import FileSettings
from .utils.json_io import dumps_json_strict

logger = logging.getLogger(__name__)

#: 参照画像として返してよい型。**中身の型で決める**（拡張子は名乗りにすぎない）。
_CONTENT_TYPES = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    # **見つけられる物は出せること**（2026-09-01・走査10周目）。
    # `library.PREVIEW_SUFFIXES` に在って ここに無い拡張子は、
    # ディスクに在るのに 404 になる。関係は
    # `tests/test_preview_suffixes_agree.py` が留める。
    ".gif": "image/gif",
    # **見つけられる物は出せること**（2026-09-01・走査10周目）。
    # `library.PREVIEW_SUFFIXES` に在って ここに無い拡張子は、
    # ディスクに在るのに 404 になる。関係は
    # `tests/test_preview_suffixes_agree.py` が留める。
}

_settings: Optional[FileSettings] = None
_library: Optional[RecordLibrary] = None


def get_settings() -> FileSettings:
    global _settings
    if _settings is None:
        _settings = FileSettings().load()
    return _settings


def get_library() -> RecordLibrary:
    global _library
    if _library is None:
        _library = RecordLibrary(get_settings())
    return _library


async def _download_file_for_environment(url, save_path, *, progress_callback=None):
    """伴走モデル1本を、**置き先が決まっている**形で落とす。

    `UnbakeEnvironment(download_file=...)` の形（`(bool, 結果)` を返す）に合わせた
    薄い覆いで、中身は `download_model` をそのまま使う——HTML を掴んだときの
    判別・続きからの再開・大きさと hash の照合・上限は**あちらが既に持っている**。

    **`kind` は渡さない。** 伴走の置き場は目録の `folder`（`text_encoders` /
    `ultralytics_bbox` など）で、`ALLOWED_KINDS` には無い。呼び手が
    ComfyUI の `folder_paths` で解決済みなので、その `save_path` をそのまま使う。

    **進みを呼び手へ返す**（2026-09-01・走査5周目で直した）。ここは

        on_progress=(lambda written, total: None) if progress_callback is None else None

    と書いてあった——**条件が逆で、渡された時にだけ捨てていた。**
    `progress_callback` は `known_model_downloader` → `UnbakeEnvironment.download_file`
    と**3層を通って**ここへ届くのに、最後の1行で必ず消えるので、
    **この経路の進みは生まれてから一度も出ていない。**

    **そのまま繋ぐと動かない。** 呼び手の `progress_callback` は
    `Callable[..., Awaitable[None]]`＝**async** で、`download_model` の
    `on_progress` は **worker スレッドから同期で呼ばれる**。素直に渡すと
    「待たれないコルーチン」を作るだけで、やはり進みは出ない（しかも黙る）。
    ループを先に掴んでおいて、スレッドから投げ返す。
    """
    import asyncio

    loop = asyncio.get_running_loop()

    def on_progress(written: int, total: Optional[int]) -> None:
        if progress_callback is None:
            return
        try:
            result = progress_callback(written, total)
            if asyncio.iscoroutine(result):
                # **待たない。** 進みの報せが遅れても取得は続ける。
                asyncio.run_coroutine_threadsafe(result, loop)
        except Exception:
            # **観測側の失敗で本体を止めない**（進みが出なくなるだけにする）。
            logger.debug("companion download progress callback failed", exc_info=True)

    def run():
        return download_model(
            url=str(url),
            kind="",
            filename=os.path.basename(str(save_path)),
            api_key=str(get_settings().get("civitai_api_key", "") or ""),
            target=str(save_path),
            on_progress=on_progress,
        )

    try:
        result = await asyncio.to_thread(run)
    except DownloadError as error:
        return False, str(error)
    return True, result


def install_default_environment() -> None:
    """環境を据える。**据えないと伴走モデルの取得が必ず 500 になる。**

    `D-20260828-01` E2。`install_environment(...)` を呼ぶ場所がどこにも無く、
    `require_environment()` が毎回 `RuntimeError: Unbake: 環境が未設置` を投げていた
    ——Flux / Qwen / Chroma の**全件**で失敗する。しかも画面は
    `downloadable: true` を出すので、**押すと必ず失敗する口が出ていた。**

    **据え直さない。** 検査が自前の環境を入れている間に上書きすると、
    そちらの意図を黙って壊す。
    """
    if has_environment():
        return
    install_environment(UnbakeEnvironment(
        settings=get_settings(),
        download_file=_download_file_for_environment,
    ))


def reset_state() -> None:
    """テストの後始末用。"""
    global _settings, _library
    _settings = None
    _library = None


# -- 各ルートの中身（HTTP から切り離してある）---------------------------
#
# aiohttp の Request/Response を通さずに検査できるようにしてある。
# 通すと、ルートの検査に ComfyUI の起動が要る形になる。


def read_settings() -> Dict[str, Any]:
    settings = get_settings()
    view = settings.public_view()
    return {
        "settings": view,
        "path": str(settings.path),
        # **読めなかったことを黙って既定へ落とさない。**
        "loadError": getattr(settings, "load_error", None),
    }


def write_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {"ok": False, "error": "expected a JSON object"}
    settings = get_settings()
    result = settings.update(payload)
    # 設定が変わったら索引は作り直す。**古い索引を返し続けない**
    # ——「設定したのに変わらない」の正体はたいていこれ。
    global _library
    _library = None
    return {"ok": True, **result, **read_settings()}


def list_records(*, offset: int = 0, limit: int = 200, rescan: bool = False) -> Dict[str, Any]:
    library = get_library()
    if rescan:
        library.scan()
    rows, total = library.summaries(offset=offset, limit=limit)
    return {
        "records": rows,
        "total": total,
        "offset": offset,
        # **読めなかったフォルダを 0件 と混ぜない。**
        "errors": library.scan_errors,
        "sourceDirs": [str(p) for p in library.source_dirs()],
        "outputDir": str(library.output_dir() or ""),
    }


def read_record(record_id: str) -> Optional[Dict[str, Any]]:
    record = get_library().record(record_id)
    if record is None:
        return None
    # **グラフを取り込み損ねた記録を、元の絵から拾い直す。**
    #
    # 実測（2026-08-22）: `ComfyUI_00183_` は記録側の `comfy_prompt` が空で
    # 「再現に必要なチェックポイント情報がありません」と出ていたが、
    # 出どころの PNG は `prompt` チャンクを持っていて checkpoint も入っていた。
    # **取り込み損ねただけで、材料はディスクに残っていた。**
    #
    # **持っている記録には触らない。** 記録が正で、これは欠けたときの拾い直し。
    if not record.get("comfy_prompt") and not record.get("comfy_workflow"):
        recovered = recover_graph(record.get("source_path"))
        if recovered:
            # **拾ってきたことを記録へ残す。** 記録に書いてあった内容と、
            # ファイルから足した内容が同じ顔をしていると、後から追えなくなる。
            record = {**record, **recovered, "unbake_graph_recovered_from": "source-file"}
    # **見本画像の寸法を添える。**
    #
    # 記録に寸法が無いとき、組み立ては見本の縦横比から寸法の枠を選ぶ作りに
    # なっているが、**`preview_size` を作る側がどこにも無かった**——読む側だけが
    # 在って、実際には一度も渡っていなかった（2026-08-24 実測）。
    # そのため寸法の無いレシピは**全部 1024x1024 の正方形**で再現されていた。
    # 実データ `civitai_82283141`: 見本 480x695 → 832x1216（元の絵と同じ）。
    #
    # **元の絵ではなく見本を測る。** 見本は元生成の出力そのもので、
    # 絶対値は hires 後なので当てにならないが、**比率は一次資料**として使える。
    size = _preview_size(record)
    if size:
        record = {**record, "preview_size": size}
    return record


def _preview_size(record: Dict[str, Any]) -> Optional[Dict[str, int]]:
    """記録が指している見本画像の寸法。**読めなければ黙って諦める。**

    ここは補いなので、開けない・壊れている・Pillow が無い、のどれでも
    **記録の取得そのものを失敗させない**（寸法が無いのは今まで通り）。

    **Unbake 自身が書いた記録も見る**（``I-20260830-29``）。

    元は ``file_path`` か ``preview_path`` しか見ていなかった。ところが
    ``preview_path`` は**この repo に書き手が1つも無い幽霊の鍵**で、Unbake が
    書く ``.unbake.json`` は ``file_path`` を持たない——つまり**自分で作った
    記録には辿れる手掛かりがゼロ**だった。材料はディスクに在る（同じ名前の
    画像が隣に在り、``/unbake/record-preview`` はそれを返している）のに、
    読む経路だけが繋がっていなかった。

    結果、寸法の無いレシピは ``resolveTargetSize()`` が手掛かりを全部外して
    **1024x1024 の正方形**へ落ちる。判定は「再現性・高」のまま**縦横比の違う
    別の絵**が出る（``correctTransposedSize()`` も所有記録では永久に発火しない）。

    索引に在る記録の対しか返さない ``Library.preview_path`` へ落とす——
    画面から届くのは id だけなので、``../`` を組み立てる余地はここにも無い。
    """
    path = record.get("file_path")
    if not isinstance(path, str) or not path:
        record_id = record.get("id")
        found = get_library().preview_path(str(record_id)) if record_id else None
        path = str(found) if found else None
    if not isinstance(path, str) or not path:
        return None
    try:
        from PIL import Image  # ComfyUI が同梱している
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        return None
    if not isinstance(width, int) or not isinstance(height, int):
        return None
    if width <= 0 or height <= 0:
        return None
    return {"width": width, "height": height}


def scan_outputs(*, offset: int = 0, limit: int = 200, keys: Optional[List[str]] = None) -> Dict[str, Any]:
    """出力画像の**生の値**を1ページ返す。

    **ここは解釈しない。** 指紋は JS 側の1本の抽出器が計算する
    ——両方に規則を持つと必ず食い違い、しかも「件数が少し違う」形でしか
    表に出ないので、どちらが正しいかを毎回人間が決めることになる。
    """
    selected = tuple(key for key in (keys or []) if key in RAW_KEYS) or None
    return get_output_scanner().page(offset=offset, limit=limit, keys=selected)


#: 版ID → いま引いているもの。**これが唯一の控えである。**
#:
#: 元は `_download` という**最後に始めた1本**を指す大域が別に在り、
#: 「もう1本走っている」の判定に使っていた。**4GB前後のチェックポイントを
#: 何本も待つと1本ずつでは実用にならない**（実測で1件 3.9GB）ので並列にしたが、
#: **`_download` はそのまま残り、応答の一番上へ展開され続けていた。**
#:
#: **これは実際に1度、利用者に見える形で壊れている**（`I-20260830-15`）——
#: 1本ぶんの `bytes` を全体の合計 `totalBytes` で割って「2.0GB / 12.0GB（16%）」
#: と出し（本当は50%）、走行判定も `state`（旧い1本ぶん）を見ていたので
#: **1本目が終わった時点で、残り2本の最中に表示が空文字**になっていた。
#:
#: そのときは**読む側**（`web/panel/panel.js`）を直して逃げた。
#: **作る側を直したのは 2026-08-31**（`I-20260831-66`）——`_download` を消し、
#: 応答には**艦隊ぜんぶの数字しか載せない**。1本ぶんの数字が要るなら
#: `running[]` の中から選ぶ。同じ階層に尺度の違う2つを並べない。
#:
#: **上限を置く。** 無制限に開くと、こちらの回線も相手の側も痛める。
#: 上流（改造版 LoRA Manager）も semaphore で抑えている。
#:
#: **ここに載るのは `start_download` が始めた分だけ。** 伴走モデル
#: （`POST /unbake/download-model-companions`）は `known_model_downloader` を
#: 通るので**ここへ載らず、進みも中断も届かない**（`I-20260901-12`）。
_downloads: Dict[str, Dict[str, Any]] = {}

#: 同時に引く本数の上限。**設定にしない**——押した人が増やせる数字にすると、
#: 「速くならないのに相手へ負荷をかける」方向へ倒す余地ができる。
MAX_PARALLEL_DOWNLOADS = 3

_downloads_lock = threading.Lock()


#: 見本として返してよい型。**記録の参照画像と同じ判断**（拡張子は名乗りにすぎない）。
_PREVIEW_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")


def resolve_model_file(kind: str, name: str) -> Optional[Path]:
    """モデルの実体。**名前の解決は ComfyUI の ``folder_paths`` に任せる。**

    自分でパスを組まない——組むと、そこが走査対象の外を読ませる口になる。
    """
    if kind not in ALLOWED_MODEL_KINDS or not name:
        return None
    try:
        import folder_paths  # type: ignore
    except ImportError:
        return None
    try:
        full = folder_paths.get_full_path(kind, name)
    except Exception:
        full = None
    if full:
        return Path(str(full))

    # **素の名前でも引けるようにする。** `get_full_path()` が受けるのは
    # `/object_info` が配る**完全な相対名**（`Illustrious\anime\x.safetensors`）で、
    # レシピが持っているのは拡張子もフォルダも無い `x` である——実測で
    # **導入済み LoRA 482本のうち399本がサブフォルダの中**なので、
    # そのままでは大半の見本が 404 になる（実機で全件出ていなかった）。
    #
    # **曖昧なときは引かない。** 同じ茎のファイルが2つ在ると
    # （実データに1件ある）、どちらの見本かを勝手に決めることになる。
    try:
        from . import models as model_tools

        found = model_tools.resolve(kind, name)
    except Exception:
        return None
    if found.get("state") != "one" or not found.get("path"):
        return None
    return Path(str(found["path"]))


def model_preview_path(kind: str, name: str) -> Optional[Path]:
    """導入済みモデルの見本画像。**無ければ None**（例外にしない）。

    **上流のものを先に見る。** 見本を網羅的に集めるのは LoRA Manager の仕事で、
    あちらが隣へ置いた ``<名前>.jpeg`` があればそれを出す（完全版が勝つ）。
    無いときだけ、こちらが集めた1枚を出す。
    """
    model = resolve_model_file(kind, name)
    if model is None:
        return None
    for suffix in _PREVIEW_SUFFIXES:
        # LoRA Manager は `<名前>.jpeg` を隣へ置く。`<名前>.preview.png` の形もある。
        for candidate in (model.with_suffix(suffix), model.with_suffix(f".preview{suffix}")):
            if candidate.is_file():
                return candidate
    # **見本が動画しか無いモデルがある。** 実測で checkpoint 9件・LoRA 30件が
    # 動画だけを持っていて、画面では無地になっていた（2026-08-22 利用者の指摘）。
    # 1コマ抜いて画像として置く——動画をそのまま流すと、一覧に何十本も並んで
    # 同時に再生され、選ぶどころではなくなる。**置き場は models の外。**
    still = still_for(kind, name, model)
    if still is not None:
        return still
    # **こちらの取り分は models フォルダの外。** 書き込みで上流とぶつからない。
    return cached_preview(kind, name)


def download_state() -> Dict[str, Any]:
    """進み具合。**走っている全部を返す**（2026-08-26 利用者の報告）。

    元は最後に始めた1本（`_download`）しか返していなかった。並列にしたので
    **3本走っていても1本ぶんしか見えず**、しかもその1本が終わっていると
    「何も走っていない」に見える——「何バイト落ちたのか判らない」の正体。

    **1本ぶんの数字を、この階層へ載せない**（``I-20260831-66``）。
    `_download` の中身をここへ展開していたので、`state` / `bytes` /
    `totalBytes` が**どれか1本の話**なのに全体の話に見えていた。
    1本ぶんが要るなら ``running[]`` から選ぶこと。

    **判らない総量を 0 と混ぜない。** `Content-Length` を返さない相手が
    居るので、総量の判らない本数を別に数えて返す。
    """
    with _downloads_lock:
        running = [dict(item) for item in _downloads.values()
                   if item.get("state") == "running"]
    done_bytes = sum(int(item.get("bytes") or 0) for item in running)
    total_bytes = 0
    unknown = 0
    for item in running:
        total = int(item.get("totalBytes") or 0)
        if total > 0:
            total_bytes += total
        else:
            unknown += 1
    return {
        "running": [
            {
                "versionId": item.get("versionId"),
                "name": item.get("filename") or item.get("name"),
                "bytes": int(item.get("bytes") or 0),
                "totalBytes": int(item.get("totalBytes") or 0) or None,
            }
            for item in running
        ],
        "runningCount": len(running),
        # **走っていないことも、旗ではなく数で言う。** `state: "idle"` のような
        # 1語を戻すと、それが「艦隊の状態」なのか「どれか1本の状態」なのかが
        # また読み手に判らなくなる（`I-20260831-66` で消したのはその形）。
        "doneBytes": done_bytes,
        # **合計には別の名前を付けたままにする**（`I-20260830-15`）。
        #
        # ここは `totalBytes` だったが、当時この階層には `_download` が展開する
        # **1本ぶんの `totalBytes`** も並んでいた。尺度の違う2つが同じ名前で
        # 並ぶと必ず取り違える——実際、トーストが**1本ぶんの済みバイトを
        # 全体の合計で割って**いた（「2.0GB / 12.0GB（16%）」・本当は50%）。
        #
        # **衝突の相手は `I-20260831-66` で消した**（`_download` そのものを
        # 外した）が、名前は戻さない。`totalBytes` は `running[]` の各項が
        # 1本ぶんとして持っており、**同じ綴りを2つの尺度で使わない**。
        "totalBytesAll": total_bytes or None,
        "unknownTotals": unknown,
    }


def start_download(version_id: str, *, kind: Optional[str] = None,
                   model_id: Optional[str] = None) -> Dict[str, Any]:
    """モデルを1つ落とす。**版IDだけを受ける。**

    **画面から URL を受け取らない。** 受け取ると、画面へ細工をした人が
    任意の場所からファイルを落とせる口になる。ここは版IDを Civitai の
    公開 API へ自分で問い合わせ、**返ってきた URL しか使わない**。
    （JS 側にも同じ問い合わせが在るが、あちらは表示のため。
    ここは「何を落としてよいか」を決める境界なので、書き込む側で持つ。）
    """
    key = str(version_id)
    with _downloads_lock:
        # **同じ版を2本走らせない。** 同じ `.part` を2つが書くと、
        # 追記が混ざって**壊れた理由が判らないファイル**ができる。
        if key in _downloads and _downloads[key].get("state") == "running":
            # **「置き場に在る」と同じ種類にしない**（2026-08-26 の読みで直した）。
            # あちらは「もう要らない」、こちらは「いま引いている最中」で、
            # 打つ手が違う。同じ種類にすると、画面はどちらも「既に在る」と数える。
            return {"ok": False, "error": "this version is already downloading",
                    "code": "downloading", "state": dict(_downloads[key])}
        running = sum(1 for item in _downloads.values() if item.get("state") == "running")
        if running >= MAX_PARALLEL_DOWNLOADS:
            return {"ok": False, "error": "too many downloads at once",
                    "code": "busy", "state": {"running": running,
                                              "limit": MAX_PARALLEL_DOWNLOADS}}

    # **鍵を渡す。** 渡していなかったので、早期公開・制限つきの版は
    # *解決の段*で落ちていた（落とす段は同じ鍵を使っている）。
    resolved = resolve_version(
        version_id, kind=kind, api_key=str(get_settings().get("civitai_api_key", "") or ""),
        allow_civarchive=bool(get_settings().get("use_civarchive")),
        model_id=model_id,
    )
    if not resolved.get("ok"):
        return {
            "ok": False,
            "error": resolved.get("error"),
            # **種類を落とさない。** 画面はこれで分類する（文言は訳されると当たらない）。
            "code": resolved.get("code", "unknown"),
        }

    settings = get_settings()
    api_key = str(settings.get("civitai_api_key", "") or "")

    mine = {
        "state": "running",
        "versionId": str(version_id),
        "kind": resolved["kind"],
        "filename": resolved["filename"],
        "bytes": 0,
        "totalBytes": resolved.get("bytes"),
        "canceled": False,
    }
    # **控えは版ごとの1箇所だけ。** 同じ実体を別の大域からも指していたのが
    # `I-20260831-66` の元だった。中断の印はこの実体に立てる。
    with _downloads_lock:
        _downloads[key] = mine

    def progress(written: int, total: Optional[int]) -> None:
        mine["bytes"] = written
        if total:
            mine["totalBytes"] = total

    try:
        result = download_model(
            url=resolved["url"],
            kind=resolved["kind"],
            filename=resolved["filename"],
            sha256=resolved.get("sha256"),
            expected_bytes=resolved.get("bytes"),
            api_key=api_key,
            on_progress=progress,
            # **落とす先の根を渡す**（2026-08-28）。選べるのは ComfyUI が
            # 知っている置き場の中だけで、合う物が無ければ既定へ戻る。
            root=str(get_settings().get("download_root", "") or ""),
            # **自分の実体を見る。** 中断の印はこの1本の控えに立つ。
            should_cancel=lambda: bool(mine.get("canceled")),
        )
    except DownloadError as error:
        # **止めたことを失敗と混ぜない**（2026-08-23 利用者の指示）。押した本人は
        # 止めたことを知っているので、「失敗」と出ると何か壊れたのかと読む。
        # 途中まで書いた `.part` は `download_model` が消している。
        code = getattr(error, "code", "unknown")
        state = "canceled" if code == "canceled" else "failed"
        finished = {**mine, "state": state, "error": str(error), "code": code}
        with _downloads_lock:
            _downloads[key] = finished
        return {"ok": False, "error": str(error), "code": code, "state": dict(finished)}
    except BaseException as error:
        # **枠を握ったまま落ちない**（`D-20260828-01` E3）。
        #
        # 元は `DownloadError` しか受けていなかった。置き場が未作成だと
        # `shutil.disk_usage` が `FileNotFoundError` を投げてここを素通りし、
        # **`_downloads[key]` は永久に `running` のまま**残る。走行枠は
        # `MAX_PARALLEL_DOWNLOADS` 本しか無いので、**3回起きると以後は
        # `busy` しか返らない**——ComfyUI を再起動するまで1本も落とせない。
        # しかも画面には「取得中」と出続けるので、詰まっていることが判らない。
        #
        # `BaseException` で受けるのは、`KeyboardInterrupt` や
        # `SystemExit` でも枠を返す必要があるため。**握り潰さずに投げ直す。**
        with _downloads_lock:
            _downloads[key] = {**mine, "state": "failed",
                               "error": str(error) or type(error).__name__,
                               "code": "unexpected"}
        raise

    finished = {**mine, "state": "done", **result}
    with _downloads_lock:
        _downloads[key] = finished
    return {"ok": True, **result, "state": dict(finished)}


def cancel_download(version_id: Optional[str] = None) -> Dict[str, Any]:
    """中断を頼む。**版IDを渡さなければ、走っている全部に頼む。**

    画面の「止める」は1つしか無いので、既定は全部にする——**1本だけ止まって
    残りが走り続ける**と、押した人からは止まっていないように見える。

    **印を立てるのは走っている控えだけ**（``I-20260831-66``）。以前はここで
    `_download["canceled"] = True` も書いていたが、`_download` が指すのは
    **最後に状態が変わった1本**なので、直前に1本終わっていると
    **終わった控えに「中断された」と書く**ことになっていた。下の輪で
    走っているものへは正しく立つので、あの行は余計でしかなかった。
    """
    stopped = []
    with _downloads_lock:
        for key, item in _downloads.items():
            if version_id is not None and key != str(version_id):
                continue
            if item.get("state") == "running":
                item["canceled"] = True
                stopped.append(key)
    return {"ok": True, "canceled": True, "stopped": stopped}


def raindrop_bookmarks(
    *, page: int = 0, collection: Optional[str] = None, all_pages: bool = False,
) -> Dict[str, Any]:
    """「あとで読む箱」を一覧する。**鍵はここから外へ出さない。**

    書庫に既に在る画像 ID を一緒に返すので、画面は「未取り込み」を
    自分で計算できる（サーバは判断しない——**判定を2箇所に置かない**）。
    """
    settings = get_settings()
    token = str(settings.get("raindrop_token", "") or "")
    result = list_bookmarks(
        token=token,
        collection_id=collection or str(settings.get("raindrop_collection_id", "") or "0"),
        page=page,
        all_pages=all_pages,
    )
    library = get_library()
    rows, _total = library.summaries(offset=0, limit=100000)
    result["knownImageIds"] = sorted({
        str(row["civitai_image_id"]) for row in rows if row.get("civitai_image_id")
    })
    return result


def decode_preview_data(value) -> Optional[bytes]:
    """画面が送ってきた ``data:`` を、バイト列へ直す。**読めなければ `None`。**

    **中身は確かめない。** それは :func:`records.store_preview` の仕事で、
    あちらが**バイト列の先頭**で画像かどうかを決める——ここで名乗り
    （``data:image/png``）を信じて通すと、名乗りだけ変えた別物が入る。

    大きさもここでは切らない（同じ理由で、決めるのは書く側1箇所）。
    """
    if not isinstance(value, str) or not value.startswith("data:"):
        return None
    marker = value.find("base64,")
    if marker < 0:
        return None
    try:
        return base64.b64decode(value[marker + len("base64,"):], validate=True)
    # `binascii.Error` は `ValueError` の一種なので、これで両方入る
    # （import を1つ増やさずに済む）。
    except ValueError:
        return None


def save_one_record(
    recipe: Dict[str, Any],
    preview_url: Optional[str] = None,
    preview_data: Optional[str] = None,
    replace: bool = False,
) -> Dict[str, Any]:
    """記録を1件ディスクへ残す（`I-20260821-03`）。

    **これが無いと、取り込んだ記録は再読み込みで消える。** Civitai や
    「あとで読む箱」から入れたものは画面の中にしか無く、口が1つも無かった。

    書いたら**索引へも足す**——書いた直後に一覧から消える（次の走査まで出てこない）
    のは、保存できていないのと見分けが付かない。
    """
    library = get_library()
    result = save_record(
        get_settings(), recipe,
        preview_url=preview_url,
        preview_bytes=decode_preview_data(preview_data),
        replace=replace,
    )
    if result.get("ok"):
        library.scan()
    return result


def delete_one_record(record_id: str) -> Dict[str, Any]:
    """記録を1件消す。**索引が知っているパスしか消さない。**

    LoRA Manager が書いた記録も消せる（2026-08-21 ユーザー決定）。ただし
    **向こうの DB からは消えない**ので、稼働中の LoRA Manager には
    再スキャンするまで残って見える——その旨は画面が伝える。
    """
    library = get_library()
    result = delete_record(library, get_settings(), record_id)
    library.forget(record_id)
    return result


def record_outputs(record_id: str, *, refresh: bool = True) -> Dict[str, Any]:
    """**印が焼かれている**出力だけを、記録の id で引く。

    こちらは指紋を使わない確実な経路で、**自分が Sweep で回した分**がここに貯まる
    （新しい環境でも2回目の実験から効く）。過去の画像を拾うのは指紋の側の仕事。
    """
    if not record_id:
        return {"outputs": [], "total": 0}
    outputs = get_recipe_output_index().get_outputs(record_id, refresh=refresh)
    return {"outputs": outputs, "total": len(outputs)}


def companion_download_result(entry: Any, outcome: Dict[str, Any]) -> Dict[str, Any]:
    """伴走モデル1本の取得結果を、画面が読む形へ直す。

    このファイルの決めごとどおり、**HTTP から切り離してある**——
    `POST /unbake/download-model-companions` はこれを呼ぶだけ。

    **大きさが台帳と違うことを捨てない**（2026-09-01・走査7周目）。
    `known_model_downloader._size_warning` は「落とした物の大きさが台帳と
    5% 以上ずれている」を計算して `size_warning` に載せる——**中身が違う物を
    掴んだかもしれない**という唯一の合図で、削除はせず警告に留める設計になっている。
    ところが**ここが落としていた**ので、repo 全体で読み手が0件だった
    （サーバの `logger.warning` にしか残らず、画面からは見えない）。
    伴走モデルは数GBなので、掴み直しの判断材料がここしか無い。
    `tests/produced_signal_is_consumed_test.mjs` が留めている型そのもの
    （作る側は正しく、唯一の受け手が捨てる）。
    """
    return {
        "key": entry.key,
        "filename": entry.filename,
        "ok": bool(outcome.get("success")),
        "skipped": bool(outcome.get("skipped")),
        "reason": outcome.get("reason"),
        "error": outcome.get("error"),
        "pageUrl": outcome.get("page_url"),
        "sizeWarning": outcome.get("size_warning"),
        "bytes": outcome.get("size_bytes"),
        "expectedBytes": outcome.get("expected_size_bytes"),
    }


def civitai_version_view(version_id: str, *, kind: Optional[str] = None) -> Dict[str, Any]:
    """版IDから、**本当のファイル名と SHA256** を引いた応答本文（落とさない）。

    このファイルの決めごとどおり、**HTTP から切り離してある**——
    `GET /unbake/civitai-version` はこれを呼ぶだけ。切り離す前は口の中で
    組み立てていたので、**応答の形を検査から一度も当てられなかった**
    （実際に `code` が抜けていたのを誰も捕まえなかった・2026-09-01）。

    **取れなかったことを「存在しない」と混ぜない。** 理由は `ok: False` と
    `code` で返し、HTTP は 200 のまま（呼び手が「引けなかった1件」として数える）。
    """
    version_id = str(version_id or "").strip()
    if not version_id.isdigit():
        return {"ok": False, "error": "id must be a number", "code": "setup"}

    api_key = str(get_settings().get("civitai_api_key", "") or "")
    resolved = resolve_version(version_id, kind=kind or None, api_key=api_key)
    if not resolved.get("ok"):
        # **種類も返す**（2026-09-01・走査5周目）。ここは `error`（英語の文）だけを
        # 返していたが、**読み手は既に `code` を見ていた**——`web/unbake.js` の
        # `if (body?.code === 'rate_limited')` は「**上限に当たったことは言う。
        # 黙ると『版が消えた』と読まれる**」という注記つきで書かれているのに、
        # **作る側が一度も載せていなかったので、この分岐は生まれてから一度も
        # 発火していない。** 上限に当たった版は黙って「引けなかった1件」へ落ち、
        # 注記が防ごうとしていた誤読がそのまま起きていた。
        #
        # 同じ解決器の `code` を `start_download` は「**種類を落とさない。**
        # 画面はこれで分類する（文言は訳されると当たらない）」と明記して
        # 保持している——**同じ値の扱いが口ごとに割れていた。**
        #
        # `tests/produced_signal_is_consumed_test.mjs` では捕まらない。
        # あれが見るのは「**作る側が載せた鍵に読み手が居るか**」で、ここは
        # **読み手が居る鍵を作る側が載せていない**という逆向きだから。
        return {
            "ok": False,
            "error": resolved.get("error"),
            "code": resolved.get("code", "unknown"),
            # 待てば通るものは、あと何秒かを渡す（`resolve_version` が計算済み）。
            "retryAfter": resolved.get("retryAfter"),
        }
    return {
        "ok": True,
        "versionId": version_id,
        "filename": resolved.get("filename"),
        "kind": resolved.get("kind"),
        "sha256": resolved.get("sha256"),
        "bytes": resolved.get("bytes"),
        "name": resolved.get("name"),
        "modelName": resolved.get("modelName"),
        "baseModel": resolved.get("baseModel"),
    }


# -- ComfyUI への登録 ----------------------------------------------------


def register_routes() -> bool:
    """``PromptServer`` へ登録する。**ComfyUI の外では何もしないで False。**

    ここで例外を投げると、ComfyUI の起動そのものが止まる。設定画面が出ない
    ことより起動が止まる方がはるかに困るので、登録できなかったことは
    戻り値で伝えて、拡張の残り（パネル）は動かす。
    """
    try:
        from server import PromptServer  # type: ignore[import-not-found]
        from aiohttp import web  # type: ignore[import-not-found]
    except ImportError:
        return False

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None:
        return False

    def json_response(payload, status=200):
        """**`NaN` / `Infinity` を本文へ出さない**（2026-09-01・走査9周目）。

        `web.json_response` の既定は `json.dumps`＝`allow_nan=True` なので、
        **非有限の float がそのまま `NaN` として本文へ出る**。JSON にその
        literal は無いので、ブラウザの `JSON.parse` は
        `Unexpected token 'N'` で落ちる——**記録が1件も開けなくなる。**

        **絵空事ではない。** `unbake/utils/json_io.py` が実測を書いている:
        毎回実行し直したいノード（WAS Node Suite のテキスト系・`WidgetToString`）は
        `IS_CHANGED` を `float('nan')` で返し、その値が画像のメタデータから
        `*.recipe.json` へそのまま渡って、**手元の346件中2件が Python の外から
        読めなくなっていた**。`read_record` は `recover_graph` で PNG の
        `prompt` チャンクを `json.loads` するので（**`json.loads` は `NaN` を
        受ける**）、同じ値がこの口からも出る。

        しかも `json_io.py` は「**The API layer already guards itself
        (`recipe_handlers._json_safe`)**」と書いていたが、
        **`recipe_handlers` はこのリポジトリに無い**（フォークの名前）——
        つまり**守られていると書いてあるだけで、守る物が無かった**。
        書き込み側（`records.py` / `settings.py` ほか）は
        `dump_json_strict` を通しているので、抜けていたのは HTTP の口だけ。
        """
        return web.json_response(payload, status=status, dumps=dumps_json_strict)

    # **環境を据えるのはここ**（`D-20260828-01` E2）。据える場所がどこにも無く、
    # 伴走モデルの取得が**全件 500** を返していた。口を登録する側と同じ場所で
    # 据えれば、口が在るのに環境が無い、という組み合わせが起こらない。
    install_default_environment()

    # **ディスクを触る口は `to_thread` を通す**（`I-20260831-60`）。
    # `READ.md` の守りごと5がそう宣言しているのに、25の口のうち14が
    # 通っていなかった。守る機械は `tests/test_event_loop_handlers.py`。
    @routes.get("/unbake/settings")
    async def _get_settings(_request):
        return json_response(await asyncio.to_thread(read_settings))

    @routes.post("/unbake/settings")
    async def _post_settings(request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        result = await asyncio.to_thread(write_settings, payload)
        return json_response(result, status=200 if result.get("ok") else 400)

    @routes.get("/unbake/records")
    async def _get_records(request):
        def _int(name: str, fallback: int) -> int:
            try:
                return int(request.query.get(name, fallback))
            except (TypeError, ValueError):
                return fallback

        import asyncio

        # **本体のイベントループの上で走らせない**（`D-20260828-01` 群D）。
        # 初回は `fill_base_models()` → `model_index.build()` が走り、実測 5〜6秒。
        # `MAX_FILES=20000` に近い環境では数十秒——その間 ComfyUI の
        # `/prompt` も進捗の WebSocket もキュー表示も**全部返らない。**
        # このファイルは既に7箇所で `to_thread` を使っている。同じ形にする。
        return json_response(await asyncio.to_thread(
            list_records,
            offset=_int("offset", 0),
            limit=max(1, min(1000, _int("limit", 200))),
            rescan=request.query.get("rescan") == "1",
        ))

    @routes.get("/unbake/record")
    async def _get_record(request):
        record_id = request.query.get("id", "")
        # **ここが一番重い**（`I-20260831-60`）。未走査なら `_ensure()` が
        # 全件走査へ落ち、`routes.py` 自身が「初回は 5〜6秒」と測っている。
        # ほかに `recover_graph` の PNG チャンク読みと `PIL.Image.open` も通る。
        record = await asyncio.to_thread(read_record, record_id)
        if record is None:
            return json_response({"error": "not found", "id": record_id}, status=404)
        return json_response(record)

    @routes.get("/unbake/outputs")
    async def _get_outputs(request):
        import asyncio

        record_id = request.query.get("id", "")
        if record_id:
            # **既定では数え直さない**（`D-20260828-01` 群D）。
            #
            # `recipe_output_index.get_outputs()` の `refresh` は既定 True で、
            # 出力フォルダ全体を `os.walk` して**全ファイルの `getmtime` を取る**
            #（実測 4,851枚で初回 2,891ms・差分でも 187ms）。ここの既定も
            # `!= "0"` ＝ True だったので、**呼べば必ず全件 stat していた。**
            # 更新が要る呼び手（再現の直後・Sweep の開始時）は `refresh=1` を付ける。
            return json_response(await asyncio.to_thread(
                record_outputs,
                record_id,
                refresh=request.query.get("refresh") == "1",
            ))

        def _int(name: str, fallback: int) -> int:
            try:
                return int(request.query.get(name, fallback))
            except (TypeError, ValueError):
                return fallback

        raw_keys = [key for key in request.query.get("keys", "").split(",") if key]
        # **実測で一番重い口。** 出力 4,851枚で約45秒、その間すべての HTTP が返らない。
        return json_response(await asyncio.to_thread(
            scan_outputs,
            offset=_int("offset", 0),
            limit=max(1, _int("limit", 200)),
            keys=raw_keys or None,
        ))

    @routes.post("/unbake/output-raw")
    async def _post_output_raw(request):
        """**名指しした絵だけ**、生の値を返す（`I-20260829-01`）。

        起動時の走査は印だけを取る（`prompt` は転送の 97% を占めるのに、実データで
        帰属を1件も増やしていなかった）。画面の「何が違うか」は `prompt` から出るので、
        **記録を開いた時に、その記録の絵のぶんだけ**ここで読む。

        **どの絵が要るかは画面が決める。** サーバ側の帰属（印での照合）に頼ると、
        名前で帰属した絵が漏れる——帰属の規則は JS 側の1本が持っている。

        読む場所は出力フォルダの中だけ（`read_raw_for` が実際のパスで確かめる）。
        """
        import asyncio

        try:
            payload = await request.json()
        except Exception:
            return json_response({"error": "bad json"}, status=400)
        items = payload.get("items")
        if not isinstance(items, list):
            return json_response({"error": "items must be a list"}, status=400)
        # **上限を置く。** 1回の求めで走査全体ぶんを開かせない。
        if len(items) > 500:
            return json_response({"error": "too many items", "limit": 500}, status=400)
        keys = payload.get("keys")
        keys = [key for key in keys if isinstance(key, str)] if isinstance(keys, list) else None
        found = await asyncio.to_thread(read_raw_for, items, keys)
        return json_response({"raw": found, "keys": list(keys or RAW_KEYS)})

    @routes.post("/unbake/record-save")
    async def _post_record_save(request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        recipe = payload.get("record") if isinstance(payload, dict) else None
        if not isinstance(recipe, dict):
            return json_response({"ok": False, "error": "no record"}, status=400)
        try:
            # 書き込みに加えて `library.scan()` の全件走査が走る（`I-20260831-60`）。
            result = await asyncio.to_thread(
                save_one_record,
                recipe, payload.get("previewUrl"), payload.get("previewData"),
                # **頼まれたときだけ置き換える**（2026-08-26 利用者の検証で必要になった）。
                # 既定は今までどおり「上書きしない」。
                replace=bool(payload.get("replace")),
            )
        except RecordError as error:
            return json_response({"ok": False, "error": str(error)}, status=400)
        # **「既に在る」は失敗ではない。** 呼び手が数を分けられるよう 200 で返す。
        return json_response(result, status=200)

    @routes.post("/unbake/record-delete")
    async def _post_record_delete(request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        record_id = str((payload or {}).get("id") or "").strip()
        try:
            result = await asyncio.to_thread(delete_one_record, record_id)
        except RecordError as error:
            return json_response({"ok": False, "error": str(error)}, status=400)
        return json_response(result, status=200)

    @routes.post("/unbake/output-delete")
    async def _post_output_delete(request):
        """出た絵を1枚消す（2026-08-25 利用者の指示）。

        **取り消しは面が持つ。** 猶予のあいだ呼ばないだけで、ここへ着いたら戻せない
        ——だから置き場の外は `delete_output` が断る。
        """
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        body = payload or {}
        result = await asyncio.to_thread(
            delete_output,
            str(body.get("filename") or ""),
            str(body.get("subfolder") or ""),
        )
        # **断ったことを 200 で返さない。** 呼び手が成功と読む。
        return json_response(result, status=200 if result.get("ok") else 400)

    @routes.get("/unbake/model-usage")
    async def _get_model_usage(request):
        name = request.query.get("name") or ""
        if not name.strip():
            return json_response({"ok": False, "error": "no name"}, status=400)
        # 索引を引くだけに見えるが、未走査なら `get_library()` が全件走査へ落ちる。
        usage = await asyncio.to_thread(lambda: model_usage(get_library(), name))
        return json_response({"ok": True, **usage}, status=200)

    @routes.get("/unbake/model-delete-plan")
    async def _get_model_delete_plan(request):
        kind = request.query.get("kind") or ""
        name = request.query.get("name") or ""
        try:
            plan = await asyncio.to_thread(plan_delete, kind, name)
        except ModelError as error:
            return json_response({"ok": False, "error": str(error)}, status=400)
        # **使用件数を必ず添える。** 実測で1つの checkpoint を39件が共有している。
        usage = await asyncio.to_thread(lambda: model_usage(get_library(), name))
        return json_response({**plan, "usage": usage}, status=200)

    @routes.post("/unbake/model-delete")
    async def _post_model_delete(request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        kind = str((payload or {}).get("kind") or "").strip()
        name = str((payload or {}).get("name") or "").strip()
        try:
            import asyncio

            # 大きなファイルの unlink は待たせうるので、口そのものは塞がない。
            result = await asyncio.to_thread(delete_model_file, kind, name)
        except ModelError as error:
            return json_response({"ok": False, "error": str(error)}, status=400)
        return json_response(result, status=200)

    @routes.get("/unbake/model-index")
    async def _get_model_index(request):
        """名前で引けないモデルを、**hash と Civitai の id** から引くための索引。

        **記録の名前が手元のファイル名とは限らない。** 実測で、人間が「再現できた」と
        記録しているのに「再現不可」と出ていた2件が、どちらもこれだった。

        置いているのは LoRA Manager なので、**入れていない環境では空になる**
        ——件数を一緒に返して、呼び手が「索引が空だった」と言えるようにする。
        """
        refresh = str(request.query.get("refresh", "")).lower() in ("1", "true", "yes")
        import asyncio

        # 走査なので別スレッドで回す（口そのものは塞がない）。
        index = await asyncio.to_thread(model_index.get, refresh)
        return json_response({"ok": True, **index}, status=200)

    @routes.get("/unbake/civitai-version")
    async def _get_civitai_version(request):
        """版IDから、**本当のファイル名と SHA256** を引く（落とさない）。

        **プロンプトの表記は手元のファイル名ではない。** 実測（利用者の画像1件・
        4件を照合）で、`<lora:ZodaPlus:1>` の実体は `zodaplus_v1_anima.safetensors`
        だった——名前で探すと**在るのに見つからない**。版IDなら一意に決まり、
        SHA256 まで付いてくるので、名前を変えて置いてあっても索引から引ける。

        **落とす口とは分ける。** あちらは走らせると数GBを書く。こちらは読むだけで、
        `downloadUrl` も返さない——画面へ渡すと、そこが任意の場所から引く口になる。
        """
        # **中身は `civitai_version_view` が持つ**（HTTP から切り離す決めごと）。
        # 外への問い合わせなので別スレッドで回す（口そのものは塞がない）。
        body = await asyncio.to_thread(
            civitai_version_view,
            request.query.get("id", ""),
            kind=request.query.get("kind") or None,
        )
        # **引けなかったことは 200 で返す**（呼び手が理由で数えられるように）。
        # 引数そのものが不正な時だけ 400。
        status = 400 if body.get("code") == "setup" and not body.get("ok") else 200
        return json_response(body, status=status)

    @routes.get("/unbake/raindrop")
    async def _get_raindrop(request):
        def _int(name: str, fallback: int) -> int:
            try:
                return int(request.query.get(name, fallback))
            except (TypeError, ValueError):
                return fallback

        # **外へ往復する。** イベントループに載せると、待つあいだ
        # ComfyUI 全体が止まる（`I-20260831-60`）。
        result = await asyncio.to_thread(
            raindrop_bookmarks,
            page=_int("page", 0),
            collection=request.query.get("collection") or None,
            # **全部読むのは頼まれたときだけ。** 箱が大きいと外への往復が増える
            # ——既定を全部にすると、開くたびに待たされる。
            all_pages=str(request.query.get("all", "")).lower() in ("1", "true", "yes"),
        )
        return json_response(result, status=200 if result.get("ok") else 400)

    @routes.post("/unbake/download")
    async def _post_download(request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        version_id = str(payload.get("versionId") or "").strip()
        if not version_id.isdigit():
            return json_response({"ok": False, "error": "versionId must be a number"}, status=400)
        # **重い。** 別スレッドで回して、口そのものは塞がない。
        import asyncio

        result = await asyncio.to_thread(
            start_download, version_id, kind=payload.get("kind") or None,
            model_id=str(payload.get("modelId") or "").strip() or None
        )
        return json_response(result, status=200 if result.get("ok") else 400)

    @routes.get("/unbake/model-companions")
    async def _get_model_companions(request):
        """この系統が、拡散モデル本体のほかに何を要るのかを返す。**落とさない。**

        **チェックポイントだけ落としても、何も動かない系統がある。**
        Civitai は Flux / Qwen-Image / HiDream / Chroma / Z-Image / Krea 2 /
        Anima について拡散モデルしか配らないので、テキストエンコーダと VAE は
        別に要る。しかも**落とし終わってから初めて足りないと判る**
        ——押す前に総量を出せないと、2往復めが必ず要る。

        目録（`known_model_catalog`）と取得（`known_model_downloader`）は
        以前から在ったが、**この口が無いので画面から一度も届いていなかった**
        （2026-08-26 の到達性の棚卸しで判明）。
        """
        from .services.known_model_catalog import companions_for, knows_companions
        from .services.known_model_downloader import find_installed_path

        base_model = str(request.query.get("baseModel", "")).strip()
        if not base_model:
            return json_response({"ok": False, "error": "baseModel is required"}, status=400)

        entries = companions_for(base_model)
        companions = []
        for entry in entries:
            # **`find_installed_path` は置き場を `os.walk` で全走査する**
            # （`known_model_downloader.py`）。置き場が大きい人ではここで
            # 画面が固まる（`I-20260831-56` / `I-20260831-60`）。
            installed = await asyncio.to_thread(
                find_installed_path, entry.folder, entry.filename)
            companions.append({
                "key": entry.key,
                "filename": entry.filename,
                "folder": entry.folder,
                "bytes": entry.size_bytes,
                "installed": bool(installed),
                # **手で入れるしかないものを、落とせるものと混ぜない。**
                # 混ぜると「押したのに来ない」になる。
                "downloadable": bool(entry.downloadable and entry.url),
                "pageUrl": entry.page_url,
                "license": entry.license,
            })
        missing = [item for item in companions if not item["installed"]]
        return json_response({
            "ok": True,
            "baseModel": base_model,
            # **「表に無い」を「何も要らない」と言わない**（2026-08-31・走査3周目）。
            #
            # 実測で、UNet で読む＝本体だけでは動かないと判定している 42 系統の
            # うち **26 が伴走の表に無い**（`Wan Video` 系・`LTXV`・`Hunyuan Video`・
            # `PixArt`・`Kolors` ほか）。表に無いと `companions_for` は空を返し、
            # そのまま `missingCount: 0` になって、画面は**「何も要りません」**と読む。
            # `I-20260830-17`（「読めなかった」と「0個」を混ぜない）と同じ話なので、
            # 画面が同じ扱いへ寄せられるように旗を渡す。
            "known": knows_companions(base_model),
            "companions": companions,
            "missingCount": len(missing),
            # **判らない大きさを 0 と混ぜない。** 混ぜると総量が実際より小さく出る。
            "missingBytes": sum(item["bytes"] for item in missing if isinstance(item["bytes"], int)),
            "missingUnknown": sum(1 for item in missing if not isinstance(item["bytes"], int)),
        })

    @routes.post("/unbake/download-model-companions")
    async def _post_download_model_companions(request):
        """足りない伴走を落とす。**系統名しか受けない**（URL もパスも受けない）。

        落とし先は目録が持っている `folder` から ComfyUI に決めさせる
        ——呼び手が置き場を指せる口にすると、そこが任意の場所へ書ける口になる。
        """
        from .services.known_model_catalog import companions_for
        from .services.known_model_downloader import download_known_model, find_installed_path

        try:
            payload = await request.json()
        except Exception:
            payload = {}
        base_model = str((payload or {}).get("baseModel") or "").strip()
        if not base_model:
            return json_response({"ok": False, "error": "baseModel is required"}, status=400)

        results = []
        for entry in companions_for(base_model):
            if await asyncio.to_thread(find_installed_path, entry.folder, entry.filename):
                results.append({"key": entry.key, "filename": entry.filename,
                                "ok": True, "skipped": True, "reason": "already_installed"})
                continue
            outcome = await download_known_model(entry.key)
            results.append(companion_download_result(entry, outcome))
        # **1本でも落ちなければ ok にしない。** 成功として報せると、
        # 残りに気づけないまま「動かない」に戻る。
        return json_response({
            "ok": all(item["ok"] for item in results) if results else True,
            "baseModel": base_model,
            "companions": results,
        })

    @routes.get("/unbake/download-plan")
    async def _get_download_plan(request):
        """落とす前に、何をどれだけ引くのかを調べる。**1バイトも落とさない。**

        **これが無いと、押した人は総量を知らずに始めることになる。** 実測で、
        19件の待ち行列の10本目が **34 GB のチェックポイント**だった
        （2026-08-20・止めるまで気づけなかった）。大きさは Civitai の公開 API が
        持っているので、落とす前に**同じ解決器で**引くだけでよい。
        """
        raw = str(request.query.get("versionIds", "")).strip()
        ids = [item for item in (part.strip() for part in raw.split(",")) if item.isdigit()]
        if not ids:
            return json_response({"ok": False, "error": "versionIds must be numbers"}, status=400)
        # **数を切る。** 一覧のたびに何百本も外へ問い合わせない。
        ids = ids[:60]

        import asyncio

        # **鍵を渡す。** 落とす側と同じ——渡さないと、早期公開・制限つきの版が
        # 「調べられない」に落ちて、総量が実際より小さく出る。
        api_key = str(get_settings().get("civitai_api_key", "") or "")

        def resolve_all():
            out = []
            for version_id in ids:
                resolved = resolve_version(version_id, api_key=api_key)
                if resolved.get("ok"):
                    out.append({
                        "versionId": version_id,
                        "name": resolved.get("name"),
                        "filename": resolved.get("filename"),
                        "kind": resolved.get("kind"),
                        "bytes": resolved.get("bytes"),
                        # **系統を返す。** 伴走（テキストエンコーダ・VAE）が
                        # 要るかは系統でしか判らず、これが無いと押す前の総量に
                        # 入れられない——落とし終わってから足りないと判ることになる。
                        "baseModel": resolved.get("baseModel"),
                        "error": None,
                    })
                else:
                    # **調べられなかったことを、大きさ0と混ぜない。**
                    out.append({
                        "versionId": version_id, "name": None, "filename": None,
                        "kind": None, "bytes": None, "baseModel": None,
                        "error": resolved.get("error"),
                    })
            return out

        items = await asyncio.to_thread(resolve_all)
        known = [item["bytes"] for item in items if isinstance(item.get("bytes"), int)]
        return json_response({
            "ok": True,
            "items": items,
            "bytes": sum(known),
            "resolved": len(known),
            "unknown": len(items) - len(known),
        })

    @routes.get("/unbake/download")
    async def _get_download(_request):
        return json_response(download_state())

    @routes.post("/unbake/download-cancel")
    async def _post_download_cancel(_request):
        return json_response(cancel_download())

    @routes.get("/unbake/model-preview")
    async def _get_model_preview(request):
        """導入済みモデルの見本画像。**種類と名前でしか引けない。**

        **なぜ要るか。** 差し替えの軸に並ぶのはファイル名だけで、
        `hassakuXLIllustrious_v13.safetensors` と `waiNSFWIllustrious_v110.safetensors`
        のどちらが欲しい絵かは**名前からは判らない**。選ぶ材料が無いまま
        4枚生成して見比べる、が今までの姿だった。

        **パスは受け取らない。** 名前は ComfyUI 自身の解決器
        （``folder_paths.get_full_path``）へ渡す——導入済みの一覧に無い名前は
        そこで落ちるので、``../`` を組み立てる余地が無い。

        見本は**モデルの隣に同じ名前で置かれた画像**（LoRA Manager が置いていく形）。
        無ければ 404 で、画面は名前だけで並べる。
        """
        kind = str(request.query.get("kind", "")).strip()
        name = str(request.query.get("name", "")).strip()
        path = await asyncio.to_thread(model_preview_path, kind, name)
        if path is None:
            return web.Response(status=404)
        content_type = _CONTENT_TYPES.get(path.suffix.lower())
        if content_type is None:
            return web.Response(status=404)
        try:
            # **何十枚も並ぶ。** 1枚ずつ丸ごと同期で読むと、その間ずっと
            # イベントループが止まる（`I-20260831-60`）。
            body = await asyncio.to_thread(path.read_bytes)
        except OSError:
            return web.Response(status=404)
        # **見本は変わらない。** 何十枚も並ぶので、毎回取り直させない。
        return web.Response(body=body, content_type=content_type,
                            headers={"Cache-Control": "public, max-age=3600"})

    @routes.post("/unbake/model-preview")
    async def _post_model_preview(request):
        """見本が無いモデルのぶんを、**1枚だけ**取りに行く。

        **役割分担。** 網羅的に集めるのは LoRA Manager の仕事で、ここがやるのは
        画面で今まさに要る1枚だけ。**models フォルダへは1バイトも書かない**ので、
        あちらのダウンロードとぶつからない（置き場は user ディレクトリの下）。

        **動画は見本にしない。** Civitai の見本は先頭が動画のことがあり、
        ``<img>`` へ入れても何も出ない——静止画だけを選ぶ。
        """
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            return json_response({"ok": False, "error": "invalid JSON"}, status=400)
        kind = str(payload.get("kind", "")).strip()
        names = payload.get("names")
        if not isinstance(names, list):
            names = [payload.get("name")]
        names = [str(item).strip() for item in names if str(item or "").strip()]
        if not names:
            return json_response({"ok": False, "error": "name is required"}, status=400)
        # **数を切る。** 画面から一度に何百本も外へ問い合わせない。
        names = names[:12]

        settings = get_settings()
        api_key = str(settings.get("civitai_api_key", "") or "")

        import asyncio

        def collect():
            out = []
            for name in names:
                if model_preview_path(kind, name) is not None:
                    out.append({"name": name, "ok": True, "from": "already"})
                    continue
                if cached_miss(kind, name):
                    # 探して無かったことを覚えている（動画しか無いモデルなど）。
                    out.append({"name": name, "ok": False, "error": "no-still-image"})
                    continue
                model = resolve_model_file(kind, name)
                if model is None:
                    out.append({"name": name, "ok": False, "error": "not-installed"})
                    continue
                result = fetch_preview(kind, name, model, api_key=api_key)
                out.append({"name": name, **result})
            return out

        items = await asyncio.to_thread(collect)
        return json_response({
            "ok": True,
            "items": items,
            "fetched": sum(1 for item in items if item.get("ok") and item.get("from") == "civitai"),
        })

    @routes.get("/unbake/record-original")
    async def _get_original(request):
        """元画像の**原寸**。手元のサムネイル（実測 480x701）では小さいため。

        **押されたときだけ取りに行く。** 一覧のために346件を落とすと、
        Civitai への問い合わせが346回走る。一度取ったら取り直さない。

        取れないことは普通に起きる（消された・年齢制限・鍵が要る）ので、
        そのときは 404 を返す——画面はサムネイルのままにする。
        """
        record_id = str(request.query.get("id", "")).strip()
        library = get_library()
        row = library.raw_row(record_id)
        if row is None:
            return web.Response(status=404)
        # **出どころは本体から取る。** 要約は `source_path` を持たない
        # （持っているのは `civitai_image_id` だけで、`.red` / `.com` の別が落ちている
        # ——手元の出典は326/340件が `.red` なので、既定へ丸めると別ドメインへ行く）。
        body = library.record(record_id) or {}
        source_path = body.get("source_path")

        settings = get_settings()
        api_key = str(settings.get("civitai_api_key", "") or "")
        import asyncio

        # 外への問い合わせと数MBの読み込みなので、口そのものは塞がない。
        result = await asyncio.to_thread(
            originals.get, record_id, source_path, api_key,
        )
        if not result.get("ok"):
            return json_response({"ok": False, "error": result.get("error")}, status=404)
        path = Path(str(result["path"]))
        content_type = _CONTENT_TYPES.get(path.suffix.lower())
        if content_type is None:
            return web.Response(status=404)
        try:
            body = path.read_bytes()
        except OSError:
            return web.Response(status=404)
        # **原寸は変わらない。** 一度取ったら取り直させない。
        return web.Response(body=body, content_type=content_type,
                            headers={"Cache-Control": "public, max-age=86400"})

    @routes.get("/unbake/record-preview")
    async def _get_preview(request):
        # **id でしか引けない。** パスは受け取らないので、走査した記録の
        # 隣に在るファイル以外は原理的に返らない。
        record_id = request.query.get("id", "")
        path = await asyncio.to_thread(lambda: get_library().preview_path(record_id))
        if path is None:
            return web.Response(status=404)
        content_type = _CONTENT_TYPES.get(path.suffix.lower())
        if content_type is None:
            return web.Response(status=404)
        try:
            # **一覧の升ごとに1回飛ぶ。** 兄弟の `/unbake/record-original` は
            # 前から `to_thread` を通しており、ここだけ通っていなかった
            # （`I-20260831-60`）。
            body = await asyncio.to_thread(path.read_bytes)
        except OSError:
            return web.Response(status=404)
        return web.Response(body=body, content_type=content_type)

    return True


def registered_paths() -> List[str]:
    """登録するはずの経路。**検査が「登録した」と「届く」を混ぜない**ための一覧。"""
    return [
        "/unbake/settings",
        "/unbake/records",
        "/unbake/record",
        "/unbake/record-preview",
        "/unbake/record-original",
        "/unbake/model-preview",
        "/unbake/outputs",
        "/unbake/output-raw",
        "/unbake/output-delete",
        "/unbake/model-companions",
        "/unbake/download-model-companions",
        "/unbake/download-plan",
        "/unbake/download",
        "/unbake/download-cancel",
        "/unbake/raindrop",
        "/unbake/record-save",
        "/unbake/record-delete",
        "/unbake/model-usage",
        "/unbake/model-delete-plan",
        "/unbake/model-delete",
        "/unbake/model-index",
        "/unbake/civitai-version",
    ]
