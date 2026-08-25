/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 取り消せない操作の前に、**何が起きるかを列挙して**確かめる面。
 *
 * ---
 *
 * **「本当によろしいですか」だけの確認は、確認になっていない。** 押す人が知りたいのは
 * 「よいか」ではなく **「何が消えるか」** なので、この面は必ず3つを出す:
 *
 * 1. **消える実ファイルの一覧**（名前とバイト数）——合計だけだと、対の画像や
 *    付随のメタが一緒に消えることが伝わらない
 * 2. **巻き添えになるもの**（このモデルを使っている記録の件数）——実測で1つの
 *    checkpoint を **39件**の記録が共有している。1件の画面から消すと38件が壊れる
 * 3. **数えた範囲**——数えているのは書庫の記録だけで、手組みのワークフローも
 *    他の UI も見ていない。**「0件だから安全」と読まれると、数えていない側が壊れる**
 *
 * **既定の指の置き場は「やめる」側にする。** 取り消せない操作では、
 * 押し間違いの向きを安全側へ倒す。
 *
 * ---
 *
 * **面ではなくポップアップにしてある**（2026-08-22 利用者の指示）。理由は、
 * 一覧を置き換えると**どの記録を消そうとしているのか**が画面から消えるため
 * ——確認の最中に元の並びが見えているほうが、選び間違いに気づける。
 *
 * **「二度と表示しない」を持つ。** ただし切り替えは設定
 * （``confirm_before_delete``）に保存する——**確認の中でしか切れない作りにすると、
 * 切った瞬間に戻す口が消える。** 切っても結果は黙らせない（履歴へ出す）。
 */

import { formatBytes } from '../core/downloadSizeEstimate.js';
import { t } from '../i18n/index.js';

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

/**
 * 大きさの表示。**2本目の整形器を書かない**——落とす側が既に持っている
 * `formatBytes()` をそのまま使い、ここが足すのは**「分からない」の扱い**だけ。
 *
 * 既存の `formatBytes()` は 0 も null も `0 B` にする。落とす前の見積もりでは
 * それでよいが、**消す前には困る**——「0バイトのファイル」と「大きさを読めなかった
 * ファイル」は別物で、後者は消してよいかの判断が変わる。だから前者は `0 B`、
 * 後者は `—` にする。
 */
export function sizeText(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return formatBytes(Number(value));
}

/**
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {string} options.title 何をしようとしているか（1行）
 * @param {{name: string, bytes?: number}[]} [options.files] 消える実ファイル
 * @param {string[]} [options.warnings] 巻き添え・範囲などの注意（**必ず読ませる**）
 * @param {() => Promise<object>} options.onConfirm 押されたときに走る処理
 * @param {(hide: boolean) => void} [options.onSuppressChange] 「二度と表示しない」が
 *   押されたまま消したとき。**設定へ保存するのは呼び手の仕事**——面は覚えない。
 * @param {() => void} [options.onClose]
 */
export function createConfirmView({
    documentRef, title, files = [], warnings = [], onConfirm,
    onSuppressChange = null, onClose = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    // **重ねる面。** 一覧は後ろに見えたまま残る。
    const root = element('div', {
        class: 'unbake-confirm-backdrop', role: 'dialog', 'aria-modal': 'true',
    });
    const box = element('div', { class: 'unbake-confirm' });
    root.append(box);
    const close = element('button', {
        class: 'unbake-confirm-close', type: 'button',
        text: '×', title: t('confirm.cancel'), 'aria-label': t('confirm.cancel'),
    });
    close.addEventListener('click', () => onClose?.());
    box.append(element('div', { class: 'unbake-sweep-head' }, [
        element('span', { class: 'unbake-sweep-title', text: title }),
        close,
    ]));
    // **外を押したら閉じる**——ただし中を押しても閉じない（消す前に読む面なので、
    // 一覧をなぞって確かめている最中に閉じてしまうと読めない）。
    root.addEventListener('click', (event) => {
        if (event?.target === root) onClose?.();
    });
    // **Esc で閉じる。** 逃げ道は多いほどよい（閉じる＝消さない）。
    root.addEventListener('keydown', (event) => {
        if (event?.key === 'Escape') { event.stopPropagation?.(); onClose?.(); }
    });

    // **取り消せないことを、色ではなく字で言う。**
    box.append(element('p', { class: 'unbake-confirm-danger', text: t('confirm.irreversible') }));

    for (const warning of warnings) {
        box.append(element('p', { class: 'unbake-confirm-warning', text: warning }));
    }

    // **分からない大きさを 0 に丸めない。** `Number(null) || 0` で足すと、
    // 大きさを1つも知らないときに「合計 0 B」と出て、**中身が空だと読める**。
    // 実機で最初にそう出た（消えるのは記録ファイルと対の画像で、空ではない）。
    // **`Number(null)` は 0 で `Number.isFinite` を通る。** 値の側で先に落とす
    // ——ここを型変換のあとで判定すると、`null` が 0 として合計に混ざる。
    const known = files
        .filter(file => file?.bytes !== null && file?.bytes !== undefined && file?.bytes !== '')
        .map(file => Number(file.bytes))
        .filter(value => Number.isFinite(value));
    const total = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
    const partial = known.length > 0 && known.length < files.length;
    box.append(element('p', {
        class: 'unbake-sweep-help',
        text: partial
            ? t('confirm.filesPartial', { count: files.length, size: sizeText(total) })
            : t('confirm.files', { count: files.length, size: sizeText(total) }),
    }));
    const listNode = element('ul', { class: 'unbake-confirm-list' });
    for (const file of files) {
        listNode.append(element('li', { class: 'unbake-confirm-file' }, [
            element('span', { class: 'unbake-confirm-file-name', text: String(file.name) }),
            element('span', { class: 'unbake-confirm-file-size', text: sizeText(file.bytes) }),
        ]));
    }
    box.append(listNode);

    // **「二度と表示しない」。** 押した回だけでなく、設定として残る（戻す口は設定画面）。
    const suppress = element('input', {
        class: 'unbake-confirm-suppress', type: 'checkbox',
        id: 'unbake-confirm-suppress', 'aria-label': t('confirm.suppress'),
    });
    const suppressRow = element('label', { class: 'unbake-confirm-suppress-row' }, [
        suppress,
        element('span', { text: t('confirm.suppress') }),
    ]);
    // **切ると何が変わるかを書く。** 「出さない」だけだと、消えたことも
    // 分からなくなると読まれる（履歴には出る）。
    const suppressHelp = element('p', {
        class: 'unbake-sweep-help', text: t('confirm.suppress.help'),
    });

    const status = element('p', { class: 'unbake-sweep-help', role: 'status' });
    // **「やめる」を先に置く。** 取り消せない操作の既定は安全側。
    const cancel = element('button', {
        class: 'unbake-confirm-cancel', type: 'button', text: t('confirm.cancel'),
    });
    const confirm = element('button', {
        class: 'unbake-confirm-go', type: 'button', text: t('confirm.delete'),
    });
    box.append(suppressRow);
    box.append(suppressHelp);
    box.append(element('div', { class: 'unbake-confirm-actions' }, [cancel, confirm]));
    box.append(status);

    let busy = false;
    let result = null;

    cancel.addEventListener('click', () => onClose?.());
    confirm.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        confirm.disabled = true;
        cancel.disabled = true;
        status.textContent = t('confirm.working');
        try {
            result = await onConfirm();
        } catch (error) {
            result = { ok: false, error: error?.message || String(error) };
        }
        busy = false;
        cancel.disabled = false;
        // **消せたときだけ切る。** 失敗した回で切ると、次からは理由も見えないまま
        // 同じ失敗を繰り返すことになる。
        if (result?.ok && suppress.checked) onSuppressChange?.(true);
        if (result?.ok) {
            // **消したものを1件ずつ出す。** 「消しました」だけだと、
            // 付随が残ったのか消えたのかが読めない。
            status.textContent = t('confirm.done', {
                list: (result.removed || []).join(' / ') || '—',
            });
            confirm.disabled = true;
        } else {
            status.textContent = t('confirm.failed', {
                detail: String(result?.error || (result?.failed || []).join(' / ') || ''),
            });
            confirm.disabled = false;
        }
    });

    return {
        root,
        box,
        get result() { return result; },
        get busy() { return busy; },
        get suppressed() { return suppress.checked === true; },
        destroy() { root.remove(); },
    };
}
