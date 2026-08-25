# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Raindrop → Civitai → レシピ の同期スクリプトを別プロセスとして起動する。

## ライセンス境界について（重要）

同期スクリプト本体（配布ツリーの ``civitai-recipe-sync/``）は **MIT**、
このディレクトリ（フォーク）は **GPL-3.0** で、境界はディレクトリそのもの。

このサービスは同期スクリプトを **import しない**。子プロセスとして起動し、
標準出力に流れるイベント行を読むだけの arm's-length な結合に留める。
同期の実体は最初から最後まで別プロセスの中にあり、スクリプト側は従来どおり
HTTP でこのサーバの ``/api/lm/recipes/*`` を叩く。

**同期ロジックをこのプロセスへ取り込む（import・コピー）と、
配布ツリー ``README.md`` の「HTTP API 越しの別プロセスなので別ライセンスにできる」
という記述が成り立たなくなる。** 変更する場合は README も同時に直すこと。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..environment import UnbakeEnvironment, require_environment

logger = logging.getLogger(__name__)


# 同期スクリプトが出す進捗行の接頭辞。これ以外の行は人間向けログとして扱う。
EVENT_PREFIX = "@@RDSYNC@@"

# 画面に出すログの保持件数（メモリ上限。全文は残さない）
MAX_LOG_LINES = 300

# 1行あたりの上限。長大な行で画面と応答を膨らませない。
MAX_LOG_LINE_CHARS = 500

# 配布ツリー内での同期スクリプトの位置（このパッケージのルートから見た相対）
DEFAULT_SCRIPT_RELATIVE_PATH = ("..", "civitai-recipe-sync", "civitai_image_download.py")

# 自動同期の既定間隔（時間）
DEFAULT_AUTO_SYNC_INTERVAL_HOURS = 24

# 自動同期の**最小**間隔（時間）。設定でこれより短くはできない。
#
# Raindrop は「濫用または過度に頻繁なリクエストは、そのアカウントの API
# アクセスの一時的または恒久的な停止につながることがある」と規約に定めており、
# 停止されるのは配布者ではなく**利用者のアカウント**。短間隔ポーリングは
# ブックマークが1件も増えていなくても毎回コレクション全件を取りに行くため、
# 得るものが無いまま条項へ近づく。下限は設定ではなく機構として持つ。
MIN_AUTO_SYNC_INTERVAL_HOURS = 1

# 起動時同期を実際に走らせるまでの待ち（秒）。
# ComfyUI 側の初期化（モデルスキャン等）が終わる前に走らせない。
STARTUP_SYNC_DELAY_SECONDS = 60


class RaindropSyncError(RuntimeError):
    """同期を開始できない状態を表す基底例外。"""


class RaindropSyncBusyError(RaindropSyncError):
    """すでに同期が走っている。"""


class RaindropSyncConfigError(RaindropSyncError):
    """設定が足りない、またはスクリプトが見つからない。"""


def _package_root() -> Path:
    """``comfyui-lora-manager/`` の絶対パス。"""

    return Path(__file__).resolve().parents[2]


class RaindropSyncService:
    """同期スクリプトの起動・進捗集約・中断を担う。

    進捗はメモリ上にだけ持つ。プロセスが落ちれば消えるが、同期そのものは
    子プロセス側で完結しているのでレシピの保存結果は残る。
    """

    def __init__(
        self,
        *,
        environment: Optional[UnbakeEnvironment] = None,
        settings_manager=None,
        recipes_dir_getter: Optional[Callable[[], str]] = None,
        python_executable: Optional[str] = None,
        logger_override: Optional[logging.Logger] = None,
    ) -> None:
        # **既定値を持たない。** 元は `get_settings_manager()` へ落ちていたので、
        # 渡し忘れても動き、**別の設定を読んだまま緑になる**形だった。
        self._environment: UnbakeEnvironment = environment or require_environment()
        self._settings = (
            settings_manager if settings_manager is not None else self._environment.settings
        )
        self._recipes_dir_getter = recipes_dir_getter
        self._python = python_executable or sys.executable
        self._logger = logger_override or logger

        self._process: Optional[asyncio.subprocess.Process] = None
        self._task: Optional[asyncio.Task] = None
        self._cancel_requested = False
        self._state: Dict[str, Any] = self._initial_state()
        self._scheduler_task: Optional[asyncio.Task] = None

    # -- 状態 ---------------------------------------------------------

    @staticmethod
    def _initial_state() -> Dict[str, Any]:
        return {
            "status": "idle",
            "stage": "",
            "message": "",
            "bookmarks": 0,
            "already_synced": 0,
            "total": 0,
            "processed": 0,
            "success": 0,
            "failed": 0,
            "failed_ids": [],
            "current_image_id": None,
            "progress_percent": 0,
            "started_at": None,
            "finished_at": None,
            "log": [],
            # ブックマーク数と対象数の差の内訳（planned イベントで埋まる）
            "excluded": {
                "total": 0,
                "not_civitai_image": 0,
                "duplicate": 0,
                "no_link": 0,
                "already_synced": 0,
                "not_civitai_image_samples": [],
                "duplicate_image_ids": [],
            },
        }

    def is_running(self) -> bool:
        return self._state["status"] == "running"

    def get_progress(self) -> Dict[str, Any]:
        """UI へ返す進捗のスナップショット。秘匿値は含めない。"""

        snapshot = dict(self._state)
        snapshot["failed_ids"] = list(self._state["failed_ids"])
        snapshot["log"] = list(self._state["log"])
        snapshot["excluded"] = dict(self._state["excluded"])
        return snapshot

    # -- 設定の解決 ---------------------------------------------------

    def resolve_script_path(self) -> Path:
        """同期スクリプトの場所を決める。設定 > 配布ツリーの既定位置。"""

        configured = self._settings.get("raindrop_sync_script_path", "") or ""
        if isinstance(configured, str) and configured.strip():
            candidate = Path(os.path.expanduser(configured.strip())).resolve()
            if not candidate.is_file():
                raise RaindropSyncConfigError(
                    f"設定された同期スクリプトが見つかりません: {candidate}"
                )
            return candidate

        candidate = _package_root().joinpath(*DEFAULT_SCRIPT_RELATIVE_PATH).resolve()
        if not candidate.is_file():
            raise RaindropSyncConfigError(
                "同期スクリプト civitai_image_download.py が見つかりません。"
                "配布ツリーの civitai-recipe-sync/ を隣に置くか、"
                "設定 raindrop_sync_script_path でパスを指定してください。"
            )
        return candidate

    def _resolve_recipes_dir(self) -> str:
        if self._recipes_dir_getter is not None:
            resolved = self._recipes_dir_getter() or ""
            if resolved:
                return resolved

        custom = self._settings.get("recipes_path", "") or ""
        if isinstance(custom, str) and custom.strip():
            return os.path.abspath(os.path.normpath(os.path.expanduser(custom.strip())))

        roots = list(self._environment.model_roots("loras"))
        if roots:
            return os.path.join(roots[0], "recipes")
        return ""

    def _build_environment(
        self,
        base_url_hint: Optional[str] = None,
        *,
        require_sync_targets: bool = True,
    ) -> Dict[str, str]:
        """子プロセスへ渡す環境変数を組み立てる。

        同期スクリプトは「環境変数 > config.json > 既定値」の順で設定を読むので、
        ここで渡した値が最優先になる。**戻り値は秘匿値を含むのでログへ出さない。**

        Args:
            require_sync_targets: コレクションIDとレシピ保存先を必須とするか。
                コレクション一覧の取得はまさにそのIDを選ぶための操作なので、
                その場合だけ False にしてトークンだけを必須にする。
        """

        token = str(self._settings.get("raindrop_token", "") or "").strip()
        collection_id = str(self._settings.get("raindrop_collection_id", "") or "").strip()
        recipes_dir = self._resolve_recipes_dir()

        missing: List[str] = []
        if not token:
            missing.append("Raindrop トークン")
        if require_sync_targets:
            if not collection_id:
                missing.append("Raindrop コレクションID")
            if not recipes_dir:
                missing.append("レシピの保存先（LoRA ルートまたは recipes_path）")
        if missing:
            raise RaindropSyncConfigError(
                "設定が足りません: " + " / ".join(missing)
            )

        # 貼り付け事故の早期検出。トークンはHTTPヘッダへ載るので非ASCIIだと
        # requests 側で 'latin-1' codec エラーになり、原因が読み取れなくなる。
        # 値そのものは出さず、位置と文字数だけを伝える。
        if not token.isascii():
            first_bad = next(
                index for index, char in enumerate(token) if not char.isascii()
            )
            raise RaindropSyncConfigError(
                f"Raindrop トークンに ASCII 以外の文字が入っています"
                f"（{first_bad + 1} 文字目以降・全 {len(token)} 文字）。"
                "別の文字列を貼り付けていないか確認して、設定し直してください。"
            )
        if any(char.isspace() for char in token):
            raise RaindropSyncConfigError(
                f"Raindrop トークンに空白が入っています（全 {len(token)} 文字）。"
                "前後や途中に余計な文字が混ざっていないか確認してください。"
            )

        env = dict(os.environ)
        env["RAINDROP_TOKEN"] = token
        # 未設定のまま空文字を渡すと、スクリプト側が config.json の古い値へ
        # フォールバックする。設定されている時だけ上書きする。
        if collection_id:
            env["RAINDROP_COLLECTION_ID"] = collection_id
        if recipes_dir:
            env["LORA_RECIPE_DIR"] = recipes_dir
        env["COMFY_BASE_URL"] = self._resolve_comfy_base_url(base_url_hint)
        env["CIVITAI_SYNC_EVENT_STREAM"] = "1"
        env["CIVITAI_SYNC_NON_INTERACTIVE"] = "1"
        # Windows で日本語のログが化けると進捗行のJSONごと壊れる。
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"

        api_key = str(self._settings.get("civitai_api_key", "") or "").strip()
        if api_key:
            env["CIVITAI_API_KEY"] = api_key
        else:
            env.pop("CIVITAI_API_KEY", None)

        lora_roots = list(self._environment.model_roots("loras"))
        if lora_roots:
            env["LORA_MODELS_DIR"] = lora_roots[0]

        # `checkpoints` と `diffusion_models` / `unet` は環境側で1本に並べてある
        # （フォークの `checkpoints_roots` / `base_models_roots` に相当）。
        checkpoint_roots = list(self._environment.model_roots("checkpoints"))
        if checkpoint_roots:
            env["CHECKPOINT_MODELS_DIR"] = checkpoint_roots[0]

        return env

    def _resolve_comfy_base_url(self, hint: Optional[str] = None) -> str:
        """子プロセスが叩き返してくる先を決める。

        設定 > 呼び出し元（今このUIを配っているサーバ自身） > 既定ポート。
        ComfyUI を 8188 以外で動かしている環境でも当たるように、
        リクエストの出所を既定より優先する。
        """

        configured = self._settings.get("raindrop_sync_comfy_base_url", "") or ""
        if isinstance(configured, str) and configured.strip():
            return configured.strip().rstrip("/")
        if isinstance(hint, str) and hint.strip():
            return hint.strip().rstrip("/")
        return "http://127.0.0.1:8188"

    # -- 起動・中断 ---------------------------------------------------

    async def start(
        self,
        base_url_hint: Optional[str] = None,
        *,
        unattended: bool = False,
    ) -> Dict[str, Any]:
        """同期を開始する。

        Args:
            unattended: 人が画面を見ていない自動実行かどうか。真のとき
                スクリプト側は不足LoRAの自動ダウンロードを強制的に止める
                （Civitai ToS §11.9 = 自動化による統計の操作の禁止）。
        """
        if self.is_running():
            raise RaindropSyncBusyError("同期はすでに実行中です。")

        script_path = self.resolve_script_path()
        env = self._build_environment(base_url_hint)
        extra_args: List[str] = []
        if unattended:
            env["CIVITAI_SYNC_UNATTENDED"] = "1"
            extra_args.append("--unattended")
        else:
            env.pop("CIVITAI_SYNC_UNATTENDED", None)

        self._state = self._initial_state()
        self._state["status"] = "running"
        self._state["stage"] = "starting"
        self._state["started_at"] = time.time()
        self._cancel_requested = False

        try:
            self._process = await asyncio.create_subprocess_exec(
                self._python,
                "-u",
                str(script_path),
                "--events",
                "--non-interactive",
                *extra_args,
                cwd=str(script_path.parent),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as exc:
            self._state["status"] = "failed"
            self._state["stage"] = "spawn"
            self._state["message"] = f"同期スクリプトを起動できませんでした: {exc}"
            self._state["finished_at"] = time.time()
            raise RaindropSyncError(self._state["message"]) from exc

        self._task = asyncio.create_task(self._pump())
        return self.get_progress()

    # -- 自動同期（無人実行） -------------------------------------------

    def _auto_sync_settings(self) -> Dict[str, Any]:
        """自動同期の設定を読み、規約側の下限を当てはめて返す。

        間隔は毎回読み直す。設定変更のたびに再起動させないため。
        """
        enabled = bool(self._settings.get("raindrop_auto_sync_enabled", False))
        on_startup = bool(self._settings.get("raindrop_auto_sync_on_startup", True))
        try:
            hours = float(self._settings.get("raindrop_auto_sync_interval_hours", 24) or 24)
        except (TypeError, ValueError):
            hours = float(DEFAULT_AUTO_SYNC_INTERVAL_HOURS)
        # **下限を機構として持つ。** 短間隔ポーリングは Raindrop の
        # 「過度に頻繁なリクエスト」条項に直撃し、止まるのは利用者のアカウント。
        # 設定でいくら小さくしても、ここで押し戻す。
        hours = max(hours, MIN_AUTO_SYNC_INTERVAL_HOURS)
        return {"enabled": enabled, "on_startup": on_startup, "interval_hours": hours}

    def start_scheduler(self, *, run_startup_sync: bool = True) -> bool:
        """自動同期のループを開始する。既に動いていれば何もしない。

        Args:
            run_startup_sync: 起動時同期を試みるか。設定変更による再起動では
                False を渡す。「起動時に1回」は ComfyUI の起動を指すのであって、
                設定を触るたびに同期が走ってよいという意味ではない。

        Returns:
            ループを開始したなら True。設定が無効なら False。
        """
        if self._scheduler_task is not None and not self._scheduler_task.done():
            return True
        if not self._auto_sync_settings()["enabled"]:
            return False
        self._scheduler_task = asyncio.create_task(
            self._auto_sync_loop(run_startup_sync=run_startup_sync)
        )
        return True

    async def stop_scheduler(self) -> None:
        """自動同期のループを止める。"""
        task = self._scheduler_task
        self._scheduler_task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:  # pragma: no cover - 停止時のみ
            pass
        except Exception as exc:  # pragma: no cover - defensive
            self._logger.warning("Auto sync scheduler stopped with error: %s", exc)

    async def _auto_sync_loop(self, *, run_startup_sync: bool = True) -> None:
        """設定された間隔で同期を回す。

        走らせるのは常に無人モード。人が画面を見ていないので、
        副作用のある動作（不足LoRAの自動ダウンロード）はスクリプト側で止まる。
        """
        settings = self._auto_sync_settings()
        if run_startup_sync and settings["on_startup"]:
            # 起動直後は ComfyUI 側の初期化が終わっていないことがある。
            await asyncio.sleep(STARTUP_SYNC_DELAY_SECONDS)
            await self._run_auto_sync_once()

        while True:
            settings = self._auto_sync_settings()
            if not settings["enabled"]:
                self._logger.info("Raindrop auto sync disabled; stopping scheduler.")
                return
            await asyncio.sleep(settings["interval_hours"] * 3600)
            await self._run_auto_sync_once()

    async def _run_auto_sync_once(self) -> None:
        """自動同期を1回試みる。失敗してもループは止めない。"""
        if not self._auto_sync_settings()["enabled"]:
            return
        if self.is_running():
            self._logger.info("Raindrop auto sync skipped: a sync is already running.")
            return
        try:
            await self.start(unattended=True)
        except RaindropSyncConfigError as exc:
            # 設定が埋まっていないだけ。次回に期待して続ける。
            self._logger.info("Raindrop auto sync skipped: %s", exc)
        except RaindropSyncError as exc:
            self._logger.warning("Raindrop auto sync failed to start: %s", exc)
        except Exception as exc:  # pragma: no cover - defensive
            self._logger.error("Raindrop auto sync raised: %s", exc, exc_info=True)

    async def list_collections(self, timeout: float = 30.0) -> List[Dict[str, Any]]:
        """Raindrop のコレクション一覧を取得する（読み取り専用・同期はしない）。

        同期本体と同じく **スクリプトを import せず子プロセスとして起動する**。
        結合は標準出力の ``@@RDSYNC@@`` 行を読むことだけに留め、
        ライセンス境界（フォーク=GPL-3.0 / スクリプト=MIT）を保つ。

        Raindrop 側は2リクエストしか発生しない（ルートと配下）ので、
        規約上の「過度に頻繁なリクエスト」には当たらない。

        Raises:
            RaindropSyncBusyError: 同期の実行中（同時に外部APIを叩かないため）
            RaindropSyncConfigError: トークン未設定・不正
            RaindropSyncError: 起動失敗・タイムアウト・スクリプト側のエラー
        """
        if self.is_running():
            raise RaindropSyncBusyError("同期の実行中はコレクション一覧を取得できません。")

        script_path = self.resolve_script_path()
        env = self._build_environment(require_sync_targets=False)

        try:
            process = await asyncio.create_subprocess_exec(
                self._python,
                "-u",
                str(script_path),
                "--list-collections",
                "--events",
                "--non-interactive",
                cwd=str(script_path.parent),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as exc:
            raise RaindropSyncError(
                f"同期スクリプトを起動できませんでした: {exc}"
            ) from exc

        try:
            stdout_raw, stderr_raw = await asyncio.wait_for(
                process.communicate(), timeout=timeout
            )
        except asyncio.TimeoutError as exc:
            try:
                process.terminate()
            except Exception:  # pragma: no cover - OS 依存
                pass
            raise RaindropSyncError(
                f"コレクション一覧の取得が {timeout:.0f} 秒で完了しませんでした。"
            ) from exc

        collections: Optional[List[Dict[str, Any]]] = None
        error_message = ""
        for raw_line in (stdout_raw or b"").decode("utf-8", errors="replace").splitlines():
            line = raw_line.strip()
            if not line.startswith(EVENT_PREFIX):
                continue
            try:
                payload = json.loads(line[len(EVENT_PREFIX):].strip())
            except (ValueError, TypeError):
                continue
            if not isinstance(payload, dict):
                continue
            if payload.get("event") == "collections":
                items = payload.get("items")
                collections = items if isinstance(items, list) else []
            elif payload.get("event") == "collections_error":
                error_message = str(payload.get("message") or "")

        if collections is not None:
            return collections

        if error_message:
            # スクリプト側は秘匿値を載せない約束でこのメッセージを作っている。
            raise RaindropSyncConfigError(error_message)

        stderr_text = (stderr_raw or b"").decode("utf-8", errors="replace").strip()
        detail = f"（終了コード {process.returncode}）"
        if stderr_text:
            # 標準エラーは秘匿値を含みうるので、末尾の1行だけに切り詰める。
            detail += f" {stderr_text.splitlines()[-1][:200]}"
        raise RaindropSyncError(f"コレクション一覧を取得できませんでした{detail}")

    async def cancel(self) -> Dict[str, Any]:
        if not self.is_running() or self._process is None:
            return self.get_progress()

        self._cancel_requested = True
        try:
            self._process.terminate()
        except ProcessLookupError:  # pragma: no cover - 競合時のみ
            pass
        except Exception as exc:  # pragma: no cover - OS 依存
            self._logger.warning("Failed to terminate raindrop sync process: %s", exc)
        return self.get_progress()

    # -- 出力の取り込み -----------------------------------------------

    async def _pump(self) -> None:
        process = self._process
        assert process is not None

        stderr_lines: List[str] = []

        async def drain_stderr() -> None:
            if process.stderr is None:
                return
            while True:
                raw = await process.stderr.readline()
                if not raw:
                    break
                text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if text:
                    stderr_lines.append(text[:MAX_LOG_LINE_CHARS])
                    del stderr_lines[:-20]

        stderr_task = asyncio.create_task(drain_stderr())

        try:
            if process.stdout is not None:
                while True:
                    raw = await process.stdout.readline()
                    if not raw:
                        break
                    self._consume_line(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
            return_code = await process.wait()
        except Exception as exc:  # pragma: no cover - 読み取り側の異常
            self._logger.error("Raindrop sync output pump failed: %s", exc, exc_info=True)
            return_code = -1
            self._append_log(f"[!] 進捗の取り込みに失敗しました: {exc}")
        finally:
            await asyncio.gather(stderr_task, return_exceptions=True)

        self._finalize(return_code, stderr_lines)

    def _consume_line(self, line: str) -> None:
        stripped = line.strip()
        if stripped.startswith(EVENT_PREFIX):
            payload = stripped[len(EVENT_PREFIX):].strip()
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                self._append_log(line)
                return
            if isinstance(event, dict):
                self._apply_event(event)
            return

        if stripped:
            self._append_log(line)

    def _append_log(self, line: str) -> None:
        self._state["log"].append(line[:MAX_LOG_LINE_CHARS])
        overflow = len(self._state["log"]) - MAX_LOG_LINES
        if overflow > 0:
            del self._state["log"][:overflow]

    def _apply_event(self, event: Dict[str, Any]) -> None:
        name = event.get("event")

        if name == "started":
            self._state["stage"] = "scanning"
            return

        if name == "planned":
            self._state["stage"] = "syncing"
            self._state["bookmarks"] = int(event.get("bookmarks") or 0)
            self._state["already_synced"] = int(event.get("already_synced") or 0)
            self._state["total"] = int(event.get("total") or 0)
            # ブックマーク数と対象数がずれる理由を画面で説明できるようにする。
            self._state["excluded"] = {
                "total": int(event.get("excluded") or 0),
                "not_civitai_image": int(event.get("excluded_not_civitai_image") or 0),
                "duplicate": int(event.get("excluded_duplicate") or 0),
                "no_link": int(event.get("excluded_no_link") or 0),
                "already_synced": int(event.get("already_synced") or 0),
                "not_civitai_image_samples": [
                    str(item)
                    for item in (event.get("excluded_not_civitai_image_samples") or [])
                ],
                "duplicate_image_ids": [
                    str(item) for item in (event.get("duplicate_image_ids") or [])
                ],
            }
            self._update_percent()
            return

        if name == "item_started":
            self._state["current_image_id"] = event.get("image_id")
            return

        if name == "item_finished":
            self._state["processed"] = int(event.get("index") or self._state["processed"] + 1)
            self._state["success"] = int(event.get("success") or 0)
            self._state["failed"] = int(event.get("failed") or 0)
            self._state["current_image_id"] = None
            self._update_percent()
            return

        if name == "finished":
            self._state["stage"] = str(event.get("stage") or "finished")
            self._state["total"] = int(event.get("total") or self._state["total"])
            self._state["success"] = int(event.get("success") or 0)
            self._state["failed"] = int(event.get("failed") or 0)
            failed_ids = event.get("failed_ids")
            if isinstance(failed_ids, list):
                self._state["failed_ids"] = [str(item) for item in failed_ids]
            message = event.get("message")
            if message:
                self._state["message"] = str(message)
            # 最終的な status はプロセス終了時に決める。ここでは
            # スクリプトが自己申告した異常だけ拾っておく。
            if event.get("status") == "error":
                self._state["stage"] = f"error:{self._state['stage']}"
            self._update_percent()
            return

    def _update_percent(self) -> None:
        total = self._state["total"]
        if total > 0:
            done = min(self._state["processed"], total)
            self._state["progress_percent"] = round(done * 100 / total, 1)
        elif self._state["status"] != "running":
            self._state["progress_percent"] = 100

    def _finalize(self, return_code: int, stderr_lines: List[str]) -> None:
        self._state["finished_at"] = time.time()
        self._state["current_image_id"] = None

        if self._cancel_requested:
            self._state["status"] = "cancelled"
            if not self._state["message"]:
                self._state["message"] = "同期を中断しました。"
        elif str(self._state["stage"]).startswith("error:"):
            self._state["status"] = "failed"
        elif return_code == 0:
            self._state["status"] = "completed"
        else:
            self._state["status"] = "failed"
            if not self._state["message"]:
                tail = " / ".join(stderr_lines[-3:]) if stderr_lines else ""
                self._state["message"] = (
                    f"同期スクリプトが異常終了しました（終了コード {return_code}）"
                    + (f": {tail}" if tail else "")
                )

        if stderr_lines:
            for line in stderr_lines[-10:]:
                self._append_log(f"[stderr] {line}")

        self._update_percent()
        self._process = None


_service: Optional[RaindropSyncService] = None


def get_raindrop_sync_service(**kwargs: Any) -> RaindropSyncService:
    """プロセス内で共有する単一のサービスを返す。"""

    global _service
    if _service is None:
        _service = RaindropSyncService(**kwargs)
    return _service


def reset_raindrop_sync_service() -> None:
    """テスト用: 共有インスタンスを捨てる。"""

    global _service
    _service = None
