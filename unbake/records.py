# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""記録をディスクへ残す・消す。**Unbake が書くのは自分の拡張子だけ。**

## なぜ `.recipe.json` で書かないのか

同じ拡張子で書くと、置き場を LoRA Manager のレシピ置き場に向けた瞬間に
**向こうの一覧へ現れる**。そうなると Unbake は「読むだけ」ではなくレシピ編集器になり、
稼働中の LoRA Manager と実ファイルを取り合う。だから **`.unbake.json`** で書く
——中身の形は同じなので、読む側（`library._summarize`）は1本のままで足りる。

## 置き場

``record_output_dir`` が設定されていればそこ。無ければ
**``<ComfyUI の user ディレクトリ>/unbake/records``**（設定ファイルと同じ根）。
**リポジトリの中には置かない。**

## 消すときの決めごと

- **索引が知っているパスしか消さない。** id からパスを引き、
  そのパスが**走査対象のフォルダの中に在ること**を実際のパスで確かめてから消す。
  画面からパスを受け取る口は作らない（``?path=`` を作らなかったのと同じ理由）。
- **対の画像も一緒に消す。** 残すと、次の走査で拾われない孤児が増える
  （実データの置き場は `.recipe.json` 346 と `.webp` の対で 1,260ファイル）。
- **消したものを1件ずつ返す。** 「1件消しました」だけだと、対の画像が
  消えたのか残ったのかが呼び手から見えない。
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .library import PREVIEW_SUFFIXES, RECORD_SUFFIXES, UNBAKE_SUFFIX, suffix_of
from .settings import default_records_dir
from .utils.json_io import dump_json_strict, dumps_json_strict


class RecordError(Exception):
    """書けなかった・消せなかった理由。**握り潰さずに呼び手へ返す。**"""


#: id に使ってよい字。**パス区切りを1文字も通さない。**
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.-]+")

#: 1件の上限。グラフを持つ記録でも実測で数百KBなので、これを超えるのは異常。
MAX_RECORD_BYTES = 8 * 1024 * 1024

#: 参照画像を取りに行ってよいホスト。**サブドメインを含める**
#: （実物は `image.civitai.com` に置かれている）。
#:
#: **どこからでも落とせる口にしない。** 画面から URL を渡せる形にした瞬間、
#: それは「このサーバに任意の URL を取りに行かせる口」になる（社内ネットワークの
#: 走査にも使える）。出典が civitai だと分かっている記録の画像だけを許す。
PREVIEW_HOSTS = ("civitai.com", "civitai.red")

#: 参照画像の上限。実測で 1408x2048 の webp が 2〜3 MB。桁が違うものは取らない。
MAX_PREVIEW_BYTES = 32 * 1024 * 1024

#: 受け取ってよい型と、その拡張子。**名乗りではなく Content-Type で決める。**
#: 並びは :data:`library.PREVIEW_SUFFIXES` の中に収まっていること
#: ——収まっていないと、落とせても `_preview_for()` が見つけられない。
PREVIEW_TYPES = {
    "image/webp": ".webp",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
}


#: 中身の先頭で見分ける印。**名乗りを信じない。**
#:
#: 落とすときは Content-Type で決めてよい（相手はホストを確かめた civitai）。
#: 画面から受け取るときは違う——名乗りは呼び手が好きに書ける。
#: だから**バイト列そのもの**で決める。
#: **数で書く。** エスケープで書くと、間に挟まる道具（シェル・編集器）が
#: 展開してしまい、**印そのものが壊れても構文としては通る**——実際に一度
#: 0x89 が別の文字へ化けた。数なら化けても目で判る。
_MAGIC = (
    (bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), ".png"),
    (bytes([0xFF, 0xD8, 0xFF]), ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
)


def sniff_image(payload: bytes):
    """中身から拡張子を決める。**画像でなければ `None`。**"""
    if not isinstance(payload, (bytes, bytearray)) or len(payload) < 12:
        return None
    data = bytes(payload)
    for prefix, suffix in _MAGIC:
        if data.startswith(prefix):
            return suffix
    # WebP は `RIFF....WEBP`（4バイトの長さを挟む）。
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def store_preview(payload: bytes, stem: Path) -> Dict[str, Any]:
    """手元の画像を1枚 ``stem + 拡張子`` へ置く（2026-08-23 利用者の指示）。

    **落とし込んだファイルの絵は、ここでしか残せない。** サーバが取りに行けるのは
    `http(s)` の URL だけで、ブラウザが抱えているバイト列には手が届かない
    ——だから一覧で絵が出るのは civitai 由来の記録だけ、という状態だった。

    **「任意の画像を書ける口」にしないための線引き:**

    1. **置き場も名前もサーバが決める。** 呼び手が渡すのは記録の id だけで、
       それは :func:`safe_id` を通っている。パスは受け取らない。
    2. **拡張子は中身で決める。** 名乗り（`Content-Type`・ファイル名）は
       呼び手が好きに書ける。画像でないバイト列はここで落とす。
    3. **大きさで切る。** :data:`MAX_PREVIEW_BYTES` は落とす側と同じ値。

    残るのは「画像の中身は呼び手が決める」——これは頼まれた機能そのものである。
    """
    if not payload:
        return {"ok": False, "error": "empty image"}
    if len(payload) > MAX_PREVIEW_BYTES:
        return {"ok": False, "error": f"too large ({len(payload)} bytes)"}
    suffix = sniff_image(payload)
    if suffix is None:
        return {"ok": False, "error": "not an image"}

    target = Path(str(stem) + suffix)
    temporary = target.with_name(target.name + ".part")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return {"ok": False, "error": f"cannot create {target.parent}: {error}"}
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, target)
    except OSError as error:
        try:
            temporary.unlink()
        except OSError:
            pass
        return {"ok": False, "error": f"cannot write {target.name}: {error}"}
    return {"ok": True, "path": str(target), "name": target.name, "bytes": len(payload)}


def _host_allowed(url: str) -> bool:
    """出典として許すホストか。**サブドメインは許すが、後方一致では見ない。**

    `evilcivitai.com` や `civitai.com.example.net` を通さないため、
    ホスト全体か `.` 区切りの末尾でだけ一致させる。
    """
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return any(host == allowed or host.endswith("." + allowed) for allowed in PREVIEW_HOSTS)


def fetch_preview(url: str, stem: Path, *, timeout: int = 30) -> Dict[str, Any]:
    """参照画像を1枚落として ``stem + 拡張子`` へ置く。**投げない。**

    **記録の保存を巻き込まない。** 画像が取れないことは珍しくない
    （消された・年齢制限・単に落ちている）が、そのために記録まで残せないのは筋が悪い。
    だから戻り値で伝えて、呼び手が「記録は残った・画像は無い」と言えるようにする。

    Returns:
        ``{"ok": True, "path": ..., "bytes": n}`` または ``{"ok": False, "error": ...}``
    """
    text = str(url or "").strip()
    if not text:
        return {"ok": False, "error": "no url"}
    if not text.lower().startswith(("http://", "https://")):
        return {"ok": False, "error": "not an http url"}
    if not _host_allowed(text):
        return {"ok": False, "error": "url is not on a known host"}

    request = urllib.request.Request(text, headers={
        "Accept": "image/webp,image/png,image/jpeg,*/*",
        "User-Agent": "ComfyUI-Unbake",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            # **飛ばされた先も確かめる。** 最初の URL だけ見ても、
            # リダイレクトで別のホストへ連れて行かれたら意味が無い。
            if not _host_allowed(response.geturl()):
                return {"ok": False, "error": "redirected off the known hosts"}
            kind = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            suffix = PREVIEW_TYPES.get(kind)
            if suffix is None:
                # 動画のこともある（Civitai は動画を配る）。**画像として扱わない。**
                return {"ok": False, "error": f"unsupported type: {kind or 'unknown'}"}
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > MAX_PREVIEW_BYTES:
                return {"ok": False, "error": f"too large ({declared} bytes)"}
            # **名乗りだけを信じない。** 実際に読んだ量でも切る。
            payload = response.read(MAX_PREVIEW_BYTES + 1)
    except (urllib.error.URLError, OSError, ValueError) as error:
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}
    if len(payload) > MAX_PREVIEW_BYTES:
        return {"ok": False, "error": "too large"}
    if not payload:
        return {"ok": False, "error": "empty response"}

    target = Path(str(stem) + suffix)
    temporary = target.with_name(target.name + ".part")
    # **書く側が置き場を作る。** 記録の保存は呼ぶ前に作っていたので気づかなかったが、
    # 原寸の置き場は初回に存在しない——**そこで `No such file or directory` で落ちていた**
    # （2026-08-22 実機）。作るのは書く関数の責任にする。
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return {"ok": False, "error": f"cannot create {target.parent}: {error}"}
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, target)
    except OSError as error:
        try:
            temporary.unlink()
        except OSError:
            pass
        return {"ok": False, "error": f"cannot write {target.name}: {error}"}
    return {"ok": True, "path": str(target), "name": target.name, "bytes": len(payload)}


def records_dir(settings) -> Path:
    """記録の保存先。**読み取り元とは分ける**（分けたのが決定）。

    既定は :func:`settings.default_records_dir`。**走査側と同じ関数から取る**
    ——別々に組むと、書けているのに読めないという形で静かに壊れる。
    """
    text = str(settings.get("record_output_dir", "") or "").strip()
    return Path(text) if text else default_records_dir()


def safe_id(value: Any) -> str:
    """id を名前に使える形へ。**空になったら投げる**（黙って別名にしない）。"""
    text = _SAFE_ID.sub("_", str(value or "").strip()).strip("._-")
    if not text:
        raise RecordError("the record has no usable id")
    # Windows の予約名を避ける（`CON.unbake.json` は作れない）。
    if text.upper().split(".")[0] in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        text = f"_{text}"
    return text[:120]


def save_record(
    settings,
    recipe: Dict[str, Any],
    *,
    preview_url: Optional[str] = None,
    preview_bytes: Optional[bytes] = None,
) -> Dict[str, Any]:
    """記録を1件書く。**既に在るものは上書きしない。**

    上書きを許すと、取り込み直しのたびに手を入れた記録が黙って戻る。
    同じ id で書きたいときは、呼び手が先に消す（``overwrite`` は作らない）。

    ``preview_url`` が在れば**参照画像も隣へ落とす**。無いと一覧が絵で選べない
    ——実際に「取り込んだ記録に画像が無い」と報告された。**取れなくても記録は残す。**
    """
    if not isinstance(recipe, dict):
        raise RecordError("the record must be an object")
    record_id = safe_id(recipe.get("id"))
    body = dict(recipe)
    body["id"] = record_id
    # **出典の画像 URL を記録の中に残す。** 落とせなかったときに後から取り直せる。
    if preview_url and not body.get("preview_url"):
        body["preview_url"] = str(preview_url)
    try:
        text = dumps_json_strict(body, ensure_ascii=False, indent=1)
    except (TypeError, ValueError) as error:
        raise RecordError(f"the record is not JSON: {error}") from error
    payload = text.encode("utf-8")
    if len(payload) > MAX_RECORD_BYTES:
        raise RecordError(f"the record is too large ({len(payload)} bytes)")

    target_dir = records_dir(settings)
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise RecordError(f"cannot create {target_dir}: {error}") from error

    path = target_dir / f"{record_id}{UNBAKE_SUFFIX}"
    if path.exists():
        return {"ok": False, "error": "already saved", "id": record_id, "path": str(path)}

    # **書いている途中の形をディスクへ残さない。** 走査は別スレッドで走りうるので、
    # 半分だけ書かれた JSON を読ませると「壊れた記録」として理由つきで出てしまう。
    temporary = path.with_name(path.name + ".part")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    except OSError as error:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise RecordError(f"cannot write {path}: {error}") from error

    # **画像は記録を書いたあとで落とす。** 先に落とすと、記録の保存に失敗したときに
    # 対を持たない画像だけが置き場に残る。
    preview = None
    # **手元のバイト列が先。** 落とし込んだファイルはこれしか手が無いし、
    # 外へ問い合わせずに済む（速いし、消えている心配も無い）。
    if preview_bytes:
        preview = store_preview(preview_bytes, target_dir / record_id)
    wanted = preview_url or body.get("preview_url")
    if (preview is None or not preview.get("ok")) and wanted:
        preview = fetch_preview(str(wanted), target_dir / record_id)
    return {
        "ok": True, "id": record_id, "path": str(path), "bytes": len(payload),
        # **「画像も落ちた」と「記録は残った」を分けて返す。** 呼び手が
        # 「記録は残ったが絵は無い」と言えるようにする。
        "preview": preview,
    }


def _inside(path: Path, roots: List[Path]) -> bool:
    """``path`` が ``roots`` のどれかの中に在るか。**実際のパスで確かめる。**

    文字列の前方一致では、``..`` もシンボリックリンクもジャンクションも抜ける。
    """
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for root in roots:
        try:
            root_resolved = root.resolve()
        except OSError:
            continue
        try:
            if os.path.commonpath([str(root_resolved), str(resolved)]) == str(root_resolved):
                return True
        except ValueError:
            # ドライブが違うと commonpath は投げる＝中には無い。
            continue
    return False


def delete_record(library, settings, record_id: str) -> Dict[str, Any]:
    """記録を1件消す。**索引が知っているパスしか消さない。**

    消すのは本体と**対の画像**だけ。付随を残すと孤児が増える。
    戻り値には**消したファイルを1件ずつ**入れる——件数だけだと、
    対の画像が消えたのか残ったのかが呼び手から見えない。
    """
    wanted = str(record_id or "").strip()
    if not wanted:
        raise RecordError("no record id")
    row = library.raw_row(wanted)
    if row is None:
        raise RecordError(f"no such record: {wanted}")
    raw_path = row.get("path")
    if not raw_path:
        # LoRA Manager から来た補助の行にはパスが無い（メモリ上だけ）。
        raise RecordError("this record has no file on disk")
    path = Path(str(raw_path))

    roots = list(library.source_dirs())
    output = records_dir(settings)
    if output not in roots:
        roots.append(output)
    configured = library.output_dir()
    if configured is not None and configured not in roots:
        roots.append(configured)
    if not _inside(path, roots):
        # **索引に在っても、走査対象の外なら消さない。** 設定が書き換わって
        # 索引だけが古い、という状態でディスクを触らせない。
        raise RecordError("refusing to delete outside the configured folders")
    if suffix_of(path.name) is None:
        raise RecordError(f"not a record file: {path.name}")

    removed: List[str] = []
    failed: List[str] = []
    suffix = suffix_of(path.name) or RECORD_SUFFIXES[0]
    stem = str(path)[: -len(suffix)]
    targets = [path] + [Path(stem + preview) for preview in PREVIEW_SUFFIXES]
    for target in targets:
        if not target.is_file():
            continue
        try:
            target.unlink()
            removed.append(str(target.name))
        except OSError as error:
            failed.append(f"{target.name}: {type(error).__name__}: {error}")
    if not removed:
        raise RecordError("nothing was removed")
    return {
        "ok": not failed,
        "id": wanted,
        "removed": removed,
        "failed": failed,
        "owner": row.get("owner"),
    }
