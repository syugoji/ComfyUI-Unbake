# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""元画像の**原寸**を1枚だけ取りに行く（2026-08-22 利用者の指示）。

## なぜ要るか

手元に在る参照画像は **LoRA Manager が置いたサムネイル**で、実測 **480x701**。
生成画像は原寸 **832x1216** なので、見比べると元画像だけが小さい。
伸ばして大きさは揃えたが、**元が480pxなのは変わらない**——原寸が要るなら
出どころから取り直すしかない。

## 何をしないか

- **一覧のために取りに行かない。** 346件ぶんを起動時に落とすと、Civitai への
  問い合わせが346回走る。**押された1件だけ**を取る。
- **models フォルダにも記録の隣にも書かない。** 置き場は user ディレクトリの下で、
  上流が置いたサムネイルを**上書きしない**（あちらの持ち物を書き換えない）。
- **一度取ったら取り直さない。** 同じ絵は変わらない。

## 取れないことは普通に起きる

消された・年齢制限・鍵が要る・単に落ちている。**そのときは 404 を返し、
画面はサムネイルのままにする**——「原寸が無い」は壊れていることではない。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, Optional

from .civitai import API_HOSTS, _get_json, is_rate_limited
from .records import fetch_preview
from .settings import user_root

#: 出典 URL から画像 ID を取る。**`.red` と `.com` の両方**（手元の出典は326/340が `.red`）。
_IMAGE_ID = re.compile(r"civitai\.(?:com|red)/images/(\d+)")


def originals_dir() -> Path:
    """原寸の置き場。**上流のサムネイルの隣には置かない。**"""
    return user_root() / "unbake" / "originals"


def image_id_of(source_path: Any) -> Optional[str]:
    match = _IMAGE_ID.search(str(source_path or ""))
    return match.group(1) if match else None


def domain_of(source_path: Any) -> str:
    """出典のドメイン。**既定へ丸めない**——`.red` が326/340件を占める。"""
    text = str(source_path or "")
    for host in API_HOSTS:
        if f"//{host}/" in text or f".{host}/" in text:
            return host
    return API_HOSTS[0]


def cached(record_id: str) -> Optional[Path]:
    """既に取ってある原寸。**拡張子は取ったときに決まる**ので、順に探す。"""
    root = originals_dir()
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(record_id or "")).strip("._-")
    if not safe:
        return None
    for suffix in (".webp", ".png", ".jpg", ".jpeg"):
        candidate = root / f"{safe}{suffix}"
        if candidate.is_file():
            return candidate
    return None


#: 画像 URL の変換指定が入る区画。ここを `original=true` へ替えると原寸が来る。
_TRANSFORM_HINTS = ("width=", "quality=", "optimized=", "original=")


def full_size_url(url: str) -> str:
    """変換指定を `original=true` へ替える。**無ければそのまま返す。**

    Civitai の画像 URL は ``…/{uuid}/{変換指定}/{name}.jpeg`` の形で、
    API が返す ``url`` は**縮んだ版を指していることがある**——それを
    そのまま「原寸」として控えると、**原寸を頼まずに原寸と呼ぶ**ことになる。

    同梱の ``civitai_recipe_sync/civitai_image_download.py`` は同じ API の
    ``url`` に対して前からこれをやっていた（失敗したら元の URL へ落とす）。
    **同じリポジトリ・同じ API で扱いが違っていた**ので、こちらへ揃える。
    """
    parts = str(url or "").split("/")
    for index, part in enumerate(parts):
        if any(hint in part for hint in _TRANSFORM_HINTS):
            parts[index] = "original=true"
            return "/".join(parts)
    return str(url or "")


def original_url(image_id: str, domain: str, api_key: str = "") -> Optional[str]:
    """Civitai の API から**原寸の在処**を引く。

    **`withMeta=true` と `nsfw=X` を落とさない。** どちらも無いと `200` のまま
    中身が空で返り、「そんな画像は無い」と誤読する（実測で2回踏んだ）。

    **上限に当たったことを「無い」と混ぜない**（2026-08-31・走査3周目）。
    `_get_json` は 429/503 のとき**辞書を返す**ので、`isinstance(payload, dict)`
    だけでは通ってしまい、`items` が無いので `None`＝「原寸が無い」になる。
    `civitai.is_rate_limited` は**その取り違えを1箇所へ閉じるために在る**
    （docstring が `model_previews` の実例まで挙げている）のに、
    ここは輸入すらしていなかった——**同じ罠の2度目**。
    """
    if not str(image_id or "").isdigit():
        return None
    host = domain if domain in API_HOSTS else API_HOSTS[0]
    url = f"https://{host}/api/v1/images?imageId={image_id}&withMeta=true&nsfw=X"
    payload = _get_json(url, api_key)
    if is_rate_limited(payload):
        raise RateLimited(int((payload or {}).get("retryAfter") or 0))
    if not isinstance(payload, dict):
        return None
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        return None
    found = items[0].get("url") if isinstance(items[0], dict) else None
    return str(found) if isinstance(found, str) and found else None


class RateLimited(Exception):
    """相手が「待て」と言っている。**「無い」と混ぜない。**

    戻り値で表すと `Optional[str]` の `None` に潰れる——呼び手はそれを
    「原寸が無い」としか読めない。**打つ手が違う**（待つ／諦める）ので、
    別の道で上げる。
    """

    def __init__(self, retry_after: int = 0) -> None:
        super().__init__("the Civitai API asked us to slow down")
        self.retry_after = max(0, int(retry_after or 0))


def get(record_id: str, source_path: Any, api_key: str = "") -> Dict[str, Any]:
    """原寸を1枚。**取ってあればそれを返し、無ければ1回だけ取りに行く。**

    Returns:
        ``{"ok": True, "path": ..., "cached": bool}`` または
        ``{"ok": False, "error": ...}``——**投げない**（取れないのは普通に起きる）。
    """
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(record_id or "")).strip("._-")
    if not safe:
        return {"ok": False, "error": "no record id"}
    already = cached(safe)
    if already is not None:
        return {"ok": True, "path": str(already), "cached": True}

    image_id = image_id_of(source_path)
    if image_id is None:
        # 出どころが Civitai でない記録（ローカルの画像・ComfyUI の出力）。
        # **原寸はもともと手元に在る**ので、ここで取りに行くものは無い。
        return {"ok": False, "error": "not from civitai"}

    try:
        url = original_url(image_id, domain_of(source_path), api_key)
    except RateLimited as limited:
        # **待てば通るものを「無い」と言わない**（`civitai.resolve_version` と同じ形）。
        return {
            "ok": False,
            "error": "the Civitai API asked us to slow down; try again shortly",
            "code": "rate_limited",
            "retryAfter": limited.retry_after,
        }
    if not url:
        return {"ok": False, "error": "could not resolve the original"}

    # **原寸を頼む**（2026-08-31・走査3周目）。API が返す `url` は縮んだ版を
    # 指していることがあり、そのまま控えると**原寸を頼まずに原寸と呼ぶ**。
    # **落ちたら元の URL へ落とす**——同梱の `civitai_image_download.py` が
    # 前からそうしている。変換指定の綴りは相手の都合で変わるので、
    # 書き換えたほうが 404 になる余地を残す。
    wanted = full_size_url(url)
    # **落とすのは参照画像と同じ経路。** ホストの許可・型・上限を2箇所に持たない。
    result = fetch_preview(wanted, originals_dir() / safe)
    if not result.get("ok") and wanted != url:
        result = fetch_preview(url, originals_dir() / safe)
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "download failed"}
    return {"ok": True, "path": result["path"], "cached": False}
