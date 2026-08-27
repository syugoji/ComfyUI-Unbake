/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 設定の面。**Sweep と同じく、同じ器の中で一覧と差し替わる。**
 *
 * ---
 *
 * **鍵は書けるが読み出せない。**
 *
 * Raindrop のトークンと Civitai の API キーは、入力できるが**画面へ戻ってこない。**
 * 戻すと、ブラウザの開発者ツール・同じページで動く他のカスタムノード・
 * スクリーンショット・画面録画のどれからでも読めるようになる。「確認のために
 * 一度表示する」という導線がそのまま漏洩経路になるので、最初から作らない。
 *
 * 代わりに**入っているかと文字数**を出す。文字数を出すのは、貼り付けが途中で
 * 切れた事故を見分けるため——切れた鍵は「設定したのに認証が通らない」という、
 * 原因の判らない形で現れる。
 *
 * 入力欄を空のまま保存しても**消えない**（＝変更しない）。消すのは
 * 「消す」ボタンだけ。空欄を「消す」の意味にすると、他の項目を直すたびに
 * 鍵が消える。
 */

import { LOCALE_META, t } from '../i18n/index.js';
import { SKINS } from './skin.js';
import { readStored, writeStored } from '../core/storage.js';

function makeElement(doc, tag, attributes = {}, children = []) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined) continue;
        if (key === 'text') node.textContent = String(value);
        else node.setAttribute(key, String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
}

/**
 * 秘密ではない、素直な文字列の項目。
 *
 * **並びは使う順**（2026-08-23 利用者の指示）。上から
 * Civitai の鍵 → Raindrop のトークン → Raindrop のコレクションID と続けて、
 * 「どれを先に入れるのか」を並びそのもので示す。置き場の設定はその後で、
 * **空のままでも動く**（既定の置き場が作られる）。
 */
const TEXT_FIELDS = [
    { key: 'raindrop_collection_id', label: 'settings.raindropCollection', help: 'settings.raindropCollection.help' },
    { key: 'record_output_dir', label: 'settings.outputDir', help: 'settings.outputDir.help' },
    // **落とす先の根**（2026-08-28 利用者の指示）。空＝ComfyUI の既定。
    // 選べるのは ComfyUI が知っている置き場の中だけ（合う物が無ければ既定へ戻る）。
    { key: 'download_root', label: 'settings.downloadRoot', help: 'settings.downloadRoot.help' },
];

/**
 * 表示の項目（裁定⑥）。**閾値と真偽値だけで、モードは1つも無い。**
 *
 * `kind` は入力の形を決めるだけで、**設定の意味は Python 側が持つ**
 * （型を寄せるのも既定へ戻すのもあちら）。ここで検証を二重に書くと、
 * 画面が通した値をサーバが黙って別の値にする、という食い違いが生まれる。
 */
const DISPLAY_FIELDS = [
    { key: 'compact_width', kind: 'number', label: 'settings.compactWidth', help: 'settings.compactWidth.help' },
    { key: 'replay_max_megapixels', kind: 'number', label: 'settings.replayCap', help: 'settings.replayCap.help' },
    // **一覧の手元に同じ口があるものは、ここに置かない**（2026-08-22 利用者の指示）。
    // 並び替え・向き・見せ方・列数は主画面の帯にあり、そこで変えた値は
    // そのまま設定へ保存される（`persistSort` / `persistView`）ので、
    // **再起動をまたいで残る**——2箇所に置くと「どちらが本当か」を覚える羽目になる。
    // **色だけで分けない、の次の段。** 語は吹き出しと読み上げに在るが、
    // 見分けにくい2色で主要な区別をしているのは、それとは別の問題。
    { key: 'verdict_palette', kind: 'select', label: 'settings.palette', help: 'settings.palette.help',
      options: ['default', 'deuteranopia'],
      optionText: (code) => t(`settings.palette.${code}`) },
    /*
     * **色分けの続き**（2026-08-26 利用者の指示）。上の項目と隣に置く。
     *
     * **上と一つにまとめない。** 上は「判定の3色をどう選ぶか」で、こちらは
     * 「別の軸の色帯を出すか」——一つの選択肢にすると、**色覚特性向けの配色を
     * 選んだ人が色帯を出せなくなる**（あるいはその逆）。軸が違うものを
     * 1つの並びへ潰すと、片方を選ぶともう片方を諦めることになる。
     */
    { key: 'extra_bands', kind: 'boolean', label: 'settings.extraBands', help: 'settings.extraBands.help' },
    { key: 'theme', kind: 'select', label: 'settings.theme', help: 'settings.theme.help',
      options: ['host', 'amber', 'ember', 'moss', 'paper'],
      optionText: (code) => t(`settings.theme.${code}`) },
    // **見た目を厚くするか。** 好みが割れるうえ、弱い機械では動きが重さになる。
    // **作りそのものの切り替え**（2026-08-25 利用者の指示）。配色（すぐ上の
    // 「テーマ」）とは別の軸——あちらは色、こちらは面の組み立て方。
    // **選択肢は名簿から取る。** ここに書き写すと、紙を足した日に片方だけ増える。
    { key: 'ui_skin', kind: 'select', label: 'settings.uiSkin', help: 'settings.uiSkin.help',
      options: SKINS,
      optionText: (code) => t(`settings.uiSkin.${code}`) },
    { key: 'rich_ui', kind: 'boolean', label: 'settings.richUi', help: 'settings.richUi.help' },
    // **器の話はここでしか切れない**（2026-08-25 利用者の指示）。
    { key: 'sidebar_overlay', kind: 'boolean', label: 'settings.sidebarOverlay', help: 'settings.sidebarOverlay.help' },
    { key: 'sidebar_width', kind: 'number', label: 'settings.sidebarWidth', help: 'settings.sidebarWidth.help' },
    { key: 'group_by_checkpoint', kind: 'boolean', label: 'settings.groupByCheckpoint', help: 'settings.groupByCheckpoint.help' },
    { key: 'show_commercial_ok', kind: 'boolean', label: 'settings.showCommercialOk', help: 'settings.showCommercialOk.help' },
    // **送り先の欄は置かない**（2026-08-24 に撤去）。送り先が決まり、通しで実測して
    // 通った（支払い・着金とも2本）ので、設定で持つ理由が消えた。
    // **空にできる欄を残すほうが害**——「まだ決めていない」という嘘の状態を作れてしまう。
    // 送り先は `panel/donateView.js` の表が持つ（フォークはそこを書き換える）。
    // **「二度と表示しない」を戻せる場所。** 確認の中だけで切れる作りにすると、
    // 切った瞬間に戻す口が消える。
    // **消えたモデルの受け皿**（2026-08-26 利用者の指示・**既定は OFF**）。
    // 開けると第三者（civarchive.com）へ問い合わせが飛び、落とす相手も増える。
    // 切ってある理由は `unbake/settings.py` に書いてある。
    { key: 'use_civarchive', kind: 'boolean', label: 'settings.useCivarchive', help: 'settings.useCivarchive.help' },
    { key: 'confirm_before_delete', kind: 'boolean', label: 'settings.confirmBeforeDelete', help: 'settings.confirmBeforeDelete.help' },
    // **見比べの面を自分から開くか**（2026-08-28 利用者の指示・既定は開く）。
    // 切るのは「勝手に開く」だけで、絵を押して開く道は残る。
    { key: 'show_compare', kind: 'boolean', label: 'settings.showCompare', help: 'settings.showCompare.help' },
    // **宿主全体に効く設定なので、切れる場所を必ず置く**（2026-08-24）。
    // Dark Reader は半透明の重ねを不透明へ潰すので、重ねた面が「背景が単色」になる。
    // 既定は有効（ComfyUI は元から暗く、上から暗くし直す意味が薄い）。
    { key: 'disable_dark_reader', kind: 'boolean', label: 'settings.disableDarkReader', help: 'settings.disableDarkReader.help' },
    // **言語。空＝宿主に合わせる（既定）。**
    //
    // 元は「独自の切替は足さない」と決めていた——足すと「アプリは日本語なのに
    // このパネルだけ英語」を作れてしまうため。だが**宿主と別の言語で読みたい**
    // という要望が実際に出た（2026-08-20）ので、**既定を「宿主に合わせる」に
    // 据えたまま**選べるようにする。既定のままなら以前と挙動は変わらない。
    //
    // `allowEmpty` が要るのは、空を送れないと**一度選ぶと二度と戻せない**から
    // （他の項目は空＝「変えない」でよいが、ここは空自体が選択肢）。
    { key: 'language', kind: 'select', label: 'settings.language', help: 'settings.language.help',
      allowEmpty: true,
      options: ['', ...Object.keys(LOCALE_META)],
      // **その言語自身の表記で出す。** 読めない言語で書かれた一覧からは選べない。
      optionText: (code) => (code ? (LOCALE_META[code]?.name || code) : t('settings.language.host')) },
];

/** 画面へ戻ってこない項目。 */
const SECRET_FIELDS = [
    { key: 'civitai_api_key', label: 'settings.civitaiKey', help: 'settings.civitaiKey.help' },
    { key: 'raindrop_token', label: 'settings.raindropToken', help: 'settings.raindropToken.help' },
];

/**
 * 設定の面を作る。
 *
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {() => Promise<object>} options.read `/unbake/settings` を読む
 * @param {(patch: object) => Promise<object>} options.write `/unbake/settings` へ書く
 * @param {() => Promise<object>} [options.rescan] 記録を数え直す
 * @param {() => void} [options.onClose]
 */
export function createSettingsView({
    documentRef,
    read,
    write,
    rescan = null,
    /**
     * **出典から読み直す**（2026-08-26 利用者の指示）。
     *
     * 古い記録は `checkpoint` が名前だけで版IDを持たず、**版IDが無いと
     * 落とせない**（実機で 44件が「落とせません」で止まっていた）。
     * 一覧を綺麗なままにしたいという指示なので、口は設定に置く。
     */
    refreshFromSource = null,
    onClose = null,
    onLanguageChange = null,
    onSaved = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    const root = element('div', { class: 'unbake-settings' });
    const back = element('button', { class: 'unbake-settings-back', type: 'button', text: t('settings.back') });
    back.addEventListener('click', () => onClose?.());

    /*
     * **説明は既定でしまう**（2026-08-24 利用者の指示「視認性が悪い」）。
     *
     * 実測すると、**ラベルと説明文が同じ書式**（13px / weight 400 / 同じ色）で、
     * どこが項目名なのかが読み取れない状態だった。字を変えるだけでは、
     * 狭い柱に長い日本語の段落が並ぶ形は変わらない——**既定でしまい、
     * 1つの口で全部出す。** 項目ごとに開かせると、開く手間が項目数だけ増える。
     */
    const HELP_KEY = 'unbake.settings.help';
    let helpOn = readStored(HELP_KEY, false) === true;
    const helpToggle = element('button', {
        class: 'unbake-settings-helptoggle', type: 'button',
    });
    function applyHelp() {
        root.setAttribute('data-help', helpOn ? 'on' : 'off');
        helpToggle.textContent = helpOn ? t('settings.help.hide') : t('settings.help.show');
        helpToggle.setAttribute('aria-pressed', helpOn ? 'true' : 'false');
    }
    helpToggle.addEventListener('click', () => {
        helpOn = !helpOn;
        writeStored(HELP_KEY, helpOn);
        applyHelp();
    });
    applyHelp();

    // **見出しは送っても消えない。** 長い一覧を下へ送ると、戻る口ごと消えていた。
    root.append(element('div', { class: 'unbake-settings-head' }, [
        back,
        element('span', { class: 'unbake-settings-title', text: t('settings.title') }),
        helpToggle,
    ]));
    const body = element('div', { class: 'unbake-settings-body' });
    root.append(body);

    /** 群の器。**何のための設定かを、並びでなく見出しで示す。** */
    const group = (titleKey, children) => element('section', { class: 'unbake-settings-group' }, [
        element('h3', { class: 'unbake-settings-group-title', text: t(titleKey) }),
        ...children.filter(Boolean),
    ]);

    /** 最後に読んだ言語。**変わったときだけ面を組み直す**ための控え。 */
    let lastLanguage = null;

    const status = element('p', { class: 'unbake-settings-status', role: 'status' });
    const storedAt = element('p', { class: 'unbake-settings-help' });

    /**
     * 項目ごとの「保存した」の印（2026-08-24 利用者の指示）。
     *
     * **一番下だと見えない。** 長い一覧を下へ送っている間は画面に入らないので、
     * **保存されたこと自体が届かない**。触った欄の横へ出す。
     *
     * **失敗はこちらへ出さない。** 理由は長くて欄の横には入らず、
     * しかも**消えては困る**。失敗と読み取りエラーは下の `status` に残す。
     */
    const savedMarks = new Map();
    /** 欄1つ分の印を作り、鍵で引けるようにしてから返す。 */
    function savedMark(key) {
        const mark = element('span', { class: 'unbake-settings-saved', 'aria-live': 'polite' });
        savedMarks.set(key, mark);
        return mark;
    }

    // --- 読み取り元（複数行）------------------------------------------
    const sourceDirs = element('textarea', {
        class: 'unbake-settings-dirs', rows: '3', 'aria-label': t('settings.sourceDirs'),
    });
    /**
     * 項目名の横に置く「?」（2026-08-24 利用者の指示。改造版と同じ作り）。
     *
     * **説明を読むために場所を動かさない。** 下へ広げると、読んだ瞬間に
     * 他の項目の位置が変わる。ここは重ねて出して、離せば元に戻る。
     *
     * `button` にするのは**触れるだけでなく辿り着けるようにする**ため
     * （キーボードだけで使う人は hover を持っていない）。
     * 中身は `data-tip` に載せ、見せ方は CSS が持つ——`::after` で出すので
     * 出し入れに JS が要らない。
     */
    function hint(helpKey) {
        if (!helpKey) return null;
        const text = t(helpKey);
        if (!text || text.startsWith('[')) return null;
        return element('button', {
            class: 'unbake-settings-hint', type: 'button',
            'data-tip': text,
            // **読み上げには本文を渡す。** 「?」だけでは何も伝わらない。
            'aria-label': text,
            tabindex: '0',
        }, [element('span', { 'aria-hidden': 'true', text: '?' })]);
    }

    /** 読み取り元の欄。**組み立ての最後に置く**（鍵とトークンを上に出すため）。 */
    const sourceDirsField = element('div', { class: 'unbake-settings-field' }, [
        element('div', { class: 'unbake-settings-labelrow' }, [
            element('label', { class: 'unbake-settings-label', text: t('settings.sourceDirs') }),
            hint('settings.sourceDirs.help'),
            savedMark('record_source_dirs'),
        ]),
        sourceDirs,
        element('p', { class: 'unbake-settings-help', text: t('settings.sourceDirs.help') }),
    ]);

    sourceDirs.addEventListener('input', () => autoSave());

    const fields = [];
    const textInputs = new Map();
    for (const field of TEXT_FIELDS) {
        const input = element('input', {
            class: 'unbake-settings-input', type: 'text', 'aria-label': t(field.label),
        });
        input.addEventListener('input', () => autoSave());
        textInputs.set(field.key, input);
        fields.push(element('div', { class: 'unbake-settings-field' }, [
            element('div', { class: 'unbake-settings-labelrow' }, [
                element('label', { class: 'unbake-settings-label', text: t(field.label) }),
                hint(field.help),
                savedMark(field.key),
            ].filter(Boolean)),
            input,
            element('p', { class: 'unbake-settings-help', text: t(field.help) }),
        ]));
    }
    // `TEXT_FIELDS` の先頭（コレクションID）は鍵の直後、残りはその下。
    const collectionField = fields.shift();

    // --- 表示の項目 ---------------------------------------------------
    const displayInputs = new Map();
    for (const field of DISPLAY_FIELDS) {
        let input;
        if (field.kind === 'boolean') {
            input = element('input', {
                class: 'unbake-settings-check', type: 'checkbox', 'aria-label': t(field.label),
            });
        } else if (field.kind === 'select') {
            input = element('select', {
                class: 'unbake-settings-input', 'aria-label': t(field.label),
            });
            for (const option of field.options) {
                input.append(element('option', {
                    value: option, text: field.optionText ? field.optionText(option) : option,
                }));
            }
        } else if (field.kind === 'text') {
            // **数の欄に URL は入らない。** 枝が無いと `type="number"` に落ち、
            // 打っても値が残らない（2026-08-22 に寄付の送り先で踏んだ）。
            input = element('input', {
                class: 'unbake-settings-input', type: 'text',
                inputmode: 'url', 'aria-label': t(field.label),
            });
        } else {
            input = element('input', {
                class: 'unbake-settings-input', type: 'number', 'aria-label': t(field.label),
            });
        }
        // **選択とチェックは変わった瞬間。** 数の欄は打ち終わってから。
        input.addEventListener('change', () => autoSave({ now: field.kind !== 'number' }));
        if (field.kind === 'number' || field.kind === 'text') {
            input.addEventListener('input', () => autoSave());
        }
        displayInputs.set(field.key, { input, field });
        // **入と切は、見出しと同じ行に置く。** 縦に積むと、印だけが下の行の
        // 真ん中に落ちて**どの項目の入り切りなのかが読めない**（2026-08-24 実機）。
        const fieldClass = field.kind === 'boolean'
            ? 'unbake-settings-field unbake-settings-field-check'
            : 'unbake-settings-field';
        fields.push(element('div', { class: fieldClass }, [
            element('div', { class: 'unbake-settings-labelrow' }, [
                element('label', { class: 'unbake-settings-label', text: t(field.label) }),
                hint(field.help),
                savedMark(field.key),
            ].filter(Boolean)),
            input,
            field.help ? element('p', { class: 'unbake-settings-help', text: t(field.help) }) : null,
        ].filter(Boolean)));
    }

    /** 鍵とトークン。**一番上に出す**ので、別の入れ物へ積む。 */
    const secretFields = [];
    const secretInputs = new Map();
    const secretStates = new Map();
    for (const field of SECRET_FIELDS) {
        const input = element('input', {
            // **`type="password"` にする。** 打っている最中の肩越しの盗み見と、
            // 画面共有・録画への写り込みを減らす。
            class: 'unbake-settings-input', type: 'password', autocomplete: 'off',
            'aria-label': t(field.label),
        });
        // **鍵は打っている間は送らない。** 半端な値が何度も保存され、
        // そのたびに「保存しました」と出るのは、貼り間違いを見つけにくくする。
        input.addEventListener('change', () => {
            if (String(input.value || '')) autoSave({ now: true });
        });
        const state = element('span', { class: 'unbake-settings-secret-state' });
        /*
         * **鍵とトークンにだけ保存ボタンを置く**（2026-08-28 利用者の指示）。
         *
         * 2026-08-24 に保存ボタンを外している——自動保存は効いていたのに、
         * ボタンが在ることで「押さないと保存されない」と読まれたため。
         * **その判断は他の欄では今も正しい**ので、全体の保存ボタンは戻さない。
         *
         * ここだけ別なのは、**秘密欄の保存の合図が `change`**（＝欄から
         * 離れたとき）だからで、貼って Escape で閉じると **`change` が起きないまま
         * 面ごと消える**。そのうえ値は二度と表示されないので、
         * **入ったかどうかを目で確かめられない。** 押す口が要るのはそこ。
         */
        const saveNow = element('button', {
            class: 'unbake-settings-secret-save', type: 'button', text: t('settings.save'),
        });
        saveNow.addEventListener('click', () => {
            // 空で押しても何も送らない（空＝「変えない」なので、押した意味が出ない）。
            if (!String(input.value || '')) return;
            autoSave({ now: true });
        });
        const clear = element('button', {
            class: 'unbake-settings-clear', type: 'button', text: t('settings.clear'),
        });
        clear.addEventListener('click', () => save({ [field.key]: '' }));
        secretInputs.set(field.key, input);
        secretStates.set(field.key, state);
        secretFields.push(element('div', { class: 'unbake-settings-field' }, [
            element('div', { class: 'unbake-settings-labelrow' }, [
                element('label', { class: 'unbake-settings-label', text: t(field.label) }),
                hint(field.help),
                // **秘密欄にも保存の印を出す。** 他の欄には出ていたのに、
                // ここだけ無かった——値が見えない欄でこそ、入った合図が要る。
                savedMark(field.key),
            ].filter(Boolean)),
            element('div', { class: 'unbake-settings-secret-row' }, [input, state, saveNow, clear]),
            element('p', { class: 'unbake-settings-help', text: t(field.help) }),
        ]));
    }
    // **なぜ戻ってこないのかを画面に書く。** 書かないと「保存されていない」と
    // 読まれ、同じ鍵を何度も貼り直すことになる。
    secretFields.push(element('p', { class: 'unbake-settings-help', text: t('settings.secretHelp') }));

    /**
     * 触ったら勝手に保存する（2026-08-23 利用者の指示）。
     *
     * **打っている途中では送らない。** 1文字ごとに送ると、鍵を貼っている
     * 最中の半端な値が何度も保存される。文字の欄は**手が止まってから**、
     * 選択・チェックは**変わった瞬間**に送る。
     *
     * **書き戻しで入力中の欄を上書きしない。** 保存が終わると値を読み直して
     * 当て直すので、打ち終える前に当てるとカーソルが飛ぶ。
     */
    let saveTimer = null;
    let saving = false;
    function autoSave({ now = false } = {}) {
        if (typeof setTimeout !== 'function') return;
        if (saveTimer) clearTimeout(saveTimer);
        const run = () => {
            saveTimer = null;
            // **走っている間は待つ。** 重ねて送ると、先に書いた値が後の値で
            // 上書きされる順が決まらない。
            if (saving) { autoSave({ now: false }); return; }
            save(collect());
        };
        if (now) run();
        else saveTimer = setTimeout(run, 700);
    }

    /**
     * 待っている保存を、今ここで送る。**閉じるときに呼ぶ。**
     *
     * 秘密欄は `change` を待つので、**打ったまま離れていない値**も拾う
     * ——`collect()` は空の秘密欄を送らないので、値が在るときだけ意味を持つ。
     */
    function flushPending() {
        const pending = saveTimer !== null;
        const typedSecret = [...secretInputs.values()].some(node => String(node.value || ''));
        if (!pending && !typedSecret) return;
        if (saveTimer && typeof clearTimeout === 'function') clearTimeout(saveTimer);
        saveTimer = null;
        save(collect());
    }

    // **全体の保存ボタンは置かない**（2026-08-24 利用者の指示・今も有効）。
    // 自動保存は 2026-08-23 から効いていた——実測でも、押さずに
    // `POST /unbake/settings` が飛んで「保存しました。」が出ていた。
    // それでも「保存されない」と読まれたのは**ボタンが残っていたから**で、
    // 押す口が在れば「押さないと保存されない」と読むのが自然である。
    // **機能が在るのに信じられないのは、無いのと同じこと。**
    /**
     * 保存できた欄にだけ印を出す。**少しで消す。**
     *
     * 残しっ本なしにすると、**いつの保存の印なのかが読めなくなる**
     * （触るたびに自動保存が走るので、印が並ぶだけになる）。
     *
     * **失敗はここへ出さない。** 理由は長くて欄の横に入らず、しかも消えては困る。
     */
    /**
     * **前に保存した値**の控え。`changedKeys()` はこれと突き合わせる。
     *
     * 送る側（`collect()`）は**毎回フォーム全体を送る**——差分だけを送ると
     * 「空にした」と「触っていない」が区別できなくなるため。だから
     * **送った鍵＝変えた鍵ではない**。ここを取り違えて、触っていない欄にまで
     * 印が出ていた（2026-08-24 実機の指摘）。
     */
    let lastSaved = null;

    /** 前の保存から**実際に値が動いた**鍵だけ。 */
    function changedKeys(patch) {
        const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const keys = Object.keys(patch);
        // 初回は比べる相手がいない。**全部に印を出すより、出さないほうがよい**
        // ——「何を保存したのか」が読めない印は、無い印より紛らわしい。
        if (!lastSaved) return [];
        return keys.filter(key => !same(patch[key], lastSaved[key]));
    }

    let savedTimer = null;
    function markSaved(keys) {
        for (const mark of savedMarks.values()) mark.textContent = '';
        for (const key of keys) {
            const mark = savedMarks.get(key);
            if (mark) mark.textContent = t('settings.savedField');
        }
        if (typeof setTimeout !== 'function') return;
        if (savedTimer) clearTimeout(savedTimer);
        savedTimer = setTimeout(() => {
            for (const mark of savedMarks.values()) mark.textContent = '';
        }, 2000);
    }

    const rescanButton = element('button', { class: 'unbake-settings-rescan', type: 'button', text: t('settings.rescan') });
    rescanButton.addEventListener('click', () => doRescan());

    // **押している間ずっと何も出ないのが一番こわい。** 件数を数えながら出す。
    const refreshButton = refreshFromSource
        ? element('button', {
            class: 'unbake-settings-rescan', type: 'button',
            text: t('settings.refreshFromSource'),
            title: t('settings.refreshFromSource.help'),
        })
        : null;
    // **止める口を必ず置く。** 何百件も外へ問い合わせるので、
    // 始めたら終わるまで待つしかない作りにはしない。
    const refreshStop = refreshFromSource
        ? element('button', {
            class: 'unbake-settings-rescan', type: 'button',
            text: t('settings.refreshFromSource.stop'),
        })
        : null;
    if (refreshStop) refreshStop.disabled = true;
    let refreshing = false;
    let stopRequested = false;
    if (refreshButton) refreshButton.addEventListener('click', () => doRefresh());
    if (refreshStop) refreshStop.addEventListener('click', () => { stopRequested = true; });

    body.append(
        // **鍵 → 取り込み → 表示。** 並びは今まで通り（使う順）で、
        // **境目に見出しを置いただけ**——並べ替えると、覚えた場所が動く。
        group('settings.group.keys', secretFields),
        group('settings.group.library', [collectionField, sourceDirsField]),
        group('settings.group.display', fields),
        element('div', { class: 'unbake-settings-actions' },
            [rescanButton, refreshButton, refreshStop].filter(Boolean)),
        status,
        storedAt,
    );

    // --- 反映 ---------------------------------------------------------

    function apply(payload) {
        const values = payload?.settings || {};
        if (lastLanguage === null) lastLanguage = String(values.language ?? '');
        // **打っている欄には当て直さない。** 保存が終わると値を読み直して当て直す
        // ので、打ち終える前に当てるとカーソルが飛ぶ——押した瞬間にしか保存
        // しなかった間は起きなかった問題で、自動保存にした今日から要る。
        const active = documentRef?.activeElement ?? null;
        const settable = (node) => node !== active;
        if (settable(sourceDirs)) {
            sourceDirs.value = (values.record_source_dirs || []).join('\n');
        }
        for (const [key, input] of textInputs) {
            if (settable(input)) input.value = String(values[key] ?? '');
        }
        for (const [key, { input, field }] of displayInputs) {
            if (!settable(input)) continue;
            const value = values[key];
            if (field.kind === 'boolean') {
                input.checked = value === true;
                // 偽 DOM でも読めるように属性でも持つ（**表示ではなく入力が真実**）。
                input.setAttribute('data-checked', value === true ? 'true' : 'false');
            } else {
                input.value = String(value ?? '');
            }
        }
        for (const [key, state] of secretStates) {
            const info = values[key] || { set: false, length: 0 };
            // **値ではなく状態を出す。**
            state.textContent = info.set
                ? t('settings.secretSet', { length: info.length })
                : t('settings.secretUnset');
            state.setAttribute('data-set', info.set ? 'true' : 'false');
        }
        storedAt.textContent = payload?.path ? t('settings.storedAt', { path: payload.path }) : '';
        if (payload?.loadError) {
            // **読めなかったことを黙って既定へ落とさない。**
            status.textContent = t('settings.loadError', { detail: payload.loadError });
        }
    }

    /** 画面から送る差分。**空の秘密欄は送らない**（＝変更しない）。 */
    function collect() {
        const patch = {
            record_source_dirs: sourceDirs.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
        };
        for (const [key, input] of textInputs) patch[key] = String(input.value || '').trim();
        for (const [key, { input, field }] of displayInputs) {
            if (field.kind === 'boolean') {
                // **入っている方を1つだけ読む。** 元は
                // `input.checked === true || data-checked === 'true'` と OR で
                // 読んでいた——本物のブラウザでは、利用者が**切った**とき
                // `checked` は false になるが**属性は 'true' のまま残る**ので、
                // OR が真を返し、**切った操作が1つも届かなかった**
                // （2026-08-24 実機「切り替えが保存されない／保存の印が出ない」）。
                //
                // **入れる側だけが通っていたので、検査も素通りしていた。**
                // 偽 DOM は `checked` を持たないことがあるので、
                // **持っていないときだけ**属性へ落とす。
                patch[key] = typeof input.checked === 'boolean'
                    ? input.checked === true
                    : input.getAttribute?.('data-checked') === 'true';
            } else {
                // **空は送らない。** 送ると Python 側が既定へ戻すので、
                // 「消したつもりが既定に化けた」という分かりにくい形になる。
                //
                // **ただし空自体が選択肢の項目は別**（言語の「宿主に合わせる」）。
                // ここを一律で落とすと、一度選んだら二度と戻せない項目ができる。
                const typed = String(input.value ?? '').trim();
                if (typed || field.allowEmpty) patch[key] = typed;
            }
        }
        for (const [key, input] of secretInputs) {
            const typed = String(input.value || '');
            if (typed) patch[key] = typed;
        }
        return patch;
    }

    async function save(patch) {
        saving = true;
        status.textContent = '';
        try {
            const payload = await write(patch);
            if (payload?.ok === false) throw new Error(payload.error || 'save failed');
            // 送った鍵は画面から消す。**打った値を残さない。**
            for (const input of secretInputs.values()) input.value = '';
            apply(payload);
            // **保存したという知らせは、触った欄の横へ出す**（2026-08-24 利用者の指示）。
            // 一番下だと、長い一覧を送っている間は**画面に入らない**。
            markSaved(changedKeys(patch));
            // **控えを進めるのは印を出した後。** 先に更新すると差分が常に空になる。
            lastSaved = { ...(lastSaved || {}), ...patch };
            // **保存しただけでは画面は変わらない。** 見た目の設定（テーマ・判定の色・
            // タイルの大きさ）は面を作るときに読んでいるので、**保存した値を今の面へ
            // 当て直す**——実機で「テーマを変えても変化が無い」と言われたのがこれ。
            onSaved?.(patch, payload?.settings || {});
            // **言語は保存しただけでは画面に出ない。** 見出しや列名は面を作った
            // ときに一度だけ文字を入れているので、選んだ言語で描き直すには
            // 面を組み直す必要がある。呼び手にそれを頼む。
            //
            // **「送った」ではなく「変わった」で判断する。** 保存はフォーム全体を
            // 送るので、言語は毎回 patch に入る——それで組み直していたせいで、
            // **どの設定を保存しても面が作り直され、テーマだけ元に戻っていた**
            // （実機で「テーマを変えても変化が無い」と言われたのがこれ）。
            const nextLanguage = String(patch.language ?? '');
            if (Object.hasOwn(patch, 'language') && nextLanguage !== lastLanguage) {
                lastLanguage = nextLanguage;
                onLanguageChange?.(nextLanguage);
            }
        } catch (error) {
            status.textContent = t('settings.saveFailed', { detail: error?.message || String(error) });
        } finally {
            saving = false;
        }
        return null;
    }

    async function doRefresh() {
        if (!refreshFromSource || refreshing) return null;
        refreshing = true;
        stopRequested = false;
        refreshButton.disabled = true;
        if (refreshStop) refreshStop.disabled = false;
        status.textContent = t('settings.refreshFromSource.working', { at: 0, total: 0 });
        try {
            const result = await refreshFromSource({
                onProgress: (state) => {
                    status.textContent = t('settings.refreshFromSource.working', {
                        at: state.at ?? 0, total: state.total ?? 0,
                    });
                },
                shouldStop: () => stopRequested,
            });
            // **何も起きなかったことも言う。** 黙ると、押せていないのか
            // 直すものが無かったのか判らない。
            status.textContent = t('settings.refreshFromSource.done', {
                refreshed: result?.refreshed ?? 0,
                skipped: result?.skipped ?? 0,
                // **出典が空だった件数も出す。** 黙って飛ばすと、
                // 「読み直したのに何も変わらない」としか読めない。
                empty: result?.empty ?? 0,
                // **回している最中に消された件数も出す。** 黙って飛ばすと、
                // 「消したのに読み直しが触ったのでは」を確かめる術が無い。
                gone: result?.gone ?? 0,
                failed: result?.failed ?? 0,
            });
            return result;
        } catch (error) {
            status.textContent = t('settings.saveFailed', { detail: error?.message || String(error) });
            return null;
        } finally {
            refreshing = false;
            refreshButton.disabled = false;
            if (refreshStop) refreshStop.disabled = true;
        }
    }

    async function doRescan() {
        if (!rescan) return null;
        rescanButton.disabled = true;
        status.textContent = '';
        try {
            const result = await rescan();
            const errors = result?.errors || [];
            status.textContent = errors.length
                // **読めなかったフォルダを 0件 と混ぜない。**
                ? `${t('settings.scanned', { total: result?.total ?? 0 })} — ${t('settings.scanErrors', { detail: errors.join(' / ') })}`
                : t('settings.scanned', { total: result?.total ?? 0 });
            return result;
        } catch (error) {
            status.textContent = t('settings.saveFailed', { detail: error?.message || String(error) });
            return null;
        } finally {
            rescanButton.disabled = false;
        }
    }

    async function load() {
        try {
            apply(await read());
            // **読み込んだ直後の値を控える。** ここで控えないと、
            // **開いてから最初の1回だけ印が出ない**（比べる相手がいないため）。
            lastSaved = collect();
        } catch (error) {
            // **設定の口が届かないことを、設定が空であることと混ぜない。**
            status.textContent = t('settings.unreachable', { detail: error?.message || String(error) });
        }
        return null;
    }

    const loaded = load();

    return {
        root,
        loaded,
        reload: load,
        save,
        rescan: doRescan,
        collect,
        // **書き戻しを外から呼べるようにする。** 打っている欄を守れているかは、
        // これを呼んで初めて確かめられる（保存の中でしか走らない道だった）。
        apply,
        destroy() {
            /*
             * **閉じる前に、待っている分を送る**（2026-08-28）。
             *
             * 文字の欄は手が止まって 700ms で送る作りなので、
             * **打ってすぐ閉じると、その 700ms は永久に来ない**——節点は消え、
             * 打った値はどこにも残らない。秘密欄はさらに `change` 待ちなので、
             * **貼って Escape** だと一度も送られないまま消える。
             */
            flushPending();
            root.remove();
        },
    };
}
