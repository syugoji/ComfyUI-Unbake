# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Download models listed in the known-model catalog.

Kept separate from ``download_manager`` because that path is built around
Civitai model versions; catalog entries are plain URLs with no version metadata.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Awaitable, Callable, Dict, Optional, Set

from .known_model_catalog import KnownModel, get_known_model
from ..environment import UnbakeEnvironment, require_environment

try:
    import folder_paths
except ImportError:  # pragma: no cover - standalone defensive fallback
    folder_paths = None


logger = logging.getLogger(__name__)

# 台帳の実測サイズとの許容差。ミラー側の再圧縮などで厳密一致しない事例があるため、
# 削除はせず警告に留める。
SIZE_TOLERANCE_RATIO = 0.05

# **同じ保存先へ同時に落とさない。**
# `downloader.download_file` は `<save_path>.part` の現在サイズを再開位置にする。
# 2つ目のダウンロードが走ると、そのときの中途サイズから Range 要求を出して
# **同じファイルへ追記する**ので、中身が混ざって壊れる。サイズ検査は許容差 5% の
# 警告どまりなので、壊れたまま通り抜けうる。
# 実際に踏んだ（2026-08-15）: レシピ画面の取得ボタンと「不足しているモデルを
# ダウンロード」を続けて押すと、同じ `.part` へ2本が書き込みうる状態だった。
_IN_FLIGHT: Set[str] = set()


def resolve_target_directory(folder: str) -> Optional[str]:
    """Return the first configured directory for a ComfyUI folder name."""

    getter = getattr(folder_paths, "get_folder_paths", None)
    if not callable(getter):
        return None

    try:
        paths = getter(folder)
    except Exception:  # pragma: no cover - ComfyUI raises on unknown folders
        logger.warning("Failed to resolve folder paths for '%s'", folder, exc_info=True)
        return None

    for path in paths or []:
        if isinstance(path, str) and path.strip():
            return path

    return None


def find_installed_path(folder: str, filename: str) -> Optional[str]:
    """Look for an already-installed copy across every configured directory.

    ComfyUI can be pointed at other UIs' model folders through
    ``extra_model_paths.yaml`` (this setup maps forge's ESRGAN/RealESRGAN/SwinIR
    onto ``upscale_models``). Checking only the download target would miss a
    copy that already exists elsewhere and waste disk on a second one.
    """

    getter = getattr(folder_paths, "get_full_path", None)
    if callable(getter):
        try:
            hit = getter(folder, filename)
            if hit and os.path.exists(hit):
                return hit
        except Exception:  # pragma: no cover - ComfyUI raises on unknown folders
            logger.debug("get_full_path failed for %s/%s", folder, filename, exc_info=True)

    # get_full_path はキャッシュ済みの一覧しか引けないことがあるので、
    # 候補ディレクトリを実際に走査する経路も残す。
    wanted = filename.casefold()
    for root in _folder_candidates(folder):
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.casefold() == wanted:
                    return os.path.join(dirpath, name)
    return None


def _folder_candidates(folder: str) -> list[str]:
    getter = getattr(folder_paths, "get_folder_paths", None)
    if not callable(getter):
        return []
    try:
        paths = getter(folder)
    except Exception:  # pragma: no cover
        return []
    return [
        path for path in (paths or [])
        if isinstance(path, str) and path.strip() and os.path.isdir(path)
    ]


def _size_warning(entry: KnownModel, actual_size: int) -> Optional[str]:
    expected = entry.size_bytes
    if not expected:
        return None

    if abs(actual_size - expected) <= expected * SIZE_TOLERANCE_RATIO:
        return None

    return (
        f"Downloaded size {actual_size} differs from the catalog size {expected} "
        f"by more than {int(SIZE_TOLERANCE_RATIO * 100)}%"
    )


async def download_known_model(
    key: str,
    *,
    progress_callback: Optional[Callable[..., Awaitable[None]]] = None,
    download_id: Optional[str] = None,
    environment: Optional[UnbakeEnvironment] = None,
) -> Dict[str, Any]:
    """Fetch a catalog entry into its ComfyUI folder."""

    entry = get_known_model(key)
    if entry is None:
        return {"success": False, "error": f"Unknown model key: {key}"}

    if not entry.downloadable or not entry.url:
        return {
            "success": False,
            "error": (
                f"{entry.filename} has no direct download URL; install it manually"
            ),
            "key": entry.key,
            "filename": entry.filename,
            "page_url": entry.page_url,
            "download_id": download_id,
        }

    # 保存先を決める前に、**どこかに既にあるか**を見る。保存先だけを見ると、
    # 他UIのフォルダ（extra_model_paths 経由）にある実体を見落として二重に落とす。
    existing = find_installed_path(entry.folder, entry.filename)
    if existing:
        return {
            "success": True,
            "skipped": True,
            "reason": "already_installed",
            "key": entry.key,
            "filename": entry.filename,
            "path": existing,
            "download_id": download_id,
        }

    target_dir = resolve_target_directory(entry.folder)
    if not target_dir:
        return {
            "success": False,
            "error": f"No configured directory for folder '{entry.folder}'",
            "key": entry.key,
            "filename": entry.filename,
            "download_id": download_id,
        }

    save_path = os.path.join(target_dir, entry.filename)

    # 走行中なら**始めない**。待たせるとリクエストが数分ぶら下がるので、
    # 走行中である事実だけを返して呼び出し側に判断させる。
    if save_path in _IN_FLIGHT:
        return {
            "success": True,
            "skipped": True,
            "reason": "already_downloading",
            "key": entry.key,
            "filename": entry.filename,
            "path": save_path,
            "download_id": download_id,
        }

    os.makedirs(target_dir, exist_ok=True)

    # **ダウンローダは呼び手が渡す。** 元はフォークの `py/services/downloader.py` を
    # 遅延 import していた（差し替えのための遅延だったが、結局その1行が
    # フォークの外へ出せない理由の1つだった）。注入なら遅延が要らない。
    env: UnbakeEnvironment = environment or require_environment()
    _IN_FLIGHT.add(save_path)
    try:
        success, result = await env.download_file(
            entry.url,
            save_path,
            progress_callback=progress_callback,
        )
    finally:
        # **失敗・例外でも必ず外す。** 残ると以後の再試行が全部「走行中」で弾かれる。
        _IN_FLIGHT.discard(save_path)

    if not success:
        return {
            "success": False,
            "error": str(result),
            "key": entry.key,
            "filename": entry.filename,
            "download_id": download_id,
        }

    payload: Dict[str, Any] = {
        "success": True,
        "skipped": False,
        "key": entry.key,
        "filename": entry.filename,
        "path": result if isinstance(result, str) and result else save_path,
        "download_id": download_id,
    }

    try:
        actual_size = os.path.getsize(payload["path"])
    except OSError:
        actual_size = None

    if actual_size is not None:
        payload["size_bytes"] = actual_size
        warning = _size_warning(entry, actual_size)
        if warning:
            payload["size_warning"] = warning
            payload["expected_size_bytes"] = entry.size_bytes
            logger.warning("%s: %s", entry.filename, warning)

    return payload
