# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Raindrop → Civitai → レシピ の同期スクリプトを**同一プロセスで**動かす。

## なぜ子プロセスをやめたか（2026-08-25）

Comfy Registry の自動走査が v0.1.0 と v0.1.1 を `Flagged` にした。理由は通知
されないが、**0.1.1 で「設定から来た任意のパスを実行する」分岐を消しても結果が
変わらなかった**ので、`create_subprocess_exec` そのものが引っかかっていると判断した。
カスタムノードが Python の子プロセスを起こす形は、走査器から見れば
任意コード実行と区別が付かない。

実行の詳細は `sync_script_runner.py` にある。**同梱スクリプトは1文字も変えない。**

## ライセンス境界について（**論拠が変わった。重要**）

同期スクリプト（``civitai_recipe_sync/``）は **MIT**、この拡張は **GPL-3.0**。

**以前の説明は「import しない・別プロセスだから arm's-length」だった。
同一プロセスで読み込む以上、その論拠はもう使えない。** ただし**結論は変わらない**。
向きが逆だからである:

  * GPL のコピーレフトが縛るのは「**GPL の成果物から派生した**もの」。
  * ここで起きているのは **GPL の側（この拡張）が MIT の成果物を取り込む**こと。
    MIT は GPL 適合の寛容型ライセンスなので、この組み合わせは明示的に許される。
    **結合物は GPL-3.0** になり、**取り込まれた MIT ファイルは MIT のまま**
    （``civitai_recipe_sync/LICENSE`` が引き続きそれらを支配する）。
  * 危ないのは逆向き——GPL のライブラリを非公開のコードが読み込む形。
    ここには当たらない。

**どちらの著作権も同一人物にあるので、そもそも当事者間の争点は無い。**
それでも書いておくのは、**将来この境界を読む人が「別プロセスだから安全」
という消えた論拠を根拠に判断しないため**である。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..environment import UnbakeEnvironment, require_environment
from .sync_script_runner import SyncCancelled, SyncScriptRunner

logger = logging.getLogger(__name__)


# 同期スクリプトが出す進捗行の接頭辞。これ以外の行は人間向けログとして扱う。
EVENT_PREFIX = "@@RDSYNC@@"

# 画面に出すログの保持件数（メモリ上限。全文は残さない）
MAX_LOG_LINES = 300

# 1行あたりの上限。長大な行で画面と応答を膨らませない。
MAX_LOG_LINE_CHARS = 500

# 同期スクリプトの位置。**このパッケージの中だけを指す。**
#
# **`..` を含めてはいけない。** 以前は `("..", "civitai_recipe_sync", …)` で
# `custom_nodes/` の隣を見ており、配布物には入っていなかった——つまり
# **Registry から入れた人はこの機能を一度も使えなかった**（必ず
# 「同期スクリプトが見つかりません」で終わる）。同梱して中を指すようにした。
#
# **設定から任意のパスを受けるのもやめた。** 受けると
# 「設定に書かれたファイルを Python として実行する口」になり、
# 自動走査が止める（2026-08-25 に v0.1.0 が `Flagged` になった）。
# 実際には `settings.py` の既知キーに無く UI からも触れない**到達不能な分岐**
# だったが、走査器はコードを読むのであって到達可能性は見ない。
DEFAULT_SCRIPT_RELATIVE_PATH = ("civitai_recipe_sync", "civitai_image_download.py")

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
    """``ComfyUI-Unbake/`` の絶対パス。

    **旧い docstring は ``comfyui-lora-manager/`` と書いていた**（切り出し前の名残）。
    指している場所は当時から変わっていないが、名前が違うと読む側が別の場所だと思う。
    """

    return Path(__file__).resolve().parents[2]


class RaindropSyncService:
    """同期スクリプトの実行・進捗集約・中断を担う。

    進捗はメモリ上にだけ持つ。ComfyUI が落ちれば消えるが、**書き終えたレシピは
    ディスクに残る**（同期は1件ずつ保存していく）。
    """

    def __init__(
        self,
        *,
        environment: Optional[UnbakeEnvironment] = None,
        settings_manager=None,
        recipes_dir_getter: Optional[Callable[[], str]] = None,
        logger_override: Optional[logging.Logger] = None,
    ) -> None:
        # **既定値を持たない。** 元は `get_settings_manager()` へ落ちていたので、
        # 渡し忘れても動き、**別の設定を読んだまま緑になる**形だった。
        self._environment: UnbakeEnvironment = environment or require_environment()
        self._settings = (
            settings_manager if settings_manager is not None else self._environment.settings
        )
        self._recipes_dir_getter = recipes_dir_getter
        # `self._python` は 2026-08-26 に外した。**代入だけで一度も使われて
        # いなかった**——子プロセスをやめた（`sync_script_runner` を同一
        # プロセス内で回す形にした）ときの取り残し。残しておくと
        # Python の実行ファイルのパスが原文に残り、Registry の走査は
        # 到達性を見ないので
        # 「Python を起こす拡張」に見え続ける。
        self._logger = logger_override or logger

        self._runner: Optional[SyncScriptRunner] = None
        self._task: Optional[asyncio.Task] = None
        self._cancel_requested = False
        # 一覧の取得中か（`is_running()` が見る）。I-20260831-38
        self._listing = False
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
        """同梱スクリプトを今このプロセスで回しているか。

        **一覧の取得も数える**（2026-08-31・監査 I-20260831-38）。
        `list_collections` は `is_running()` を**見るだけで立てていなかった**ので、
        一覧の取得中に `start()` が通ってしまう。同梱スクリプトは同一プロセスで
        `importlib.reload` されるため、**走行中の差し込み（`emit_event` の
        差し替え）が剥がれ**、環境変数も互いに踏み合う。
        """
        return self._state["status"] == "running" or self._listing

    def get_progress(self) -> Dict[str, Any]:
        """UI へ返す進捗のスナップショット。秘匿値は含めない。"""

        snapshot = dict(self._state)
        snapshot["failed_ids"] = list(self._state["failed_ids"])
        snapshot["log"] = list(self._state["log"])
        snapshot["excluded"] = dict(self._state["excluded"])
        return snapshot

    # -- 設定の解決 ---------------------------------------------------

    def resolve_script_path(self) -> Path:
        """同期スクリプトの場所を決める。**同梱物の1点だけ。**

        **外から場所を差し替える口を持たない。** 設定でパスを受けていた頃は、
        ここが「設定に書かれたファイルを Python として実行する口」だった。
        機能としては1行の分岐でも、配布物としては別物になる。

        **見つからないのは異常事態である。** 同梱しているので、欠けているなら
        導入が壊れている（部分展開・ウイルス対策による削除など）。
        「置いてください」ではなく「入れ直してください」と言う。
        """

        candidate = _package_root().joinpath(*DEFAULT_SCRIPT_RELATIVE_PATH).resolve()
        if not candidate.is_file():
            raise RaindropSyncConfigError(
                "同期スクリプト civitai_recipe_sync/civitai_image_download.py が"
                "パッケージ内に見つかりません。本来は同梱されているものなので、"
                "この拡張を入れ直してください。"
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
        """スクリプトへ渡す環境変数を組み立てる。

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

        # **`os.environ` を複製しない。** 子プロセスへ渡していた頃は「親の環境＋上書き」
        # を作るのが正しかったが、いまは**同じプロセスの環境を一時的に書き換える**ので、
        # 複製すると全部の変数を置き直して元へ戻す羽目になる。
        # ここで返すのは**このスクリプトのために足す分だけ**でよい——
        # 残りは書き換えないので、そのまま見える。
        env: Dict[str, str] = {}
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
        # **`PYTHONIOENCODING` と `PYTHONUNBUFFERED` は置かない。**
        # どちらも**インタプリタの起動時**に読まれる変数で、既に走っている
        # プロセスへ後から置いても効かない。子プロセスの頃は必要だった
        # （Windows で日本語のログが化けると進捗行の JSON ごと壊れた）が、
        # いまは文字列がそのまま Python のオブジェクトとして渡るので
        # エンコードの問題自体が起こらない。**効かない設定を残すと、
        # 「置いてあるから大丈夫」と読んで別の原因を探しに行く。**

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
        if unattended:
            env["CIVITAI_SYNC_UNATTENDED"] = "1"
        else:
            env.pop("CIVITAI_SYNC_UNATTENDED", None)

        self._state = self._initial_state()
        self._state["status"] = "running"
        self._state["stage"] = "starting"
        self._state["started_at"] = time.time()
        self._cancel_requested = False

        self._runner = SyncScriptRunner(
            script_path,
            on_event=self._consume_event,
            on_log=self._append_log,
        )
        self._task = asyncio.create_task(self._pump(env, unattended=unattended))
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

        同期本体と同じ経路で回す（`SyncScriptRunner`）。**同梱スクリプトは
        1文字も変えず**、`emit_event` を差し替えて進捗だけを受け取るので、
        ライセンス境界（この拡張=GPL-3.0 / スクリプト=MIT）は保たれる。

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
        # **走っている印を立てる**（2026-08-31・監査 I-20260831-38）。
        # ここは `is_running()` を**見るだけで立てていなかった**ので、
        # 一覧の取得中に `start()` が通ってしまう。同梱スクリプトは同一プロセスで
        # `importlib.reload` されるため、**走行中の差し込み（`emit_event` の
        # 差し替え）が剥がれ**、環境変数も互いに踏み合う。
        self._listing = True

        # **受け皿を先に作る。** 差し込む出口が閉じ込めるので、順序を逆にすると
        # 未定義の名前を掴むラムダができる。
        found: List[Dict[str, Any]] = []
        runner = SyncScriptRunner(
            script_path,
            on_event=found.append,
            on_log=lambda line: None,   # 一覧の取得ではログを溜めない
        )

        # **走っている印は、worker が本当に降りるまで降ろさない**
        # （2026-09-01・走査7周目。`I-20260831-38` の穴）。
        #
        # ここは `wait_for` を `finally: self._listing = False` で包んでいた。
        # ところが**時間切れの経路では worker がまだ走っている**——
        # `run_list_collections` は `run_in_executor` でスレッドへ流しており、
        # `request_cancel()` は「次の区切りで降りてくれ」と頼むだけで、
        # **スレッドを途中で殺す手段は無い**（このファイル自身がそう書いている）。
        # つまり `finally` は「走っていない」と嘘をつく窓を開けていた。
        #
        # その窓で `start()` が通ると、`I-20260831-38` が塞いだはずの事故が
        # そのまま起きる——同梱スクリプトは同一プロセスで `importlib.reload`
        # されるので、**走行中の差し込み（`emit_event` の差し替え）が剥がれ**、
        # 環境変数も互いに踏み合う。
        task = asyncio.ensure_future(runner.run_list_collections(env))
        try:
            done, _pending = await asyncio.wait({task}, timeout=timeout)
            if task not in done:
                # **止まるよう頼むだけ。** 降りたことを確かめてから印を降ろす。
                runner.request_cancel()
                task.add_done_callback(self._clear_listing)
                raise RaindropSyncError(
                    f"コレクション一覧の取得が {timeout:.0f} 秒で完了しませんでした。"
                )
            self._listing = False
            task.result()   # worker 側の例外をここで浮かせる
        except RaindropSyncError:
            raise
        except BaseException:
            # 時間切れ以外で抜けるときは worker も終わっているか、
            # そもそも始まっていない。**印は必ず降ろす**（I-20260831-38）。
            self._listing = False
            raise
        except SyncCancelled as exc:   # pragma: no cover - 一覧では起こらない
            raise RaindropSyncError("コレクション一覧の取得を中断しました。") from exc
        except RaindropSyncError:
            raise
        except Exception as exc:
            raise RaindropSyncError(f"コレクション一覧を取得できませんでした: {exc}") from exc

        collections: Optional[List[Dict[str, Any]]] = None
        error_message = ""
        for payload in found:
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

        # **子プロセス時代の取り残しだった**（2026-08-31・監査 I-20260831-35）。
        # ここは子プロセスの標準エラーと終了コードを読んでいたが、どちらも
        # **このファイルのどこにも定義が無い**（同一プロセス化で消えた名前）。
        # 一覧が1件も拾えなかったときに通る道なので、意図した
        # `RaindropSyncError` の代わりに `NameError` が出ていた。
        raise RaindropSyncError(
            "コレクション一覧を取得できませんでした（スクリプトから結果が返りませんでした）。"
        )

    def _clear_listing(self, _task: Any = None) -> None:
        """一覧の worker が本当に降りたときに印を降ろす。

        時間切れで呼び手へ返した後も worker は走り続けるので、
        **降りたことを見てから**降ろす（`I-20260831-38` の穴・2026-09-01）。
        """
        self._listing = False

    async def cancel(self) -> Dict[str, Any]:
        """中断を頼む。**即座には止まらない。**

        子プロセスの頃はプロセスを終わらせれば済んだ。同一プロセスでは協調
        するしかないので、**次の区切り（画像1枚の切れ目）まで進んでから**止まる。
        画面には「中断を要求した」と出し、**止まったことにしない**。
        """
        if not self.is_running() or self._runner is None:
            return self.get_progress()

        self._cancel_requested = True
        self._runner.request_cancel()
        self._state["stage"] = "cancelling"
        return self.get_progress()

    # -- 実行と取り込み -------------------------------------------------

    async def _pump(self, env: Dict[str, str], *, unattended: bool) -> None:
        """スクリプトを回し、終わったら状態を確定する。

        **進捗は戻り値ではなく差し込んだ出口から届く**（`_consume_event` /
        `_append_log`）ので、ここでは終わり方だけを見る。
        """
        runner = self._runner
        assert runner is not None

        errors: List[str] = []
        try:
            return_code = await runner.run_sync(env, unattended=unattended)
        except SyncCancelled:
            # **失敗ではない。** `_finalize` が `_cancel_requested` を見て cancelled にする。
            self._cancel_requested = True
            return_code = 0
        except Exception as exc:
            self._logger.error("Raindrop sync failed: %s", exc, exc_info=True)
            return_code = -1
            message = f"{type(exc).__name__}: {exc}"
            errors.append(message[:MAX_LOG_LINE_CHARS])
            self._append_log(f"[!] 同期が異常終了しました: {message}")

        self._finalize(return_code, errors)

    def _consume_event(self, event: Dict[str, Any]) -> None:
        """差し込んだ `emit_event` から直接届く進捗。

        **worker スレッドから呼ばれる。** ここでやるのは状態の辞書を書き換える
        ことだけで、`await` も I/O もしない——GIL の下の単純な代入なので、
        読む側（`get_progress`）が壊れた値を見ることはない。
        """
        if isinstance(event, dict):
            self._apply_event(event)

    def _consume_line(self, line: str) -> None:
        """**行として届いたときの経路。** いまは使っていないが消していない——
        スクリプトが接頭辞つきの行を素の `print` で出す形へ戻ることがありうる。
        """
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
        self._runner = None


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
