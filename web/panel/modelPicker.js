/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * モデルを**絵で選ぶ**面（2026-08-22 利用者の指示）。
 *
 * 元は素の `<select>` だった。2つ困ることがあった:
 *
 *   1. **開いた一覧が白飛びする。** 選択肢の並びは OS 側が描くので、
 *      面の色は届かない——暗いテーマの上に白地・白字が出る
 *   2. **絵が出せない。** 名前だけでは、同じ系統のどれが欲しいのか判らない
 *      （行の見本を 48px から 96px にしたのと同じ理由）
 *
 * だから自前で描く。**選ぶ間も絵が見えている**ことがこの面の全部で、
 * それ以外（並べ替え・分類・お気に入り）は持たない。
 *
 * **候補は呼び手が渡す。** ここはディスクも `/object_info` も見ない
 * ——手元に在るものだけを並べる責任は、渡す側が既に負っている。
 */

import { t } from '../i18n/index.js';

/** ほかの面と同じ作り（この階層は各面が自前で持っている）。 */
function makeElement(documentRef, tag, attributes = {}, children = []) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
}

/** 一度に描く数。**多いと開くのが重い**（LoRA は実測 483本）。 */
export const PAGE_SIZE = 120;

/** 名前の絞り込み。**大文字小文字とフォルダ区切りを無視する。** */
export function filterNames(names, query) {
    const wanted = String(query || '').trim().toLowerCase().replaceAll('\\', '/');
    if (!wanted) return [...(names || [])];
    return (names || []).filter(name => String(name).toLowerCase().replaceAll('\\', '/').includes(wanted));
}

/**
 * @param {object} options
 * @param {object} options.documentRef 差し込み先の document
 * @param {string} options.kind        `checkpoints` / `loras`
 * @param {string} options.current     いま選んでいる名前
 * @param {string[]} options.names     選べる名前（**手元に在るものだけ**）
 * @param {(name: string) => void} options.onPick
 * @param {() => void} [options.onClose]
 */
export function createModelPicker({
    documentRef, kind, current = '', names = [], onPick, onClose = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    const backdrop = element('div', {
        class: 'unbake-picker-backdrop', role: 'dialog', 'aria-modal': 'true',
        // **焦点を受け取れる箱にする**（2026-08-31・監査 I-20260831-27）。
        // 文書側の Esc は張ってあったが、焦点がここへ来ていないと
        // **開いた直後の Esc が下の面へ届く**（`I-20260830-21` と同じ形）。
        tabindex: '-1',
    });
    const box = element('div', { class: 'unbake-picker' });
    backdrop.append(box);

    const search = element('input', {
        class: 'unbake-picker-search', type: 'search',
        placeholder: t('picker.search'), 'aria-label': t('picker.search'),
    });
    const count = element('p', { class: 'unbake-sweep-help' });
    const list = element('div', { class: 'unbake-picker-list' });
    box.append(element('div', { class: 'unbake-picker-head' }, [search]));
    box.append(count);
    box.append(list);

    function draw() {
        const matches = filterNames(names, search.value);
        const shown = matches.slice(0, PAGE_SIZE);
        // **切ったことを黙らない。** 「これで全部」と読まれると、
        // 在るはずのモデルを「入っていない」と判断される。
        count.textContent = matches.length > shown.length
            ? t('picker.countTruncated', { shown: shown.length, total: matches.length })
            : t('picker.count', { total: matches.length });
        list.replaceChildren();
        for (const name of shown) {
            const thumb = element('img', {
                class: 'unbake-picker-thumb', loading: 'lazy', alt: '',
                src: `/unbake/model-preview?kind=${encodeURIComponent(kind)}`
                    + `&name=${encodeURIComponent(name)}`,
            });
            // **無い見本を「壊れた画像」として出さない**（行の一覧と同じ作法）。
            thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
            const row = element('button', {
                class: 'unbake-picker-row', type: 'button',
                'data-current': name === current ? 'true' : 'false',
                title: name,
            }, [thumb, element('span', { class: 'unbake-picker-name', text: name })]);
            row.addEventListener('click', () => {
                onPick?.(name);
                close();
            });
            list.append(row);
        }
        if (shown.length === 0) {
            list.append(element('p', { class: 'unbake-sweep-help', text: t('picker.none') }));
        }
    }

    let closed = false;
    function close() {
        if (closed) return;
        closed = true;
        doc.removeEventListener?.('keydown', onKey);
        backdrop.remove();
        onClose?.();
    }
    const onKey = (event) => { if (String(event?.key || '') === 'Escape') close(); };

    // **周りを押すと閉じる。** 中を押しても閉じない（選びかけで消えない）。
    backdrop.addEventListener('click', (event) => {
        if (event?.target === backdrop) close();
    });
    box.addEventListener('click', (event) => event?.stopPropagation?.());
    search.addEventListener('input', draw);
    doc.addEventListener?.('keydown', onKey);
    /*
     * **焦点をこちらへ移す**（2026-08-31・監査 I-20260831-27）。
     * 移さないと、開いた直後の Esc が下の面へ届く。
     *
     * **付いてから移す**（`I-20260830-21` と同じ形）。構築の途中ではこの箱は
     * まだ文書に付いておらず、外れた要素への `focus()` は何も起きない
     * ——人形を本物へ寄せた（`I-20260831-17`）ので、ここは検査で捕まる。
     */
    setTimeout(() => {
        if (backdrop.isConnected === false) return;
        try { backdrop.focus?.(); } catch { /* 焦点を移せない環境でも面は出す */ }
    }, 0);

    draw();
    return { root: backdrop, box, search, draw, close, get shown() { return list.children.length; } };
}
