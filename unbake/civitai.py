# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""Civitai の版1件を、**落としてよい形へ解決する**。

## なぜサーバ側にも問い合わせが要るのか

同じ問い合わせは ``web/core/civitaiClient.js`` にもある。あちらは**表示のため**で、
ここは**「何を落としてよいか」を決める境界**である。

画面から URL を受け取って落とすと、画面へ細工をした人が任意の場所から
ファイルを引ける口になる。だから落とす側は**版IDだけ**を受け、
自分で公開 API を引いて、**返ってきた URL しか使わない**。
ホストも Civitai であることを確かめる。

**これは正規化の二重化ではない。** 二重に持つと食い違うのは「同じ値を作る規則」で、
ここが持っているのは「何を信じるか」という別の判断である。

## 上流を写していない

フォークの ``civitai_client.py`` は上流ファイルなので開いていない。
材料は公開 API の応答だけ（実測 2026-08-20）。
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

#: 問い合わせてよいホスト。**手元の記録の出典は `.red` が326/340件。**
API_HOSTS = ("civitai.com", "civitai.red")

#: 落として良いホスト。**API が返した URL でも、ここに無ければ使わない。**
DOWNLOAD_HOSTS = ("civitai.com", "civitai.red")

#: モデルの種別 → ComfyUI の置き場。**判らない種別は落とさない。**
KIND_OF_TYPE = {
    "lora": "loras",
    "locon": "loras",
    "dora": "loras",
    "checkpoint": "checkpoints",
    "textualinversion": "embeddings",
    "vae": "vae",
    "controlnet": "controlnet",
    "upscaler": "upscale_models",
}


def _get_json(url: str, api_key: str = "", timeout: int = 30) -> Optional[Dict[str, Any]]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ComfyUI-Unbake",
        **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # **上限に当たったことを「見つからない」と混ぜない。**
        #
        # ここは元々 `URLError` を全部握って ``None`` を返していたので、
        # 429 も「版が消えた」も同じ顔で出ていた。**打つ手が正反対**
        # （前者は待つ、後者は諦める）なのに、画面はどちらも「もう引けない」と言う。
        # しかも黙って続けると、上限に当たり続けたまま叩き続けることになる。
        if error.code in (429, 503):
            retry_after = 0
            try:
                retry_after = int(str(error.headers.get("Retry-After", "")).strip() or 0)
            except (TypeError, ValueError):
                retry_after = 0
            logger.warning("civitai rate limited (%s), retry after %ss", error.code, retry_after)
            return {"__unbake_rate_limited__": True, "retryAfter": max(0, retry_after)}
        logger.debug("civitai request failed: %s", error)
        return None
    except (urllib.error.URLError, ValueError, OSError) as error:
        logger.debug("civitai request failed: %s", error)
        return None


def _primary_file(version: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """落とすべきファイル1つ。**`primary` を優先する。**

    版には本体の他に学習の設定や画像が付いていることがあり、
    最初の1つを取ると本体でない物を落とす。
    """
    files = version.get("files") or []
    for file in files:
        if file.get("primary"):
            return file
    for file in files:
        if str(file.get("type", "")).lower() == "model":
            return file
    return files[0] if files else None


def _host_of(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def resolve_version(
    version_id: str,
    *,
    kind: Optional[str] = None,
    host: str = API_HOSTS[0],
    api_key: str = "",
    fetch: Optional[Any] = None,
) -> Dict[str, Any]:
    """版IDから、落とすのに要るものを揃える。

    Returns:
        ``{"ok": True, "url", "filename", "kind", "bytes", "sha256", "name"}``
        または ``{"ok": False, "error": …}``。**投げない**（呼び手が理由を画面へ出す）。
    """
    version_id = str(version_id or "").strip()
    if not version_id.isdigit():
        return {"ok": False, "error": "versionId must be a number", "code": "setup"}
    api_host = host if host in API_HOSTS else API_HOSTS[0]

    getter = fetch or _get_json
    version = getter(f"https://{api_host}/api/v1/model-versions/{version_id}", api_key)
    if isinstance(version, dict) and version.get("__unbake_rate_limited__"):
        # **待てば通るものを「もう引けない」と言わない。**
        wait = int(version.get("retryAfter") or 0)
        return {
            "ok": False,
            "error": (
                f"the Civitai API asked us to slow down; try again in {wait} seconds"
                if wait else "the Civitai API asked us to slow down; try again shortly"
            ),
            "code": "rate_limited",
            "retryAfter": wait,
        }
    if not isinstance(version, dict):
        # **取れなかったことを「存在しない」と混ぜない。**
        #
        # ただし**打つ手は同じ**（2026-08-23 利用者の指示で分類を付けた）。
        # 版が消えていても、鍵が無くて見えなくても、繋がらなくても、
        # ここからは区別が付かない——`gone` と呼んで「もう引けない」とだけ言う。
        # 区別が要るなら、そこは口の側（HTTP の番号）が持っている。
        return {
            "ok": False,
            "error": "could not reach the Civitai API for this version",
            "code": "gone",
        }

    file = _primary_file(version)
    if not file:
        return {"ok": False, "error": "this version has no downloadable file", "code": "gone"}

    resolved_kind = kind or KIND_OF_TYPE.get(str((version.get("model") or {}).get("type", "")).lower())
    if not resolved_kind:
        return {
            "ok": False,
            "error": f"unsupported model type: {(version.get('model') or {}).get('type')}",
            "code": "setup",
        }

    url = str(file.get("downloadUrl") or "")
    if _host_of(url) not in DOWNLOAD_HOSTS:
        # **API が返した URL でも、行き先は確かめる。**
        return {
            "ok": False,
            "error": f"refusing to download from {_host_of(url) or 'an unknown host'}",
            "code": "setup",
        }

    size_kb = file.get("sizeKB")
    try:
        size_bytes = int(float(size_kb) * 1024) if size_kb is not None else None
    except (TypeError, ValueError):
        size_bytes = None

    hashes = file.get("hashes") or {}
    return {
        "ok": True,
        "url": url,
        "filename": file.get("name"),
        "kind": resolved_kind,
        "bytes": size_bytes,
        # **無いこともある。** その場合は照合しないことを呼び手へ伝える
        # （`download_model` は `verified` で返す）。
        "sha256": hashes.get("SHA256"),
        "name": version.get("name"),
        "modelName": (version.get("model") or {}).get("name"),
        "baseModel": version.get("baseModel"),
    }
