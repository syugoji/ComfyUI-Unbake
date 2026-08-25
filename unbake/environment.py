"""環境の注入口（Python 側）。**unbake/ は宿主の内部実装へ触らない。**

Copyright (C) 2026 syugoji
SPDX-License-Identifier: GPL-3.0-or-later

切り出す前、この層はフォークの ``py/config.py`` ``py/services/settings_manager.py``
``py/services/downloader.py`` の3つを直接 import していた。使っている面積は極小
（モデル格納先の3属性・設定の getter・ダウンロード関数1本）なのに、
その3行だけでフォークの外へ出せない状態になっていた。

ここで**環境を1つの形へ集める**。

- **モデル格納先** は ComfyUI 本体の ``folder_paths`` から取る。これが本来の姿で、
  フォークの ``config`` は同じものを別名で持っていただけである。
- **設定** は呼び手が渡す。既定値を持たない——持つと「渡し忘れても動くが別物を読む」
  という、最も見つけにくい壊れ方をする。
- **ダウンロード** も呼び手が渡す。

**形は据える時点で検査する。** 注入されるものの形が違うとき、テストは自前の
ダブルを入れているので全緑のまま、実機だけが死ぬ。入口で弾く。
"""

from __future__ import annotations

import inspect
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol, Tuple

try:  # ComfyUI 本体が提供する。カスタムノードなら常に在る。
    import folder_paths  # type: ignore
except ImportError:  # pragma: no cover - ComfyUI の外で読まれたとき
    folder_paths = None  # type: ignore


class SettingsProvider(Protocol):
    """呼び手が渡す設定の読み口。``get(key, default)`` だけを使う。"""

    def get(self, key: str, default: Any = None) -> Any: ...  # pragma: no cover


#: ``folder_paths`` の名前へ写す。**フォークの属性名は使わない。**
_ROOT_KINDS: Dict[str, Tuple[str, ...]] = {
    # フォークの ``loras_roots``
    "loras": ("loras",),
    # フォークの ``checkpoints_roots`` / ``base_models_roots``。
    # 後者は「checkpoints が空のときの受け皿」として使われていたので、
    # ComfyUI 側の該当フォルダを同じ順で並べる。
    "checkpoints": ("checkpoints", "diffusion_models", "unet"),
    "embeddings": ("embeddings",),
}


class UnbakeEnvironment:
    """据えられた環境。**この形以外を core は知らない。**"""

    def __init__(
        self,
        *,
        settings: SettingsProvider,
        download_file: Optional[Callable[..., Awaitable[Tuple[bool, Any]]]] = None,
        model_roots: Optional[Callable[[str], List[str]]] = None,
    ) -> None:
        if settings is None or not callable(getattr(settings, "get", None)):
            raise TypeError("UnbakeEnvironment: settings は get(key, default) を持つこと")
        if download_file is not None:
            if not callable(download_file):
                raise TypeError("UnbakeEnvironment: download_file が呼び出せない")
            if not inspect.iscoroutinefunction(download_file):
                # 同期/非同期の食い違いは「await されないコルーチン」として
                # 静かに落ちる。ここで弾かないと、緑のまま何も落ちてこない。
                raise TypeError("UnbakeEnvironment: download_file は async def であること")
        if model_roots is not None and not callable(model_roots):
            raise TypeError("UnbakeEnvironment: model_roots が呼び出せない")

        self._settings = settings
        self._download_file = download_file
        self._model_roots = model_roots

    # -- 設定 ---------------------------------------------------------

    @property
    def settings(self) -> SettingsProvider:
        return self._settings

    # -- モデル格納先 -------------------------------------------------

    def model_roots(self, kind: str) -> List[str]:
        """``kind`` の格納先を並べる。**無ければ空**（例外にしない）。

        ``kind`` は :data:`_ROOT_KINDS` の鍵。知らない鍵は誤字なので投げる
        ——空で返すと「設定されていない」と見分けが付かなくなる。
        """
        if kind not in _ROOT_KINDS:
            raise KeyError(f"UnbakeEnvironment: 未知の格納先種別 {kind!r}")
        if self._model_roots is not None:
            return [str(p) for p in (self._model_roots(kind) or [])]
        if folder_paths is None:
            return []
        roots: List[str] = []
        for name in _ROOT_KINDS[kind]:
            try:
                found = folder_paths.get_folder_paths(name)
            except Exception:
                continue
            for path in found or []:
                if path not in roots:
                    roots.append(str(path))
        return roots

    # -- ダウンロード -------------------------------------------------

    async def download_file(self, url: str, save_path: str, *, progress_callback=None):
        """呼び手が渡したダウンローダへ回す。渡されていなければ投げる。"""
        if self._download_file is None:
            raise RuntimeError(
                "Unbake: download_file が未設置。"
                "UnbakeEnvironment(download_file=...) を渡すこと"
            )
        return await self._download_file(
            url, save_path, progress_callback=progress_callback
        )

    @property
    def has_downloader(self) -> bool:
        return self._download_file is not None


_installed: Optional[UnbakeEnvironment] = None


def install_environment(environment: UnbakeEnvironment) -> UnbakeEnvironment:
    """環境を据える。"""
    if not isinstance(environment, UnbakeEnvironment):
        raise TypeError("install_environment: UnbakeEnvironment を渡すこと")
    global _installed
    _installed = environment
    return _installed


def reset_environment() -> None:
    """据えた環境を捨てる（テストの後始末用）。"""
    global _installed
    _installed = None


def has_environment() -> bool:
    return _installed is not None


def require_environment() -> UnbakeEnvironment:
    """据えた環境。未設置なら投げる——**黙って既定値へ落ちない。**"""
    if _installed is None:
        raise RuntimeError(
            "Unbake: 環境が未設置。install_environment(UnbakeEnvironment(...)) を先に呼ぶこと"
        )
    return _installed
