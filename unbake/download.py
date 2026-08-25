# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""モデルを1つだけ落とす。

## 単品だけ作る理由（凍結・2026-08-20）

一括ダウンロードは作らない。実測で、**同じモデルを待っている記録は最大2件**しか
無く、束ねても待ち時間はほぼ変わらない。一方で一括は「どれが落ちて、どれが
落ちなかったか」を人が追えなくする。母数が出てから考える。

## 上流を写していない

フォークの ``downloader.py`` は上流ファイルなので開いていない。ここは
Civitai の公開 API の応答（``files[].downloadUrl`` / ``hashes.SHA256`` /
``sizeKB``）だけを材料に、標準ライブラリで書いてある。

## 危ないのは書き込む先

落とすのは数GBのファイルで、**置き場所を間違えると気づきにくい**。だから:

- 置き場は **ComfyUI が知っている場所だけ**（``folder_paths``）。設定から
  受け取ったパスへは書かない。
- ファイル名は **API が返した名前の basename だけ**を使う。``../`` を含む名前を
  そのまま繋ぐと、モデルの置き場の外へ書ける。
- **既にあるファイルを上書きしない。** 同名の別物を黙って置き換えると、
  「同じ名前なのに別の絵が出る」という一番厄介な壊れ方をする。
- **一時ファイルへ落として、確かめてから置き換える。** 途中で切れたファイルが
  本物の名前で残ると、モデルとして読めないだけでなく「落とし済み」に見える。
- **SHA256 を照合する。** 合わなければ本物の名前へ置かない。
  照合しないと、切れたダウンロードと成功の区別が付かない。
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

#: 落として良い置き場。**ここに無い種別は受けない。**
ALLOWED_KINDS = ("loras", "checkpoints", "embeddings", "vae", "controlnet", "upscale_models")

#: 受け取ってよい拡張子。**実行できる形式を落とさない。**
ALLOWED_SUFFIXES = (".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin")

#: 1回に落としてよい上限。**桁を間違えたリンクで数百GBを引かないため。**
MAX_BYTES = 64 * 1024 * 1024 * 1024

#: 読み込みの単位。
CHUNK = 1024 * 1024


class DownloadError(Exception):
    """落とせなかった理由。**握り潰さずに呼び手へ返す。**

    ``code`` は**画面が分類に使う機械可読の印**（2026-08-23 利用者の指示）。
    文言を読んで種類を当てさせない——訳したら当たらなくなるし、
    そもそも「HTTP 404」と「could not reach the Civitai API」が
    **同じこと（もう配布されていない）を指す**とは、文言からは読めない。

    種類:
      ``gone``      … Civitai にもう無い（404・版が引けない）
      ``forbidden`` … 権限が要る（401/403・早期公開など）
      ``network``   … 繋がらなかった（次に試せば通るかもしれない）
      ``already``   … 置き場に既に在る（失敗ではない）
      ``canceled``  … 人が止めた（失敗ではない）
      ``corrupt``   … 落ちたが中身が合わない
      ``space``     … 置き場が足りない／大きすぎる
      ``setup``     … こちらの設定・環境の問題
    """

    def __init__(self, message, code="unknown"):
        super().__init__(message)
        self.code = code


def _model_dir(kind: str) -> str:
    """ComfyUI が知っている置き場。**設定から受け取ったパスは使わない。**"""
    if kind not in ALLOWED_KINDS:
        raise DownloadError(f"unsupported kind: {kind}", "setup")
    try:
        import folder_paths  # type: ignore
    except ImportError as error:  # pragma: no cover - ComfyUI の外
        raise DownloadError("folder_paths is not available (not running inside ComfyUI)", "setup") from error
    paths = folder_paths.get_folder_paths(kind)
    if not paths:
        raise DownloadError(f"ComfyUI has no folder configured for {kind}", "setup")
    return paths[0]


def safe_target(kind: str, filename: str) -> str:
    """置き先を組む。**API が返した名前を、そのまま繋がない。**"""
    base = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    if not base or base in (".", ".."):
        raise DownloadError("the file name is empty", "setup")
    if os.path.splitext(base)[1].lower() not in ALLOWED_SUFFIXES:
        raise DownloadError(f"unsupported file type: {base}", "setup")
    root = _model_dir(kind)
    target = os.path.abspath(os.path.join(root, base))
    # **必ず置き場の中であること。** basename を取ってあるので理屈では外れないが、
    # 理屈で守るとリンクや正規化の穴で破れる。実際のパスで確かめる。
    if os.path.commonpath([os.path.abspath(root), target]) != os.path.abspath(root):
        raise DownloadError("refusing to write outside the model folder", "setup")
    return target


def download_model(
    *,
    url: str,
    kind: str,
    filename: str,
    sha256: Optional[str] = None,
    expected_bytes: Optional[int] = None,
    api_key: str = "",
    on_progress: Optional[Callable[[int, Optional[int]], None]] = None,
    opener: Optional[Callable[..., Any]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """モデルを1つ落とす。

    Returns:
        ``{"ok": True, "path": …, "bytes": …, "sha256": …, "elapsedMs": …}``

    Raises:
        DownloadError: 置き先が作れない・既にある・大きすぎる・hash が合わない
    """
    target = safe_target(kind, filename)
    if os.path.exists(target):
        # **上書きしない。** 同名の別物へ差し替えると、
        # 「同じ名前なのに別の絵が出る」という一番厄介な壊れ方をする。
        raise DownloadError(f"already there: {os.path.basename(target)}", "already")

    if expected_bytes is not None and expected_bytes > MAX_BYTES:
        raise DownloadError(f"too large: {expected_bytes} bytes", "space")
    if expected_bytes is not None:
        free = shutil.disk_usage(os.path.dirname(target)).free
        # 余裕を少し見る（書き込み中に他が埋めることがある）。
        if free < expected_bytes * 1.1:
            raise DownloadError(f"not enough space: need {expected_bytes}, free {free}", "space")

    request = urllib.request.Request(url, headers={
        "User-Agent": "ComfyUI-Unbake",
        **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
    })
    started = time.monotonic()
    digest = hashlib.sha256()
    written = 0
    os.makedirs(os.path.dirname(target), exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        dir=os.path.dirname(target), prefix=".unbake-download-", suffix=".part"
    )
    # **開いた口はここで包む。** 元は ``with open_url(...) as response,
    # os.fdopen(handle, "wb") as stream:`` と1行で書いていたので、
    # **接続の側が先に落ちると `os.fdopen` に届かず、生の handle が開いたまま**に
    # なった。Windows では開いているファイルを消せないので ``_remove`` が
    # 黙って失敗し、``.part`` が置き去りになる——実測（2026-08-20）: 34GB の
    # 取得を取り消したあと、0バイトの ``.part`` が残っていた。
    stream = os.fdopen(handle, "wb")
    try:
        open_url = opener or urllib.request.urlopen
        with stream, open_url(request, timeout=60) as response:
            # **HTML が返ってきたら、それはモデルではない。**
            #
            # Civitai の取得口は**鍵が無いとログインの画面へ流す**（早期公開や
            # 一部のモデルは、鍵が在っても持ち主の権限が要る）。ここを見ないと、
            # **ログイン画面の HTML が `.safetensors` として置き場へ入る**——
            # hash も大きさも渡されていない呼び方だと誰も気づけない。
            kind_header = ""
            if hasattr(response, "headers"):
                kind_header = str(response.headers.get("Content-Type") or "").lower()
            if kind_header.startswith("text/html"):
                raise DownloadError(
                    "the server returned a web page, not a model"
                    " (a Civitai API key is usually required)",
                    "forbidden",
                )
            total = expected_bytes
            length = response.headers.get("Content-Length") if hasattr(response, "headers") else None
            if total is None and length:
                try:
                    total = int(length)
                except (TypeError, ValueError):
                    total = None
            while True:
                if should_cancel is not None and should_cancel():
                    raise DownloadError("canceled", "canceled")
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_BYTES:
                    raise DownloadError(f"too large: passed {MAX_BYTES} bytes", "space")
                digest.update(chunk)
                stream.write(chunk)
                if on_progress is not None:
                    on_progress(written, total)
    except urllib.error.HTTPError as error:
        _remove(temp_name)
        # **番号で分ける。** 404 は「もう無い」、401/403 は「権限が要る」
        # ——押した人の打つ手が違う（前者は諦める、後者は鍵を確かめる）。
        status = int(getattr(error, "code", 0) or 0)
        kind = "gone" if status == 404 else ("forbidden" if status in (401, 403) else "network")
        raise DownloadError(f"HTTP {status}", kind) from error
    except urllib.error.URLError as error:
        _remove(temp_name)
        raise DownloadError(f"network: {error.reason}", "network") from error
    except DownloadError:
        _remove(temp_name)
        raise
    except OSError as error:
        _remove(temp_name)
        raise DownloadError(f"{type(error).__name__}: {error}", "setup") from error

    got = digest.hexdigest()
    if sha256 and got.lower() != str(sha256).lower():
        # **合わなければ本物の名前へ置かない。** 置くと、切れたファイルが
        # 「落とし済み」に見えて、次に落とし直す機会が永久に来ない。
        _remove(temp_name)
        raise DownloadError(f"checksum mismatch: expected {sha256}, got {got}", "corrupt")
    if expected_bytes is not None and written != expected_bytes:
        _remove(temp_name)
        raise DownloadError(f"size mismatch: expected {expected_bytes}, got {written}", "corrupt")
    if written == 0:
        _remove(temp_name)
        raise DownloadError("empty download", "corrupt")

    os.replace(temp_name, target)
    return {
        "ok": True,
        "path": os.path.basename(target),
        "kind": kind,
        "bytes": written,
        "sha256": got,
        # **照合したかどうかを返す。** 照合していないのに「確かめた」と読ませない。
        "verified": bool(sha256),
        "elapsedMs": int((time.monotonic() - started) * 1000),
    }


def _remove(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
