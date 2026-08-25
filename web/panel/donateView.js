/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 支援の口（2026-08-22 → 2026-08-24 に作り直した）。
 *
 * **ここは案内だけを出す。** 金額も決済も扱わない——押されたら別のタブへ渡すだけ。
 *
 * ## 送り先を決め打ちにした（2026-08-24 利用者の指示）
 *
 * 以前は設定の `donate_url` から1本だけ読んでいた。**その設計は捨てた**——
 * 送り先が実際に決まり、**通しで実測して通った**（支払い・着金とも2本）ので、
 * 設定で持つ理由が無くなった。設定に残すと**空にできてしまい、
 * 「まだ決めていない」という嘘の状態を作れる**ほうが害になる。
 * フォークして自分の送り先にしたい人は、この表を書き換えればよい。
 *
 * ## 上流（LoRA Manager）への支援導線は置かない（2026-08-24 利用者決定）
 *
 * **一度置いたが、同日に撤去した。** 置いた根拠は `D-20260820-03` の
 * 「上流の取り分を減らさない」という位置づけだったが、**その前提を利用者が改めた**
 * ——`Unbake は LoRA Manager とは機能が全く異なり、完全に独立させている`。
 * 独立した道具の支援画面から他所へ送るのは、**利用者の意図ではないうえ、
 * 押す先が6つに増えて誰への送り先か読めなくなる**。
 *
 * **順序を守る検査も一緒に消した。** 守る対象が無くなったのに検査だけ残すと、
 * **緑のまま何も守らない見張り**になる。
 *
 * ## 上流を参考にしたが、採らなかったものがある
 *
 * LoRA Manager の支援モーダルを**見た目の参考にした**（節ごとの見出し・決済ごとの
 * ブランド色のボタン・脈打つハート・末尾の礼）。**採らなかったのは次の3つ。**
 *
 * - **支援者の一覧**——同意・撤回・偽名を書けてしまう（`D-20260820-03` で「出さない」決着）
 * - **初回から5日後に自動で出るバナー**——こちらは**押されたときだけ開く**。
 *   自分から出ていく口を作らない
 * - **不具合報告・コミュニティへの導線**——置きたいが**置けない**。
 *   リポジトリがまだ公開されておらず、`github.com/syugoji/ComfyUI-Unbake` は
 *   **実測で 404**（2026-08-24）。**押すと存在しない場所へ飛ぶ口を作らない**
 *
 * ## 「寄付」という語を使わない
 *
 * PayPal 利用規定ポリシーで事前承認が要るのは「**慈善団体または非営利組織として
 * 寄付を募る行為**」である。こちらは該当しないが、**慈善団体のように見える書き方を
 * すると審査で誤分類される余地を自分で作る**。使うのは support / tip。
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

/**
 * 送り先。**2本とも 2026-08-24 に実測で通っている**
 * （支払い・着金とも。引き出しだけが未実測）。
 *
 * `noteKey` はボタンの下に出る小さな注記の鍵。PayPal 側は**口数で額が決まる**ので、
 * それを書かないと「$1 しか送れない」と読まれる。
 */
export const OWN_RAILS = Object.freeze([
    { id: 'kofi', label: 'Ko-fi', url: 'https://ko-fi.com/syugoji', noteKey: 'donate.kofiFree' },
    {
        id: 'paypal', label: 'PayPal',
        url: 'https://www.paypal.com/ncp/payment/Q3YJJVB5LNEML',
        noteKey: 'donate.paypalUnit',
    },
]);

/**
 * 送り先として出してよい URL か。**`http(s)` だけ**。
 *
 * `javascript:` や `data:` を通すと、押した瞬間に何が動くか読めなくなる。
 * **表を決め打ちにした後も残す**——フォークが書き換える場所なので、
 * ここが最後の関門になる。
 */
export function usableDonateUrl(value) {
    const text = String(value || '').trim();
    if (!/^https?:\/\//i.test(text)) return '';
    try {
        // 形として壊れているものは出さない（押しても何も起きない口を作らない）。
        return new URL(text).href;
    } catch {
        return '';
    }
}

/** 出せる送り先だけに絞る。**壊れた1本で面ごと落とさない。** */
function usableRails(rails) {
    return rails
        .map(rail => ({ ...rail, url: usableDonateUrl(rail.url) }))
        .filter(rail => rail.url);
}

/**
 * @param {object} options
 * @param {object} options.documentRef
 * @param {(text: string) => Promise<void>|void} [options.onCopy]
 * @param {() => void} [options.onClose]
 */
export function createDonateView({ documentRef, onCopy = null, onClose = null }) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    const backdrop = element('div', {
        class: 'unbake-donate-backdrop', role: 'dialog', 'aria-modal': 'true',
    });
    const box = element('div', { class: 'unbake-donate' });
    backdrop.append(box);

    box.append(element('div', { class: 'unbake-donate-head' }, [
        // **色と動きだけで、読み上げには出さない。** 意味は見出しが持っている。
        element('span', { class: 'unbake-donate-heart', 'aria-hidden': 'true', text: '♡' }),
        element('h2', { class: 'unbake-donate-title', text: t('donate.title') }),
    ]));
    box.append(element('p', { class: 'unbake-donate-body', text: t('donate.body') }));

    const status = element('p', { class: 'unbake-donate-status', role: 'status' });

    /** 送り先1つ分のボタン。**押されたときだけ、別のタブで開く。** */
    function railButton(rail) {
        return element('a', {
            class: 'unbake-donate-button', 'data-rail': rail.id,
            href: rail.url, target: '_blank', rel: 'noopener noreferrer',
            text: rail.label,
        });
    }

    /**
     * 見せる用の短い形。**写す値は本物のURLのまま。**
     *
     * 生のURLをそのまま並べると、狭い柱では語の途中で折り返して
     * 「https://www.paypal.com/ncp/pa / yment/Q3YJ…」のように割れる
     * （2026-08-24 実機）。**読ませたいのは宛先であって文字列ではない**ので、
     * host と末尾だけに畳む。写す側は畳まない——畳んだ値は開けない。
     */
    function shortUrl(url) {
        const raw = String(url || '');
        let host = raw;
        let path = '';
        try {
            const parsed = new URL(raw);
            host = parsed.host.replace(/^www\./, '');
            path = parsed.pathname.replace(/\/+$/, '');
        } catch {
            return raw.length > 34 ? `${raw.slice(0, 33)}…` : raw;
        }
        const tail = path.split('/').filter(Boolean).at(-1) || '';
        const shown = tail ? `${host}/${tail}` : host;
        return shown.length > 34 ? `${shown.slice(0, 33)}…` : shown;
    }

    /** 節を1つ作る。 */
    function section(name, rails, { copyable = false } = {}) {
        const children = [
            element('h3', { class: 'unbake-donate-section-title', text: t(`donate.${name}.title`) }),
            element('p', { class: 'unbake-donate-section-body', text: t(`donate.${name}.body`) }),
            element('div', { class: 'unbake-donate-links' }, rails.map(railButton)),
        ];
        for (const rail of rails) {
            if (rail.noteKey) {
                children.push(element('p', {
                    class: 'unbake-donate-note', 'data-rail': rail.id, text: t(rail.noteKey),
                }));
            }
            if (!copyable) continue;
            const copy = element('button', {
                class: 'unbake-donate-copy', type: 'button',
                text: t('donate.copy'), 'data-rail': rail.id,
            });
            copy.addEventListener('click', async () => {
                try {
                    await onCopy?.(rail.url);
                    status.textContent = t('donate.copied');
                } catch (error) {
                    // **写せなかったことを黙らない。** 押したのに何も起きないと
                    // 「壊れている」と読まれる（URL は目の前に出ているので手で写せる）。
                    status.textContent = t('donate.copyFailed', {
                        detail: error?.message || String(error),
                    });
                }
            });
            // **宛先・開く・写すを1枚に畳む。** ばらばらに並べると、
            // どのURLがどのボタンのものかが読み取れない。
            children.push(element('div', { class: 'unbake-donate-row', 'data-rail': rail.id }, [
                element('span', {
                    class: 'unbake-donate-link', 'data-rail': rail.id,
                    // 写す値は本物。**見せる形だけ畳む**（title で全体も出す）。
                    title: rail.url, text: shortUrl(rail.url),
                }),
                copy,
            ]));
        }
        return element('section', { class: 'unbake-donate-section', 'data-for': name }, children);
    }

    const own = usableRails(OWN_RAILS);
    box.append(section('mine', own, { copyable: true }));

    box.append(status);
    box.append(element('p', { class: 'unbake-donate-footer', text: t('donate.footer') }));

    const close = element('button', {
        class: 'unbake-donate-close', type: 'button', text: t('confirm.cancel'),
    });
    box.append(element('div', { class: 'unbake-donate-actions' }, [close]));

    let closed = false;
    function destroy() {
        if (closed) return;
        closed = true;
        doc.removeEventListener?.('keydown', onKey);
        backdrop.remove();
        onClose?.();
    }
    const onKey = (event) => { if (String(event?.key || '') === 'Escape') destroy(); };

    close.addEventListener('click', destroy);
    // **周りを押すと閉じる。** 中を押しても閉じない。
    backdrop.addEventListener('click', (event) => { if (event?.target === backdrop) destroy(); });
    box.addEventListener('click', (event) => event?.stopPropagation?.());
    doc.addEventListener?.('keydown', onKey);

    return {
        root: backdrop, box, status, destroy,
        get ownRails() { return own; },
    };
}
