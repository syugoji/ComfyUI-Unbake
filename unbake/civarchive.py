# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""消えたモデルの受け皿（civarchive.com）。**既定では使わない。**

Civitai から消えた版は、こちらからは「もう引けない」としか言えない。
CivArchive は消える前の記録を持っていて、置き場（`huggingface.co` など）への
道も持っていることがある。

**既定を OFF にしてある**（2026-08-26 利用者の指示）。理由は3つ:

1. **第三者へ問い合わせが飛ぶ。** どの版を探しているかが、Civitai ではない
   相手に伝わる。既定で外へ増やさない。
2. **作者が意図的に消したものが含まれる。** 消した理由はこちらからは判らない。
   拾い直すかどうかは、使う人が決めることであってこちらが決めることではない。
3. **行き先が増える。** `download.py` は「API が返した URL でも行き先は
   確かめる」という許可リストを持っている。ここを開けるのは、開けると
   決めた人の環境だけにする。

**版IDはそのまま通じる**（実測 2026-08-26）: 応答の `civitai_model_version_id`
が Civitai の版IDと一致する（例 753328）。ただし**入口はモデルIDが要る**ので、
記録がモデルIDを持っていないと引けない。
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

API_HOST = "civarchive.com"

#: 受け入れる配布元。**実測で出たものだけ**（2026-08-26 / mirrors の netloc）。
#:
#: `civitai.com` は元から許している。`huggingface.co` はここを開けたときだけ
#: 増える——**知らない相手からは落とさない**という約束は外さない。
EXTRA_DOWNLOAD_HOSTS = ("huggingface.co",)


def _get_json(url: str, timeout: int = 30) -> Optional[Dict[str, Any]]:
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ComfyUI-Unbake",
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response)
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as error:
        # **投げない。** ここは補助の道なので、落ちても本筋を止めない。
        logger.debug("civarchive lookup failed for %s: %s", url, error)
        return None


def _host_of(url: str) -> str:
    try:
        return urllib.parse.urlparse(str(url)).netloc.lower()
    except ValueError:
        return ""


def pick_download_url(file_entry: Dict[str, Any], allowed_hosts) -> Optional[str]:
    """落とせる URL を選ぶ。**許した相手だけ。**

    `mirrors` を先に見る——`downloadUrl` は Civitai を指していることが多く、
    消えた版ではそこが 404 を返す（**それが在るから探しに来ている**）。
    """
    urls = []
    for mirror in file_entry.get("mirrors") or []:
        url = str((mirror or {}).get("url") or "")
        if url:
            urls.append(url)
    fallback = str(file_entry.get("downloadUrl") or "")
    if fallback:
        urls.append(fallback)
    for url in urls:
        if not url.startswith("https://"):
            continue
        if _host_of(url) in allowed_hosts:
            return url
    return None


def resolve_version(
    model_id: Any,
    version_id: Any,
    *,
    allowed_hosts,
    fetch: Optional[Any] = None,
) -> Optional[Dict[str, Any]]:
    """消えた版を、こちらの解決器と同じ形で返す。**見つからなければ None。**

    Args:
        model_id: Civitai のモデルID（**入口に要る**）
        version_id: Civitai の版ID
        allowed_hosts: 落とすことを許す相手（呼び手が決める）
    """
    model_id = str(model_id or "").strip()
    version_id = str(version_id or "").strip()
    if not model_id.isdigit() or not version_id.isdigit():
        return None

    getter = fetch or _get_json
    url = "https://%s/api/models/%s?modelVersionId=%s" % (API_HOST, model_id, version_id)
    payload = getter(url)
    if not isinstance(payload, dict):
        return None
    version = payload.get("version")
    if not isinstance(version, dict):
        return None

    # **別の版を掴まない。** 引数を無視して既定の版を返されても気づけるように、
    # 返ってきた版IDを必ず突き合わせる。
    got = version.get("civitai_model_version_id") or version.get("id")
    if str(got or "") != version_id:
        logger.debug("civarchive returned version %s for %s", got, version_id)
        return None

    if version.get("allow_download") is False:
        # **作者が配布を止めているなら、こちらも止める。**
        return None

    files = [item for item in (version.get("files") or []) if isinstance(item, dict)]
    if not files:
        return None
    primary = next((item for item in files if item.get("is_primary")), files[0])

    download_url = pick_download_url(primary, allowed_hosts)
    if not download_url:
        return None

    size_kb = primary.get("sizeKB")
    return {
        "ok": True,
        "url": download_url,
        "filename": primary.get("name"),
        "bytes": int(float(size_kb) * 1024) if isinstance(size_kb, (int, float)) else None,
        # **無いこともある。** 呼び手が「照合していない」と扱えるよう None を通す。
        "sha256": (str(primary.get("sha256")) or None) if primary.get("sha256") else None,
        "name": version.get("name"),
        "modelName": payload.get("name"),
        # **種類は Civitai と同じ語**（実測 2026-08-26: `"LORA"`）。
        # 呼び手が `KIND_OF_TYPE` で置き場に直せる。
        "modelType": payload.get("type"),
        "baseModel": version.get("baseModel"),
        # **どこから来たかを必ず残す。** Civitai が言っていることと、
        # 受け皿が言っていることを混ぜない。
        "source": "civarchive",
        "trainedWords": version.get("trigger") or None,
    }
