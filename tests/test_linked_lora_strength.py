# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**強度が読めなくても、その LoRA を無かったことにしない**（`I-20260831-57`）。

`_embedded_lora_evidence` は `_finite_number` が `None` を返した時点で
`continue` していた。強度が**配線（``[node_id, slot]``）で来る**のは ComfyUI では
普通の形なので、そのグラフの LoRA は**名前ごと証拠から消えて**いた
——落ちるのは強度ではなく「**このグラフはこの LoRA を使っている**」という事実である。

**判らないときは鍵を置かない**（`null` にしない）。`null` を置くと下流の
`Number(null)` が **0** になり、`Number.isFinite(0)` は true なので
「強度0で積む」という嘘に化ける。鍵が無ければ `NaN` になり、既にある
`LORA_STRENGTH_NON_FINITE` の道が正しく走る。
"""
import unittest

from unbake.services.recipes.replay_manifest_service import (
    _embedded_lora_evidence,
    _strengths_conflict,
)


def _graph(strength_model, extra=None):
    prompt = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
        "2": {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": "alpha.safetensors",
                "strength_model": strength_model,
                "strength_clip": strength_model,
                "model": ["1", 0],
                "clip": ["1", 1],
            },
        },
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "p", "clip": ["2", 1]}},
        "4": {"class_type": "KSampler", "inputs": {
            "seed": 1, "steps": 20, "cfg": 4, "sampler_name": "euler",
            "scheduler": "normal", "denoise": 1,
            "model": ["2", 0], "positive": ["3", 0], "negative": ["3", 0],
            "latent_image": ["5", 0]}},
        "5": {"class_type": "EmptyLatentImage",
              "inputs": {"width": 512, "height": 512, "batch_size": 1}},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["4", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0], "filename_prefix": "x"}},
    }
    if extra:
        prompt.update(extra)
    return prompt


class LinkedLoraStrengthTest(unittest.TestCase):
    def test_配線で来ても_LoRA_が証拠から消えない(self):
        prompt = _graph(["9", 0], {"9": {"class_type": "SomeNode", "inputs": {"a": ["1", 0]}}})
        evidence = _embedded_lora_evidence(prompt)

        self.assertEqual(len(evidence), 1, f"LoRA が丸ごと落ちている: {evidence}")
        item = evidence[0]
        self.assertEqual(item["name"], "alpha.safetensors")
        self.assertFalse(item["strength_known"], "判らないのに判っていると言っている")
        self.assertEqual(item.get("strength_source"), "link")

    def test_判らない強度は_鍵ごと置かない(self):
        """`null` を置くと下流の `Number(null)` が 0 になる。"""
        prompt = _graph(["9", 0], {"9": {"class_type": "SomeNode", "inputs": {"a": ["1", 0]}}})
        item = _embedded_lora_evidence(prompt)[0]
        self.assertNotIn("strength_model", item, "`null` の強度を置いている（0 に化ける）")
        self.assertNotIn("strength_clip", item)

    def test_繋がっている先が定数なら_読む(self):
        prompt = _graph(["9", 0], {"9": {"class_type": "PrimitiveFloat", "inputs": {"value": 0.65}}})
        item = _embedded_lora_evidence(prompt)[0]
        self.assertTrue(item["strength_known"], "定数を読めていない")
        self.assertAlmostEqual(item["strength_model"], 0.65)
        self.assertAlmostEqual(item["strength_clip"], 0.65)

    def test_定数が1つに決まらないなら_読まない(self):
        """**どれが出口か決められないものを、当てずっぽうで読まない。**"""
        prompt = _graph(["9", 0],
                        {"9": {"class_type": "SomeNode", "inputs": {"a": 1.0, "b": 2.0}}})
        item = _embedded_lora_evidence(prompt)[0]
        self.assertFalse(item["strength_known"], "2つ在るのにどちらかを読んでいる")

    def test_対照_数で来ればこれまでどおり(self):
        item = _embedded_lora_evidence(_graph(0.8))[0]
        self.assertTrue(item["strength_known"])
        self.assertAlmostEqual(item["strength_model"], 0.8)

    def test_対照_名前が無ければ今までどおり落とす(self):
        prompt = _graph(0.8)
        prompt["2"]["inputs"]["lora_name"] = ""
        self.assertEqual(_embedded_lora_evidence(prompt), [])

    def test_判らない強度を_競合として数えない(self):
        """読めなかっただけで `LORA_STRENGTH_CONFLICT` を出さない。"""
        known = {"strength_model": 0.5, "strength_clip": 0.5}
        unknown = {"strength_known": False}
        self.assertFalse(_strengths_conflict([known, unknown]),
                         "判らないものを別の値として数えている")
        self.assertFalse(_strengths_conflict([known, dict(known)]))
        # **対照。** 本当に食い違っていれば、これまでどおり競合として出る。
        self.assertTrue(_strengths_conflict([known, {"strength_model": 0.9, "strength_clip": 0.9}]))


if __name__ == "__main__":
    unittest.main()
