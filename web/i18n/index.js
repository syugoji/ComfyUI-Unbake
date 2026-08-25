/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 文言の切り替え。**依存なし・百行ほど。**
 *
 * 外部の i18n ライブラリは入れない——このパッケージの前提が「外部パッケージ0」で、
 * 1つ入れた瞬間にそのライセンスが配布物へ乗る（NOTICE が主張していることが崩れる）。
 *
 * ---
 *
 * **既定は英語。** 発見経路が ComfyUI Manager である以上、最初に読まれるのは英語で、
 * 日本語で書いておくと**母数がその時点で切り落とされる**。
 *
 * **言語は宿主から取る。** ComfyUI は `Comfy.Locale` を持ち、実測（frontend v1.42.15）で
 * **12言語**を選べる: en / zh / zh-TW / ru / ja / ko / fr / es / ar / tr / pt-BR / fa。
 * **持っている言語をこの12へ合わせてある**——宿主が選べない言語を用意しても届かないし、
 * 宿主が選べる言語を欠くとその利用者は英語へ落ちる。
 * 独自の切替は足さない（足すと「アプリは日本語なのにこのパネルだけ英語」が作れてしまう）。
 *
 * ---
 *
 * **見つからない鍵は黙って消さない。** 未訳の鍵は `[code]` の形でそのまま出す。
 * 空文字や英語へ静かに落とすと、**訳が抜けていること自体が見えなくなる**
 * ——`tests/i18n_test.mjs` が全カタログの鍵集合の一致を固定しているのはそのため。
 *
 * **母語話者の確認を通っていない訳がある。** `meta.reviewed` がそれを持つ。
 * 画面には出さない（利用者には関係ない）が、**訂正を受けるために所在を明示する**。
 */

import * as ar from './locales/ar.js';
import * as en from './locales/en.js';
import * as es from './locales/es.js';
import * as fa from './locales/fa.js';
import * as fr from './locales/fr.js';
import * as ja from './locales/ja.js';
import * as ko from './locales/ko.js';
import * as ptBR from './locales/pt-BR.js';
import * as ru from './locales/ru.js';
import * as tr from './locales/tr.js';
import * as zh from './locales/zh.js';
import * as zhTW from './locales/zh-TW.js';

/**
 * 持っている言語。**ComfyUI の `Comfy.Locale` の選択肢と同じ並び**にしてある
 * （実測 2026-08-20・frontend v1.42.15）。増減したら検査が知らせる。
 *
 * 追加は `locales/` へ1ファイル置いて、ここへ1行足すだけ。
 */
const LOCALES = { en, zh, 'zh-TW': zhTW, ru, ja, ko, fr, es, ar, tr, 'pt-BR': ptBR, fa };

/** 鍵→文言。 */
export const CATALOGS = Object.fromEntries(
    Object.entries(LOCALES).map(([code, mod]) => [code, mod.messages]),
);

/** 表示名・書字方向・確認済みかどうか。 */
export const LOCALE_META = Object.fromEntries(
    Object.entries(LOCALES).map(([code, mod]) => [code, mod.meta]),
);

/** 既定。**英語から動かさない。** */
export const DEFAULT_LOCALE = 'en';

let current = DEFAULT_LOCALE;

/**
 * 宿主の言語表記を、持っているカタログへ落とす。
 * `ja-JP` → `ja`、`zh-CN` → `zh`、知らない言語 → 既定（英語）。
 *
 * **地域つきを先に見る**——`zh-TW` を `zh` へ落とすと繁体字の利用者が簡体字を読む。
 *
 * @param {string|null|undefined} hostLocale
 * @returns {string}
 */
export function resolveLocale(hostLocale) {
    const raw = String(hostLocale || '').trim();
    if (!raw) return DEFAULT_LOCALE;
    const exact = Object.keys(CATALOGS).find(code => code.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const base = raw.split(/[-_]/)[0].toLowerCase();
    const byBase = Object.keys(CATALOGS).find(code => code.toLowerCase() === base);
    return byBase ?? DEFAULT_LOCALE;
}

/** 使う言語を据える。**解決してから据える**ので、知らない言語でも壊れない。 */
export function setLocale(hostLocale) {
    current = resolveLocale(hostLocale);
    return current;
}

export function getLocale() {
    return current;
}

/** 今の言語の書字方向（`ltr` / `rtl`）。**アラビア語とペルシア語は右から左。** */
export function getDirection(locale = current) {
    return LOCALE_META[locale]?.dir === 'rtl' ? 'rtl' : 'ltr';
}

/** 母語話者の確認を通っているか。**通っていない訳を「無い」ことにしない。** */
export function isReviewed(locale = current) {
    return LOCALE_META[locale]?.reviewed === true;
}

/**
 * `{name}` を差し替える。**値が無い差し込みは `{name}` のまま残す**
 * ——空文字にすると「文言が変」ではなく「情報が消えた」形で壊れる。
 */
function interpolate(template, params) {
    return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        params && Object.hasOwn(params, key) ? String(params[key]) : whole
    ));
}

/**
 * 文言を引く。
 *
 * @param {string} code 鍵
 * @param {object} [params] 差し込む値
 * @returns {string}
 */
export function t(code, params) {
    const table = CATALOGS[current] || CATALOGS[DEFAULT_LOCALE];
    const template = table?.[code] ?? CATALOGS[DEFAULT_LOCALE]?.[code];
    // **未訳を英語へ静かに落とさない。** 落とすと訳の抜けが永久に見えなくなる。
    if (template === undefined) return `[${code}]`;
    return interpolate(template, params);
}

/** ある言語に足りない鍵（検査用）。 */
export function missingCodes(locale) {
    const base = Object.keys(CATALOGS[DEFAULT_LOCALE]);
    const table = CATALOGS[locale] || {};
    return base.filter(code => !Object.hasOwn(table, code));
}

/** ある言語にしか無い鍵（検査用）。**余りも抜けと同じくらい危ない**——消し忘れが溜まる。 */
export function extraCodes(locale) {
    const base = new Set(Object.keys(CATALOGS[DEFAULT_LOCALE]));
    return Object.keys(CATALOGS[locale] || {}).filter(code => !base.has(code));
}
