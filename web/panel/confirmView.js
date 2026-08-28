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
    /*
     * **消す面を、消さない問いに使い回さない**（2026-08-26 実機で判明）。
     *
     * 再現の前に聞く2つ（分割復号・VRAM に載らない）も この面を借りていたが、
     * 中身は消す用のままだった——**何も消さないのに**「これは取り消せません」
     * 「0 個のファイル・合計 —」「消す」と出ていた。
     * 読んだ人は、押したら何かが消えると思う。
     */
    destructive = true,
    confirmLabel = null,
    /**
     * 終わったときの語の鍵。既定は消す側（`confirm.done`）。
     * **入れる問いに使うときは呼び手が渡す**——渡さないと
     * ノードパックを頼んだのに「消しました」と出る。
     */
    doneKey = null,
    /*
     * **並べたものを選べるようにする**（2026-08-26 利用者の指示）。
     *
     * 「本当に落とす（6 件・299 MB）」だけでは、**何が 299 MB なのかが
     * 判らない**。内訳を出し、要らないものを外せるようにする。
     * **押す回数は増やさない**——調べた回にこの面が出て、ここで落とす。
     */
    selectable = false,
    /**
     * 進む口の字を、**選び直すたびに**作り直す関数。
     * 「本当に落とす（6 件・299 MB）」の数字を、外した分だけ減らすために要る。
     */
    confirmLabelFor = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    // **重ねる面。** 一覧は後ろに見えたまま残る。
    const root = element('div', {
        class: 'unbake-confirm-backdrop', role: 'dialog', 'aria-modal': 'true',
        /*
         * **焦点を受け取れる箱にする**（`D-20260828-01` E8）。
         *
         * `keydown` は**焦点から上へしか伝わらない**。この箱は `tabindex` を
         * 持たず `.focus()` も呼ばれていなかったので、下の Esc の受け口へは
         * **永久に届かなかった**——代わりに面の側の `keydown` が走り、
         * **取り消せない削除の確認が開いたまま、後ろの選択だけが消えていた。**
         */
        tabindex: '-1',
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
    // `stopPropagation` は面の側の `keydown`（選択の解除）を止めるために要る。
    const onEscape = (event) => {
        if (event?.key !== 'Escape') return;
        event.stopPropagation?.();
        onClose?.();
    };
    root.addEventListener('keydown', onEscape);
    // **焦点がこの箱の外に在っても効く。** 開いた直後は下で焦点を移すが、
    // 面の別の場所を押すと焦点は出ていく——そこで Esc が死ぬと、
    // 「さっきは閉じたのに閉じない」という一番読みにくい形になる。
    doc.addEventListener?.('keydown', onEscape);

    // **取り消せないことを、色ではなく字で言う。**（消す面だけ）
    if (destructive) {
        box.append(element('p', { class: 'unbake-confirm-danger', text: t('confirm.irreversible') }));
    }

    for (const warning of warnings) {
        box.append(element('p', { class: 'unbake-confirm-warning', text: warning }));
    }

    // **分からない大きさを 0 に丸めない。** `Number(null) || 0` で足すと、
    // 大きさを1つも知らないときに「合計 0 B」と出て、**中身が空だと読める**。
    // 実機で最初にそう出た（消えるのは記録ファイルと対の画像で、空ではない）。
    // **`Number(null)` は 0 で `Number.isFinite` を通る。** 値の側で先に落とす
    // ——ここを型変換のあとで判定すると、`null` が 0 として合計に混ざる。
    /** 今えらばれている分だけを数える。**外したものを総量に残さない。** */
    function countedText(picked) {
        const known = picked
            .filter(file => file?.bytes !== null && file?.bytes !== undefined && file?.bytes !== '')
            .map(file => Number(file.bytes))
            .filter(value => Number.isFinite(value));
        const total = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
        const partial = known.length > 0 && known.length < picked.length;
        return partial
            ? t('confirm.filesPartial', { count: picked.length, size: sizeText(total) })
            : t('confirm.files', { count: picked.length, size: sizeText(total) });
    }

    // **数える物が無ければ、行ごと出さない。**「0 個のファイル」は
    // 消す物が無いという意味に読めるが、ここでは数える物が無いだけ。
    const countLine = files.length
        ? element('p', { class: 'unbake-sweep-help', text: countedText(files) })
        : null;
    if (countLine) box.append(countLine);

    /** 行 → 印。**選べる面のときだけ置く。** */
    const boxes = new Map();
    const listNode = element('ul', { class: 'unbake-confirm-list' });
    for (const file of files) {
        const parts = [
            element('span', { class: 'unbake-confirm-file-name', text: String(file.name) }),
        ];
        // **一行に添える短い覚え書き**（2026-08-26）。買い足しの相談では
        // 「これを何件が待っているか」が、大きさと同じくらい判断を決める。
        if (file.note) {
            parts.push(element('span', { class: 'unbake-confirm-file-note', text: String(file.note) }));
        }
        parts.push(element('span', { class: 'unbake-confirm-file-size', text: sizeText(file.bytes) }));
        if (selectable) {
            // **既定は全部えらばれている。** 外したい人だけが触る。
            const pick = element('input', {
                class: 'unbake-confirm-pick', type: 'checkbox',
                'aria-label': String(file.name),
            });
            pick.checked = true;
            pick.addEventListener('change', () => refreshPicked());
            boxes.set(file, pick);
            parts.unshift(pick);
        }
        listNode.append(element('li', { class: 'unbake-confirm-file' }, parts));
    }
    box.append(listNode);

    /** えらばれている行。**選べない面では全部。** */
    function pickedFiles() {
        if (!selectable) return files;
        return files.filter(file => boxes.get(file)?.checked !== false);
    }

    function refreshPicked() {
        const picked = pickedFiles();
        if (countLine) countLine.textContent = countedText(picked);
        // **1つも選んでいなければ進ませない。** 押しても何も起きない口を残さない。
        confirm.disabled = picked.length === 0;
        // **数字を選択に追随させる。** 外したのに総量が減らないと、
        // どちらが本当なのか読めなくなる。
        if (confirmLabelFor) confirm.textContent = confirmLabelFor(picked);
    }

    // **「二度と表示しない」は消す面だけ。** この切り替えは「消す前に聞くか」の
    // 設定なので、消さない問いに出すと**別の物を切ったつもりになる。**
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
        class: 'unbake-confirm-go', type: 'button',
        text: confirmLabel || t('confirm.delete'),
    });
    if (destructive) {
        box.append(suppressRow);
        box.append(suppressHelp);
    }
    box.append(element('div', { class: 'unbake-confirm-actions' }, [cancel, confirm]));
    box.append(status);
    // **釦の字を、開いた時点の顔ぶれに合わせる**（呼び手が件数を書ける）。
    if (selectable) refreshPicked();

    let busy = false;
    let result = null;
    /** 済んだか。**済んだ後の押しは「閉じる」**（もう一度走らせない）。 */
    let finished = false;

    cancel.addEventListener('click', () => onClose?.());
    confirm.addEventListener('click', async () => {
        if (finished) { onClose?.(); return; }
        if (busy) return;
        busy = true;
        confirm.disabled = true;
        cancel.disabled = true;
        status.textContent = t('confirm.working');
        try {
            // **えらばれた分だけを渡す。** 外したものを落としに行かない。
            result = await onConfirm(pickedFiles());
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
            // **語は呼び手が決める**（2026-08-28）。既定は消す側だが、
            // この面は入れる側でも使う——ノードパックを頼んだのに
            // **「消しました」と出ていた。**
            status.textContent = t(doneKey || 'confirm.done', {
                list: (result.removed || []).join(' / ') || '—',
            });
            /*
             * **押した釦が、そのまま出口になる**（2026-08-28 利用者の報告2回）。
             *
             * 1回目「ここから先に進めません」——済んだあと押せるのが「やめる」
             * だけだったので、押すと取り消される（入れたものが戻る）ように
             * しか読めなかった。そこで**やめる側の語**を「閉じる」に変えた。
             *
             * 2回目「閉じるに変化しますが、わかりにくいです」——**語だけ変えても
             * 目が行かない**。押した直後に見ているのは**自分が押した釦**で、
             * そこは「頼む」のまま押せなくなり、視線の外の釦が黙って語を変えていた。
             *
             * **同じ場所を出口にする。** 押した釦を「閉じる」にして押せるまま残し、
             * やめる側は引っ込める（済んだ後に「やめる」は意味を持たない）。
             * 「モデルとノード」では、この閉じが次の段の始まりでもある。
             */
            finished = true;
            confirm.textContent = t('confirm.close');
            confirm.disabled = false;
            cancel.style.display = 'none';
        } else {
            // **失敗の並びは、相手によって形が違う。** 数を渡してくる呼び手も
            // 居るので、並びのときだけ繋ぐ——`.join` を無条件で呼ぶと、
            // **結果を出そうとした所で例外になり、何も出なくなる。**
            const failedList = Array.isArray(result?.failed) ? result.failed.join(' / ') : '';
            status.textContent = t('confirm.failed', {
                detail: String(result?.error || failedList || ''),
            });
            confirm.disabled = false;
        }
        // **結果をそのまま返す。** 押した側（と検査）が終わりを待てる。
        return result;
    });

    // **開いたら焦点をこの箱へ移す。** 鍵盤の操作がここから始まるようにする
    // （移さないと、後ろの一覧へ矢印や Esc が届いてしまう）。
    try { root.focus?.(); } catch { /* 焦点を移せない環境でも面は出す */ }

    return {
        root,
        box,
        get result() { return result; },
        get busy() { return busy; },
        get suppressed() { return suppress.checked === true; },
        /** 今えらばれている行。**呼び手が押す前に読める。** */
        get picked() { return pickedFiles(); },
        destroy() {
            // **付けた聞き手を必ず外す。** 残ると、閉じた面のために Esc を
            // 拾い続ける（次の面を勝手に閉じる形で表に出る）。
            doc.removeEventListener?.('keydown', onEscape);
            root.remove();
        },
    };
}
