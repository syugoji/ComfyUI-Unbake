import os
import re
import sys
import json
import time
import hashlib
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# =====================================================================
# ------------------------- 設定の読み込み -------------------------
# =====================================================================
# 秘匿値（Raindropトークン・Civitai APIキー）と環境依存パス（レシピ置き場・
# モデルフォルダ）は、このファイルには書かない。
#
#   優先順位: 環境変数 > config.json > 既定値
#
# 1) config.json を使う場合: config.example.json をコピーして config.json を作り、
#    値を埋める。config.json は .gitignore 済みなので誤コミットしない。
# 2) 環境変数を使う場合: 下表の env 名で渡す。CI や一時実行に向く。
#
#   設定キー                 環境変数                     必須
#   ----------------------- --------------------------- ----
#   raindrop_token          RAINDROP_TOKEN               ●
#   collection_id           RAINDROP_COLLECTION_ID       ●
#   recipe_dir              LORA_RECIPE_DIR              ●
#   civitai_api_key         CIVITAI_API_KEY              任意
#   comfy_base_url          COMFY_BASE_URL               任意
#   lora_models_dir         LORA_MODELS_DIR              任意
#   checkpoint_models_dir   CHECKPOINT_MODELS_DIR        任意
#   prompt_lora_fallbacks   (config.json のみ)            任意
# =====================================================================

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.environ.get("CIVITAI_SYNC_CONFIG") or os.path.join(_SCRIPT_DIR, "config.json")


def _load_config_file(path):
    """config.json を読む。無ければ空 dict（環境変数だけでも動く）。"""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else {}
    except Exception as err:
        print(f"[!] 設定ファイルを読めませんでした（既定値で続行）: {path} / {err}")
        return {}


_CONFIG = _load_config_file(CONFIG_PATH)


def _cfg(key, env_name, default=""):
    """環境変数 > config.json > 既定値 の順で1項目を解決する。"""
    value = os.environ.get(env_name)
    if value is None:
        value = _CONFIG.get(key)
    if value is None or value == "":
        return default
    return value


# 1. 発行したRaindropのテストトークン
RAINDROP_TOKEN = _cfg("raindrop_token", "RAINDROP_TOKEN")

# 2. 対象のコレクションID
COLLECTION_ID = str(_cfg("collection_id", "RAINDROP_COLLECTION_ID"))

# 3. Lora-Managerのレシピ保存フォルダ
RECIPE_DIR = _cfg("recipe_dir", "LORA_RECIPE_DIR")

# 4. 【任意】CivitaiのAPIキー（成人向けコンテンツやフォールバック時用）
CIVITAI_API_KEY = _cfg("civitai_api_key", "CIVITAI_API_KEY")

# 5. Lora-ManagerのComfyUIベースURL
COMFY_BASE_URL = _cfg("comfy_base_url", "COMFY_BASE_URL", "http://127.0.0.1:8188")

# 6. ローカルのLoRA/チェックポイント実体フォルダ（ハッシュ照合による名前解決に使用）
#    未指定なら LORA_MODELS_DIR は RECIPE_DIR の一つ上（Loraフォルダ本体）を使う。
LORA_MODELS_DIR = _cfg("lora_models_dir", "LORA_MODELS_DIR") or os.path.dirname(RECIPE_DIR)
CHECKPOINT_MODELS_DIR = _cfg("checkpoint_models_dir", "CHECKPOINT_MODELS_DIR")

# 7. ローカルファイルのハッシュ計算結果をキャッシュするJSONファイル（再走査高速化用）
HASH_CACHE_PATH = os.path.join(LORA_MODELS_DIR, "_local_hash_cache.json")

# 8. プロンプトにしか残っていない旧LoRAの自動復元先
#    Civitaiから削除済みでも、同一SHA256のSafeTensorが信頼できるミラーに
#    残っているものだけを明示登録する。未知の名前を曖昧検索して勝手に取得しない。
PROMPT_LORA_FALLBACK_DIR = os.path.join(LORA_MODELS_DIR, "_prompt_auto_resolved")
PROMPT_LORA_RESOLUTION_CACHE_PATH = os.path.join(PROMPT_LORA_FALLBACK_DIR, "resolution_cache.json")

# ミラー登録枠。既定は空。利用者が自分の責任で config.json の
# "prompt_lora_fallbacks" に追記する。形式:
#   { "<正規化したLoRA名>": {"file_name": "...", "url": "https://...", "sha256": "..."} }
# sha256 は必須。ダウンロード後に実ファイルのハッシュを照合し、
# 一致しない場合は破棄する（すり替え防止）。
PROMPT_LORA_FALLBACKS = {}
_raw_fallbacks = _CONFIG.get("prompt_lora_fallbacks")
if isinstance(_raw_fallbacks, dict):
    for _name, _desc in _raw_fallbacks.items():
        if isinstance(_desc, dict) and _desc.get("url") and _desc.get("sha256"):
            PROMPT_LORA_FALLBACKS[str(_name)] = {
                "file_name": _desc.get("file_name") or os.path.basename(_desc["url"]),
                "url": _desc["url"],
                "sha256": _desc["sha256"],
            }
        else:
            print(f"[!] prompt_lora_fallbacks の '{_name}' は url と sha256 の両方が要るため無視しました。")


def validate_config():
    """必須項目が揃っているかを起動時に確認する。"""
    missing = []
    if not RAINDROP_TOKEN:
        missing.append("raindrop_token / RAINDROP_TOKEN")
    if not COLLECTION_ID:
        missing.append("collection_id / RAINDROP_COLLECTION_ID")
    if not RECIPE_DIR:
        missing.append("recipe_dir / LORA_RECIPE_DIR")
    if missing:
        print("[-] 設定が足りません。config.example.json を config.json へコピーして埋めるか、環境変数で渡してください。")
        for item in missing:
            print(f"    - {item}")
        print(f"    設定ファイルの探索先: {CONFIG_PATH}")
        return False
    if not CHECKPOINT_MODELS_DIR:
        print("[~] checkpoint_models_dir が未設定です。チェックポイントの名前解決（ローカルハッシュ照合）は無効になります。")
    return True

# =====================================================================
# --------------- 進捗イベント／非対話モード（任意・既定OFF） ---------------
# =====================================================================
# 呼び出し元（GUI等）から起動されたときだけ、標準出力へ1行1件のJSONを混ぜる。
# 人間向けの print はそのまま残るので、CLIとしての見え方は既定では変わらない。
#
#   有効化       環境変数                          引数
#   ----------- -------------------------------- --------------------
#   イベント出力 CIVITAI_SYNC_EVENT_STREAM=1       --events
#   対話待ち省略 CIVITAI_SYNC_NON_INTERACTIVE=1    --non-interactive
#
# イベント行の形式: "@@RDSYNC@@ {\"event\": ..., ...}"
# 接頭辞を付けるのは、通常のログ行と機械的に区別できるようにするため。
EVENT_PREFIX = "@@RDSYNC@@"
EVENTS_ENABLED = os.environ.get("CIVITAI_SYNC_EVENT_STREAM", "") == "1"
NON_INTERACTIVE = os.environ.get("CIVITAI_SYNC_NON_INTERACTIVE", "") == "1"


def emit_event(event, **fields):
    """進捗イベントを1行のJSONとして出す。無効時は何もしない。

    秘匿値（トークン・APIキー）は渡さないこと。呼び出し元はこの標準出力を
    そのまま画面へ出すことがある。
    """
    if not EVENTS_ENABLED:
        return
    payload = {"event": event}
    payload.update(fields)
    try:
        sys.stdout.write(f"{EVENT_PREFIX} {json.dumps(payload, ensure_ascii=False)}\n")
        sys.stdout.flush()
    except Exception:
        # 進捗の出力失敗で同期本体を止めない。
        pass


def apply_cli_flags(argv):
    """コマンドライン引数でイベント出力・非対話・無人モードを有効化する。

    引数が無ければ何も変えない（従来のダブルクリック起動と同じ挙動）。

    `--unattended` は「人が画面を見ていない」ことの宣言。副作用のある動作
    （不足LoRAの自動ダウンロード）を強制的に無効化する。
    """
    global EVENTS_ENABLED, NON_INTERACTIVE, UNATTENDED, AUTO_DOWNLOAD_MISSING_LORAS
    if "--events" in argv:
        EVENTS_ENABLED = True
    if "--non-interactive" in argv:
        NON_INTERACTIVE = True
    if "--unattended" in argv:
        UNATTENDED = True
    if UNATTENDED and AUTO_DOWNLOAD_MISSING_LORAS:
        # Civitai ToS §11.9（自動化による統計の操作の禁止）。無人でモデルを
        # 取得するとダウンロード数へ自動加算される。人がいる時だけに限る。
        AUTO_DOWNLOAD_MISSING_LORAS = False
        print("[~] 無人実行のため、不足LoRAの自動ダウンロードを無効にしました。")
    return EVENTS_ENABLED, NON_INTERACTIVE, UNATTENDED

# =====================================================================
# ------------- 外部APIのレート制御（Civitai / Raindrop） -------------
# =====================================================================
# なぜ要るか（一次資料）:
#
#   Civitai 利用規約 §11.4 は自動アクセスを「(a) 公開APIなど明示的に提供する
#   インターフェース経由で、それぞれ自分自身の有効な資格情報を用い、かつ
#   **適用されるレート制限の範囲内で**」に限っている。ところが Civitai は
#   公開APIの上限値を公表していない（developer.civitai.com のガイドにも
#   requests/min の記載が無い）。守るべき数字が公表されていない以上、
#   こちらで保守的な間隔を置き、429 を受けたら必ず下がるほかない。
#
#   Raindrop は上限 120 req/min を明示し、429 とともに X-RateLimit-* を返す。
#   さらに規約で「濫用または過度に頻繁なリクエストは、そのアカウントの
#   API アクセスの一時的または恒久的な停止につながることがある」と定めている。
#   **停止されるのは配布者ではなく利用者のアカウント**なので、既定は安全側に倒す。
#
# 方針:
#   - ホストごとに最小間隔を空ける（無人実行では人が気づけないため）
#   - 429/503 は Retry-After を尊重し、無ければ指数バックオフ
#   - 401/403 は単発ではスキップに留める（見られない画像でも返るため）が、
#     連続して閾値を超えたら資格情報かアクセス権の問題として全体を止める
#   - X-RateLimit-Remaining が僅少なら X-RateLimit-Reset まで待つ
#   - リトライを使い切った 429 は明確なレート違反シグナルなので全体を止める
#
# ローカルの ComfyUI (COMFY_BASE_URL) は対象外。ホスト判定で素通しする。


def _cfg_float(key, env_name, default):
    """設定値を float で取る。壊れた値は既定へ倒す（同期を止めない）。"""
    try:
        value = float(_cfg(key, env_name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


def _cfg_int(key, env_name, default):
    """設定値を int で取る。壊れた値は既定へ倒す。"""
    try:
        value = int(float(_cfg(key, env_name, str(default))))
    except (TypeError, ValueError):
        return default
    return value if value >= 0 else default


# Civitai は上限が非公表。1req/秒は「公表されていない上限を踏む確率が低い」側の値。
CIVITAI_MIN_INTERVAL_SEC = _cfg_float("civitai_min_interval_sec", "CIVITAI_MIN_INTERVAL_SEC", 1.0)
# Raindrop は 120 req/min = 0.5s 間隔で上限ちょうど。既定はその半分の速さにする。
RAINDROP_MIN_INTERVAL_SEC = _cfg_float("raindrop_min_interval_sec", "RAINDROP_MIN_INTERVAL_SEC", 1.0)
HTTP_MAX_RETRIES = _cfg_int("http_max_retries", "HTTP_MAX_RETRIES", 3)
HTTP_BACKOFF_BASE_SEC = _cfg_float("http_backoff_base_sec", "HTTP_BACKOFF_BASE_SEC", 2.0)
HTTP_BACKOFF_CAP_SEC = _cfg_float("http_backoff_cap_sec", "HTTP_BACKOFF_CAP_SEC", 60.0)
# 401/403 が連続でこの回数を超えたら、資格情報かアクセス権の問題として止める。
HTTP_ABORT_AFTER_DENIALS = _cfg_int("http_abort_after_denials", "HTTP_ABORT_AFTER_DENIALS", 5)
# Raindrop の残枠がこれ以下になったらリセットまで待つ。
RAINDROP_REMAINING_FLOOR = _cfg_int("raindrop_remaining_floor", "RAINDROP_REMAINING_FLOOR", 5)


def _cfg_bool(key, env_name, default=False):
    """設定値を真偽で取る。"1"/"true"/"yes"/"on" を真とみなす。"""
    raw = _cfg(key, env_name, "1" if default else "0")
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


# 成人向けを含めるか。**既定は含めない。**
# 無条件に nsfw=X&browsingLevel=255 を付けると、利用者が Civitai 側で
# 成人向けを非表示にしていてもこのツールだけが取りに行くことになる。
INCLUDE_ADULT_CONTENT = _cfg_bool("include_adult_content", "INCLUDE_ADULT_CONTENT", False)

# プロンプトにしか痕跡が無い LoRA を自動ダウンロードするか。
# 対話実行の既定は従来どおり有効。ただし**無人実行では強制的に無効**にする
# （下の UNATTENDED 参照）。Civitai ToS §11.9 は「自動化でシステムや統計を
# 操作すること」を禁じており、無人でのモデル取得はダウンロード数へ自動加算される
# 唯一の経路にあたるため。
AUTO_DOWNLOAD_MISSING_LORAS = _cfg_bool("auto_download_missing_loras", "AUTO_DOWNLOAD_MISSING_LORAS", True)

# 無人実行（スケジューラ・自動同期から起動された）かどうか。
# 人が画面を見ていない前提で、副作用のある動作を絞る。
UNATTENDED = os.environ.get("CIVITAI_SYNC_UNATTENDED", "") == "1"

_RATE_MIN_INTERVAL = {
    "civitai": CIVITAI_MIN_INTERVAL_SEC,
    "raindrop": RAINDROP_MIN_INTERVAL_SEC,
}
_RATE_LAST_REQUEST_AT = {}
_RATE_CONSECUTIVE_DENIALS = {}


class RateLimitAbort(BaseException):
    """これ以上叩かずに同期全体を止めるための停止シグナル。

    **`Exception` ではなく `BaseException` を継承しているのは意図的**。
    このファイルには `except Exception` が31箇所あり（画像1枚の失敗で
    同期全体を止めないための設計）、`Exception` を継承すると停止シグナルが
    そこで握りつぶされる。そうなるとレート制限を踏んでも同期が走り続け、
    規約対応が実質的に無効になる。無人実行では誰も気づけない。
    KeyboardInterrupt と同じ扱いにして、必ず最上位まで浮かせる。

    捕まえてよいのは `main()` と `__main__` ブロックだけ。
    """


def _rate_host(url):
    """レート制御の対象ホストを返す。対象外なら空文字。"""
    lowered = str(url).lower()
    if "api.raindrop.io" in lowered:
        return "raindrop"
    if "civitai.com" in lowered or "civitai.red" in lowered:
        return "civitai"
    return ""


def _rate_wait_for_slot(host):
    """同一ホストへの最小間隔を守る。"""
    interval = _RATE_MIN_INTERVAL.get(host, 0.0)
    if interval <= 0:
        return
    last = _RATE_LAST_REQUEST_AT.get(host)
    if last is None:
        return
    elapsed = time.monotonic() - last
    if elapsed < interval:
        time.sleep(interval - elapsed)


def _rate_parse_retry_after(response):
    """Retry-After を秒で返す。無い・読めないなら None。"""
    raw = (response.headers or {}).get("Retry-After")
    if not raw:
        return None
    try:
        return max(0.0, float(str(raw).strip()))
    except (TypeError, ValueError):
        # HTTP-date 形式は扱わない（指数バックオフへ委ねる）。
        return None


def _rate_honor_remaining(host, response):
    """X-RateLimit-Remaining が僅少ならリセットまで待つ（Raindrop 向け）。"""
    if host != "raindrop":
        return
    headers = response.headers or {}
    remaining_raw = headers.get("X-RateLimit-Remaining")
    if remaining_raw is None:
        return
    try:
        remaining = int(float(remaining_raw))
    except (TypeError, ValueError):
        return
    if remaining > RAINDROP_REMAINING_FLOOR:
        return
    try:
        reset_epoch = float(headers.get("X-RateLimit-Reset", ""))
    except (TypeError, ValueError):
        # リセット時刻が読めないときは 1 分待てば必ず窓が変わる。
        time.sleep(60.0)
        return
    wait = reset_epoch - time.time()
    if wait > 0:
        print(f"[~] Raindrop の残枠が {remaining} 件です。{wait:.0f} 秒待ちます。")
        time.sleep(min(wait, 120.0))


def request_with_policy(method, url, **kwargs):
    """外部API向けの requests ラッパー。規約側のレート制限を守る。

    ローカル（ComfyUI）や制御対象外ホストは素通しする。
    stream=True でも呼べるよう、応答オブジェクトをそのまま返す。

    Raises:
        RateLimitAbort: リトライを使い切った 429、または 401/403 の連続超過。
    """
    host = _rate_host(url)
    if not host:
        return requests.request(method, url, **kwargs)

    attempt = 0
    while True:
        _rate_wait_for_slot(host)
        _RATE_LAST_REQUEST_AT[host] = time.monotonic()
        response = requests.request(method, url, **kwargs)
        status = response.status_code

        if status in (429, 503):
            attempt += 1
            if attempt > HTTP_MAX_RETRIES:
                raise RateLimitAbort(
                    f"{host} が HTTP {status} を返し続けています"
                    f"（{HTTP_MAX_RETRIES} 回リトライ済み）。"
                    "レート制限に触れているため同期を中止します。"
                )
            wait = _rate_parse_retry_after(response)
            if wait is None:
                wait = min(HTTP_BACKOFF_BASE_SEC ** attempt, HTTP_BACKOFF_CAP_SEC)
            print(f"[~] {host} が HTTP {status}。{wait:.0f} 秒待って再試行します（{attempt}/{HTTP_MAX_RETRIES}）。")
            emit_event("rate_limited", host=host, status=status, wait_seconds=round(wait, 1), attempt=attempt)
            try:
                response.close()
            except Exception:
                pass
            time.sleep(wait)
            continue

        if status in (401, 403):
            denials = _RATE_CONSECUTIVE_DENIALS.get(host, 0) + 1
            _RATE_CONSECUTIVE_DENIALS[host] = denials
            if denials >= HTTP_ABORT_AFTER_DENIALS:
                raise RateLimitAbort(
                    f"{host} が HTTP {status} を {denials} 回連続で返しました。"
                    "資格情報かアクセス権の問題と判断して同期を中止します。"
                )
        else:
            _RATE_CONSECUTIVE_DENIALS[host] = 0

        _rate_honor_remaining(host, response)
        return response


def with_civitai_auth(headers):
    """Civitai 公開API向けのヘッダを組む。APIキーは必ず Authorization で送る。

    **URL のクエリ文字列（`?token=...`）に載せない。** クエリはアクセスログ・
    プロキシ・Referer・ブラウザ履歴にそのまま残るため、鍵の置き場所として不適切。
    Civitai 自身も API トークンについて「パスワードと同様に扱え」と案内している。
    公開API は Bearer 認証を受け付けるので、ヘッダだけで用が足りる。

    呼び出し元が既に Authorization を持っていればそれを尊重する
    （検証済み外部ミラーへ Civitai の鍵を送らないための既存の配慮を壊さない）。
    """
    merged = dict(headers or {})
    if CIVITAI_API_KEY and not merged.get("Authorization"):
        merged["Authorization"] = f"Bearer {CIVITAI_API_KEY}"
    return merged


def civitai_browsing_params():
    """成人向けを含めるかどうかを URL パラメータ片として返す。

    既定は空＝**含めない**。`nsfw=X&browsingLevel=255` を無条件に付けると、
    利用者が Civitai 側で成人向けを非表示にしていても取りに行くことになる。
    配布物では利用者が選べる必要があるので設定に出す。
    """
    if not INCLUDE_ADULT_CONTENT:
        return ""
    return "&nsfw=X&browsingLevel=255"


def get_with_policy(url, **kwargs):
    """GET のショートハンド。"""
    return request_with_policy("GET", url, **kwargs)


def post_with_policy(url, **kwargs):
    """POST のショートハンド。"""
    return request_with_policy("POST", url, **kwargs)

# =====================================================================


ANALYZE_ENDPOINT = f"{COMFY_BASE_URL}/api/lm/recipes/analyze-image"
SAVE_ENDPOINT = f"{COMFY_BASE_URL}/api/lm/recipes/save"
SCAN_ENDPOINT = f"{COMFY_BASE_URL}/api/lm/recipes/scan"
RECIPE_SOURCE_POLICY = "embedded-first-v1"
REIMPORT_ENDPOINT_TEMPLATE = f"{COMFY_BASE_URL}/api/lm/recipe/{{recipe_id}}/reimport"

def get_civitai_image_info(url):
    """URLからCivitaiのドメイン(com/red)と画像IDを抽出する関数"""
    match = re.search(r'civitai\.(com|red)/images/(\d+)', url)
    if match:
        return match.group(1), match.group(2)
    return None, None

def safe_int(val, default=0):
    """例外を発生させずに安全に数値をキャストするヘルパー関数"""
    try:
        if val is None:
            return default
        return int(val)
    except (ValueError, TypeError):
        return default


def safe_float(val, default=1.0):
    """例外を発生させずにLoRA強度を数値化する。"""
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


def normalize_for_lora_manager_save(recipe_metadata):
    """
    Lora-Managerの保存APIが受け取る画面用スキーマへ統一する。

    補完処理は.recipe.json用の ``modelVersionId/modelName/strength`` を使うが、
    保存APIは ``id/name/weight`` だけを読む。この変換をせずに送ると、LoRA名と
    バージョンIDが空のまま保存され、レシピ上で Null / 0 になってしまう。
    """
    normalized = dict(recipe_metadata)
    loras = []

    for lora in recipe_metadata.get("loras", []):
        if not isinstance(lora, dict):
            continue

        version_id = safe_int(lora.get("id") or lora.get("modelVersionId"))
        model_id = safe_int(lora.get("modelId"))
        name = str(lora.get("name") or lora.get("modelName") or "").strip()
        version = str(lora.get("version") or lora.get("modelVersionName") or "").strip()
        file_name = str(lora.get("file_name") or "").strip()
        model_hash = str(lora.get("hash") or "").strip()

        # 名前もバージョンIDも無いエントリは、Lora-Manager側でNullにしかならない。
        if not name and not version_id:
            print("    -> [!] 名前・バージョンIDを解決できないLoRAを保存対象から除外しました。")
            continue

        normalized_lora = dict(lora)
        normalized_lora.update({
            "id": version_id,
            "modelId": model_id,
            "name": name,
            "version": version,
            "weight": safe_float(lora.get("weight", lora.get("strength", 1.0))),
            "file_name": file_name,
            "hash": model_hash,
            "isDeleted": bool(lora.get("isDeleted", False)),
            "exclude": bool(lora.get("exclude", False)),
        })
        loras.append(normalized_lora)

    normalized["loras"] = loras

    embeddings = []
    for embedding in recipe_metadata.get("embeddings", []):
        if not isinstance(embedding, dict):
            continue
        version_id = safe_int(embedding.get("id") or embedding.get("modelVersionId"))
        model_id = safe_int(embedding.get("modelId"))
        name = str(embedding.get("name") or embedding.get("modelName") or "").strip()
        if not name and not version_id:
            continue
        normalized_embedding = dict(embedding)
        normalized_embedding.update({
            "type": "embedding",
            "id": version_id,
            "modelVersionId": version_id,
            "modelId": model_id,
            "name": name,
            "modelName": name,
            "version": str(embedding.get("version") or embedding.get("modelVersionName") or "").strip(),
            "file_name": str(embedding.get("file_name") or name).strip(),
            "hash": str(embedding.get("hash") or "").lower(),
            "isDeleted": bool(embedding.get("isDeleted", False)),
            "exclude": bool(embedding.get("exclude", False)),
        })
        embeddings.append(normalized_embedding)
    normalized["embeddings"] = embeddings

    # 解析APIの返却値には checkpoint ではなく model で入る版があるため、
    # 保存前に同じ情報をcheckpointへも置く。
    if not isinstance(normalized.get("checkpoint"), dict) and isinstance(normalized.get("model"), dict):
        normalized["checkpoint"] = dict(normalized["model"])

    return normalized


def get_civitai_model_id(version_data):
    """Civitaiのモデル親IDを、現在と旧形式の両方から取り出す。"""
    model = version_data.get("model") or {}
    return safe_int(model.get("id") or model.get("modelId") or version_data.get("modelId"))


def fetch_civitai_version(version_id, headers, cache=None):
    """モデルバージョン情報を取得する。実行中は同じIDへの問い合わせを再利用する。"""
    version_id = safe_int(version_id)
    if not version_id:
        return None

    if cache is not None and version_id in cache:
        return cache[version_id]

    try:
        response = get_with_policy(
            f"https://civitai.com/api/v1/model-versions/{version_id}",
            headers=with_civitai_auth(headers),
            timeout=15,
        )
        version_data = response.json() if response.status_code == 200 else None
    except Exception:
        version_data = None

    if cache is not None:
        cache[version_id] = version_data
    return version_data


def backfill_saved_recipe_model_ids(recipe_dir, headers):
    """保存時に欠落したLoRAの親モデルIDを既存.recipe.jsonへ戻す。"""
    repaired_recipes = 0
    repaired_loras = 0

    if not os.path.isdir(recipe_dir):
        return repaired_recipes, repaired_loras

    recipes = []
    missing_version_ids = set()
    for root, _, files in os.walk(recipe_dir):
        for filename in files:
            if not filename.lower().endswith(".recipe.json"):
                continue

            json_path = os.path.join(root, filename)
            try:
                with open(json_path, "r", encoding="utf-8") as file_obj:
                    recipe_data = json.load(file_obj)
            except Exception:
                continue

            recipes.append((json_path, filename, recipe_data))
            for lora in recipe_data.get("loras") or []:
                if isinstance(lora, dict) and not safe_int(lora.get("modelId")):
                    version_id = safe_int(lora.get("modelVersionId") or lora.get("id"))
                    if version_id:
                        missing_version_ids.add(version_id)

    version_cache = {}
    if missing_version_ids:
        # 数百件ある場合もCivitaiへ負荷を掛けすぎないよう、少数並列で取得する。
        with ThreadPoolExecutor(max_workers=6) as executor:
            futures = {
                executor.submit(fetch_civitai_version, version_id, headers): version_id
                for version_id in missing_version_ids
            }
            for future in as_completed(futures):
                version_id = futures[future]
                try:
                    version_cache[version_id] = future.result()
                except Exception:
                    version_cache[version_id] = None

    for json_path, filename, recipe_data in recipes:
        changed = False
        for lora in recipe_data.get("loras") or []:
            if not isinstance(lora, dict) or safe_int(lora.get("modelId")):
                continue

            version_id = safe_int(lora.get("modelVersionId") or lora.get("id"))
            version_data = version_cache.get(version_id)
            model_id = get_civitai_model_id(version_data or {})
            if not model_id:
                continue

            lora["modelId"] = model_id
            changed = True
            repaired_loras += 1

        if changed:
            try:
                temp_path = f"{json_path}.tmp"
                with open(temp_path, "w", encoding="utf-8") as file_obj:
                    json.dump(recipe_data, file_obj, indent=4, ensure_ascii=False)
                os.replace(temp_path, json_path)
                repaired_recipes += 1
            except Exception as exc:
                print(f"    -> [!] リンク補完の保存に失敗: {filename} ({exc})")

    return repaired_recipes, repaired_loras


def refresh_lora_manager_recipes():
    """外部更新した.recipe.jsonをLora-Managerへ再読込させる。"""
    try:
        response = get_with_policy(SCAN_ENDPOINT, timeout=60)
        return response.status_code == 200
    except Exception:
        return False

def has_resolved_recipe_resources(recipe_data):
    """再実行をスキップしてよい、完全なレシピかを判定する。"""
    if not isinstance(recipe_data, dict):
        return False

    checkpoint = recipe_data.get("checkpoint") or recipe_data.get("model")
    if not isinstance(checkpoint, dict):
        return False
    if not (
        safe_int(checkpoint.get("id") or checkpoint.get("modelVersionId"))
        and safe_int(checkpoint.get("modelId"))
        and str(checkpoint.get("name") or checkpoint.get("modelName") or "").strip()
    ):
        return False

    for lora in recipe_data.get("loras") or []:
        if not isinstance(lora, dict):
            return False
        local_path = str(lora.get("localPath") or "").strip()
        local_verified = bool(lora.get("inLibrary") and local_path and os.path.isfile(local_path) and lora.get("hash"))
        if not local_verified and not (
            safe_int(lora.get("modelVersionId") or lora.get("id"))
            and safe_int(lora.get("modelId"))
            and str(lora.get("modelName") or lora.get("name") or "").strip()
        ):
            return False

    return True


def get_synced_image_ids(recipe_dir):
    """保存済みレシピに対応するCivitai画像IDを返す。

    リソースが未解決でも、同じCivitai画像を保存APIへ再送してはいけない。
    保存APIは毎回UUIDを採番するため、未解決チェックポイントを含む画像が実行の
    たびに別レシピとして増殖してしまう。既存レシピの改善は新規保存ではなく、
    ``reimport_stale_civitai_recipes`` が同じIDに対して行う。
    """
    synced_ids = set()
    if not os.path.exists(recipe_dir):
        return synced_ids

    for filename in os.listdir(recipe_dir):
        if filename.endswith(".recipe.json"):
            filepath = os.path.join(recipe_dir, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                    recipe_data = json.loads(content)

                image_ids = set(re.findall(r'images/(\d+)', content))
                image_ids.update(re.findall(r'civitai_(\d+)', content))
                if not image_ids:
                    continue

                synced_ids.update(image_ids)
            except Exception:
                pass
                
    return synced_ids


def quarantine_duplicate_civitai_recipes(recipe_dir):
    """同一Civitai画像を指す重複レシピを可逆的に隔離する。

    解析済みの.recipe.jsonは削除せず、選ばれなかったものの末尾を
    ``.duplicate`` に変える。Lora-Managerとこのスクリプトは
    ``.recipe.json`` だけをレシピとして読むため、一覧からは消え、必要なら
    拡張子を戻すだけで復元できる。
    """
    groups = {}
    for filename in os.listdir(recipe_dir):
        if not filename.endswith(".recipe.json"):
            continue
        path = os.path.join(recipe_dir, filename)
        try:
            with open(path, "r", encoding="utf-8") as file_obj:
                recipe = json.load(file_obj)
        except (OSError, ValueError, TypeError):
            continue

        source_path = str(recipe.get("source_path") or "")
        match = re.search(r"civitai\.(?:com|red)/images/(\d+)", source_path)
        if not match:
            continue

        image_id = match.group(1)
        prompt = str((recipe.get("gen_params") or {}).get("prompt") or "").strip()
        source_rank = {
            "embedded_comfy": 4,
            "embedded_a1111": 3,
            "civitai_generation_data": 2,
            "reconstructed": 1,
        }.get(str(recipe.get("generation_source") or ""), 0)
        checkpoint = recipe.get("checkpoint") or recipe.get("model") or {}
        resource_rank = int(bool(prompt)) + int(bool(checkpoint))
        modified = safe_float(recipe.get("modified"), 0.0)
        groups.setdefault(image_id, []).append(
            (source_rank, resource_rank, modified, filename, path)
        )

    quarantined = []
    kept = {}
    for image_id, entries in groups.items():
        if len(entries) < 2:
            continue
        # 元画像の埋込情報、プロンプト/資源の有無、最終更新日時の順で残す。
        entries.sort(reverse=True)
        kept[image_id] = entries[0][3]
        for _, _, _, filename, path in entries[1:]:
            quarantine_path = f"{path}.duplicate"
            if os.path.exists(quarantine_path):
                continue
            os.replace(path, quarantine_path)
            quarantined.append(filename)

    return {
        "groups": len(kept),
        "quarantined": len(quarantined),
        "kept": kept,
    }


def reimport_stale_civitai_recipes(recipe_dir, limit=25, delay=0.25):
    """現行の元画像優先ポリシーで未解析のCivitaiレシピを再取込する。

    旧レシピはプロンプトが存在していてもA1111のHiRes/AddNet情報を失って
    いる可能性があるため、空プロンプトだけでなくポリシー印のない全件を
    対象にする。新ポリシーを公開するサーバーだけで実行し、旧ComfyUIへ
    誤って大量再取込しない。
    """
    result = {
        "candidates": 0,
        "attempted": 0,
        "reimported": 0,
        "failed": 0,
        "remaining": 0,
        "server_ready": False,
    }
    try:
        health = get_with_policy(
            f"{COMFY_BASE_URL}/api/lm/health-check", timeout=5
        ).json()
        if health.get("recipe_generation_source_policy") != RECIPE_SOURCE_POLICY:
            print(
                "[!] 元画像優先の再取込機能が未読込です。ComfyUIを再起動してから再実行してください。"
            )
            return result
        result["server_ready"] = True
    except Exception as exc:
        print(f"[!] 既存レシピ再取込を開始できません: {exc}")
        return result

    candidates = []
    for filename in os.listdir(recipe_dir):
        if not filename.endswith(".recipe.json"):
            continue
        path = os.path.join(recipe_dir, filename)
        try:
            with open(path, "r", encoding="utf-8") as file_obj:
                recipe = json.load(file_obj)
        except Exception:
            continue
        source_path = str(recipe.get("source_path") or "")
        if not re.search(r"civitai\.(?:com|red)/images/\d+", source_path):
            continue
        if recipe.get("generation_source_policy") == RECIPE_SOURCE_POLICY:
            continue
        gen_params = recipe.get("gen_params") or {}
        has_prompt = bool(
            str(gen_params.get("prompt") or gen_params.get("positivePrompt") or "").strip()
        )
        candidates.append((has_prompt, filename, str(recipe.get("id") or "")))

    # 明確に壊れている空プロンプトを先に直し、その後に情報欠落の可能性が
    # ある旧レシピを安定したファイル名順で移行する。
    candidates.sort(key=lambda item: (item[0], item[1].lower()))
    result["candidates"] = len(candidates)
    selected = candidates if not limit or limit < 0 else candidates[:limit]

    for _, filename, recipe_id in selected:
        if not recipe_id:
            result["failed"] += 1
            continue
        result["attempted"] += 1
        try:
            response = post_with_policy(
                REIMPORT_ENDPOINT_TEMPLATE.format(recipe_id=recipe_id),
                json={},
                timeout=180,
            )
            payload = response.json() if response.content else {}
            new_recipe_id = payload.get("recipe_id")
            new_json_path = (
                os.path.join(recipe_dir, f"{new_recipe_id}.recipe.json")
                if new_recipe_id
                else ""
            )
            if response.status_code != 200 or not payload.get("success"):
                raise RuntimeError(payload.get("error") or response.text)
            if not new_json_path or not os.path.isfile(new_json_path):
                raise RuntimeError("再取込後のレシピJSONが見つかりません")
            with open(new_json_path, "r", encoding="utf-8") as file_obj:
                updated = json.load(file_obj)
            if updated.get("generation_source_policy") != RECIPE_SOURCE_POLICY:
                raise RuntimeError("再取込後のレシピに元画像優先ポリシーがありません")
            result["reimported"] += 1
            print(
                f"    -> [元画像優先へ移行] {filename}: "
                f"{updated.get('generation_source', 'unknown')}"
            )
        except Exception as exc:
            result["failed"] += 1
            print(f"    -> [再取込失敗] {filename}: {exc}")
        if delay:
            time.sleep(delay)

    result["remaining"] = max(0, result["candidates"] - result["reimported"])
    return result

# =====================================================================
# 🌟 完全・安全設計：成人向け(NSFW)モデル・LoRA・Embedding自動補完エンジン
# =====================================================================
def _sha256_file(path, chunk_size=1024 * 1024):
    """ローカルファイルのSHA256ハッシュを計算する（Civitaiのハッシュ表記に合わせ大文字で返す）"""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest().upper()


def _load_hash_cache_file():
    if os.path.exists(HASH_CACHE_PATH):
        try:
            with open(HASH_CACHE_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save_hash_cache_file(cache):
    try:
        with open(HASH_CACHE_PATH, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
    except Exception:
        pass


_LOCAL_HASH_INDEX_CACHE = {"built": False, "index": {}}


def build_local_hash_index():
    """
    LORA_MODELS_DIR / CHECKPOINT_MODELS_DIR 以下の .safetensors/.ckpt/.pt/.pth を走査し、
    「ファイル名(拡張子抜き、小文字) -> {hash, path}」の索引を作る。
    civitai.red側の名前解決バグ・検索APIの不具合・ボット判定によるブロックを
    まったく経由せず、ローカルの実ファイルから直接ハッシュを得るための仕組み。
    再走査コストを抑えるため、mtime+sizeをキーにしたキャッシュファイル(HASH_CACHE_PATH)を使う。
    プロセス内では一度構築したら再利用する（複数画像の処理をまたいで使い回す）。
    """
    if _LOCAL_HASH_INDEX_CACHE["built"]:
        return _LOCAL_HASH_INDEX_CACHE["index"]

    disk_cache = _load_hash_cache_file()
    index = {}
    dirty = False

    for base_dir in [LORA_MODELS_DIR, CHECKPOINT_MODELS_DIR]:
        if not base_dir or not os.path.exists(base_dir):
            continue
        for root, dirs, files in os.walk(base_dir):
            dirs[:] = [d for d in dirs if d.lower() != "recipes"]  # レシピ保存フォルダは除外
            for filename in files:
                ext = os.path.splitext(filename)[1].lower()
                if ext not in (".safetensors", ".ckpt", ".pt", ".pth"):
                    continue
                full_path = os.path.join(root, filename)
                try:
                    stat = os.stat(full_path)
                    cached = disk_cache.get(full_path)
                    if cached and cached.get("mtime") == stat.st_mtime and cached.get("size") == stat.st_size:
                        file_hash = cached["hash"]
                    else:
                        file_hash = _sha256_file(full_path)
                        disk_cache[full_path] = {"hash": file_hash, "mtime": stat.st_mtime, "size": stat.st_size}
                        dirty = True

                    name_key = os.path.splitext(filename)[0].lower()
                    index[name_key] = {"hash": file_hash, "path": full_path}
                except Exception:
                    continue

    if dirty:
        _save_hash_cache_file(disk_cache)

    _LOCAL_HASH_INDEX_CACHE["built"] = True
    _LOCAL_HASH_INDEX_CACHE["index"] = index
    print(f"[+] ローカルLoRA/チェックポイントのハッシュ索引を構築しました（{len(index)} 件）。")
    return index


def find_local_hash_by_name(index, name_hint):
    """
    name_hint（プロンプトの<lora:xxx>名やCheckpointのmodelName等）に最も近い
    ローカルファイルのハッシュを返す。完全一致 -> 区切り文字を無視した部分一致の順で探す。
    """
    if not name_hint:
        return None
    key = name_hint.strip().lower()
    if key in index:
        return index[key]["hash"]

    normalized = re.sub(r'[\s_\-]+', '', key)
    if not normalized:
        return None
    for name_key, data in index.items():
        candidate = re.sub(r'[\s_\-]+', '', name_key)
        if normalized == candidate or normalized in candidate or candidate in normalized:
            return data["hash"]
    return None


def find_local_lora_by_tag(index, tag_name):
    """プロンプトタグは区切り文字無視の完全一致だけを採用し、誤った部分一致を避ける。"""
    target = normalize_lora_tag_name(tag_name)
    matches = [data for name, data in index.items() if normalize_lora_tag_name(name) == target]
    return matches[0] if len(matches) == 1 else None


def normalize_lora_tag_name(value):
    """LoRAタグ名を拡張子・区切り文字・大小文字に依存しない照合キーへ変換する。"""
    name = os.path.basename(str(value or "").replace("\\", "/"))
    name = re.sub(r'\.(?:safetensors|ckpt|pt|pth)$', '', name, flags=re.IGNORECASE)
    return re.sub(r'[^a-z0-9]+', '', name.lower())


def lora_name_tokens(value):
    """LoRA名をcamelCaseと区切り文字の双方で分割した比較用トークンへ変換する。"""
    name = os.path.basename(str(value or "").replace("\\", "/"))
    name = re.sub(r'\.(?:safetensors|ckpt|pt|pth)$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name).lower()
    generic_tokens = {
        "lora", "locon", "style", "model", "version", "sd", "sdxl", "xl",
        "pony", "illustrious", "safetensors", "safetensor", "checkpoint",
    }
    return [
        token for token in re.split(r'[^a-z0-9]+', name)
        if len(token) >= 2
        and token not in generic_tokens
        and not re.fullmatch(r'v?\d+(?:\.\d+)?', token)
    ]


def bigram_dice(left, right):
    """短い別名にも過剰反応しない文字bigram Dice係数を返す。"""
    if left == right:
        return 1.0
    if len(left) < 2 or len(right) < 2:
        return 0.0
    counts = {}
    for index in range(len(left) - 1):
        pair = left[index:index + 2]
        counts[pair] = counts.get(pair, 0) + 1
    intersection = 0
    for index in range(len(right) - 1):
        pair = right[index:index + 2]
        count = counts.get(pair, 0)
        if count:
            intersection += 1
            counts[pair] = count - 1
    return (2.0 * intersection) / (len(left) + len(right) - 2)


def lora_name_similarity(left, right):
    """ファイル名・公開名・プロンプト別名の高信頼照合スコアを返す。"""
    left_compact = normalize_lora_tag_name(left)
    right_compact = normalize_lora_tag_name(right)
    if not left_compact or not right_compact:
        return 0.0
    if left_compact == right_compact:
        return 1.0

    shorter, longer = sorted((left_compact, right_compact), key=len)
    length_ratio = len(shorter) / len(longer)
    score = 0.0
    if len(shorter) >= 6 and shorter in longer:
        score = 0.82 + (0.16 * length_ratio)

    left_tokens = set(lora_name_tokens(left))
    right_tokens = set(lora_name_tokens(right))
    if left_tokens and right_tokens:
        common = len(left_tokens & right_tokens)
        containment = common / min(len(left_tokens), len(right_tokens))
        union = len(left_tokens | right_tokens)
        jaccard = common / union if union else 0.0
        score = max(score, (0.72 * containment) + (0.28 * jaccard))

    return max(score, bigram_dice(left_compact, right_compact) * 0.9)


def lora_resource_names(lora):
    """構造化LoRAが持つ実ファイル名・公開名・既知別名を列挙する。"""
    civitai = lora.get("civitai") or {}
    names = [
        lora.get("file_name"), lora.get("filename"), lora.get("name"),
        lora.get("modelName"), lora.get("modelVersionName"),
        civitai.get("name"), (civitai.get("model") or {}).get("name"),
    ]
    names.extend(lora.get("promptAliases") or [])
    names.extend(lora.get("aliases") or [])
    names.extend(file_info.get("name") for file_info in (civitai.get("files") or []))
    return [str(name) for name in names if name]


def match_prompt_lora_resource(tag_name, loras, excluded_indices=None):
    """一意かつ十分高いスコアの構造化LoRAだけをプロンプト別名へ対応付ける。"""
    tag_key = normalize_lora_tag_name(tag_name)
    if len(tag_key) < 6:
        return None
    ranked = []
    excluded_indices = set(excluded_indices or [])
    for index, lora in enumerate(loras or []):
        if index in excluded_indices:
            continue
        score = max([lora_name_similarity(tag_name, name) for name in lora_resource_names(lora)] or [0.0])
        ranked.append((score, index))
    ranked.sort(reverse=True)
    if not ranked or ranked[0][0] < 0.62:
        return None
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.12:
        return None
    return ranked[0][1], ranked[0][0]


def register_prompt_lora_alias(lora, tag_name, tag_weight):
    """別名と画像固有の強度を構造化LoRAへ永続化する。"""
    aliases = list(dict.fromkeys([*(lora.get("promptAliases") or []), tag_name]))
    lora["promptAliases"] = aliases
    lora["strength"] = safe_float(tag_weight, lora.get("strength", 1.0))
    return lora


_PROMPT_LORA_RECIPE_CATALOG_CACHE = {"built": False, "index": {}}


def build_prompt_lora_recipe_catalog():
    """既存レシピを、別レシピのプロンプトLoRA解決に再利用できるローカル台帳へする。"""
    if _PROMPT_LORA_RECIPE_CATALOG_CACHE["built"]:
        return _PROMPT_LORA_RECIPE_CATALOG_CACHE["index"]

    index = {}
    try:
        recipe_files = [
            os.path.join(RECIPE_DIR, name)
            for name in os.listdir(RECIPE_DIR)
            if name.endswith(".recipe.json")
        ]
    except OSError:
        recipe_files = []

    for recipe_path in recipe_files:
        try:
            with open(recipe_path, "r", encoding="utf-8") as file_obj:
                recipe = json.load(file_obj)
        except (OSError, ValueError, TypeError):
            continue
        for lora in recipe.get("loras") or []:
            version_id = safe_int(lora.get("modelVersionId") or lora.get("id"))
            resource_hash = str(lora.get("hash") or "").lower()
            if not version_id or not re.fullmatch(r"[0-9a-f]{64}", resource_hash):
                continue
            record = {
                "lora": lora,
                "base_model": (lora.get("civitai") or {}).get("baseModel") or recipe.get("base_model"),
                "version_id": version_id,
                "hash": resource_hash,
            }
            for name in lora_resource_names(lora):
                key = normalize_lora_tag_name(name)
                if key:
                    index.setdefault(key, {})[(version_id, resource_hash)] = record

    _PROMPT_LORA_RECIPE_CATALOG_CACHE["built"] = True
    _PROMPT_LORA_RECIPE_CATALOG_CACHE["index"] = index
    return index


def find_recipe_catalog_prompt_lora(tag_name, headers, recipe_base_model=None):
    """同名の既存レシピ資源が一意なら、Civitai再検索より優先して再利用する。"""
    records = list(build_prompt_lora_recipe_catalog().get(normalize_lora_tag_name(tag_name), {}).values())
    records = [
        record for record in records
        if is_compatible_lora_base(recipe_base_model, record.get("base_model"))
    ]
    if len(records) != 1:
        return None

    record = records[0]
    lora = record["lora"]
    version_data = lora.get("civitai") or fetch_civitai_version(record["version_id"], headers)
    if not version_data:
        return None
    files = [file_info for file_info in (version_data.get("files") or []) if is_safe_civitai_lora_file(file_info)]
    if not files:
        return None

    preferred = next(
        (file_info for file_info in files if normalize_lora_tag_name(file_info.get("name")) == normalize_lora_tag_name(tag_name)),
        None,
    )
    if preferred is None:
        preferred = next(
            (file_info for file_info in files if str((file_info.get("hashes") or {}).get("SHA256") or "").lower() == record["hash"]),
            None,
        )
    if preferred is None:
        return None

    download_url = (
        preferred.get("downloadUrl")
        or version_data.get("downloadUrl")
        or f"https://civitai.com/api/download/models/{record['version_id']}"
    ).replace("civitai.red", "civitai.com")
    return {
        "score": 1.0,
        "exact": True,
        "model_id": get_civitai_model_id(version_data),
        "version_id": record["version_id"],
        "model_name": (version_data.get("model") or {}).get("name") or lora.get("modelName") or tag_name,
        "version_name": version_data.get("name") or lora.get("modelVersionName") or "",
        "base_model": version_data.get("baseModel") or record.get("base_model") or "",
        "file_name": os.path.basename(preferred["name"]),
        "sha256": preferred["hashes"]["SHA256"].lower(),
        "url": download_url,
    }


def calculate_file_sha256(file_path):
    """大きなモデルをメモリへ載せずにSHA256を計算する。"""
    digest = hashlib.sha256()
    with open(file_path, "rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().lower()


def load_prompt_lora_resolution_cache():
    try:
        with open(PROMPT_LORA_RESOLUTION_CACHE_PATH, "r", encoding="utf-8") as file_obj:
            data = json.load(file_obj)
            return data if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def save_prompt_lora_resolution_cache(cache):
    os.makedirs(PROMPT_LORA_FALLBACK_DIR, exist_ok=True)
    temp_path = f"{PROMPT_LORA_RESOLUTION_CACHE_PATH}.tmp"
    with open(temp_path, "w", encoding="utf-8") as file_obj:
        json.dump(cache, file_obj, ensure_ascii=False, indent=2)
    os.replace(temp_path, PROMPT_LORA_RESOLUTION_CACHE_PATH)


def lora_base_family(value):
    value = str(value or "").lower()
    if "flux" in value:
        return "flux"
    if any(marker in value for marker in ("sdxl", "sd xl", "pony", "illustrious", "noobai", "animagine")):
        return "sdxl"
    if any(marker in value for marker in ("sd 1", "sd1", "1.5")):
        return "sd15"
    return ""


def is_compatible_lora_base(recipe_base_model, candidate_base_model):
    recipe_family = lora_base_family(recipe_base_model)
    candidate_family = lora_base_family(candidate_base_model)
    return not recipe_family or not candidate_family or recipe_family == candidate_family


def is_safe_civitai_lora_file(file_info):
    """自動取得対象をSHA付きSafeTensorのモデル本体だけに制限する。"""
    name = str(file_info.get("name") or "")
    metadata = file_info.get("metadata") or {}
    file_format = str(metadata.get("format") or "").lower()
    sha256 = str((file_info.get("hashes") or {}).get("SHA256") or "").lower()
    scan_values = {
        str(file_info.get("pickleScanResult") or "").lower(),
        str(file_info.get("virusScanResult") or "").lower(),
    }
    return bool(
        name.lower().endswith(".safetensors")
        and (not file_format or file_format == "safetensor")
        and re.fullmatch(r"[0-9a-f]{64}", sha256)
        and not scan_values.intersection({"danger", "error"})
    )


def find_civitai_prompt_lora(tag_name, headers, recipe_base_model=None):
    """
    Civitaiの公開モデル検索から、タグ名と一意に高信頼一致するLoRAを探す。
    queryはモデル名検索なので、候補のファイル名・バージョン名も再採点し、
    SHA付きSafeTensorかつベースモデル互換の候補以外は採用しない。
    """
    basename_hint = os.path.basename(str(tag_name or "").replace("\\", "/"))
    humanized = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', basename_hint)
    humanized = re.sub(r'[_\\/-]+', ' ', humanized)
    search_stopwords = {
        "lora", "locon", "style", "sd", "sdxl", "xl", "pony", "illustrious",
        "hololive", "version", "model", "checkpoint", "safetensors", "safetensor",
    }
    distinctive_tokens = [
        token for token in lora_name_tokens(humanized)
        if token not in search_stopwords and not re.fullmatch(r'v?\d+(?:\d+)?', token)
    ]
    distinctive_query = " ".join(distinctive_tokens[:5])
    pair_queries = [
        " ".join(distinctive_tokens[index:index + 2])
        for index in range(max(0, len(distinctive_tokens) - 1))
        if len(distinctive_tokens[index]) >= 3 and len(distinctive_tokens[index + 1]) >= 3
    ]
    queries = list(dict.fromkeys(filter(None, [
        basename_hint.strip(), humanized.strip(), distinctive_query.strip(), *pair_queries,
    ])))[:6]
    candidates = {}

    for query in queries:
        try:
            response = get_with_policy(
                "https://civitai.com/api/v1/models",
                headers=headers,
                params={"limit": 100, "types": "LORA", "query": query},
                timeout=30,
            )
            if response.status_code != 200:
                continue
            models = response.json().get("items", [])
        except Exception:
            continue

        for model in models:
            if str(model.get("type") or "").lower() not in ("lora", "locon"):
                continue
            for version in model.get("modelVersions") or []:
                if not is_compatible_lora_base(recipe_base_model, version.get("baseModel")):
                    continue
                for file_info in version.get("files") or []:
                    if not is_safe_civitai_lora_file(file_info):
                        continue
                    labels = [
                        file_info.get("name"), model.get("name"), version.get("name"),
                        f"{model.get('name', '')} {version.get('name', '')}".strip(),
                    ]
                    score = max(lora_name_similarity(tag_name, label) for label in labels if label)
                    exact = any(normalize_lora_tag_name(tag_name) == normalize_lora_tag_name(label) for label in labels if label)
                    if not exact and score < 0.90:
                        continue
                    sha256 = file_info["hashes"]["SHA256"].lower()
                    candidate = {
                        "score": score,
                        "exact": exact,
                        "model_id": safe_int(model.get("id")),
                        "version_id": safe_int(version.get("id")),
                        "model_name": model.get("name") or tag_name,
                        "version_name": version.get("name") or "",
                        "base_model": version.get("baseModel") or recipe_base_model or "",
                        "file_name": os.path.basename(file_info["name"]),
                        "sha256": sha256,
                        "url": (
                            file_info.get("downloadUrl")
                            or version.get("downloadUrl")
                            or f"https://civitai.com/api/download/models/{safe_int(version.get('id'))}"
                        ).replace("civitai.red", "civitai.com"),
                    }
                    previous = candidates.get(sha256)
                    if previous is None or candidate["score"] > previous["score"]:
                        candidates[sha256] = candidate

    ranked = sorted(candidates.values(), key=lambda item: (item["exact"], item["score"]), reverse=True)
    if not ranked:
        return None
    if len(ranked) > 1:
        first_rank = (1 if ranked[0]["exact"] else 0, ranked[0]["score"])
        second_rank = (1 if ranked[1]["exact"] else 0, ranked[1]["score"])
        if first_rank[0] == second_rank[0] and first_rank[1] - second_rank[1] < 0.08:
            print(f"    -> [保留/LoRA] '{tag_name}' はCivitai候補が複数あるため自動取得しません。")
            return None
    return ranked[0]


def download_verified_prompt_lora(tag_name, descriptor, headers):
    """期待SHA256が付いたLoRA記述子を原子的にダウンロードして検証する。"""
    os.makedirs(PROMPT_LORA_FALLBACK_DIR, exist_ok=True)
    file_name = os.path.basename(descriptor["file_name"])
    target_path = os.path.join(PROMPT_LORA_FALLBACK_DIR, file_name)
    expected_hash = descriptor["sha256"].lower()

    if os.path.isfile(target_path):
        actual_hash = calculate_file_sha256(target_path)
        if actual_hash == expected_hash:
            return {"path": target_path, "hash": actual_hash, "file_name": file_name}
        print(f"    -> [!] 既存LoRAのSHA256が一致しないため再取得します: {file_name}")

    # ここから先が「ネットワークから実際に取得する」段。
    # ローカルに既にある場合は上で返しているので、この位置のガードは
    # キャッシュ利用を妨げずに新規ダウンロードだけを止める。
    # 無人実行で止める理由は Civitai ToS §11.9（自動化による統計の操作の禁止）。
    if not AUTO_DOWNLOAD_MISSING_LORAS:
        print(f"    -> [~] 自動ダウンロードが無効なため取得しません: {file_name}")
        emit_event("auto_download_skipped", file_name=file_name, reason="disabled")
        return None

    temp_path = f"{target_path}.part"
    try:
        request_headers = {"User-Agent": (headers or {}).get("User-Agent", "Mozilla/5.0")}
        # Civitai用Bearerを検証済み外部ミラーへ送信しない。
        if "civitai.com/" in str(descriptor["url"]).lower() and (headers or {}).get("Authorization"):
            request_headers["Authorization"] = headers["Authorization"]
        with get_with_policy(descriptor["url"], headers=request_headers, stream=True, timeout=(15, 180)) as response:
            response.raise_for_status()
            digest = hashlib.sha256()
            with open(temp_path, "wb") as file_obj:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    file_obj.write(chunk)
                    digest.update(chunk)

        actual_hash = digest.hexdigest().lower()
        if actual_hash != expected_hash:
            raise ValueError(f"SHA256 mismatch: expected {expected_hash}, got {actual_hash}")

        os.replace(temp_path, target_path)
        _LOCAL_HASH_INDEX_CACHE["built"] = False
        _LOCAL_HASH_INDEX_CACHE["index"] = {}
        print(f"    -> [自動取得/LoRA] '{tag_name}' をSHA256検証後に保存しました。")
        return {"path": target_path, "hash": actual_hash, "file_name": file_name}
    except Exception as exc:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass
        print(f"    -> [!] プロンプト内LoRA '{tag_name}' の自動取得に失敗しました: {exc}")
        return None


def download_prompt_lora_fallback(tag_name, headers, recipe_base_model=None):
    """
    Civitaiから削除済み等でID解決できない既知LoRAを、検証済みSHA256の
    ミラーから原子的に取得する。成功時はローカルパスとハッシュを返す。
    """
    tag_key = normalize_lora_tag_name(tag_name)
    cache = load_prompt_lora_resolution_cache()
    cached = cache.get(tag_key)
    if cached:
        cached_path = os.path.realpath(str(cached.get("path") or ""))
        allowed_root = os.path.realpath(LORA_MODELS_DIR)
        try:
            path_allowed = os.path.commonpath([cached_path, allowed_root]) == allowed_root
        except ValueError:
            path_allowed = False
        if path_allowed and os.path.isfile(cached_path):
            actual_hash = calculate_file_sha256(cached_path)
            if actual_hash == str(cached.get("sha256") or "").lower():
                return {"path": cached_path, "hash": actual_hash, "file_name": os.path.basename(cached_path)}

    descriptor = PROMPT_LORA_FALLBACKS.get(tag_key)
    source = "verified-mirror"
    if descriptor:
        descriptor = {**descriptor}
    else:
        descriptor = find_recipe_catalog_prompt_lora(tag_name, headers, recipe_base_model)
        source = "recipe-catalog"
        if not descriptor:
            descriptor = find_civitai_prompt_lora(tag_name, headers, recipe_base_model)
            source = "civitai-search"
    if not descriptor:
        return None

    downloaded = download_verified_prompt_lora(tag_name, descriptor, headers)
    if downloaded:
        cache[tag_key] = {
            "tag": tag_name,
            "source": source,
            "path": downloaded["path"],
            "file_name": downloaded["file_name"],
            "sha256": downloaded["hash"],
            "modelId": safe_int(descriptor.get("model_id")),
            "modelVersionId": safe_int(descriptor.get("version_id")),
            "resolvedAt": int(time.time()),
        }
        save_prompt_lora_resolution_cache(cache)
    return downloaded


def reconcile_saved_recipe_prompt_loras(recipe_dir=RECIPE_DIR):
    """
    保存済みレシピを機械的に補正する。
    - 同一レシピ内の高信頼別名は promptAliases と画像固有強度へ反映
    - 別レシピに同じタグ名・単一SHAの構造化資源があれば複製
    曖昧候補や非公開タグは変更しない。
    """
    _PROMPT_LORA_RECIPE_CATALOG_CACHE["built"] = False
    _PROMPT_LORA_RECIPE_CATALOG_CACHE["index"] = {}
    catalog = build_prompt_lora_recipe_catalog()
    repaired_files = 0
    alias_count = 0
    added_resources = 0

    try:
        recipe_paths = [
            os.path.join(recipe_dir, name)
            for name in os.listdir(recipe_dir)
            if name.endswith(".recipe.json")
        ]
    except OSError:
        return repaired_files, alias_count, added_resources

    for recipe_path in recipe_paths:
        try:
            with open(recipe_path, "r", encoding="utf-8") as file_obj:
                recipe = json.load(file_obj)
        except (OSError, ValueError, TypeError):
            continue

        prompt = (recipe.get("gen_params") or {}).get("prompt") or ""
        tags = re.findall(
            r'<lora:([^:>]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))>',
            prompt,
            flags=re.IGNORECASE,
        )
        if not tags:
            continue

        loras = recipe.setdefault("loras", [])
        claimed_indices = set()
        changed = False
        for tag_name, tag_weight in tags:
            tag_key = normalize_lora_tag_name(tag_name)
            exact_indices = [
                index for index, lora in enumerate(loras)
                if tag_key in {normalize_lora_tag_name(name) for name in lora_resource_names(lora)}
            ]
            matched = (exact_indices[0], 1.0) if len(exact_indices) == 1 else None
            fuzzy_match = matched or match_prompt_lora_resource(tag_name, loras, claimed_indices)
            if fuzzy_match:
                index, score = fuzzy_match
                before_aliases = list(loras[index].get("promptAliases") or [])
                before_strength = safe_float(loras[index].get("strength"), 1.0)
                register_prompt_lora_alias(loras[index], tag_name, tag_weight)
                if score < 1.0:
                    claimed_indices.add(index)
                if before_aliases != loras[index].get("promptAliases") or before_strength != loras[index].get("strength"):
                    alias_count += 1
                    changed = True
                continue

            catalog_records = list(catalog.get(tag_key, {}).values())
            compatible_records = [
                record for record in catalog_records
                if is_compatible_lora_base(recipe.get("base_model"), record.get("base_model"))
            ]
            if len(compatible_records) != 1:
                continue
            source_lora = json.loads(json.dumps(compatible_records[0]["lora"], ensure_ascii=False))
            source_version_id = safe_int(source_lora.get("modelVersionId") or source_lora.get("id"))
            source_hash = str(source_lora.get("hash") or "").lower()
            if any(
                safe_int(item.get("modelVersionId") or item.get("id")) == source_version_id
                or str(item.get("hash") or "").lower() == source_hash
                for item in loras
            ):
                continue
            register_prompt_lora_alias(source_lora, tag_name, tag_weight)
            loras.append(source_lora)
            claimed_indices.add(len(loras) - 1)
            added_resources += 1
            changed = True

        if not changed:
            continue
        recipe["fingerprint"] = "|".join(
            f"{lora.get('hash') or 'dummy_hash'}:{safe_float(lora.get('strength'), 1.0)}"
            for lora in loras
        )
        temp_path = f"{recipe_path}.tmp"
        try:
            with open(temp_path, "w", encoding="utf-8") as file_obj:
                json.dump(recipe, file_obj, ensure_ascii=False, indent=4)
            os.replace(temp_path, recipe_path)
            repaired_files += 1
        except OSError:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except OSError:
                pass

    return repaired_files, alias_count, added_resources


def resolve_hashes_via_api(hashes, headers):
    """
    SHA256ハッシュのリストを、civitai.com の公開 by-hash API で一括解決する。
    このエンドポイントは Public 認証（ドメイン/NSFWによる制限を受けない）のため、
    Lora-Managerが名前解決に失敗したハッシュだけが残っていれば、そこから確実に復元できる。
    """
    resolved = {}
    clean_hashes = list({
        h.upper() for h in hashes
        if h and h not in ("dummy_hash", "No_LoRA_Placeholder", "No_No_LoRA_Placeholder")
    })
    if not clean_hashes:
        return resolved

    try:
        url = "https://civitai.com/api/v1/model-versions/by-hash"
        res = post_with_policy(url, headers=headers, json=clean_hashes, timeout=20)
        if res.status_code == 200:
            for ver_data in res.json():
                for f in ver_data.get("files", []):
                    sha = f.get("hashes", {}).get("SHA256")
                    if sha:
                        resolved[sha.upper()] = ver_data
    except Exception:
        pass

    return resolved


def fetch_civitai_image_public(domain, image_id, headers):
    """公開API `/api/v1/images` から画像1件を取得する（Civitai ToS で許可された経路）。

    返り値は API のアイテムそのまま（`url` / `meta` / `modelVersionIds` を含む dict）。
    取得できなければ空 dict。

    実測メモ（2026-07-26）:
      - `imageId` フィルタは公式ドキュメントに無いが機能する。
      - `withMeta=true` が無いと `meta` が空で返る。
      - 成人向けを含める場合は `nsfw=X&browsingLevel=255` が要る。
        **既定では付けない**（`include_adult_content` 設定・既定 false）。
      - `meta` は `{"id": .., "meta": {..}}` と1段包まれて返ることがある
        （save_recipe_and_image 側で展開する）。
    """
    url = (
        f"https://civitai.{domain}/api/v1/images"
        f"?imageId={image_id}&withMeta=true{civitai_browsing_params()}"
    )
    try:
        response = get_with_policy(url, headers=with_civitai_auth(headers), timeout=20)
        if response.status_code != 200:
            return {}
        items = response.json().get("items", [])
        return items[0] if items else {}
    except Exception:
        return {}


def repair_missing_resources(image_id, domain, recipe_metadata, headers):
    """
    Lora-Managerが解決できなかった Checkpoint / LoRA / Embedding を、以下の3系統で補完する。

    1) チェックポイント: IDは既に判明しているので、画像側からの「リソース発見」には
       依存せず、常に /model-versions/{id} を直接叩いて civitai情報とDLリンクを注入する。
       (旧仕様では既知のIDが existing_version_ids に先に入るため、発見ループの中で
        「すでに存在する」と判定されてスキップされ、DLボタンが永久に付かなかった)

    2) LoRA: Lora-Managerは画像からSHA256ハッシュ自体は正しく取得できているが、
       (主に成人向けコンテンツで)名前解決だけに失敗し、名称Null・modelVersionId 0の
       破損エントリを残すことが多い。/model-versions/by-hash はPublic認証でドメイン/
       NSFW制限を受けないため、このハッシュだけから確実に名前・DLリンクを復元できる。

    3) 未知リソース: 上記1・2でも解決できない、画像自体にまだ全く紐付いていない
       リソースがあれば、公開API /api/v1/images の modelVersionIds から補完する。
       ※ imageId フィルタは公式ドキュメントに記載が無いが、実際には機能する
         （2026-07-26 実測。存在しないIDでは items が空になるので、
          パラメータが無視されているのではなくフィルタとして効いている）。
         withMeta=true を付けないと meta が空で返る点に注意。
    """
    try:
        # 数百GBあるモデル群を毎回すべてハッシュ化しない。名前照合が本当に必要な
        # 分岐に入った時だけ索引を構築する。
        local_index = {}
        local_index_built = False

        # -----------------------------------------------------------------
        # 修正0-A: IDが無いチェックポイントを、画像メタデータのハッシュ（優先）または
        # ローカルファイル名から得たハッシュで公開by-hash APIへ照合する。
        # (Lora-Manager側がNSFWチェックポイントの名前解決に失敗し、
        #  modelName だけが残っているケースへの対処)
        # -----------------------------------------------------------------
        checkpoint = recipe_metadata.get("checkpoint")
        if checkpoint and safe_int(checkpoint.get("id")) == 0:
            if not local_index_built:
                local_index = build_local_hash_index()
                local_index_built = True
            name_hint = checkpoint.get("modelName") or checkpoint.get("name")
            resource_hash = checkpoint.get("hash") or find_local_hash_by_name(local_index, name_hint)
            if resource_hash:
                resolved = resolve_hashes_via_api([resource_hash], headers)
                ver_data = resolved.get(resource_hash.upper())
                if ver_data:
                    model_info = ver_data.get("model", {})
                    files = ver_data.get("files", [])
                    primary_file = files[0] if files else {}
                    for f in files:
                        if f.get("primary", False) or f.get("name", "").endswith(".safetensors"):
                            primary_file = f
                            break
                    file_hash = primary_file.get("hashes", {}).get("SHA256", resource_hash)
                    file_name = os.path.splitext(primary_file.get("name", "model"))[0]
                    vid = safe_int(ver_data.get("id"))
                    raw_dl_url = ver_data.get("downloadUrl", "")
                    clean_dl_url = raw_dl_url.replace("civitai.red", "civitai.com") if raw_dl_url else f"https://civitai.com/api/download/models/{vid}"

                    checkpoint = {
                        "id": vid,
                        "modelId": get_civitai_model_id(ver_data),
                        "name": model_info.get("name", name_hint),
                        "version": ver_data.get("name", ""),
                        "type": "checkpoint",
                        "hash": file_hash,
                        "file_name": file_name,
                        "baseModel": ver_data.get("baseModel", "SD 1.5"),
                        "isDeleted": False,
                        "downloadUrl": clean_dl_url,
                        "civitai": ver_data
                    }
                    recipe_metadata["checkpoint"] = checkpoint
                    recipe_metadata["base_model"] = ver_data.get("baseModel", recipe_metadata.get("base_model"))
                    print(f"    -> [ハッシュ一致/Checkpoint] '{name_hint}' を {model_info.get('name')} (バージョンID: {vid}) として復元しました。")
                else:
                    print(f"    -> [!] Checkpoint '{name_hint}' のハッシュがCivitai側で解決できませんでした（削除済み、または照合違いの可能性）。")
            else:
                print(f"    -> [!] Checkpoint '{name_hint}' に一致するローカルファイルが見つかりませんでした。CHECKPOINT_MODELS_DIRの設定をご確認ください。")

        # -----------------------------------------------------------------
        # 修正0-B: loras[] が空でも、プロンプト内の <lora:名前:強度> タグから
        # ローカルの実ファイルを特定し、同じくハッシュ経由で復元してloras[]へ注入する。
        # (Lora-Managerがそもそも構造化リソースとして拾えず、
        #  プロンプト文字列にしか情報が残らないケースへの対処)
        # -----------------------------------------------------------------
        prompt_text = recipe_metadata.get("gen_params", {}).get("prompt", "") or ""
        lora_tags = re.findall(r'<lora:([^:>]+):([+-]?(?:\d+(?:\.\d*)?|\.\d+))>', prompt_text, flags=re.IGNORECASE)
        if lora_tags:
            existing_names = set()
            for lora in recipe_metadata.get("loras", []):
                existing_names.update(normalize_lora_tag_name(name) for name in lora_resource_names(lora))

            for tag_name, tag_weight in lora_tags:
                tag_key = normalize_lora_tag_name(tag_name)
                if tag_key in existing_names:
                    for lora in recipe_metadata.get("loras", []):
                        if tag_key in {normalize_lora_tag_name(name) for name in lora_resource_names(lora)}:
                            register_prompt_lora_alias(lora, tag_name, tag_weight)
                            break
                    continue

                # Civitaiが返す実ファイル名とプロンプト別名が異なる場合でも、
                # 同じレシピ内の構造化リソースに一意な高信頼候補があればそれを使う。
                structured_match = match_prompt_lora_resource(tag_name, recipe_metadata.get("loras", []))
                if structured_match:
                    matched_index, match_score = structured_match
                    matched_lora = recipe_metadata["loras"][matched_index]
                    register_prompt_lora_alias(matched_lora, tag_name, tag_weight)
                    existing_names.add(tag_key)
                    print(
                        f"    -> [別名一致/LoRA] プロンプトの '{tag_name}' を "
                        f"'{matched_lora.get('file_name') or matched_lora.get('modelName')}' "
                        f"へ対応付けました (score={match_score:.2f})。"
                    )
                    continue

                # 次にローカル名を照合する。見つからない時だけ検証済みミラー、
                # またはCivitaiの一意な完全一致候補をSHA256付きで自動取得する。
                if not local_index_built:
                    local_index = build_local_hash_index()
                    local_index_built = True
                local_match = find_local_lora_by_tag(local_index, tag_name)
                local_hash = local_match["hash"] if local_match else None
                downloaded_fallback = None
                if not local_hash:
                    downloaded_fallback = download_prompt_lora_fallback(
                        tag_name,
                        headers,
                        recipe_metadata.get("base_model"),
                    )
                    if not downloaded_fallback:
                        print(f"    -> [!] プロンプト内のLoRA '{tag_name}' はローカル/Civitaiの高信頼候補で解決できませんでした。")
                        continue
                    local_hash = downloaded_fallback["hash"]
                    local_index[tag_key] = {
                        "hash": local_hash,
                        "path": downloaded_fallback["path"],
                    }

                resolved = resolve_hashes_via_api([local_hash], headers)
                ver_data = resolved.get(local_hash.upper())
                if not ver_data:
                    # Civitaiから削除済みでも、SHA256検証済みのローカル実体があれば
                    # ワークフロー再現には使用できる。ID=0のローカル専用エントリとして保持する。
                    if downloaded_fallback:
                        try:
                            strength = float(tag_weight)
                        except Exception:
                            strength = 1.0
                        file_name = os.path.splitext(downloaded_fallback["file_name"])[0]
                        recipe_metadata.setdefault("loras", []).append({
                            "file_name": file_name,
                            "hash": local_hash,
                            "strength": strength,
                            "modelVersionId": 0,
                            "modelId": 0,
                            "modelName": tag_name,
                            "modelVersionName": "Local verified fallback",
                            "isDeleted": False,
                            "exclude": False,
                            "inLibrary": True,
                            "localPath": downloaded_fallback["path"],
                            "promptAliases": [tag_name],
                        })
                        existing_names.add(tag_key)
                        print(f"    -> [ローカル復元/LoRA] '{tag_name}' を検証済みファイルとしてレシピへ追加しました。")
                        continue
                    print(f"    -> [!] プロンプト内のLoRA '{tag_name}' のローカルハッシュがCivitai側で解決できませんでした。")
                    continue

                model_info = ver_data.get("model", {})
                model_type = model_info.get("type", "").lower()
                if model_type not in ["lora", "locon"]:
                    continue

                vid = safe_int(ver_data.get("id"))
                files = ver_data.get("files", [])
                primary_file = files[0] if files else {}
                for f in files:
                    if f.get("primary", False) or f.get("name", "").endswith(".safetensors"):
                        primary_file = f
                        break
                file_hash = primary_file.get("hashes", {}).get("SHA256", local_hash)
                # ミラーから取得した場合は、実際にローカルへ保存した名前を優先する。
                # Civitai側の表示名が旧ファイル名と異なると、同じLoRAを二重挿入し
                # 片方だけ「required model missing」に見えるため。
                resolved_file_name = (
                    downloaded_fallback["file_name"]
                    if downloaded_fallback
                    else primary_file.get("name", tag_name)
                )
                file_name = os.path.splitext(resolved_file_name)[0]
                raw_dl_url = ver_data.get("downloadUrl", "")
                clean_dl_url = raw_dl_url.replace("civitai.red", "civitai.com") if raw_dl_url else f"https://civitai.com/api/download/models/{vid}"

                try:
                    strength = float(tag_weight)
                except Exception:
                    strength = 1.0

                new_lora = {
                    "file_name": file_name,
                    "hash": file_hash,
                    "strength": strength,
                    "modelVersionId": vid,
                    "modelId": get_civitai_model_id(ver_data),
                    "modelName": model_info.get("name", tag_name),
                    "modelVersionName": ver_data.get("name", ""),
                    "isDeleted": False,
                    "exclude": False,
                    "downloadUrl": clean_dl_url,
                    "civitai": ver_data,
                    "promptAliases": [tag_name],
                }
                recipe_metadata.setdefault("loras", []).append(new_lora)
                existing_names.add(tag_key)
                print(f"    -> [ローカルファイル一致/LoRA] プロンプトの '{tag_name}' を {model_info.get('name')} (バージョンID: {vid}) として復元しました。")

        # -----------------------------------------------------------------
        # 修正1: チェックポイントの直接補完（DLボタンが出ない問題への対処）
        # -----------------------------------------------------------------
        checkpoint = recipe_metadata.get("checkpoint")
        if checkpoint:
            chk_vid = safe_int(checkpoint.get("id"))
            if chk_vid != 0 and "civitai" not in checkpoint:
                try:
                    ver_url = f"https://civitai.com/api/v1/model-versions/{chk_vid}"
                    ver_res = get_with_policy(ver_url, headers=with_civitai_auth(headers), timeout=15)
                    if ver_res.status_code == 200:
                        ver_data = ver_res.json()
                        raw_dl_url = ver_data.get("downloadUrl", "")
                        clean_dl_url = raw_dl_url.replace("civitai.red", "civitai.com") if raw_dl_url else f"https://civitai.com/api/download/models/{chk_vid}"
                        checkpoint["downloadUrl"] = clean_dl_url
                        checkpoint["civitai"] = ver_data
                        if not checkpoint.get("baseModel") or checkpoint.get("baseModel") == "SD 1.5":
                            checkpoint["baseModel"] = ver_data.get("baseModel", checkpoint.get("baseModel", "SD 1.5"))
                        recipe_metadata["checkpoint"] = checkpoint
                        recipe_metadata["base_model"] = checkpoint.get("baseModel", recipe_metadata.get("base_model"))
                        model_name = ver_data.get("model", {}).get("name", checkpoint.get("name"))
                        print(f"    -> [Checkpoint直接補完成功] {model_name} (バージョンID: {chk_vid}) にDLリンク情報を追加しました。")
                    else:
                        print(f"    -> [!] Checkpoint直接補完失敗: バージョンID {chk_vid} が取得できませんでした (status={ver_res.status_code})")
                except Exception as e:
                    print(f"  [!] チェックポイント直接補完中にエラー: {e}")

        # -----------------------------------------------------------------
        # 修正2: 名前解決に失敗した既存LoRAをハッシュから復元（Null名/404問題への対処）
        # -----------------------------------------------------------------
        broken_hashes = []
        surviving_loras = []
        version_cache = {}
        for lora in recipe_metadata.get("loras", []):
            h = lora.get("hash", "")
            vid = safe_int(lora.get("modelVersionId") or lora.get("id"))
            # analyze-imageの返却値は画面用スキーマ(name)、補完後のJSONは
            # 保存用スキーマ(modelName)なので、両方を読む。
            name = lora.get("modelName") or lora.get("name", "")
            mid = safe_int(lora.get("modelId", 0))

            # バージョンIDが既に分かる場合は、ハッシュに頼らず親モデルIDを直接取得する。
            # このIDが無いと、画面側はLoRA名を表示できてもCivitaiリンクを生成できない。
            if vid and not mid:
                ver_data = fetch_civitai_version(vid, headers, version_cache)
                resolved_model_id = get_civitai_model_id(ver_data or {})
                if resolved_model_id:
                    lora["modelId"] = resolved_model_id
                    lora.setdefault("civitai", ver_data)
                    lora.setdefault("downloadUrl", (ver_data or {}).get("downloadUrl", ""))
                    mid = resolved_model_id

            is_broken = (
                vid == 0
                or not name
                or name in ["No_LoRA_Placeholder", "Unknown LoRA"]
                or mid == 0
            )
            has_usable_hash = bool(h) and h not in ["dummy_hash", "No_LoRA_Placeholder", "No_No_LoRA_Placeholder"]
            local_path = str(lora.get("localPath") or "").strip()
            local_verified = bool(
                lora.get("inLibrary")
                and has_usable_hash
                and local_path
                and os.path.isfile(local_path)
            )

            # Civitaiから削除済みでも、SHA256検証済みのローカルファイルは
            # 破損扱いにせず、そのままレシピへ永続化する。
            if local_verified:
                surviving_loras.append(lora)
                continue

            if is_broken:
                if has_usable_hash:
                    broken_hashes.append(h)  # 復元を試みるため保持
                continue  # 破損エントリは一旦除去（復元できれば後で再注入）

            if not has_usable_hash:
                continue  # ハッシュ自体が無いダミーは復元不能なので除去

            surviving_loras.append(lora)

        recipe_metadata["loras"] = surviving_loras

        existing_version_ids = set()
        chk_id = recipe_metadata.get("checkpoint", {}).get("id") if recipe_metadata.get("checkpoint") else None
        if chk_id:
            existing_version_ids.add(safe_int(chk_id))
        for lora in recipe_metadata["loras"]:
            vid = lora.get("modelVersionId") or lora.get("id")
            if vid:
                existing_version_ids.add(safe_int(vid))

        # **embeddings も数える。** ここに入れ忘れると、LoRA Manager が既に
        # 解決済みの embedding まで毎回「未カバーのリソース」と判定され、
        # 下の TI 分岐が必ず走ってプロンプトへ追記される。
        # 実測（346レシピ）: 14件21トークンが注入され、うち **9件14トークンは
        # 元がネガティブ側**だった。`lazyhand` / `lazyneg` / `easynegative` 等が
        # 符号を反転してポジティブへフル強度で乗り、負方向の適用は消えていた。
        for embedding in recipe_metadata.get("embeddings") or []:
            if not isinstance(embedding, dict):
                continue
            vid = embedding.get("modelVersionId") or embedding.get("id")
            if vid:
                existing_version_ids.add(safe_int(vid))

        if broken_hashes:
            resolved_map = resolve_hashes_via_api(broken_hashes, headers)
            for h in broken_hashes:
                ver_data = resolved_map.get(h.upper())
                if not ver_data:
                    print(f"    -> [!] ハッシュ {h[:12]}... の解決に失敗しました（モデル削除済み、または未登録の可能性）。")
                    continue

                vid = safe_int(ver_data.get("id"))
                if vid == 0 or vid in existing_version_ids:
                    continue

                model_info = ver_data.get("model", {})
                model_type = model_info.get("type", "").lower()
                if model_type not in ["lora", "locon"]:
                    continue  # 型が想定外の場合は念のためスキップ

                files = ver_data.get("files", [])
                primary_file = files[0] if files else {}
                for f in files:
                    if f.get("primary", False) or f.get("name", "").endswith(".safetensors"):
                        primary_file = f
                        break
                file_hash = primary_file.get("hashes", {}).get("SHA256", h)
                file_name = os.path.splitext(primary_file.get("name", "model"))[0]

                raw_dl_url = ver_data.get("downloadUrl", "")
                clean_dl_url = raw_dl_url.replace("civitai.red", "civitai.com") if raw_dl_url else f"https://civitai.com/api/download/models/{vid}"

                new_lora = {
                    "file_name": file_name,
                    "hash": file_hash,
                    "strength": 0.8,
                    "modelVersionId": int(vid),
                    "modelId": get_civitai_model_id(ver_data),
                    "modelName": model_info.get("name", "Unknown LoRA"),
                    "modelVersionName": ver_data.get("name", ""),
                    "isDeleted": False,
                    "exclude": False,
                    "downloadUrl": clean_dl_url,
                    "civitai": ver_data
                }
                recipe_metadata["loras"].append(new_lora)
                existing_version_ids.add(vid)
                print(f"    -> [ハッシュ復元成功/LoRA] {model_info.get('name')} (バージョンID: {vid}) を復元しました。")

        # -----------------------------------------------------------------
        # 修正3: 画像の生成情報から、使われた全リソースを追加補完する。
        # 公開API /api/v1/images の modelVersionIds を使う。
        # (旧実装は内部APIの image.getGenerationData を叩いていたが、Civitai の
        #  利用規約が自動アクセスを「明示的に提供するインターフェース」に限って
        #  いるため撤去した。実測では公開APIで同じリソースが取れる＝損失なし)
        # -----------------------------------------------------------------
        api_image = fetch_civitai_image_public(domain, image_id, headers)
        resources_to_process = [
            {"modelVersionId": version_id}
            for version_id in (api_image.get("modelVersionIds") or [])
        ]

        for res_item in resources_to_process:
            try:
                vid = res_item.get("modelVersionId") or res_item.get("id")
                if not vid:
                    continue
                vid = safe_int(vid)
                if vid == 0 or vid in existing_version_ids:
                    continue

                ver_url = f"https://civitai.com/api/v1/model-versions/{vid}"
                ver_res = get_with_policy(ver_url, headers=with_civitai_auth(headers), timeout=15)
                if ver_res.status_code != 200:
                    continue

                ver_data = ver_res.json()
                model_info = ver_data.get("model", {})
                model_type = model_info.get("type", "").lower()

                files = ver_data.get("files", [])
                primary_file = files[0] if files else {}
                for f in files:
                    if f.get("primary", False) or f.get("name", "").endswith(".safetensors"):
                        primary_file = f
                        break

                file_hash = primary_file.get("hashes", {}).get("SHA256", "dummy_hash")
                file_name = os.path.splitext(primary_file.get("name", "model"))[0]

                raw_dl_url = ver_data.get("downloadUrl", "")
                clean_dl_url = raw_dl_url.replace("civitai.red", "civitai.com") if raw_dl_url else f"https://civitai.com/api/download/models/{vid}"

                if model_type in ["lora", "locon"]:
                    parent_model_id = get_civitai_model_id(ver_data)
                    new_lora = {
                        "file_name": file_name,
                        "hash": file_hash,
                        "strength": 0.8,
                        "modelVersionId": int(vid),
                        "modelId": int(parent_model_id),
                        "modelName": model_info.get("name", "Unknown LoRA"),
                        "modelVersionName": ver_data.get("name", ""),
                        "isDeleted": False,
                        "exclude": False,
                        "downloadUrl": clean_dl_url,
                        "civitai": ver_data
                    }
                    recipe_metadata["loras"].append(new_lora)
                    existing_version_ids.add(int(vid))
                    print(f"    -> [新規リソース補完成功/LoRA] {model_info.get('name')} (バージョンID: {vid}, 親モデルID: {parent_model_id}) を追加しました。")

                elif model_type in ["textualinversion", "embedding"]:
                    # **プロンプトへ追記しない。**
                    #
                    # 以前はここで無条件に `gen_params["prompt"]` へ
                    # `embedding:<name>` を連結していた。元がポジティブか
                    # ネガティブかを一切見ないため、**ネガティブ用の embedding が
                    # 符号を反転してポジティブへフル強度で乗っていた**
                    # （実測: 注入14件のうち9件が元ネガティブ。`lazyhand` は
                    #  「崩れた手」を表象するために作られたもので、これが
                    #  ポジティブに乗れば手が増える方向へ働く）。
                    # 同時に、負方向の適用は失われる。
                    #
                    # 正しい置き場は `embeddings[]` で、そこに入れておけば
                    # LoRA Manager 側が使用側（positive/negative）を保ったまま扱える。
                    embeddings = recipe_metadata.get("embeddings")
                    if not isinstance(embeddings, list):
                        embeddings = []
                    known_ids = {
                        safe_int(item.get("modelVersionId") or item.get("id"))
                        for item in embeddings
                        if isinstance(item, dict)
                    }
                    if safe_int(vid) not in known_ids:
                        embeddings.append({
                            "type": "embedding",
                            "id": int(vid),
                            "modelVersionId": int(vid),
                            "modelId": safe_int(get_civitai_model_id(ver_data)),
                            "name": model_info.get("name", "Unknown Embedding"),
                            "modelName": model_info.get("name", "Unknown Embedding"),
                            "version": ver_data.get("name", ""),
                            "modelVersionName": ver_data.get("name", ""),
                            "file_name": file_name,
                            "hash": file_hash,
                            "isDeleted": False,
                            "exclude": False,
                            "downloadUrl": clean_dl_url,
                            "civitai": ver_data,
                        })
                        recipe_metadata["embeddings"] = embeddings
                        existing_version_ids.add(int(vid))
                        print(f"    -> [新規リソース補完成功/Embedding] {file_name} を embeddings へ追加しました（プロンプトは変更しません）。")

                elif model_type in ["checkpoint"]:
                    current_checkpoint = recipe_metadata.get("checkpoint", {})
                    if (not current_checkpoint
                        or current_checkpoint.get("id", 0) == 0
                        or current_checkpoint.get("name") == "Unknown"
                        or "civitai" not in current_checkpoint):
                        new_checkpoint = {
                            "id": int(vid),
                            "modelId": get_civitai_model_id(ver_data),
                            "name": model_info.get("name", "Unknown Checkpoint"),
                            "version": ver_data.get("name", ""),
                            "type": "checkpoint",
                            "hash": file_hash,
                            "file_name": file_name,
                            "baseModel": ver_data.get("baseModel", "SD 1.5"),
                            "isDeleted": False,
                            "downloadUrl": clean_dl_url,
                            "civitai": ver_data
                        }
                        recipe_metadata["checkpoint"] = new_checkpoint
                        recipe_metadata["base_model"] = ver_data.get("baseModel", "SD 1.5")
                        existing_version_ids.add(int(vid))
                        print(f"    -> [新規リソース補完成功/Checkpoint] {model_info.get('name')} (バージョンID: {vid}) を設定・補完しました。")

            except Exception as item_err:
                print(f"  [!] リソースID {res_item.get('id')} の個別解析中にエラーが発生しました（スキップ）: {item_err}")
                continue

        # 発見APIで後から追加された構造化LoRAにもプロンプト別名と画像固有強度を適用する。
        # これにより、公開モデル名と <lora:...> のファイル別名が異なっていても、
        # ワークフロー生成時に存在しない別名ノードを重複作成しない。
        for tag_name, tag_weight in lora_tags:
            tag_key = normalize_lora_tag_name(tag_name)
            exact_match = None
            for index, lora in enumerate(recipe_metadata.get("loras", [])):
                if tag_key in {normalize_lora_tag_name(name) for name in lora_resource_names(lora)}:
                    exact_match = (index, 1.0)
                    break
            structured_match = exact_match or match_prompt_lora_resource(tag_name, recipe_metadata.get("loras", []))
            if not structured_match:
                continue
            matched_index, match_score = structured_match
            matched_lora = recipe_metadata["loras"][matched_index]
            if tag_name not in (matched_lora.get("promptAliases") or []):
                register_prompt_lora_alias(matched_lora, tag_name, tag_weight)
                print(
                    f"    -> [後段別名一致/LoRA] '{tag_name}' を "
                    f"'{matched_lora.get('file_name') or matched_lora.get('modelName')}' "
                    f"へ対応付けました (score={match_score:.2f})。"
                )

        recipe_metadata["fingerprint"] = "|".join(
            f"{lora.get('hash') or 'dummy_hash'}:{safe_float(lora.get('strength'), 1.0)}"
            for lora in recipe_metadata.get("loras", [])
        )

    except Exception as e:
        print(f"  [!] 補完エンジン全体で例外が発生しました: {e}")

    return recipe_metadata

# =====================================================================
# フォールバック処理用
# =====================================================================
def save_recipe_and_image(img_info, save_dir, headers, domain="com"):
    """画像を保存し、.recipe.jsonを自動生成する（フォールバック用）"""
    image_id = img_info.get("id")
    download_url = img_info.get("url")
    meta = img_info.get("meta", {})
    
    if download_url and not download_url.startswith("http"):
        download_url = f"https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/{download_url}/original=true"
    
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}

    # Civitai's image.getGenerationData response wraps generation fields in
    # ``meta``; the image API returns those fields directly.
    if isinstance(meta, dict) and isinstance(meta.get("meta"), dict):
        meta = meta["meta"]
    if not isinstance(meta, dict):
        meta = {}
            
    clean_url = download_url.split("?")[0]
    ext = os.path.splitext(clean_url)[1]
    if not ext or len(ext) > 5:
        ext = ".png" if ".png" in download_url.lower() else ".jpg"
        
    img_filename = f"civitai_{image_id}{ext}"
    img_path = os.path.join(save_dir, img_filename)
    json_path = os.path.join(save_dir, f"civitai_{image_id}.recipe.json")
    
    if os.path.exists(img_path) and os.path.exists(json_path):
        return True

    parts = download_url.split("/")
    for i, part in enumerate(parts):
        if any(k in part for k in ["width=", "quality=", "optimized=", "original="]):
            parts[i] = "original=true"
            break
    original_url = "/".join(parts)

    try:
        # 1. 画像のダウンロード
        img_response = get_with_policy(original_url, headers=headers)
        if img_response.status_code != 200:
            img_response = get_with_policy(download_url, headers=headers)
            if img_response.status_code != 200:
                return False

        with open(img_path, 'wb') as f:
            f.write(img_response.content)

        # 2. レシピスキーマの組み立て
        now = time.time()
        prompt = meta.get("prompt") or meta.get("positivePrompt") or None
        neg_prompt = meta.get("negativePrompt", "")
        steps = meta.get("steps", 20)
        sampler = meta.get("sampler", "Euler a")
        cfg = meta.get("cfgScale", 5.0)
        seed = meta.get("seed", -1)
        
        base_model = "SD 1.5"
        checkpoint_name = "Unknown"
        checkpoint_id = 0
        checkpoint_model_id = 0
        checkpoint_version = ""
        checkpoint_hash = ""
        checkpoint_file_name = ""
        loras = []
        
        resources = img_info.get("resources", [])
        for res in resources:
            res_type = res.get("type", "")
            res_name = res.get("name", "")
            if res_type == "checkpoint":
                checkpoint_name = res_name
                checkpoint_id = res.get("id", 0)
                checkpoint_model_id = res.get("modelId", 0)
                checkpoint_version = res.get("version", "")
                checkpoint_hash = res.get("hash", "")
                checkpoint_file_name = res.get("file_name", "")
                
                if "xl" in res_name.lower() or "sdxl" in res_name.lower():
                    base_model = "SDXL"
                elif "flux" in res_name.lower():
                    base_model = "Flux"
                elif "pony" in res_name.lower():
                    base_model = "Pony"
                elif "illustrious" in res_name.lower():
                    base_model = "Illustrious"
            elif res_type == "lora":
                loras.append({
                    "file_name": "", 
                    "hash": res.get("hash", "dummy_hash"),
                    "strength": res.get("weight", 1.0),
                    "modelVersionId": res.get("id", 0),
                    "modelId": res.get("modelId", 0),
                    "modelName": res_name,
                    "modelVersionName": res.get("modelVersionName", ""),
                    "isDeleted": False,
                    "exclude": False
                })

        win_img_path = img_path.replace("/", "\\")
        
        fingerprint_parts = []
        for l in loras:
            h = l.get("hash") or "dummy_hash"
            fingerprint_parts.append(f"{h}:{l['strength']}")
        fingerprint = "|".join(fingerprint_parts)

        checkpoint_obj = {
            "id": checkpoint_id,
            "modelId": checkpoint_model_id,
            "name": checkpoint_name,
            "version": checkpoint_version,
            "type": "checkpoint",
            "hash": checkpoint_hash,
            "file_name": checkpoint_file_name,
            "baseModel": base_model,
            "isDeleted": False
        }
        
        recipe_json = {
            "id": f"civitai_{image_id}",
            "file_path": win_img_path,
            "title": f"civitai_{image_id}",
            "modified": now,
            "created_date": now,
            "base_model": base_model,
            "loras": loras,
            "gen_params": {
                "size": "1024x1024",
                "seed": seed,
                "cfg_scale": cfg,
                "steps": steps,
                "negative_prompt": neg_prompt,
                "clip_skip": "2",
                "prompt": prompt,
                "sampler": sampler
            },
            "fingerprint": fingerprint,
            "checkpoint": checkpoint_obj,
            "source_path": f"https://civitai.com/images/{image_id}",
            "folder": ""
        }

        # 動的ドメインを引き渡して自動補完を実行
        recipe_json = repair_missing_resources(image_id, domain, recipe_json, headers)

        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(recipe_json, f, indent=4, ensure_ascii=False)
            
        print(f"  [+] 取得 (フォールバック多重スキャン/ダミー注入済): ID {image_id}")
        return True
        
    except Exception as e:
        print(f"  [-] 保存・変換エラー (ID: {image_id}): {e}")
        return False

def download_civitai_image_and_meta(domain, image_id, save_dir, failed_ids):
    """公開API経由で画像とメタデータを取得し、レシピを組み立てる。

    旧実装は「画像ページのHTMLを直接スキャンして original URL を正規表現で抜く」
    経路と、内部APIの `image.getGenerationData` / `image.get` を持っていたが、
    Civitai の利用規約が自動アクセスを「明示的に提供するインターフェース（公開API等）」
    に限定しているため撤去した。

    撤去にあたって回収率をペアで実測した（2026-07-26）:
      - 既存レシピの reconstructed 19件 / civitai.com の人気50件、計69件
      - 公開API と内部API のどちらでも、プロンプト・生成条件・リソースの
        取得件数が完全に一致（69/69）。resources と modelVersionIds の集合も一致
      → 撤去による損失は 0。
    """
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    if CIVITAI_API_KEY:
        headers["Authorization"] = f"Bearer {CIVITAI_API_KEY}"

    try:
        item = fetch_civitai_image_public(domain, image_id, headers)
        if item and item.get("url"):
            if save_recipe_and_image(item, save_dir, headers, domain):
                return
    except Exception:
        pass

    print(f"  [-] 失敗: ID {image_id} (公開APIから取得できませんでした)")
    failed_ids.append(image_id)

# =====================================================================
# メインのハイブリッド同期処理
# =====================================================================
def sync_image_hybrid(domain, image_id, recipe_dir, failed_ids, synced_ids):
    civitai_url = f"https://civitai.{domain}/images/{image_id}"
    
    print(f"[*] 処理中: ID {image_id} ({civitai_url})")
    
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    if CIVITAI_API_KEY:
        headers["Authorization"] = f"Bearer {CIVITAI_API_KEY}"

    # ----------------------------------------------------
    # ルート1：【最優先】Lora-Managerの解析・保存APIを使用
    # ----------------------------------------------------
    try:
        analyze_response = post_with_policy(ANALYZE_ENDPOINT, json={"url": civitai_url}, timeout=60)
        
        if analyze_response.status_code == 200:
            analyzed_json = analyze_response.json()
            source_data = analyzed_json.get("data", analyzed_json) if "data" in analyzed_json else analyzed_json

            name = source_data.get("name", "").strip()
            if not name:
                name = f"Civitai_Recipe_{image_id}"

            tags = source_data.get("tags", [])
            extension = source_data.get("extension", ".jpg")
            image_base64 = source_data.get("image_base64", "")

            recipe_metadata = dict(source_data)
            recipe_metadata.pop("image_base64", None)
            recipe_metadata["source_path"] = civitai_url

            # analyze-imageの返却値ではチェックポイントがmodelキーに入る。
            # 補完前にcheckpointへ写しておかないと、ID=0のチェックポイントを
            # ローカルハッシュから復元する経路が実行されず、DL対象にならない。
            if not isinstance(recipe_metadata.get("checkpoint"), dict) and isinstance(recipe_metadata.get("model"), dict):
                recipe_metadata["checkpoint"] = dict(recipe_metadata["model"])

            # NSFW完全解除版の自動補完エンジンを実行
            recipe_metadata = repair_missing_resources(image_id, domain, recipe_metadata, headers)
            recipe_metadata = normalize_for_lora_manager_save(recipe_metadata)

            data_payload = {
                'name': name,
                'tags': json.dumps(tags) if isinstance(tags, (list, dict)) else str(tags),
                'extension': str(extension),
                'metadata': json.dumps(recipe_metadata)
            }
            files_payload = {
                'image_base64': (None, str(image_base64), 'text/plain')
            }

            save_response = post_with_policy(SAVE_ENDPOINT, data=data_payload, files=files_payload, timeout=30)
            if save_response.status_code == 200:
                print(f"  [+] 同期成功 (Lora-Manager API完全復元): {name}")
                synced_ids.add(image_id)
                return True
            else:
                print(f"  [!] Lora-Manager 保存APIエラー ({save_response.status_code}): {save_response.text}")
        else:
            print(f"  [!] Lora-Manager 解析APIエラー ({analyze_response.status_code}): {analyze_response.text}")
                
    except requests.exceptions.ReadTimeout:
        print("  [!] Lora-Manager APIが応答時間切れ（タイムアウト: 60秒）になりました。")
    except requests.exceptions.ConnectionError:
        print("  [!] Lora-Manager APIに接続できませんでした（ComfyUIが起動していないか、アドレスが異なります）。")
    except Exception as e:
        print(f"  [!] Lora-Manager API処理中に予期せぬエラーが発生しました: {e}")
        
    # ----------------------------------------------------
    # ルート2：【救済】API非対応・失敗時に Civitai 公開APIから直接組み立てる
    # ----------------------------------------------------
    print("  [~] Lora-Manager API非対応のため、Civitai公開APIでのフォールバックを実行します...")
    download_civitai_image_and_meta(domain, image_id, recipe_dir, failed_ids)
    
    json_path = os.path.join(recipe_dir, f"civitai_{image_id}.recipe.json")
    if os.path.exists(json_path):
        synced_ids.add(image_id)
        return True
    return False

# =====================================================================
# メイン処理エントリーポイント
# =====================================================================
def fetch_raindrop_collections():
    """Raindrop のコレクション一覧を取得する。

    UI からコレクションを選べるようにするための**読み取り専用**モード。
    ルート（`/collections`）と配下（`/collections/childrens`）を1回ずつ叩くだけで、
    ブックマーク本体は取得しない。Raindrop の 120 req/min に対して2リクエストなので
    「過度に頻繁なリクエスト」には当たらない。

    Returns:
        (items, error_message) のタプル。成功時 error_message は空文字。
        items は [{"id", "title", "count", "parent_id"}] の並び。
    """
    if not RAINDROP_TOKEN:
        return [], "raindrop_token が未設定です。"

    headers = {
        "Authorization": f"Bearer {RAINDROP_TOKEN}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }
    items = []
    for path in ("collections", "collections/childrens"):
        try:
            response = get_with_policy(
                f"https://api.raindrop.io/rest/v1/{path}", headers=headers, timeout=20
            )
        except RateLimitAbort:
            raise
        except Exception as err:
            return [], f"Raindrop へ接続できませんでした: {type(err).__name__}"

        if response.status_code != 200:
            # 応答本文にはトークンが混ざりうるので、ステータスコードだけを載せる。
            return [], f"Raindrop APIエラー: HTTP {response.status_code}"

        try:
            payload = response.json().get("items", [])
        except ValueError:
            return [], "Raindrop の応答を JSON として読めませんでした。"

        for item in payload:
            parent = item.get("parent") or {}
            items.append({
                "id": item.get("_id"),
                "title": str(item.get("title") or ""),
                "count": safe_int(item.get("count"), 0),
                "parent_id": parent.get("$id") if isinstance(parent, dict) else None,
            })

    # 同じコレクションが両方の応答に現れることがあるので ID で畳む。
    unique = {}
    for item in items:
        if item["id"] is not None:
            unique[item["id"]] = item
    return sorted(unique.values(), key=lambda x: x["title"].lower()), ""


def run_list_collections():
    """`--list-collections` の本体。終了コードを返す。"""
    try:
        items, error = fetch_raindrop_collections()
    except RateLimitAbort as abort:
        print(f"[-] 規約側の制限により中止しました: {abort}")
        emit_event("collections_error", message=str(abort), stage="rate_limited")
        return 2

    if error:
        print(f"[-] コレクション一覧を取得できませんでした: {error}")
        emit_event("collections_error", message=error, stage="fetch")
        return 1

    emit_event("collections", items=items, total=len(items))
    print(f"[+] コレクション {len(items)} 件:")
    for item in items:
        indent = "    " if item.get("parent_id") else "  "
        print(f"{indent}[{item['id']}] {item['title']} ({item['count']} 件)")
    return 0


def main():
    print("=== Raindrop から Civitai 画像のハイブリッド同期を開始 ===")
    emit_event("started")

    if not validate_config():
        emit_event(
            "finished",
            status="error",
            stage="config",
            message="設定が足りません（raindrop_token / collection_id / recipe_dir）",
            total=0,
            success=0,
            failed=0,
            failed_ids=[],
        )
        return


    os.makedirs(RECIPE_DIR, exist_ok=True)

    # 旧レシピを少量ずつ現行の元画像優先ポリシーへ移行する。初回だけ
    # CIVITAI_REIMPORT_BATCH_SIZE=0 を指定すれば全件を一括処理できる。
    reimport_limit = safe_int(os.environ.get("CIVITAI_REIMPORT_BATCH_SIZE", "25"), 25)
    migration = reimport_stale_civitai_recipes(
        RECIPE_DIR,
        limit=reimport_limit,
    )
    if migration["candidates"]:
        print(
            "[+] 既存レシピの元画像優先移行: "
            f"候補 {migration['candidates']} / 成功 {migration['reimported']} / "
            f"失敗 {migration['failed']} / 次回以降 {migration['remaining']}"
        )

    civitai_headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    if CIVITAI_API_KEY:
        civitai_headers["Authorization"] = f"Bearer {CIVITAI_API_KEY}"

    repaired_recipes, repaired_loras = backfill_saved_recipe_model_ids(RECIPE_DIR, civitai_headers)
    alias_recipes, alias_count, alias_resources = reconcile_saved_recipe_prompt_loras(RECIPE_DIR)
    if repaired_loras or alias_recipes:
        refreshed = refresh_lora_manager_recipes()
        refresh_note = "一覧を再読込しました" if refreshed else "次回の一覧再読込時に反映されます"
        print(
            f"[+] 既存レシピのLoRAリンク {repaired_loras} 件、プロンプト別名 {alias_count} 件、"
            f"台帳資源 {alias_resources} 件を補完し、{refresh_note}。"
        )
    
    print("[+] ローカルフォルダ内のファイル名とJSONから同期済みIDを走査中...")
    synced_ids = get_synced_image_ids(RECIPE_DIR)
    print(f"    -> 同期済みIDを {len(synced_ids)} 件検出しました。")

    page = 0
    perpage = 50
    all_items = []
    failed_ids = []
    # 例外が取得段階で起きても集計を出せるよう、先に初期化しておく。
    pending = []
    succeeded = 0

    headers = {
        "Authorization": f"Bearer {RAINDROP_TOKEN}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }
    
    raindrop_error = ""
    try:
        print("[+] Raindropからブックマーク一覧を取得中...")
        while True:
            raindrop_url = f"https://api.raindrop.io/rest/v1/raindrops/{COLLECTION_ID}?perpage={perpage}&page={page}"
            response = get_with_policy(raindrop_url, headers=headers)

            if response.status_code != 200:
                print(f"[-] Raindrop APIエラー: {response.status_code}")
                # 401/403 は「ブックマーク0件」と区別が付かなくなるため、
                # 呼び出し元へは異常として伝える。ステータスコードだけを載せる
                # （応答本文にはトークンが混ざりうるので出さない）。
                raindrop_error = f"Raindrop APIエラー: HTTP {response.status_code}"
                break

            page_items = response.json().get("items", [])
            if not page_items:
                break
                
            all_items.extend(page_items)
            
            if len(page_items) < perpage:
                break
            page += 1
            
        if not all_items:
            print("[!] ブックマークが見つかりませんでした。")
            emit_event(
                "finished",
                status="error" if raindrop_error else "ok",
                stage="raindrop" if raindrop_error else "empty",
                message=raindrop_error or "ブックマークが見つかりませんでした",
                total=0,
                success=0,
                failed=0,
                failed_ids=[],
            )
            return

        print(f"[+] 合計 {len(all_items)} 個のブックマークをスキャンします（取得済みのものはサイレントスキップ）\n")

        # 処理対象を先に確定させる。ループ内で判定していた頃と同じ結果になるよう、
        # 同期済みIDの除外と重複リンクの除去をここで済ませる。
        # ブックマーク数と対象数がずれる理由を後から説明できるよう、除外の内訳を数える。
        queued_ids = set()
        skipped_no_link = 0
        skipped_not_civitai_image = []
        skipped_duplicate = []
        skipped_already_synced = []
        for item in all_items:
            link = item.get("link", "")
            if not link:
                skipped_no_link += 1
                continue

            domain, image_id = get_civitai_image_info(link)
            if not (image_id and domain):
                skipped_not_civitai_image.append(link)
                continue
            if image_id in synced_ids:
                skipped_already_synced.append(image_id)
                continue
            if image_id in queued_ids:
                skipped_duplicate.append(image_id)
                continue
            queued_ids.add(image_id)
            pending.append((domain, image_id))

        total_pending = len(pending)

        excluded = (
            skipped_no_link
            + len(skipped_not_civitai_image)
            + len(skipped_duplicate)
            + len(skipped_already_synced)
        )
        if excluded:
            print(
                f"[+] 対象外 {excluded} 件の内訳: "
                f"Civitai画像URLでない {len(skipped_not_civitai_image)} / "
                f"重複 {len(skipped_duplicate)} / "
                f"同期済み {len(skipped_already_synced)} / "
                f"リンク無し {skipped_no_link}"
            )
            for link in skipped_not_civitai_image[:20]:
                print(f"    -> 対象外URL: {link}")
            if len(skipped_not_civitai_image) > 20:
                print(f"    -> ほか {len(skipped_not_civitai_image) - 20} 件")

        emit_event(
            "planned",
            bookmarks=len(all_items),
            total=total_pending,
            already_synced=len(skipped_already_synced),
            excluded=excluded,
            excluded_not_civitai_image=len(skipped_not_civitai_image),
            excluded_duplicate=len(skipped_duplicate),
            excluded_no_link=skipped_no_link,
            # 調べ直せるように、対象外URLは先頭20件だけ載せる（秘匿値は含まない公開URL）
            excluded_not_civitai_image_samples=skipped_not_civitai_image[:20],
            duplicate_image_ids=skipped_duplicate[:20],
        )

        for index, (domain, image_id) in enumerate(pending, start=1):
            emit_event("item_started", image_id=image_id, index=index, total=total_pending)
            ok = bool(sync_image_hybrid(domain, image_id, RECIPE_DIR, failed_ids, synced_ids))
            if ok:
                succeeded += 1
            emit_event(
                "item_finished",
                image_id=image_id,
                index=index,
                total=total_pending,
                ok=ok,
                success=succeeded,
                failed=index - succeeded,
            )
            time.sleep(2.0)

        # 修正前に起動したLora-Managerは親モデルIDを保存時に落とすため、
        # 今回新規保存されたレシピも最後に直接補完して即時反映する。
        repaired_recipes, repaired_loras = backfill_saved_recipe_model_ids(RECIPE_DIR, civitai_headers)
        alias_recipes, alias_count, alias_resources = reconcile_saved_recipe_prompt_loras(RECIPE_DIR)
        if repaired_loras or alias_recipes:
            refreshed = refresh_lora_manager_recipes()
            refresh_note = "一覧を再読込しました" if refreshed else "次回の一覧再読込時に反映されます"
            print(
                f"[+] 同期後レシピのLoRAリンク {repaired_loras} 件、プロンプト別名 {alias_count} 件、"
                f"台帳資源 {alias_resources} 件を補完し、{refresh_note}。"
            )
                
        print("\n[+] 全ての同期処理が終了しました。")
        
        if failed_ids:
            print("\n======================================")
            print(f"[-] 以下の画像 ({len(failed_ids)}件) の取得に失敗しました:")
            for fid in failed_ids:
                print(f"  * ID: {fid} ( https://civitai.com/images/{fid} )")
            print("======================================")
        else:
            print("\n[+] すべての画像が正常に処理されました（失敗なし）")

        emit_event(
            "finished",
            status="ok",
            total=total_pending,
            success=succeeded,
            failed=total_pending - succeeded,
            failed_ids=list(failed_ids),
        )

    except Exception as e:
        print(f"[-] 実行中にエラーが発生しました: {e}")
        emit_event(
            "finished",
            status="error",
            stage="run",
            message=str(e),
            total=len(pending),
            success=succeeded,
            failed=len(pending) - succeeded,
            failed_ids=list(failed_ids),
        )

if __name__ == "__main__":
    apply_cli_flags(sys.argv[1:])
    # 無人実行では画面を誰も見ていない。中止した理由を終了コードでも伝える。
    #   0=正常 / 1=致命的エラー / 2=規約側の制限による中止
    _EXIT_CODE = 0
    if "--list-collections" in sys.argv[1:]:
        # 読み取り専用モード。同期はせず、コレクション一覧だけ返して終わる。
        # 必要な設定は raindrop_token だけなので validate_config は通さない。
        sys.exit(run_list_collections())
    try:
        main()
    except RateLimitAbort as abort:
        # レート制限・資格情報の問題で自ら止まった場合。異常終了として扱う。
        # 無人実行では画面を誰も見ていないので、終了コードでも判るようにする。
        print(f"[-] 規約側の制限により同期を中止しました: {abort}")
        emit_event("finished", status="error", stage="rate_limited", message=str(abort),
                   total=0, success=0, failed=0, failed_ids=[])
        _EXIT_CODE = 2
    except Exception as e:
        print(f"[-] 致命的なエラー: {e}")
        emit_event("finished", status="error", stage="fatal", message=str(e),
                   total=0, success=0, failed=0, failed_ids=[])
        _EXIT_CODE = 1
    finally:
        print("\n--------------------------------------")
        if NON_INTERACTIVE:
            # 呼び出し元がGUI等の場合、ここで待つとプロセスが終わらない。
            print("（非対話モードのため終了します）")
        else:
            input("エンターキーを押すとウインドウを閉じます...")
    sys.exit(_EXIT_CODE)
