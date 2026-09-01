# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""供給ノードの**出力の型**を固定する（`I-20260829-04`）。

守るのは3つ。どれも、崩れても画面は正常に見えるものである。

1. **`sampler` / `scheduler` は選択肢（COMBO）の型で出る。** 文字列型のままだと
   フロントでもサーバでも選択肢の口へ繋がらず、「画像を差し替えてもサンプラーが
   追従しない」が残る。
2. **一覧は現物を握る（複製しない）。** サーバ側の `validate_node_input` は
   受け側が旧形式のとき**内容が等しいこと**を要求する。複製を持つと、他の拡張が
   一覧へ足した瞬間に食い違い、**そのグラフ全体が投入不能**になる。
3. **`checkpoint` は選択肢にしない。** 一覧の出所が毎回コピーを返すため現物を
   握れず、固めると利用者がモデルを1つ足しただけで同じ壊れ方をする。

**ComfyUI の外でも読み込めること**もここで見る。検査や道具から素で import
されたときに例外を投げると、ノードの一覧を作る側が丸ごと倒れる。
"""
from __future__ import annotations

import importlib
import sys
import types

import pytest


def _reload_nodes():
    """`unbake.nodes` を読み直して返す。`RETURN_TYPES` は import 時に決まる。"""
    sys.modules.pop("unbake.nodes", None)
    return importlib.import_module("unbake.nodes")


@pytest.fixture
def host_comfy():
    """`comfy.samplers` を持つ宿主を模す。**後片付けまでが仕事。**

    偽物を置いたまま抜けると、後続の検査が「ComfyUI の中に居る」と誤認する。
    """
    saved = {name: sys.modules.get(name) for name in ("comfy", "comfy.samplers", "unbake.nodes")}
    samplers = ["euler", "dpmpp_2m"]
    schedulers = ["normal", "karras"]

    module = types.ModuleType("comfy.samplers")

    class KSampler:
        SAMPLERS = samplers
        SCHEDULERS = schedulers

    module.KSampler = KSampler
    package = types.ModuleType("comfy")
    package.samplers = module
    sys.modules["comfy"] = package
    sys.modules["comfy.samplers"] = module
    try:
        yield samplers, schedulers
    finally:
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
        _reload_nodes()


def _slot(nodes, field: str) -> int:
    return [name for name, _kind, _default in nodes.FIELDS].index(field)


def test_sampler_and_scheduler_are_combo(host_comfy):
    samplers, schedulers = host_comfy
    nodes = _reload_nodes()
    types_ = nodes.UnbakeRecipeSource.RETURN_TYPES
    assert types_[_slot(nodes, "sampler")] == samplers
    assert types_[_slot(nodes, "scheduler")] == schedulers


def test_choice_lists_are_the_host_objects_not_copies(host_comfy):
    """**現物であること。** 等しいだけでは足りない——複製は黙って古くなる。"""
    samplers, schedulers = host_comfy
    nodes = _reload_nodes()
    types_ = nodes.UnbakeRecipeSource.RETURN_TYPES
    assert types_[_slot(nodes, "sampler")] is samplers
    assert types_[_slot(nodes, "scheduler")] is schedulers

    # 宿主側が後から足したものが、こちらの型にも届く（＝同じ物を見ている）。
    samplers.append("後から足したサンプラー")
    assert "後から足したサンプラー" in nodes.UnbakeRecipeSource.RETURN_TYPES[_slot(nodes, "sampler")]


def test_checkpoint_stays_a_string(host_comfy):
    """一覧の現物を握れないので選択肢にしない（`_return_types()` の理由）。"""
    nodes = _reload_nodes()
    assert nodes.UnbakeRecipeSource.RETURN_TYPES[_slot(nodes, "checkpoint")] == "STRING"
    assert "checkpoint" not in nodes.CHOICE_FIELDS


def test_choice_fields_are_exactly_sampler_and_scheduler(host_comfy):
    """JS 側（`recipeSourceNode.js` の配線）と対。片方だけ広げると投入不能になる。"""
    nodes = _reload_nodes()
    assert sorted(nodes.CHOICE_FIELDS) == ["sampler", "scheduler"]


def test_loads_outside_comfyui_and_falls_back_to_strings():
    """ComfyUI の外では**例外を出さず**、全部の型が文字列側へ落ちる。"""
    saved = {name: sys.modules.get(name) for name in ("comfy", "comfy.samplers", "unbake.nodes")}
    sys.modules.pop("comfy", None)
    sys.modules.pop("comfy.samplers", None)
    try:
        nodes = _reload_nodes()
        types_ = nodes.UnbakeRecipeSource.RETURN_TYPES
        assert types_[_slot(nodes, "sampler")] == "STRING"
        assert types_[_slot(nodes, "scheduler")] == "STRING"
        # 型の数は環境で変わらない（出力の本数が環境依存になると配線が壊れる）。
        assert len(types_) == len(nodes.FIELDS)
    finally:
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
        _reload_nodes()


def test_empty_choice_list_falls_back_instead_of_shipping_an_empty_combo():
    """**空の一覧を COMBO として出さない。**

    空を出すと、受け側の一覧と内容が一致しないため
    `Return type mismatch` でグラフ全体が投入不能になる。文字列へ落ちれば
    「繋がらない」で済み、壊れ方が線1本に閉じる。
    """
    saved = {name: sys.modules.get(name) for name in ("comfy", "comfy.samplers", "unbake.nodes")}
    module = types.ModuleType("comfy.samplers")

    class KSampler:
        SAMPLERS: list = []
        SCHEDULERS: list = []

    module.KSampler = KSampler
    package = types.ModuleType("comfy")
    package.samplers = module
    sys.modules["comfy"] = package
    sys.modules["comfy.samplers"] = module
    try:
        nodes = _reload_nodes()
        types_ = nodes.UnbakeRecipeSource.RETURN_TYPES
        assert types_[_slot(nodes, "sampler")] == "STRING"
        assert types_[_slot(nodes, "scheduler")] == "STRING"
    finally:
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
        _reload_nodes()
