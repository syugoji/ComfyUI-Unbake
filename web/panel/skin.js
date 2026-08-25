/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 画面の作り（skin）の切り替え。**捨てられる形で足す**（2026-08-25 利用者の指示）。
 *
 * 利用者の指示は「テーマ2を作れ。ただし**却下する可能性がある**ので
 * 可塑性を持たせて」だった。可塑性を意図で持つと必ず腐るので、
 * **構造で持つ**——テーマ2を捨てるのに要る手順を、最初から3つに固定する:
 *
 *   1. `node tools/remove-skin.mjs <名前> --apply`（紙・名簿・訳語をまとめて外す）
 *   2. 全部外したら `unbake/settings.py` の `ui_skin` を消す
 *   3. このファイルを消して、呼んでいる2箇所（`panel.js`）を消す
 *
 * **テーマ1（classic）は1行も変えていない。** テーマ2の指定は全部
 * `.unbake-root[data-skin="prism"]` の下に閉じ込めてあり、
 * 選んでいない間は**紙自体を読み込まない**（`<link>` を外す）。
 * 「閉じ込めてある」は意図ではなく、`tests/skin_test.mjs` が
 * **紙の全ての規則を走査して**固定している。
 *
 * **紙は必要になってから積む。** 常に積んでおくと、テーマ1の人にも
 * 数十KBの解析を負わせるうえ、「読み込んでいるが効いていない」という
 * 一番追いにくい状態を作る。
 */

/**
 * 選べる作り。**先頭が既定**（＝迷ったらテーマ1へ倒す）。
 *
 * 足し方は2手: `skin-<名前>.css` を置き、ここへ名前を1つ足す。
 * 訳語（`settings.uiSkin.<名前>`）が無ければ設定画面で名前がそのまま出るだけで、
 * **動きはする**——訳の抜けで画面が壊れない。
 */
export const SKINS = ['classic', 'prism', 'vinyl', 'kitchen'];

/** 紙を挿すときの目印。**同じ id を使い回して二重挿しを防ぐ。** */
export const SKIN_LINK_ID = 'unbake-skin';

/** 知らない値は既定へ倒す。**綴りを間違えた設定で画面が消えない。** */
export function normalizeSkin(value) {
    const wanted = String(value ?? '').trim();
    return SKINS.includes(wanted) ? wanted : SKINS[0];
}

/**
 * 作りに応じて、紙を積む／外す。
 *
 * @param {object} documentRef 宿主の `document`（無ければ何もしない）
 * @param {string} skin `classic` か `prism`
 * @param {object} [options]
 * @param {string} [options.href] 紙の場所（検査用に差し替えられる）
 * @returns {{skin: string, loaded: boolean, reason?: string}}
 */
export function applySkin(documentRef, skin, options = {}) {
    const wanted = normalizeSkin(skin);
    // **器が無い所からも呼ばれる**（検査・headless）。ここで落ちると面ごと出ない。
    if (!documentRef?.getElementById || !documentRef.head) {
        return { skin: wanted, loaded: false, reason: 'no document' };
    }
    // **面の外にも印を出す**（2026-08-25 利用者の指示）。
    // ComfyUI のツール列に居る印（`.unbake-icon`）は `.unbake-root` の外なので、
    // 面の中だけを見る `data-skin` では届かない。**文書の根に1つだけ**置く
    // ——名前を `data-unbake-skin` にして、宿主の属性と混ざらないようにする。
    const html = documentRef.documentElement;
    if (wanted === 'classic') html?.removeAttribute?.('data-unbake-skin');
    else html?.setAttribute?.('data-unbake-skin', wanted);

    const existing = documentRef.getElementById(SKIN_LINK_ID);
    if (wanted === 'classic') {
        // **外して初めて「元のまま」になる。** 残したままだと、
        // `data-skin` を戻しても紙は解析され続け、次に足す規則の効き方が変わる。
        existing?.remove?.();
        return { skin: wanted, loaded: false };
    }
    const href = options.href || new URL(`./skin-${wanted}.css`, import.meta.url).href;
    if (existing) {
        // **同じ紙かどうかを見る。** 見ずに「もう在る」で帰っていたので、
        // **テーマ→テーマの切り替えで古い紙が残った**（2026-08-25 実機:
        // vinyl から kitchen へ変えると、印は kitchen なのに紙は vinyl のまま
        // ——どちらの規則も当たらず、テーマ1の見た目に戻って見える）。
        // 元に戻す道（classic）は紙を外すので、そこだけは効いていた。
        if (existing.unbakeSkin !== wanted) {
            existing.unbakeSkin = wanted;
            existing.setAttribute?.('data-skin', wanted);
            existing.href = href;
        }
        return { skin: wanted, loaded: true };
    }

    const link = documentRef.createElement('link');
    link.id = SKIN_LINK_ID;
    link.rel = 'stylesheet';
    link.href = href;
    // どの紙かを持たせておく（次の切り替えで見る）。
    link.unbakeSkin = wanted;
    link.setAttribute?.('data-skin', wanted);
    documentRef.head.append(link);
    return { skin: wanted, loaded: true };
}
