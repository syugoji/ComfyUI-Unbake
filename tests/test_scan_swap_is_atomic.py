# Copyright (C) 2026 syugoji
# SPDX-License-Identifier: GPL-3.0-or-later
"""**走査の最中に読んでも、記録は消えない**（`I-20260831-59`）。

``RecordLibrary.scan()`` は以前 ``self._index = {}`` で**先に空にしてから**
数千件を詰め直していた。その間に読んだ側は「記録が無い」を見る。

**同時に走る窓は構造として在った**——``GET /unbake/record`` は
イベントループ上から ``_index`` を引き、``POST /unbake/record-save`` と
``GET /unbake/records?rescan=1`` はどちらも ``scan()`` を呼ぶ。
症状は 404・一覧の欠けで、「消したはずが出る／出るはずが消える」の形になる。

**前回の走査はこれを「決定的な再現を作れず」として枠から落としていた。**
筋書きが書けないことと窓が無いことは別なので、ここで**窓を止めて**確かめる
——``_summarize`` を差し替えて走査を途中で止め、その瞬間に読む。
"""
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from unbake import library as library_module
from unbake.library import RecordLibrary

RECORD_COUNT = 5


def _write_records(root: Path) -> list:
    ids = []
    for index in range(RECORD_COUNT):
        name = f"rec{index}"
        (root / f"{name}.recipe.json").write_text(
            '{"id": "%s", "title": "%s", "checkpoint": "a.safetensors"}' % (name, name),
            encoding="utf-8",
        )
        ids.append(name)
    return ids


class ScanSwapIsAtomicTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ids = _write_records(self.root)
        self.library = RecordLibrary({"record_source_dirs": [str(self.root)]})
        self.library.scan()

    def tearDown(self):
        self._tmp.cleanup()

    def test_走査の途中で読んでも全件そろっている(self):
        started = threading.Event()
        resume = threading.Event()
        original = library_module._summarize
        first = {"seen": False}

        def paused(path):
            # **最初の1件で止める。** ここが「索引を組み替えている最中」である。
            if not first["seen"]:
                first["seen"] = True
                started.set()
                resume.wait(timeout=10)
            return original(path)

        library_module._summarize = paused
        try:
            worker = threading.Thread(target=self.library.scan, daemon=True)
            worker.start()
            self.assertTrue(started.wait(timeout=10), "走査が始まらなかった")

            # **走査が止まっている、まさにその瞬間に読む。**
            missing = [rid for rid in self.ids if self.library.record(rid) is None]
            known = self.library.known_ids()
        finally:
            resume.set()
            library_module._summarize = original
            worker.join(timeout=10)

        self.assertEqual(
            missing, [],
            f"走査の最中に記録が消えている（{len(missing)}/{RECORD_COUNT}件）: {missing}",
        )
        self.assertEqual(
            sorted(known), sorted(self.ids),
            "走査の最中に索引が欠けている（部分的な索引が読めてしまう）",
        )

    def test_走査が終われば新しい内容に入れ替わっている(self):
        """**対照。** 差し替えを遅らせただけで、結果まで古いままにしていない。"""
        (self.root / "rec-new.recipe.json").write_text(
            '{"id": "rec-new", "title": "new", "checkpoint": "a.safetensors"}',
            encoding="utf-8",
        )
        (self.root / "rec0.recipe.json").unlink()
        self.library.scan()
        known = set(self.library.known_ids())
        self.assertIn("rec-new", known, "足した記録が入っていない")
        self.assertNotIn("rec0", known, "消した記録が残っている")

    def test_走査の理由も同時に入れ替わる(self):
        """``scan_errors`` も索引と一緒に差し替わること。

        片方だけ先に空にすると、「記録は在るのに理由の欄が空」という
        食い違った状態が読める瞬間ができる——``list_records`` は
        ``errors: library.scan_errors`` をそのまま返しているので、
        **読めなかったフォルダが在るのに理由が空**で画面へ出る。

        **理由が出るのを、止める場所より後ろに置く。** 先に出してしまうと
        変異を入れても同じ数になり、この検査は何も見ない
        （最初にそう書いて、実際に素通りした）。
        """
        missing = self.root / "nope"
        library = RecordLibrary(
            {"record_source_dirs": [str(self.root), str(missing)]}
        )
        library.scan()
        before = list(library.scan_errors)
        self.assertEqual(len(before), 1, f"読めないフォルダの理由が1件でない: {before}")

        started = threading.Event()
        resume = threading.Event()
        original = library_module._summarize
        first = {"seen": False}

        def paused(path):
            # 止まるのは1つめのフォルダの最初の1件＝**理由が出る前**。
            if not first["seen"]:
                first["seen"] = True
                started.set()
                resume.wait(timeout=10)
            return original(path)

        library_module._summarize = paused
        try:
            worker = threading.Thread(target=library.scan, daemon=True)
            worker.start()
            self.assertTrue(started.wait(timeout=10), "走査が始まらなかった")
            during = list(library.scan_errors)
        finally:
            resume.set()
            library_module._summarize = original
            worker.join(timeout=10)

        self.assertEqual(
            during, before,
            "走査の最中に理由の欄が空になっている（記録は在るのに理由だけ消える）",
        )
        self.assertEqual(library.scan_errors, before, "走査のたびに理由が積み増されている")


if __name__ == "__main__":
    unittest.main()
