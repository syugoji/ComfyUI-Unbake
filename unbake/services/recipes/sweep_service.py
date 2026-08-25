# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
#
# ComfyUI-Unbake の一部。著作権の所在を明示してあることが、
# 後から別のライセンスを足せる唯一の担保になる。
"""Server-side persistence for recipe sweep templates and human selections."""

from __future__ import annotations

import asyncio
import copy
import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from ...utils.json_io import dump_json_strict, dumps_json_strict


SCHEMA = "lora-manager.recipe-sweeps"
SCHEMA_VERSION = 1
COLLECTIONS = ("templates", "jobs", "recommendations")
ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
AXIS_KINDS = {
    "prompt_placeholder",
    "prompt_append",
    "lora_strength",
    "checkpoint",
    "generation_parameter",
}
SWEEP_MODES = {"single_axis_seeds", "cartesian", "cartesian_seeds"}
JOB_STATUSES = {"draft", "ready", "running", "paused", "completed", "failed"}
CELL_STATUSES = {"pending", "queued", "running", "completed", "failed", "reused"}
MAX_SAFE_SEED = (1 << 53) - 2


class RecipeSweepError(RuntimeError):
    """Validation or persistence error safe to expose to the API caller."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
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
    if isinstance(value, float):
        if not math.isfinite(value):
            raise RecipeSweepError("INVALID_NUMBER", "NaNや無限大は保存できません。")
        return value
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    raise RecipeSweepError("INVALID_VALUE", "保存できない値が含まれています。")


def _require_text(value: Any, field: str, *, limit: int = 250) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RecipeSweepError("INVALID_FIELD", f"{field} は空にできません。")
    text = value.strip()
    if len(text) > limit:
        raise RecipeSweepError("INVALID_FIELD", f"{field} が長すぎます。")
    return text


def _validate_id(value: Any, field: str = "id") -> str:
    text = _require_text(value, field, limit=64)
    if not ID_PATTERN.fullmatch(text):
        raise RecipeSweepError("INVALID_ID", f"{field} の形式が正しくありません。")
    return text


def _validate_seed(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RecipeSweepError("INVALID_SEED", "seed は整数で指定してください。")
    if value < 0 or value > MAX_SAFE_SEED:
        raise RecipeSweepError("INVALID_SEED", "seed が安全な範囲外です。")
    return value


def _validate_axis(axis: Any, index: int) -> dict[str, Any]:
    if not isinstance(axis, dict):
        raise RecipeSweepError("INVALID_AXIS", f"axes[{index}] はオブジェクトが必要です。")
    result = _canonical(axis)
    result["id"] = _validate_id(result.get("id"), f"axes[{index}].id")
    kind = result.get("kind")
    if kind not in AXIS_KINDS:
        raise RecipeSweepError("INVALID_AXIS", f"axes[{index}].kind が未対応です。")
    result["kind"] = kind
    result["label"] = _require_text(result.get("label"), f"axes[{index}].label", limit=120)
    if kind == "prompt_placeholder":
        token = _require_text(result.get("token"), f"axes[{index}].token", limit=80)
        if not (token.startswith("{") and token.endswith("}")):
            raise RecipeSweepError("INVALID_AXIS", "穴方式の token は {pose} 形式が必要です。")
        result["token"] = token
    elif kind == "generation_parameter":
        result["parameter"] = _require_text(
            result.get("parameter"), f"axes[{index}].parameter", limit=80
        )

    values = result.get("values")
    if not isinstance(values, list) or not 2 <= len(values) <= 50:
        raise RecipeSweepError("INVALID_AXIS", "各軸には2〜50個の値が必要です。")
    normalized_values: list[dict[str, Any]] = []
    baseline_count = 0
    for value_index, item in enumerate(values):
        if not isinstance(item, dict) or "value" not in item:
            raise RecipeSweepError(
                "INVALID_AXIS", f"axes[{index}].values[{value_index}] が不正です。"
            )
        normalized = _canonical(item)
        normalized["label"] = _require_text(
            normalized.get("label"),
            f"axes[{index}].values[{value_index}].label",
            limit=120,
        )
        normalized["baseline"] = normalized.get("baseline") is True
        baseline_count += int(normalized["baseline"])
        normalized_values.append(normalized)
    if baseline_count != 1:
        raise RecipeSweepError("INVALID_AXIS", "各軸には baseline がちょうど1つ必要です。")
    result["values"] = normalized_values
    return result


class RecipeSweepService:
    """Atomic JSON store for comparison assets, resumable jobs, and recommendations."""

    def __init__(self, storage_path: str | Path) -> None:
        self._path = Path(storage_path)
        self._lock = asyncio.Lock()

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {
            "schema": SCHEMA,
            "schemaVersion": SCHEMA_VERSION,
            "revision": 0,
            "updatedAt": None,
            "templates": [],
            "jobs": [],
            "recommendations": [],
        }

    def _read_sync(self) -> dict[str, Any]:
        if not self._path.exists():
            return self._empty_state()
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RecipeSweepError(
                "SWEEP_STORE_UNREADABLE", "比較資産の保存ファイルを読み取れません。", 500
            ) from exc
        if not isinstance(payload, dict) or payload.get("schema") != SCHEMA:
            raise RecipeSweepError(
                "SWEEP_STORE_INVALID", "比較資産の保存形式が正しくありません。", 500
            )
        for name in COLLECTIONS:
            if not isinstance(payload.get(name), list):
                raise RecipeSweepError(
                    "SWEEP_STORE_INVALID", "比較資産の保存形式が正しくありません。", 500
                )
        return payload

    def _write_sync(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp = self._path.with_name(f".{self._path.name}.tmp-{uuid.uuid4().hex}")
        try:
            with temp.open("w", encoding="utf-8", newline="\n") as stream:
                dump_json_strict(_canonical(payload), stream, ensure_ascii=False, indent=2)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self._path)
        finally:
            temp.unlink(missing_ok=True)

    async def get_state(self) -> dict[str, Any]:
        async with self._lock:
            return copy.deepcopy(await asyncio.to_thread(self._read_sync))

    @staticmethod
    def _validate_template(payload: Any, item_id: str) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise RecipeSweepError("INVALID_TEMPLATE", "テンプレートはオブジェクトが必要です。")
        item = _canonical(payload)
        item["id"] = item_id
        item["name"] = _require_text(item.get("name"), "name", limit=120)
        item["recipeId"] = _require_text(item.get("recipeId"), "recipeId", limit=500)
        if item.get("mode") not in SWEEP_MODES:
            raise RecipeSweepError("INVALID_TEMPLATE", "未対応の掃引モードです。")
        axes = item.get("axes")
        if not isinstance(axes, list) or not 1 <= len(axes) <= 8:
            raise RecipeSweepError("INVALID_TEMPLATE", "axes は1〜8軸で指定してください。")
        item["axes"] = [_validate_axis(axis, index) for index, axis in enumerate(axes)]
        if item["mode"] == "single_axis_seeds" and len(item["axes"]) != 1:
            raise RecipeSweepError("INVALID_TEMPLATE", "1軸モードでは axes は1件だけです。")
        seeds = item.get("seeds", [])
        if not isinstance(seeds, list) or len(seeds) > 50:
            raise RecipeSweepError("INVALID_TEMPLATE", "seeds は最大50件です。")
        item["seeds"] = [_validate_seed(seed) for seed in seeds]
        if item["mode"] in {"single_axis_seeds", "cartesian_seeds"} and not item["seeds"]:
            raise RecipeSweepError("INVALID_TEMPLATE", "このモードでは seed が1件以上必要です。")
        return item

    @staticmethod
    def _validate_job(payload: Any, item_id: str) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise RecipeSweepError("INVALID_JOB", "ジョブはオブジェクトが必要です。")
        item = _canonical(payload)
        item["id"] = item_id
        item["templateId"] = _validate_id(item.get("templateId"), "templateId")
        if item.get("status") not in JOB_STATUSES:
            raise RecipeSweepError("INVALID_JOB", "ジョブ状態が不正です。")
        cells = item.get("cells")
        if not isinstance(cells, list) or len(cells) > 500:
            raise RecipeSweepError("INVALID_JOB", "cells は最大500件です。")
        normalized_cells: list[dict[str, Any]] = []
        for index, cell in enumerate(cells):
            if not isinstance(cell, dict):
                raise RecipeSweepError("INVALID_JOB", f"cells[{index}] が不正です。")
            normalized = _canonical(cell)
            normalized["id"] = _validate_id(normalized.get("id"), f"cells[{index}].id")
            if normalized.get("status") not in CELL_STATUSES:
                raise RecipeSweepError("INVALID_JOB", f"cells[{index}].status が不正です。")
            normalized["signature"] = _require_text(
                normalized.get("signature"), f"cells[{index}].signature", limit=128
            )
            normalized_cells.append(normalized)
        item["cells"] = normalized_cells
        return item

    @staticmethod
    def _validate_recommendation(payload: Any, item_id: str) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise RecipeSweepError("INVALID_RECOMMENDATION", "推奨値はオブジェクトが必要です。")
        item = _canonical(payload)
        item["id"] = item_id
        target = item.get("target")
        if not isinstance(target, dict) or target.get("kind") not in {"lora", "checkpoint"}:
            raise RecipeSweepError("INVALID_RECOMMENDATION", "target は LoRA または checkpoint が必要です。")
        target = _canonical(target)
        target["id"] = _require_text(target.get("id"), "target.id", limit=500)
        item["target"] = target
        item["templateId"] = _validate_id(item.get("templateId"), "templateId")
        item["jobId"] = _validate_id(item.get("jobId"), "jobId")
        item["cellId"] = _validate_id(item.get("cellId"), "cellId")
        selections = item.get("selections")
        if not isinstance(selections, list) or not selections:
            raise RecipeSweepError("INVALID_RECOMMENDATION", "selections が必要です。")
        normalized: list[dict[str, Any]] = []
        for index, selection in enumerate(selections):
            if not isinstance(selection, dict) or "value" not in selection:
                raise RecipeSweepError(
                    "INVALID_RECOMMENDATION", f"selections[{index}] が不正です。"
                )
            entry = _canonical(selection)
            entry["axis"] = _validate_id(entry.get("axis"), f"selections[{index}].axis")
            normalized.append(entry)
        item["selections"] = normalized
        item["selectedBy"] = "human"
        return item

    async def upsert(self, collection: str, item_id: str, payload: Any) -> dict[str, Any]:
        if collection not in COLLECTIONS:
            raise RecipeSweepError("INVALID_COLLECTION", "保存先が不正です。")
        item_id = _validate_id(item_id)
        validators = {
            "templates": self._validate_template,
            "jobs": self._validate_job,
            "recommendations": self._validate_recommendation,
        }
        item = validators[collection](payload, item_id)
        now = _utc_now()
        async with self._lock:
            state = await asyncio.to_thread(self._read_sync)
            previous = next((entry for entry in state[collection] if entry.get("id") == item_id), None)
            item["createdAt"] = previous.get("createdAt", now) if previous else now
            item["updatedAt"] = now
            state[collection] = [entry for entry in state[collection] if entry.get("id") != item_id]
            state[collection].append(item)
            state[collection].sort(key=lambda entry: str(entry.get("id", "")))
            state["revision"] = int(state.get("revision") or 0) + 1
            state["updatedAt"] = now
            await asyncio.to_thread(self._write_sync, state)
        return copy.deepcopy(item)

    async def delete(self, collection: str, item_id: str) -> bool:
        if collection not in COLLECTIONS:
            raise RecipeSweepError("INVALID_COLLECTION", "保存先が不正です。")
        item_id = _validate_id(item_id)
        async with self._lock:
            state = await asyncio.to_thread(self._read_sync)
            before = len(state[collection])
            state[collection] = [entry for entry in state[collection] if entry.get("id") != item_id]
            if len(state[collection]) == before:
                return False
            state["revision"] = int(state.get("revision") or 0) + 1
            state["updatedAt"] = _utc_now()
            await asyncio.to_thread(self._write_sync, state)
        return True
