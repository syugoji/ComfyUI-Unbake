# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Immutable recipe revisions adopted from verified ComfyUI trial outputs."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import math
import os
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from PIL import Image
from ...utils.json_io import dump_json_strict, dumps_json_strict


SCHEMA = "lora-manager.recipe-revision"
ACTIVE_SCHEMA = "lora-manager.recipe-revision-active"
SOURCE_FIELDS = (
    "base_model",
    "gen_params",
    "checkpoint",
    "loras",
    "embeddings",
    "comfy_prompt",
    "comfy_workflow",
    "a1111_parameters",
    "generation_metadata",
    "replay_policy",
)
MAX_IMAGE_BYTES = 100 * 1024 * 1024
MAX_IMAGE_PIXELS = 80_000_000
MAX_PROMPT_LENGTH = 250_000
MAX_SAFE_SEED = (1 << 53) - 2


class RecipeRevisionError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_bytes(value: Any) -> bytes:
    return dumps_json_strict(
        _canonical(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


class RecipeRevisionService:
    """Store active prompt/seed variants without changing source recipe files."""

    def __init__(
        self,
        *,
        history_getter: Callable[[str], dict[str, Any]] | None = None,
        output_dir_getter: Callable[[], str] | None = None,
    ) -> None:
        self._history_getter = history_getter or self._default_history_getter
        self._output_dir_getter = output_dir_getter or self._default_output_dir_getter
        self._lock = asyncio.Lock()

    @staticmethod
    def _default_history_getter(prompt_id: str) -> dict[str, Any]:
        try:
            from server import PromptServer  # type: ignore[import-not-found]

            return PromptServer.instance.prompt_queue.get_history(prompt_id=prompt_id)
        except Exception as exc:  # pragma: no cover - ComfyUI runtime path
            raise RecipeRevisionError(
                "COMFY_HISTORY_UNAVAILABLE",
                "ComfyUIの生成履歴を確認できません。",
                503,
            ) from exc

    @staticmethod
    def _default_output_dir_getter() -> str:
        try:
            import folder_paths  # type: ignore[import-not-found]

            return folder_paths.get_output_directory()
        except Exception as exc:  # pragma: no cover - ComfyUI runtime path
            raise RecipeRevisionError(
                "COMFY_OUTPUT_UNAVAILABLE", "ComfyUIの出力先を確認できません。", 503
            ) from exc

    @staticmethod
    def _recipe_key(recipe_id: str) -> str:
        return hashlib.sha256(recipe_id.encode("utf-8")).hexdigest()[:32]

    def _paths(self, recipe_id: str, recipe_json_path: str | Path) -> dict[str, Path]:
        root = Path(recipe_json_path).resolve().parent / ".recipe-revisions"
        key = self._recipe_key(recipe_id)
        item = root / "items" / key
        return {
            "root": root,
            "item": item,
            "revisions": item / "revisions",
            "active": root / "active" / f"{key}.json",
        }

    @staticmethod
    def _source_image_path(recipe: dict[str, Any]) -> Path | None:
        value = recipe.get("file_path")
        if isinstance(value, str) and value.strip():
            path = Path(value).expanduser()
            if path.is_file():
                return path.resolve()
        return None

    def _source_state_sync(self, recipe: dict[str, Any]) -> dict[str, str]:
        image_path = self._source_image_path(recipe)
        image_sha256 = _sha256_file(image_path) if image_path else ""
        basis = {key: recipe.get(key) for key in SOURCE_FIELDS}
        basis["recipe_image_sha256"] = image_sha256
        etag = hashlib.sha256(_json_bytes(basis)).hexdigest()
        return {"etag": etag, "recipe_image_sha256": image_sha256}

    async def get_source_state(self, recipe: dict[str, Any]) -> dict[str, str]:
        return await asyncio.to_thread(self._source_state_sync, recipe)

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError, json.JSONDecodeError):
            return None

    @staticmethod
    def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f".{path.name}.tmp-{uuid.uuid4().hex}")
        try:
            with temp.open("w", encoding="utf-8", newline="\n") as stream:
                dump_json_strict(_canonical(payload), stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink(missing_ok=True)

    def _load_revision(
        self, recipe_id: str, recipe_json_path: str | Path, revision_id: str
    ) -> tuple[dict[str, Any], Path]:
        if not re.fullmatch(r"[a-f0-9]{32}", revision_id):
            raise RecipeRevisionError(
                "REVISION_NOT_FOUND", "指定された改変版が見つかりません。", 404
            )
        paths = self._paths(recipe_id, recipe_json_path)
        revision_dir = paths["revisions"] / revision_id
        payload = self._read_json(revision_dir / "revision.json")
        if (
            not payload
            or payload.get("schema") != SCHEMA
            or payload.get("version") != 1
            or payload.get("recipe_id") != recipe_id
            or payload.get("revision_id") != revision_id
        ):
            raise RecipeRevisionError(
                "REVISION_NOT_FOUND", "指定された改変版が見つかりません。", 404
            )
        return payload, revision_dir

    def _read_active_marker(
        self, paths: dict[str, Path], recipe_id: str
    ) -> dict[str, Any] | None:
        """有効な active marker だけを返す。**壊れていれば「無い」と読む。**

        読み方を1つにする（``I-20260831-50``）。以前は ``get_summary`` が
        schema と recipe_id まで見て「有効な改変版は無い」と答えるのに、
        ``resolve_active_recipe`` は marker の有無しか見ずに
        ``_load_revision`` へ渡していた——**同じ壊れた marker に対して、
        片方は「無い」と言い、片方は 404 を投げる**。

        入口が2つある限り、片方だけ直しても次の書き手がまた分ける。
        """
        marker = self._read_json(paths["active"])
        return marker if self._marker_is_valid(marker, recipe_id) else None

    @staticmethod
    def _marker_is_valid(marker: Any, recipe_id: Any) -> bool:
        """この active marker を「有効」と読んでよいか。**判定はこの1本だけ。**

        ``I-20260831-50`` が「読み方を1つにする」ために `_read_active_marker` を
        作ったが、**4人目の読み手が残っていた**（2026-09-01・走査6周目）——
        `get_active_prompt_recipe_ids` は marker を自分で読み、`schema` しか
        見ていなかった。**同じ marker について `get_summary` が
        「有効な改変版は無い」と答える一方、そちらは「この レシピには
        有効な改変版が在る」と数える。** `I-20260831-50` の docstring 自身が
        「**入口が2つある限り、片方だけ直しても次の書き手がまた分ける**」と
        書いている、その通りのことが起きていた。

        判定をここへ畳んだので、読み手は marker の持ち主が判っていても
        いなくても同じ規則を使える。
        """
        if not isinstance(marker, dict):
            return False
        if marker.get("schema") != ACTIVE_SCHEMA:
            return False
        # 持ち主を指定されていれば一致を要求する（指定が無ければ marker 自身の値を使う）。
        owner = marker.get("recipe_id")
        if not isinstance(owner, str) or not owner:
            return False
        if recipe_id is not None and owner != recipe_id:
            return False
        # **改変版を名指ししていない marker は「壊れている」側**。
        # 名前が空のまま通すと ``_load_revision`` が失敗し、
        # 「改変版が古い」（stale）として出る——**名指ししていない**のと
        # **名指しした先が消えている**のは別の状態である。
        return bool(str(marker.get("revision_id") or "").strip())

    async def get_summary(
        self,
        recipe_id: str,
        recipe_json_path: str | Path,
        *,
        current_etag: str,
    ) -> dict[str, Any]:
        def read() -> dict[str, Any]:
            paths = self._paths(recipe_id, recipe_json_path)
            marker = self._read_active_marker(paths, recipe_id)
            if marker is None:
                return {"active": False, "stale": False, "count": self._revision_count(paths)}
            revision_id = str(marker.get("revision_id") or "")
            try:
                revision, _ = self._load_revision(recipe_id, recipe_json_path, revision_id)
            except RecipeRevisionError:
                return {"active": False, "stale": True, "count": self._revision_count(paths)}
            provenance = revision.get("provenance") or {}
            return {
                "active": True,
                "stale": revision.get("source", {}).get("generation_etag") != current_etag,
                "count": self._revision_count(paths),
                "revision_id": revision_id,
                "prompt_source": provenance.get("prompt_source"),
                "seed": provenance.get("seed"),
                "model": provenance.get("model"),
                "created_at": provenance.get("created_at"),
            }

        return await asyncio.to_thread(read)

    @staticmethod
    def _revision_count(paths: dict[str, Path]) -> int:
        directory = paths["revisions"]
        if not directory.is_dir():
            return 0
        return sum(1 for item in directory.iterdir() if item.is_dir() and not item.name.startswith(".tmp-"))

    async def get_active_prompt_recipe_ids(self, recipes_dir: str | Path) -> set[str]:
        def scan() -> set[str]:
            result = set()
            root = Path(recipes_dir).resolve()
            if not root.is_dir():
                return result
            for current_root, dirs, _files in os.walk(root):
                if ".recipe-revisions" not in dirs:
                    continue
                store = Path(current_root) / ".recipe-revisions"
                dirs.remove(".recipe-revisions")
                active_dir = store / "active"
                if not active_dir.is_dir():
                    continue
                for path in active_dir.glob("*.json"):
                    marker = self._read_json(path)
                    # **読み方を1つにする**（`I-20260831-50` の4人目・2026-09-01）。
                    # ここだけ `schema` しか見ておらず、改変版を名指ししていない
                    # marker を「有効」と数えていた——同じ marker を
                    # `get_summary` は `active: False` と答える。
                    if self._marker_is_valid(marker, None):
                        result.add(str(marker["recipe_id"]))
            return result

        return await asyncio.to_thread(scan)

    @staticmethod
    def _validated_uuid(value: Any, field: str) -> str:
        text = str(value or "")
        try:
            parsed = uuid.UUID(text)
        except (ValueError, AttributeError) as exc:
            raise RecipeRevisionError(
                "CANDIDATE_INVALID", f"{field}が正しいUUIDではありません。", 400
            ) from exc
        if str(parsed) != text:
            raise RecipeRevisionError(
                "CANDIDATE_INVALID", f"{field}が正規形式ではありません。", 400
            )
        return text

    @staticmethod
    def _trial_metadata(entry: dict[str, Any]) -> dict[str, Any]:
        prompt = entry.get("prompt")
        if not isinstance(prompt, (list, tuple)) or len(prompt) < 4:
            return {}
        extra = prompt[3]
        if not isinstance(extra, dict):
            return {}
        trial = extra.get("lora_manager_recipe_trial")
        return trial if isinstance(trial, dict) else {}

    def _verified_history_output(
        self,
        *,
        recipe_id: str,
        source_etag: str,
        manifest_hash: str,
        draft_hash: str,
        candidate: dict[str, Any],
    ) -> tuple[Path, dict[str, Any], dict[str, Any]]:
        prompt_id = self._validated_uuid(candidate.get("prompt_id"), "prompt_id")
        candidate_id = str(candidate.get("candidate_id") or "")
        if not candidate_id or len(candidate_id) > 300:
            raise RecipeRevisionError(
                "CANDIDATE_INVALID", "candidate_idがありません。", 400
            )
        seed = candidate.get("seed")
        if isinstance(seed, bool) or not isinstance(seed, int) or not (0 <= seed <= MAX_SAFE_SEED):
            raise RecipeRevisionError(
                "CANDIDATE_INVALID", "seedが安全な非負整数ではありません。", 400
            )
        output_node_id = str(candidate.get("output_node_id") or "")
        image_index = candidate.get("image_index")
        if not output_node_id or isinstance(image_index, bool) or not isinstance(image_index, int) or image_index < 0:
            raise RecipeRevisionError(
                "CANDIDATE_INVALID", "出力画像の識別情報が不正です。", 400
            )

        history = self._history_getter(prompt_id)
        entry = history.get(prompt_id) if isinstance(history, dict) else None
        if not isinstance(entry, dict):
            raise RecipeRevisionError(
                "CANDIDATE_HISTORY_MISSING", "候補のComfyUI履歴が見つかりません。"
            )
        status = entry.get("status") or {}
        if status.get("completed") is not True or status.get("status_str") != "success":
            raise RecipeRevisionError(
                "CANDIDATE_NOT_COMPLETE", "候補画像の生成が正常完了していません。"
            )
        trial = self._trial_metadata(entry)
        expected = {
            "schema": "lora-manager.recipe-trial",
            "version": 1,
            "recipe_id": recipe_id,
            "source_etag": source_etag,
            "manifest_hash": manifest_hash,
            "draft_hash": draft_hash,
            "candidate_id": candidate_id,
            "seed": seed,
        }
        if any(trial.get(key) != value for key, value in expected.items()):
            raise RecipeRevisionError(
                "CANDIDATE_PROVENANCE_MISMATCH",
                "候補履歴が現在のレシピ・下書きと一致しません。",
            )

        output = (entry.get("outputs") or {}).get(output_node_id)
        images = output.get("images") if isinstance(output, dict) else None
        if not isinstance(images, list) or image_index >= len(images):
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_MISSING", "候補履歴に指定画像がありません。"
            )
        image = images[image_index]
        if not isinstance(image, dict) or image.get("type") != "output":
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_INVALID", "通常出力以外の画像は採用できません。", 400
            )
        filename = image.get("filename")
        subfolder = image.get("subfolder") or ""
        if not isinstance(filename, str) or not filename or not isinstance(subfolder, str):
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_INVALID", "候補画像名が不正です。", 400
            )
        output_root = Path(self._output_dir_getter()).resolve()
        candidate_path = (output_root / subfolder / filename).resolve()
        try:
            candidate_path.relative_to(output_root)
        except ValueError as exc:
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_INVALID", "候補画像がComfyUI出力先の外にあります。", 400
            ) from exc
        if not candidate_path.is_file():
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_MISSING", "候補画像ファイルが見つかりません。"
            )
        return candidate_path, image, trial

    @staticmethod
    def _verify_image(path: Path) -> tuple[str, int]:
        size = path.stat().st_size
        if size <= 0 or size > MAX_IMAGE_BYTES:
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_INVALID", "候補画像のファイルサイズが不正です。", 400
            )
        try:
            with Image.open(path) as image:
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise RecipeRevisionError(
                        "CANDIDATE_IMAGE_INVALID", "候補画像の解像度が不正です。", 400
                    )
                image.verify()
        except RecipeRevisionError:
            raise
        except Exception as exc:
            raise RecipeRevisionError(
                "CANDIDATE_IMAGE_INVALID", "候補画像を検証できません。", 400
            ) from exc
        return _sha256_file(path), size

    async def adopt_revision(
        self,
        *,
        recipe: dict[str, Any],
        recipe_json_path: str | Path,
        replay_manifest: dict[str, Any],
        if_match: str,
        draft: dict[str, Any],
        candidate: dict[str, Any],
    ) -> dict[str, Any]:
        async with self._lock:
            source_state = await self.get_source_state(recipe)
            normalized_match = str(if_match or "").strip().strip('"')
            if normalized_match != source_state["etag"]:
                raise RecipeRevisionError(
                    "RECIPE_ETAG_CHANGED",
                    "元レシピの生成情報が更新されています。候補を作り直してください。",
                    412,
                )
            manifest_hash = str(replay_manifest.get("manifest_hash") or "")
            if str(draft.get("manifest_hash") or "") != manifest_hash:
                raise RecipeRevisionError(
                    "REPLAY_MANIFEST_CHANGED",
                    "再現manifestが更新されています。候補を作り直してください。",
                )
            if (
                draft.get("schema") != "lora-manager.prompt-draft"
                or draft.get("version") != 1
                or draft.get("prompt_source") != "lm_studio"
            ):
                raise RecipeRevisionError(
                    "DRAFT_INVALID", "AI下書きの形式が不正です。", 400
                )
            proposed_prompt = draft.get("proposed_prompt")
            if not isinstance(proposed_prompt, str) or not proposed_prompt.strip() or len(proposed_prompt) > MAX_PROMPT_LENGTH:
                raise RecipeRevisionError(
                    "DRAFT_INVALID", "採用するpromptが不正です。", 400
                )
            source_negative = str((recipe.get("gen_params") or {}).get("negative_prompt") or "")
            if str(draft.get("negative_prompt") or "") != source_negative:
                raise RecipeRevisionError(
                    "NEGATIVE_PROMPT_CHANGED", "Negative promptの変更は採用できません。", 409
                )
            draft_hash = str(draft.get("draft_hash") or "")
            if not re.fullmatch(r"[a-f0-9]{64}", draft_hash):
                raise RecipeRevisionError(
                    "DRAFT_INVALID", "draft_hashが不正です。", 400
                )

            image_path, _history_image, _trial = await asyncio.to_thread(
                self._verified_history_output,
                recipe_id=str(recipe.get("id") or recipe.get("recipe_id") or ""),
                source_etag=source_state["etag"],
                manifest_hash=manifest_hash,
                draft_hash=draft_hash,
                candidate=candidate,
            )
            image_sha256, image_size = await asyncio.to_thread(self._verify_image, image_path)
            return await asyncio.to_thread(
                self._adopt_sync,
                recipe,
                Path(recipe_json_path),
                source_state,
                manifest_hash,
                draft,
                candidate,
                image_path,
                image_sha256,
                image_size,
            )

    def _adopt_sync(
        self,
        recipe: dict[str, Any],
        recipe_json_path: Path,
        source_state: dict[str, str],
        manifest_hash: str,
        draft: dict[str, Any],
        candidate: dict[str, Any],
        image_path: Path,
        image_sha256: str,
        image_size: int,
    ) -> dict[str, Any]:
        recipe_id = str(recipe.get("id") or recipe.get("recipe_id") or "")
        identity = {
            "recipe_id": recipe_id,
            "draft_hash": draft["draft_hash"],
            "candidate_id": candidate["candidate_id"],
            "prompt_id": candidate["prompt_id"],
            "output_node_id": str(candidate["output_node_id"]),
            "image_index": candidate["image_index"],
        }
        revision_id = hashlib.sha256(_json_bytes(identity)).hexdigest()[:32]
        paths = self._paths(recipe_id, recipe_json_path)
        final_dir = paths["revisions"] / revision_id
        if final_dir.exists():
            existing, _ = self._load_revision(recipe_id, recipe_json_path, revision_id)
            self._write_active(paths["active"], recipe_id, revision_id, source_state["etag"])
            return {
                "created": False,
                "revision": existing,
                "summary": self._summary_from_revision(existing, stale=False, count=self._revision_count(paths)),
            }

        paths["revisions"].mkdir(parents=True, exist_ok=True)
        temp_dir = paths["revisions"] / f".tmp-{revision_id}-{uuid.uuid4().hex}"
        suffix = image_path.suffix.casefold()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            suffix = ".png"
        image_name = f"image{suffix}"
        effective = copy.deepcopy(recipe)
        for key in ("replay_manifest", "revision_summary", "source_etag", "file_url", "preview_url"):
            effective.pop(key, None)
        gen_params = copy.deepcopy(effective.get("gen_params") or {})
        gen_params["prompt"] = draft["proposed_prompt"]
        gen_params["negative_prompt"] = str((recipe.get("gen_params") or {}).get("negative_prompt") or "")
        gen_params["seed"] = candidate["seed"]
        gen_params["prompt_source"] = "lm_studio"
        effective["gen_params"] = gen_params
        effective["prompt_source"] = "lm_studio"
        effective["revision_id"] = revision_id

        lm_studio = draft.get("lm_studio") if isinstance(draft.get("lm_studio"), dict) else {}
        payload = {
            "schema": SCHEMA,
            "version": 1,
            "revision_id": revision_id,
            "recipe_id": recipe_id,
            "source": {
                "generation_etag": source_state["etag"],
                "replay_manifest_hash": manifest_hash,
                "recipe_image_sha256": source_state["recipe_image_sha256"],
            },
            "provenance": {
                "prompt_source": "lm_studio",
                "draft_hash": draft["draft_hash"],
                "draft_input_image_sha256": (draft.get("image") or {}).get("sha256"),
                "model": lm_studio.get("model"),
                "loaded_identifier": lm_studio.get("loaded_identifier"),
                "gpu": lm_studio.get("gpu"),
                "candidate_id": candidate["candidate_id"],
                "prompt_id": candidate["prompt_id"],
                "output_node_id": str(candidate["output_node_id"]),
                "image_index": candidate["image_index"],
                "seed": candidate["seed"],
                "created_at": _utc_now(),
            },
            "effective_recipe": effective,
            "image_file": image_name,
            "image_sha256": image_sha256,
            "image_size": image_size,
        }
        try:
            temp_dir.mkdir(parents=False, exist_ok=False)
            shutil.copy2(image_path, temp_dir / image_name)
            self._atomic_json(temp_dir / "revision.json", payload)
            os.replace(temp_dir, final_dir)
            self._write_active(paths["active"], recipe_id, revision_id, source_state["etag"])
        except Exception:
            if temp_dir.exists():
                shutil.rmtree(temp_dir, ignore_errors=True)
            raise
        return {
            "created": True,
            "revision": payload,
            "summary": self._summary_from_revision(payload, stale=False, count=self._revision_count(paths)),
        }

    def _write_active(
        self, path: Path, recipe_id: str, revision_id: str, source_etag: str
    ) -> None:
        self._atomic_json(
            path,
            {
                "schema": ACTIVE_SCHEMA,
                "version": 1,
                "recipe_id": recipe_id,
                "revision_id": revision_id,
                "source_etag": source_etag,
                "updated_at": _utc_now(),
            },
        )

    @staticmethod
    def _summary_from_revision(
        revision: dict[str, Any], *, stale: bool, count: int
    ) -> dict[str, Any]:
        provenance = revision.get("provenance") or {}
        return {
            "active": True,
            "stale": stale,
            "count": count,
            "revision_id": revision.get("revision_id"),
            "prompt_source": provenance.get("prompt_source"),
            "seed": provenance.get("seed"),
            "model": provenance.get("model"),
            "created_at": provenance.get("created_at"),
        }

    async def resolve_active_recipe(
        self,
        recipe: dict[str, Any],
        recipe_json_path: str | Path,
        *,
        current_etag: str,
    ) -> dict[str, Any]:
        recipe_id = str(recipe.get("id") or recipe.get("recipe_id") or "")

        def resolve() -> dict[str, Any]:
            paths = self._paths(recipe_id, recipe_json_path)
            # **壊れた marker は「無い」と読む**（``I-20260831-50``）。
            # ここだけ有無しか見ていなかったので、``get_summary`` が
            # ``active: false`` と答える状態で 404 を投げていた。
            marker = self._read_active_marker(paths, recipe_id)
            if marker is None:
                return copy.deepcopy(recipe)
            revision, revision_dir = self._load_revision(
                recipe_id, recipe_json_path, str(marker.get("revision_id") or "")
            )
            if revision.get("source", {}).get("generation_etag") != current_etag:
                raise RecipeRevisionError(
                    "REVISION_STALE",
                    "元レシピの生成情報が変わったため、改変版を再生成してください。",
                    409,
                )
            effective = copy.deepcopy(revision.get("effective_recipe") or {})
            image_file = str(revision.get("image_file") or "")
            image_path = (revision_dir / image_file).resolve()
            try:
                image_path.relative_to(revision_dir.resolve())
            except ValueError as exc:
                raise RecipeRevisionError(
                    "REVISION_INVALID", "改変版画像の保存先が不正です。", 500
                ) from exc
            if not image_path.is_file():
                raise RecipeRevisionError(
                    "REVISION_IMAGE_MISSING", "改変版画像が見つかりません。", 409
                )
            effective["file_path"] = str(image_path)
            effective["revision_summary"] = self._summary_from_revision(
                revision, stale=False, count=self._revision_count(paths)
            )
            return effective

        return await asyncio.to_thread(resolve)

    async def list_revisions(
        self, recipe_id: str, recipe_json_path: str | Path, *, current_etag: str
    ) -> list[dict[str, Any]]:
        def read() -> list[dict[str, Any]]:
            paths = self._paths(recipe_id, recipe_json_path)
            marker = self._read_active_marker(paths, recipe_id) or {}
            active_id = marker.get("revision_id")
            result = []
            if not paths["revisions"].is_dir():
                return result
            for directory in paths["revisions"].iterdir():
                if not directory.is_dir() or directory.name.startswith(".tmp-"):
                    continue
                payload = self._read_json(directory / "revision.json")
                if not payload or payload.get("recipe_id") != recipe_id:
                    continue
                provenance = payload.get("provenance") or {}
                result.append(
                    {
                        "revision_id": payload.get("revision_id"),
                        "active": payload.get("revision_id") == active_id,
                        "stale": payload.get("source", {}).get("generation_etag") != current_etag,
                        "prompt_source": provenance.get("prompt_source"),
                        "seed": provenance.get("seed"),
                        "model": provenance.get("model"),
                        "created_at": provenance.get("created_at"),
                        "image_sha256": payload.get("image_sha256"),
                    }
                )
            result.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
            return result

        return await asyncio.to_thread(read)

    async def activate_revision(
        self,
        recipe_id: str,
        recipe_json_path: str | Path,
        *,
        current_etag: str,
        revision_id: str | None,
    ) -> dict[str, Any]:
        async with self._lock:
            def activate() -> dict[str, Any]:
                paths = self._paths(recipe_id, recipe_json_path)
                if not revision_id:
                    paths["active"].unlink(missing_ok=True)
                    return {"active": False, "stale": False, "count": self._revision_count(paths)}
                revision, _ = self._load_revision(recipe_id, recipe_json_path, revision_id)
                if revision.get("source", {}).get("generation_etag") != current_etag:
                    raise RecipeRevisionError(
                        "REVISION_STALE", "元レシピと一致しない改変版は有効化できません。"
                    )
                self._write_active(paths["active"], recipe_id, revision_id, current_etag)
                return self._summary_from_revision(
                    revision, stale=False, count=self._revision_count(paths)
                )

            return await asyncio.to_thread(activate)

    async def cleanup_recipe(self, recipe_id: str, recipe_json_path: str | Path) -> None:
        async with self._lock:
            def cleanup() -> None:
                paths = self._paths(recipe_id, recipe_json_path)
                if paths["item"].is_dir():
                    shutil.rmtree(paths["item"])
                paths["active"].unlink(missing_ok=True)

            await asyncio.to_thread(cleanup)
