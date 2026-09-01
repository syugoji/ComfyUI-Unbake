/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsView } from '../web/panel/settingsView.js';
import { fakeDocument } from './fake_dom.mjs';
import { setLocale } from '../web/i18n/index.js';

// --- 設定の面: 打っている欄を守る約束が、省略で消えていた --------------------
//
// `createSettingsView` は `documentRef` の省略を認めている
// （`const doc = documentRef || globalThis.document`）。ところが「打っている
// 欄には当て直さない」の判定だけが**生の `documentRef`** を読んでいたので、
// 省いて作ると判定が常に真になり、**約束だけが黙って消えていた。**
//
// 実測（面を付けてから欄に焦点を置き、`apply()` を呼んだ）:
//
//   documentRef を渡した: "打っている途中"  ← 守られている
//   documentRef を省いた: "saved"          ← 打った字が消える

const SETTINGS_IO = {
    read: async () => ({ settings: { record_output_dir: 'saved' } }),
    write: async () => ({ ok: true, settings: {} }),
};

/** 面を作って本文へ付け、記録の置き場の欄を返す。**付けないと焦点を取れない。** */
async function mountSettings({ passDocumentRef }) {
    const doc = fakeDocument();
    const previous = globalThis.document;
    globalThis.document = doc;
    const view = createSettingsView(
        passDocumentRef ? { documentRef: doc, ...SETTINGS_IO } : { ...SETTINGS_IO });
    doc.body.append(view.root);
    await view.loaded;
    const input = view.root.allByClass('unbake-settings-input').find(node => node.value === 'saved');
    return { doc, view, input, restore: () => { globalThis.document = previous; } };
}

for (const passDocumentRef of [true, false]) {
    const how = passDocumentRef ? 'documentRef を渡した' : 'documentRef を省いた';
    test(`打っている欄には当て直さない（${how}）`, async () => {
        setLocale('en');
        const { doc, view, input, restore } = await mountSettings({ passDocumentRef });
        try {
            assert.ok(input, '記録の置き場の欄が見つからない（前提が崩れている）');
            input.focus();
            assert.equal(doc.activeElement, input, '焦点が欄に入っていない（前提が崩れている）');
            input.value = '打っている途中';
            view.apply({ settings: { record_output_dir: 'saved' } });
            assert.equal(input.value, '打っている途中',
                '打っている最中の欄へ当て直している（打った字が消える）');
        } finally {
            restore();
        }
    });
}

test('対照: 焦点が外に在れば、読み直した値を当てる', async () => {
    setLocale('en');
    const { doc, view, input, restore } = await mountSettings({ passDocumentRef: true });
    try {
        input.value = '古い値';
        doc.activeElement = doc.body;   // どこも打っていない
        view.apply({ settings: { record_output_dir: 'saved' } });
        assert.equal(input.value, 'saved', '読み直した値を当てていない');
    } finally {
        restore();
    }
});
