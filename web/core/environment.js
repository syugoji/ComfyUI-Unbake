/**
 * 環境の注入口。**core/ は自分で外へ出ない。**
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * この層の商品性は「フォークから切り離しても同じ答えを出す」ことに依存している。
 * ところが元の実装は `/object_info` を**モジュールの中で大域の HTTP API から直接**取っており、
 * ブラウザで LoRA Manager のページを開いている状態にしか置けなかった。
 *
 * ここで**環境を1つの形へ集める**。呼び手（ComfyUI 拡張・テスト・別のホスト）が
 * `installEnvironment({ request })` を1回呼び、core/ はそれしか使わない。
 *
 * **形は install の時点で検査する。** 注入するものの形が違うとき、テストは
 * 自前のダブルを入れているので全緑のまま、実機だけが死ぬ——注入の失敗は
 * 「動かない」ではなく「静かに別物になる」形で出るので、入口で弾く。
 */

/**
 * @typedef {{ getItem: (key: string) => string | null,
 *             setItem: (key: string, value: string) => void,
 *             removeItem: (key: string) => void }} UnbakeStorage
 */
/**
 * @typedef {{ request: (input: string, init?: object) => Promise<any>,
 *             storage?: UnbakeStorage | null }} UnbakeEnvironment
 */

let installed = null;

const STORAGE_METHODS = ['getItem', 'setItem', 'removeItem'];

/**
 * 呼び手の環境を据える。
 *
 * `storage` は任意。**据えなければ core は揮発の入れ物へ書く**——「保存できない」
 * ではなく「このセッションだけ残る」に倒す。書けないことを例外にすると、
 * 保存は本題ではない使い方（テスト・埋め込み）まで巻き添えで止まる。
 *
 * @param {UnbakeEnvironment} environment
 * @returns {UnbakeEnvironment} 据えたもの（呼び手がそのまま握れる）
 */
export function installEnvironment(environment) {
    if (!environment || typeof environment !== 'object') {
        throw new TypeError('installEnvironment: an environment object is required');
    }
    if (typeof environment.request !== 'function') {
        throw new TypeError('installEnvironment: request(input, init) is not a function');
    }
    if (environment.request.length === 0) {
        // 引数を1つも取らない関数は、URL を無視して常に同じ物を返す形＝差し替え事故。
        throw new TypeError('installEnvironment: request must accept at least an input argument');
    }
    const storage = environment.storage ?? null;
    if (storage !== null) {
        // **形は入口で弾く。** 3つのうち1つ欠けたものを通すと、読めるのに消せない
        // ような半端な入れ物ができ、「消したのに戻ってくる」として後から現れる。
        for (const method of STORAGE_METHODS) {
            if (typeof storage?.[method] !== 'function') {
                throw new TypeError(`installEnvironment: storage.${method}() is not a function`);
            }
        }
    }
    installed = { request: environment.request, storage };
    return installed;
}

/** 据えた環境を捨てる（テストの後始末用）。 */
export function resetEnvironment() {
    installed = null;
}

/** 据えられているか。**「未設置」と「取れなかった」を混ぜないため**に要る。 */
export function hasEnvironment() {
    return installed !== null;
}

/**
 * 据えた環境。未設置なら投げる。
 * @returns {UnbakeEnvironment}
 */
export function requireEnvironment() {
    if (!installed) {
        throw new Error(
            'Unbake: no environment installed. Call installEnvironment({ request }) first'
        );
    }
    return installed;
}

/**
 * 据えた環境の request。**未設置なら null**——判定側は「取れなかった」として
 * 縮んだ結果を返せるが、その理由が呼び手から見えるようにしておく。
 * @returns {((input: string, init?: object) => Promise<any>) | null}
 */
export function environmentRequestOrNull() {
    return installed ? installed.request : null;
}

/**
 * 据えた入れ物。**未設置なら null**——`storage.js` はこれを見て揮発の入れ物へ倒す。
 * @returns {UnbakeStorage | null}
 */
export function environmentStorageOrNull() {
    return installed ? installed.storage : null;
}
