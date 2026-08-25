/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 記録1件の詳細（2026-08-22 利用者の指示）。**絵を押したら、まずここが開く。**
 *
 * ---
 *
 * **元は「拡大するだけ」だった。** 絵を大きくしても、どのモデルで・どのプロンプトで
 * 出したのかが見えないので、次の一手が決まらない——利用者の言葉で
 * 「それだけでは情報が不足しています」。
 *
 * 並びは改造版 LoRA Manager の詳細に合わせてある（実測した構成）:
 *
 *     [絵]  |  生成パラメータ（項目ごとに複製・書き換え）
 *     ------+-----------------------------------------
 *     checkpoint と LoRA（見本つき・差し替えできる）
 *     不足しているもの
 *
 * **ホイールで見比べる。** 絵の上でホイールを回すと
 * **元画像 → 最新の生成画像 → 古い生成画像** の順に切り替わる。
 * 出力は口が新しい順で返すので、その並びをそのまま使う（こちらで並べ替えない）。
 *
 * **「一つだけ変えて結果を見比べます」をここへ入れた。** 別の面へ移ってから
 * 値をいじるのではなく、**見ている絵の隣で書き換えて、その場で1枚出す**。
 * 変えた項目は印が付き、元へ戻せる——何を変えたのか判らなくなるのが一番困る。
 *
 * **周りを押すと閉じる。** 取り消せない操作は無いので、閉じるのは easy でよい。
 * 絵そのものを押すと**窓いっぱいの拡大**へ行く（閉じるのではなく、進む）。
 */

import { t } from '../i18n/index.js';
import { outputViewUrl } from './variantsView.js';
import { MAX_SEEDS, buildDetailRunPlan, placeholdersIn } from '../core/detailRunPlan.js';
import { paramsOf } from '../core/extractedParams.js';

/** 判定の短い語。**鍵を組み立てない**（訳の足し忘れが画面まで出ないと気づけない）。 */
function verdictShort(verdict) {
    if (verdict === 'reproducible') return t('verdict.reproducible.short');
    if (verdict === 'approximate') return t('verdict.approximate.short');
    if (verdict === 'blocked') return t('verdict.blocked.short');
    if (verdict === 'pending') return t('verdict.pending.short');
    return '';
}

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
 * 書き換えられる項目。**Sweep が振れる軸と揃える**——ここで変えたものが
 * そのまま「一つだけ変えた」1枚になる。
 *
 * `kind` は入力の種類で、`multiline` は長い文（プロンプト）。
 */
export const EDITABLE_FIELDS = Object.freeze([
    { key: 'prompt', label: 'detail.prompt', multiline: true },
    { key: 'negative_prompt', label: 'detail.negativePrompt', multiline: true },
    // `nudge` は − / ＋ が動かす幅、`spread` は「枚数」を指したときの刻み。
    { key: 'seed', label: 'detail.seed', kind: 'number', nudge: 1, spread: 1 },
    // **`multi` は「複数書ける」印**（2026-08-22 に「振る」から移した）。
    // 数の欄なのに `type="number"` にしない——`number` は「20, 30」を
    // **黙って空文字にする**ので、打てたつもりで何も伝わらない。
    { key: 'steps', label: 'detail.steps', kind: 'number', multi: true, nudge: 5, spread: 5 },
    { key: 'cfg_scale', label: 'detail.cfg', kind: 'number', multi: true, nudge: 0.5, spread: 1 },
    { key: 'sampler', label: 'detail.sampler' },
    { key: 'size', label: 'detail.size' },
]);

/**
 * 見比べる並びを作る。**元画像が先頭、そのあとは口が返した順（新しい順）。**
 *
 * @param {object} record 元の記録
 * @param {object[]} outputs この記録から出た絵（新しい順）
 * @returns {{url: string, label: string, kind: 'source'|'output'}[]}
 */
export function compareSequence(record, outputs = []) {
    const out = [];
    if (record?.previewUrl) {
        out.push({
            // **原寸を先に当てる。** 手元の参照画像は LoRA Manager が置いた
            // サムネイル（実測 480x701）で、生成画像（832x1216）と並べると
            // 元画像だけが甘い。原寸が取れなければ画面側でサムネイルへ戻す。
            url: record.originalUrl || record.previewUrl,
            fallbackUrl: record.originalUrl ? record.previewUrl : null,
            label: t('detail.source'),
            kind: 'source',
        });
    }
    for (const [index, output] of (outputs || []).entries()) {
        // **URL は組み立てる。** 出力が持っているのは `filename` と `subfolder` で、
        // `url` は入っていない——`url` だけを見ていたので、実データで
        // **47枚あるのに1枚も並ばなかった**（既出の面は組み立てていたので出ていた）。
        // 組み立ては `variantsView` の1本を使う（2本目を書かない）。
        // **名前が無い出力は並べない。** `outputViewUrl()` は名前が空でも
        // `filename=` の URL を作るので、そのまま並べると壊れた絵が1枚増える
        // ——「絵が出ない」と「そもそも出す物が無い」を混ぜない。
        const url = output?.url || (output?.filename ? outputViewUrl(output) : null);
        if (!url) continue;
        out.push({
            url,
            // **何番目に新しいかを言う。** 「生成画像」とだけ出ると、
            // ホイールを回しても同じ物を見ている気がする。
            label: index === 0
                ? t('detail.latest', { label: output.differenceLabel || '' })
                : t('detail.older', { n: index + 1, label: output.differenceLabel || '' }),
            kind: 'output',
        });
    }
    return out;
}

/**
 * 生成パラメータを、記録と本体のどちらからでも同じ形で取り出す。
 *
 * **実体は `core/extractedParams.js` へ移した**（2026-08-24）。絵から抜き出す側と
 * ここで表示する側が同じ読み方をしないと、**画面には出ているのに読み込めない**
 * （またはその逆）が起きる。読み方は1本しか持たない。
 */
export { paramsOf };

/**
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {object} options.record
 * @param {object|null} [options.recipe]
 * @param {object[]} [options.outputs] この記録から出た絵（新しい順）
 * @param {(url: string, list: object[], index: number) => void} [options.onEnlarge]
 * @param {(changes: object) => Promise<object>} [options.onRun] 書き換えた条件で1枚出す
 * @param {(entry: object) => void} [options.onSwapModel] モデルを差し替える
 * @param {{id: string, label: string, mount: (box: HTMLElement) => object|null}[]} [options.tabs]
 *   下半分へ差す面。**中身は呼び手が作る**——詳細が Sweep や既出の面の作り方を
 *   知り始めると、あちらを直すたびにここも直すことになる。
 *   `mount` は押されたとき**1回だけ**呼ばれ、返り値に `destroy` があれば畳むときに呼ぶ。
 * @param {() => void} [options.onClose]
 */
export function createDetailView({
    documentRef, record, recipe = null, outputs = [], title = null, originalUrl = null,
    tabs = [], openTab = null,
    onEnlarge = null, onRun = null, onSwapModel = null, onClose = null,
    /** 強度を動かした本数。**ボタンの字に出すためだけ**に読む。 */
    changedStrengths = () => 0,
    /**
     * 出した絵をレコードにする口。`(outputs) => Promise<{ok, count}>`。
     *
     * **出してから保存するまでを1枚の中で終わらせる**（利用者の指示・2026-08-22）。
     * 別の面へ移して探させると、出した絵がどれだったか判らなくなる。
     */
    onCapture = null,
    /**
     * 出た絵から設定を読み取る口。`(item) => Promise<{ok, params, reason}>`。
     *
     * **`onCapture` の逆向き。** 保存する側（升目ごとの「レコードにする」）は
     * 前から在ったが、**読み取って戻す側**が無く、「この設定で出た絵が良かったので
     * そこから続けたい」ができなかった（利用者の要望・2026-08-24）。
     *
     * **元画像には出さない。** 元画像はいま開いている記録そのものなので、
     * 読み込んでも何も変わらない口が1つ増えるだけになる。
     */
    onExtractParams = null,
    /** 回っている最中に止める口。**旗を立てるだけ**（投入済みの1枚は出る）。 */
    onStop = null,
    /** 組めない理由（**開いた時点で判っている**）。あれば押せなくする。 */
    runBlockedReason = null,
    /**
     * LoRA の差し替え先（`[{target, values, label}]`）。
     *
     * **口は下の「使っているモデル」の面が持つ**が、計画を組むのはここ
     * ——押す前に出る枚数を、1箇所で数えられるようにする。
     */
    loraAlternates = () => [],
    /** 土台のモデルの差し替え先（`modelsView` の「＋」から届く）。 */
    checkpointAlternates = () => [],
    /**
     * 使っているモデルの面を差す口。**プロンプトなどの欄の下に置く**
     * （利用者の指示・2026-08-22）——タブに置くと、値を直すのと
     * モデルを直すのが別の画面になり、行き来のたびに対象を見失う。
     *
     * 渡されなければ、この面が持っている簡素な一覧を同じ場所へ出す。
     */
    mountModels = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    // **原寸の在処は呼び手から受け取る。** 面が口の名前を組み立て始めると、
    // 口を変えるたびに面も直すことになる。
    const sequence = compareSequence(
        originalUrl ? { ...record, originalUrl } : record,
        outputs,
    );
    const original = paramsOf(record, recipe);
    /** 書き換えた分だけを持つ。**元の値は触らない**（戻せなくなる）。 */
    const changes = {};

    const root = element('div', {
        class: 'unbake-detail-backdrop', role: 'dialog', 'aria-modal': 'true',
        'aria-label': t('detail.title', { title: title || record?.title || record?.id || '' }),
    });
    const box = element('div', { class: 'unbake-detail' });
    root.append(box);

    // **周りを押すと閉じる。** 中を押しても閉じない（読んでいる最中に消えない）。
    root.addEventListener('click', (event) => { if (event?.target === root) onClose?.(); });
    root.addEventListener('keydown', (event) => {
        if (event?.key === 'Escape') { event.stopPropagation?.(); onClose?.(); }
    });

    const close = element('button', {
        class: 'unbake-detail-close', type: 'button',
        text: '×', title: t('confirm.cancel'), 'aria-label': t('confirm.cancel'),
    });
    close.addEventListener('click', () => onClose?.());
    box.append(element('div', { class: 'unbake-detail-head' }, [
        element('span', {
            // **外向きの名前で出す。** 上流の語（`recipe`）は外へ出さないと決めてあり、
            // 出す絵の名前も `civitai_<id>` になっている——ここだけ生の題を出すと、
            // 同じものを2つの名前で呼ぶことになる。
            class: 'unbake-detail-title', text: title || record?.title || record?.id || '',
        }),
        element('span', {
            class: 'unbake-detail-verdict', 'data-verdict': record?.verdict || 'pending',
            text: verdictShort(record?.verdict),
        }),
        close,
    ]));

    // --- 絵の側 -------------------------------------------------------------
    let index = 0;
    const stage = element('img', {
        class: 'unbake-detail-image', alt: '', 'data-zoom': 'true', title: t('image.enlarge'),
    });
    const caption = element('p', { class: 'unbake-detail-caption' });
    const dots = element('div', { class: 'unbake-detail-dots' });

    function show(next) {
        if (!sequence.length) return;
        index = (next + sequence.length) % sequence.length;
        const item = sequence[index];
        stage.setAttribute('src', item.url);
        caption.textContent = sequence.length > 1
            ? t('detail.nth', { index: index + 1, total: sequence.length, label: item.label })
            : item.label;
        // **今どこを見ているかを、字だけでなく形でも出す。**
        dots.replaceChildren(...sequence.map((entry, i) => element('span', {
            class: 'unbake-detail-dot',
            'data-on': i === index ? 'true' : 'false',
            'data-kind': entry.kind,
        })));
        // **見ている絵が変わったら、読み取りの口も出し入れする。**
        // 元画像を見ているときに押せる口が残っていると、押しても何も変わらない。
        syncExtract();
    }

    /** いま見ているのが「出た絵」か。**元画像からは読み取らない。** */
    function extractableItem() {
        const item = sequence[index];
        return item && item.kind === 'output' ? item : null;
    }

    /** 読み取りの口の出し入れ。`show()` から呼ぶ（口が無ければ何もしない）。 */
    function syncExtract() {
        if (!onExtractParams) return;
        extract.style.display = extractableItem() ? '' : 'none';
    }

    // **原寸が取れなかったら、黙ってサムネイルへ戻す。** 取れないことは普通に起きる
    // （消された・年齢制限・鍵が要る）ので、壊れた絵を出さずに手元の1枚を使う。
    stage.addEventListener('error', () => {
        const item = sequence[index];
        if (!item?.fallbackUrl) return;
        const back = item.fallbackUrl;
        item.fallbackUrl = null;   // 一度だけ（無限に取り直さない）
        item.url = back;
        stage.setAttribute('src', back);
    });

    // **ホイールで 元画像 → 最新 → 古い の順に送る。**
    stage.addEventListener('wheel', (event) => {
        if (sequence.length < 2) return;
        // **後ろの一覧を一緒に動かさない。** 閉じたときにどこを見ていたか判らなくなる。
        event.preventDefault?.();
        show(index + (Number(event?.deltaY) >= 0 ? 1 : -1));
    });
    // **絵を押したら、窓いっぱいの拡大へ進む**（閉じるのではない）。
    stage.addEventListener('click', (event) => {
        event?.stopPropagation?.();
        onEnlarge?.(sequence[index]?.url, sequence, index);
    });

    const media = element('div', { class: 'unbake-detail-media' }, [stage, caption, dots]);

    // --- 生成パラメータ -----------------------------------------------------
    //
    // **欄より先に宣言する。** 欄を組む途中から触るので、下に置くと
    // 「初期化前に読んだ」で面ごと開かなくなる（実際に踏んだ）。
    let countInput = null;
    /** 数の欄ごとの「枚数」。**欄より先に作る**（欄の中から詰めるので）。 */
    const counts = new Map();
    /** 直前の状態欄が「押せない理由」だったか（結果の文言を消さないため）。 */
    let lastStatusWasPlanError = false;

    const fields = element('div', { class: 'unbake-detail-params' });
    const inputs = new Map();
    for (const field of EDITABLE_FIELDS) {
        const value = original[field.key];
        const input = field.multiline
            // **プロンプトは長い。** 3行では実データの本文（1,000字超が普通）を
            // 覗き窓から読むことになり、直すのに巻き続ける羽目になった
            // （2026-08-24 利用者の指摘）。8行にして、掴んで伸ばせる。
            ? element('textarea', {
                class: 'unbake-detail-input', rows: '8', 'aria-label': t(field.label),
            })
            : element('input', {
                class: 'unbake-detail-input',
                type: (field.kind === 'number' && !field.multi) ? 'number' : 'text',
                ...(field.multi ? { inputmode: 'decimal', title: t('detail.multi.help') } : {}),
                'aria-label': t(field.label),
            });
        input.value = value === null || value === undefined ? '' : String(value);
        const revert = element('button', {
            class: 'unbake-detail-revert', type: 'button',
            text: '↺', title: t('detail.revert'), 'aria-label': t('detail.revert'), disabled: 'true',
        });
        const row = element('div', { class: 'unbake-detail-row' }, [input, revert]);

        // **数の欄には − / ＋ と枚数を置く**（2026-08-22 利用者の指示）。
        // 「20, 30, 40」と打つのは面倒なので、**押すだけで動かせて、
        // 枚数を指せば刻んで並ぶ**ようにする。手で複数書いたらそちらが勝つ。
        if (field.nudge) {
            const nudge = (direction) => {
                const current = Number(String(input.value).split(/[,、\s]+/)[0]);
                const base = Number.isFinite(current) ? current : 0;
                const next = base + (field.nudge * direction);
                if (next < 0) return;
                // 端数を持ち込まない（0.5 刻みで 8.700000000000001 を作らない）。
                input.value = String(Math.round(next * 1e6) / 1e6);
                sync();
            };
            const down = element('button', {
                class: 'unbake-detail-nudge', type: 'button', text: '−',
                title: t('detail.nudge.down', { step: field.nudge }),
                'aria-label': t('detail.nudge.down', { step: field.nudge }),
            });
            const up = element('button', {
                class: 'unbake-detail-nudge', type: 'button', text: '＋',
                title: t('detail.nudge.up', { step: field.nudge }),
                'aria-label': t('detail.nudge.up', { step: field.nudge }),
            });
            down.addEventListener('click', () => nudge(-1));
            up.addEventListener('click', () => nudge(1));
            row.append(down);
            row.append(up);

            const count = element('input', {
                class: 'unbake-detail-count', type: 'number',
                min: '1', max: String(MAX_SEEDS), step: '1',
                title: field.key === 'seed' ? t('detail.count.help') : t('detail.spread.help', { step: field.spread }),
                'aria-label': t('detail.count'),
            });
            count.value = '1';
            count.addEventListener('input', updateRun);
            count.addEventListener('change', updateRun);
            counts.set(field.key, count);
            // **seed の枚数は計画の seed 本数**（軸ではない）。前からある口。
            if (field.key === 'seed') countInput = count;
            row.append(element('span', { class: 'unbake-detail-count-label', text: t('detail.count') }));
            row.append(count);
        }

        // **元の値を、変えた値と並べて出す**（利用者の指示・2026-08-22）。
        // 欄を書き換えると元が消えるので、「何から何へ変えたのか」が
        // 画面から読めなくなっていた。
        const was = element('p', { class: 'unbake-detail-was' });
        const group = element('div', { class: 'unbake-detail-field', 'data-changed': 'false' }, [
            element('label', { class: 'unbake-detail-label', text: t(field.label) }),
            row,
            was,
        ]);

        const sync = () => {
            const now = input.value;
            const before = value === null || value === undefined ? '' : String(value);
            const changed = now !== before;
            // **変えた項目に印を付ける。** 何を変えたのか判らなくなるのが一番困る。
            group.setAttribute('data-changed', changed ? 'true' : 'false');
            revert.disabled = !changed;
            // 変えていないときは出さない（同じ値を2度読ませない）。
            was.textContent = changed ? t('detail.was', { value: before || '—' }) : '';
            if (changed) changes[field.key] = now;
            else delete changes[field.key];
            if (field.key === 'prompt') syncPlaceholders();
            updateRun();
        };
        input.addEventListener('input', sync);
        input.addEventListener('change', sync);
        revert.addEventListener('click', () => {
            input.value = value === null || value === undefined ? '' : String(value);
            sync();
        });
        inputs.set(field.key, { input, sync, group });
        fields.append(group);
    }

    // --- プロンプトの置き換え口 ---------------------------------------------
    //
    // **`{...}` を見つけたら、その場で候補を書けるようにする**（利用者の指示・
    // 2026-08-22 に「振る」から移した）。1行1候補で、2つ以上あればその数だけ絵が出る。
    //
    // **口はプロンプトから拾う。** 別に宣言させると、プロンプトを直した瞬間に
    // 宣言と食い違い、投入の直前で「そんな口は無い」で落ちる。
    const swapsBox = element('div', { class: 'unbake-detail-swaps' });
    fields.append(swapsBox);

    // --- 語を足す（2026-08-22「振る」から移した）-----------------------------
    //
    // **置き換えとは別の口。** `{...}` を書いていないプロンプトでも、
    // 末尾へ足すだけなら振れる——元の文を1文字も触らずに済むのが利点。
    // **置き換えの口とはクラスを分ける。** 同じ名前にすると、
    // 「`{...}` がいくつ在るか」を数えている側が1つ多く数える。
    const appendInput = element('textarea', {
        class: 'unbake-detail-append', rows: '2',
        title: t('detail.append.help'), 'aria-label': t('detail.append'),
    });
    appendInput.addEventListener('input', updateRun);
    fields.append(element('div', { class: 'unbake-detail-swap-field' }, [
        element('label', { class: 'unbake-detail-label', text: t('detail.append') }),
        appendInput,
    ]));
    /** 口ごとに書いた候補。**口が消えても覚えておく**（打ち直しさせない）。 */
    const choiceText = new Map();
    let shownTokens = '';

    function syncPlaceholders() {
        const tokens = placeholdersIn(inputs.get('prompt')?.input.value ?? '');
        const key = tokens.join('\u0000');
        // 口ぶれが無いときは組み直さない（打っている最中に欄が飛ぶ）。
        if (key === shownTokens) return;
        shownTokens = key;
        swapsBox.replaceChildren();
        for (const token of tokens) {
            const area = element('textarea', {
                class: 'unbake-detail-choices', rows: '2',
                title: t('detail.placeholder.help'), 'aria-label': token,
            });
            area.value = choiceText.get(token) || '';
            area.addEventListener('input', () => {
                choiceText.set(token, area.value);
                updateRun();
            });
            swapsBox.append(element('div', { class: 'unbake-detail-swap-field' }, [
                element('label', { class: 'unbake-detail-label', text: token }),
                area,
            ]));
        }
        if (tokens.length) {
            swapsBox.append(element('p', {
                class: 'unbake-detail-was', text: t('detail.placeholder.help'),
            }));
        }
    }

    // --- モデル -------------------------------------------------------------
    const models = element('div', { class: 'unbake-detail-models' });
    const modelEntries = [];
    const checkpoint = recipe?.checkpoint ?? record?.checkpoint;
    const checkpointName = typeof checkpoint === 'string'
        ? checkpoint
        : (checkpoint?.localPath || checkpoint?.file_name || checkpoint?.name || '');
    if (checkpointName) {
        modelEntries.push({
            kind: 'checkpoints', name: checkpointName, role: 'checkpoint', source: checkpoint,
        });
    }
    for (const lora of (recipe?.loras || record?.loras || [])) {
        const name = lora?.localPath || lora?.file_name || lora?.name;
        if (name) modelEntries.push({ kind: 'loras', name: String(name), role: 'lora', source: lora });
    }

    for (const entry of modelEntries) {
        const thumb = element('img', {
            class: 'unbake-detail-model-thumb', loading: 'lazy', alt: '',
            src: `/unbake/model-preview?kind=${encodeURIComponent(entry.kind)}`
                + `&name=${encodeURIComponent(entry.name)}`,
        });
        thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
        const swap = onSwapModel
            ? element('button', { class: 'unbake-detail-swap', type: 'button', text: t('models.change') })
            : null;
        swap?.addEventListener('click', () => onSwapModel(entry));

        const row = element('div', {
            class: 'unbake-detail-model', 'data-role': entry.role, 'data-changed': 'false',
        }, [
            thumb,
            element('span', {
                class: 'unbake-detail-model-role',
                text: entry.role === 'checkpoint' ? t('models.role.checkpoint') : t('models.role.lora'),
            }),
            element('span', { class: 'unbake-detail-model-name', text: entry.name }),
        ]);

        if (swap) row.append(swap);
        models.append(row);
    }

    // --- 「一つだけ変えて結果を見比べます」 ----------------------------------
    const status = element('p', { class: 'unbake-detail-status', role: 'status' });

    /**
     * 出た絵を升目で出す（2026-08-22 利用者の指示で「振る」から移した）。
     *
     * **1枚ずつ届くたびに描き直す。** 全部揃うまで何も出さないと、
     * 24枚の計画では数分間「押しただけ」の画面になる。
     */
    const cells = element('div', { class: 'unbake-detail-cells' });

    /** 何と何を変えたのかを1行で。**基準は基準と判るようにする。** */
    function cellLabel(cell) {
        const parts = (cell?.labels || [])
            .map(item => `${item.label}: ${item.valueLabel ?? item.value}`)
            .filter(Boolean);
        if (cell?.seed !== null && cell?.seed !== undefined) parts.push(`seed ${cell.seed}`);
        return parts.join(' / ') || t('detail.cell.same');
    }

    function drawCells(job) {
        const list = Array.isArray(job?.cells) ? job.cells : [];
        cells.replaceChildren();

        /**
         * 出した絵を押したときの並び。**先頭は必ず元画像**（2026-08-22 利用者の指摘
         * 「変更した生成画像と元画像の比較が行いにくい」）。
         *
         * 元は押した1枚だけを渡していたので、元画像を見るには**拡大を閉じて
         * 上へ戻り、ホイールで送り直す**必要があった。先頭に置いておけば、
         * **ホイール1つで往復できる**——比べるのに画面を行き来しない。
         */
        const compareList = () => {
            const source = sequence[0]?.kind === 'source' ? sequence[0] : null;
            const made = list
                .filter(item => item?.output?.url)
                .map(item => ({ url: item.output.url, label: cellLabel(item) }));
            return source
                ? [{ url: source.url, label: t('detail.cell.source') }, ...made]
                : made;
        };

        for (const cell of list) {
            const url = cell?.output?.url;
            const box = element('div', {
                class: 'unbake-detail-cell',
                'data-status': String(cell?.status || 'pending'),
                'data-baseline': cell?.baseline === true ? 'true' : 'false',
            });
            if (url) {
                const image = element('img', {
                    class: 'unbake-detail-cell-image', loading: 'lazy', alt: '', src: url,
                });
                // **押したら元画像と並べて開く。** 先頭が元画像なので、
                // ホイールを1つ戻せばそのまま見比べられる。
                image.setAttribute('title', t('detail.cell.compare'));
                image.addEventListener('click', () => {
                    const all = compareList();
                    const at = all.findIndex(item => item.url === url);
                    onEnlarge?.(url, all, at >= 0 ? at : 0);
                });
                box.append(image);
            } else {
                box.append(element('div', {
                    class: 'unbake-detail-cell-image', 'data-state': 'none',
                    text: cell?.status === 'failed' ? '×' : '…',
                }));
            }
            box.append(element('span', { class: 'unbake-detail-cell-label', text: cellLabel(cell) }));
            // **落ちた理由を升目に残す。** 件数だけでは次の一手が決まらない。
            if (cell?.error) {
                box.append(element('span', { class: 'unbake-detail-cell-error', text: String(cell.error) }));
            }
            // **1枚だけ保存できる。** まとめて保存とは別に要る
            //（振った中で良かった1枚だけを書庫へ入れたい、が普通）。
            if (url && onCapture) {
                const keep = element('button', {
                    class: 'unbake-detail-cell-save', type: 'button', text: t('detail.save'),
                    title: t('detail.save.help'),
                });
                keep.addEventListener('click', async () => {
                    keep.disabled = true;
                    const result = await onCapture([cell.output]).catch(() => ({ ok: false }));
                    keep.textContent = result?.ok ? t('detail.cell.saved') : t('detail.save');
                    keep.disabled = result?.ok === true;
                });
                box.append(keep);
            }
            cells.append(box);
        }
    }

    /** 直前に出した絵。**保存できるのはこれだけ**（前の回の絵を混ぜない）。 */
    let produced = [];
    const save = element('button', {
        class: 'unbake-detail-save', type: 'button', text: t('detail.save'),
        title: t('detail.save.help'),
    });
    // 出すまでは押せない（押せるのに何も起きない口を作らない）。
    save.style.display = 'none';
    // **保存の隣に置く。** 同じ絵に対する「しまう」と「戻す」なので、
    // 探す場所を分けない。作り付けの見た目は保存と共有する（`unbake-detail-save`）。
    const extract = element('button', {
        class: 'unbake-detail-save unbake-detail-extract', type: 'button',
        text: t('detail.extract'), title: t('detail.extract.help'),
    });
    extract.style.display = 'none';
    const stop = element('button', {
        class: 'unbake-detail-stop', type: 'button', text: t('detail.stop'),
        title: t('detail.stop.help'),
    });
    stop.style.display = 'none';
    stop.addEventListener('click', () => {
        stop.disabled = true;
        onStop?.();
    });
    save.addEventListener('click', async () => {
        if (!onCapture || !produced.length) return;
        save.disabled = true;
        status.textContent = t('detail.saving');
        let result;
        try {
            result = await onCapture(produced);
        } catch (error) {
            result = { ok: false, errors: [error?.message || String(error)] };
        }
        save.disabled = false;
        if (result?.ok) {
            status.textContent = t('detail.saved', { count: result.count });
            // **同じ絵を2度取り込ませない。** 押し直すと重複した記録ができる。
            save.style.display = 'none';
            produced = [];
        } else {
            status.textContent = t('detail.saveFailed', { detail: (result?.errors || []).join(' / ') });
        }
    });

    /**
     * 取り出した値を欄へ流し込む。**在る項目だけを上書きする。**
     *
     * **空で上書きしない。** 読めなかった項目まで書くと、
     * 「読めなかった」が「消してよい」に化けて、手で書いた本文が消える。
     *
     * 返すのは2つの数である。`matched` は**流し込める値が在った項目**、
     * `changed` は**実際に値が動いた項目**。同じ絵を2度読むと `changed` は 0 になるが、
     * それは失敗ではない——`matched` で報せるので「押しても何も起きない」に見えない。
     */
    function applyParams(params) {
        let matched = 0;
        let changed = 0;
        for (const field of EDITABLE_FIELDS) {
            const value = params?.[field.key];
            if (value === null || value === undefined) continue;
            const text = String(value);
            if (!text.trim()) continue;
            const entry = inputs.get(field.key);
            if (!entry) continue;
            matched += 1;
            if (entry.input.value === text) continue;
            entry.input.value = text;
            // **`sync()` を通す。** 直接代入だけでは、変えた印も「元は…」の行も
            // `changes` も更新されず、**画面だけが変わって計画は古い値のまま**になる。
            entry.sync();
            changed += 1;
        }
        return { matched, changed };
    }

    extract.addEventListener('click', async () => {
        const item = extractableItem();
        if (!onExtractParams || !item) return;
        extract.disabled = true;
        status.textContent = t('detail.extracting');
        let result;
        try {
            result = await onExtractParams(item);
        } catch (error) {
            result = { ok: false, reason: error?.message || String(error) };
        }
        extract.disabled = false;
        lastStatusWasPlanError = false;
        if (!result?.ok) {
            status.textContent = t('detail.extractFailed', { detail: String(result?.reason || '') });
            return;
        }
        const { matched, changed } = applyParams(result.params);
        // **読めたことと、流し込む物が在ったことは別。** メタを持たない絵は
        // 「読めたが 0 項目」で返るので、そこを成功と言うと嘘になる。
        status.textContent = matched
            ? t('detail.extracted', { count: matched, changed })
            : t('detail.extractEmpty');
    });

    /** いま欄に入っている値から作れる計画。**押す前に数と理由を出す。** */
    function currentPlan() {
        try {
            return {
                plan: buildDetailRunPlan({
                    seed: inputs.get('seed')?.input.value,
                    count: countInput ? countInput.value : 1,
                    placeholders: [...choiceText].map(([token, text]) => ({ token, text })),
                    // **数の欄は複数書ける。** 2つ以上あればその項目の軸になる。
                    parameters: EDITABLE_FIELDS.filter(item => item.multi).map(item => ({
                        key: item.key,
                        label: t(item.label),
                        text: inputs.get(item.key)?.input.value ?? '',
                        // 手で複数書いていなければ、枚数と刻みで並べる。
                        count: counts.get(item.key)?.value ?? 1,
                        spread: item.spread,
                    })),
                    loraSwaps: loraAlternates() || [],
                    checkpointSwaps: checkpointAlternates() || [],
                    appendWords: appendInput ? appendInput.value : '',
                }),
                error: null,
            };
        } catch (error) {
            // **押せない理由をここで作る。** 投入まで持っていくと、
            // 待たされた末に落ちる（数は押す前に判る）。
            return { plan: null, error: error?.message || String(error) };
        }
    }
    const run = element('button', {
        class: 'unbake-detail-run', type: 'button', text: t('detail.run.idle'), disabled: 'true',
    });
    let busy = false;

    function updateRun() {
        const count = Object.keys(changes).length + (Number(changedStrengths()) || 0);
        const { plan, error } = currentPlan();
        // **組めないことは、押す前に言う。** 押してから待たせて理由を出すのは、
        // 「壊れた」と読まれる——理由は開いた時点で判っている（2026-08-23）。
        if (runBlockedReason) {
            run.disabled = true;
            run.textContent = t('detail.run.same');
            status.textContent = runBlockedReason;
            return;
        }
        // **何も変えていなくても押せる。** 「同じ条件でもう1枚」は普通に要る
        // （seed が同じでも、実装差でどれだけ動くかを見たいことがある）。
        run.disabled = busy || !onRun || !plan;
        // **材料が無いことを黙らない。** 押せないボタンだけでは、
        // 「壊れている」のか「この環境では出せない」のか読めない
        //（2026-08-22 に「振る」を畳んだとき、ここへ移した約束）。
        if (!onRun) {
            run.textContent = t('detail.run.same');
            status.textContent = t('sweep.noRunner');
            return;
        }
        if (!plan) {
            // **理由を字で出す。** 押せないボタンだけでは何を直せばいいか判らない。
            run.textContent = t('detail.run.same');
            status.textContent = error || '';
            return;
        }
        if (status.textContent && !busy && lastStatusWasPlanError) status.textContent = '';
        lastStatusWasPlanError = Boolean(error);
        run.textContent = plan.cellCount > 1
            ? t('detail.run.images', { count: plan.cellCount })
            : (count ? t('detail.run', { count }) : t('detail.run.same'));
    }

    run.addEventListener('click', async () => {
        if (busy || !onRun) return;
        busy = true;
        updateRun();
        status.textContent = t('detail.running');
        // **前の回の升目は消す。** 残すと、どれが今出したものか判らなくなる。
        cells.replaceChildren();
        produced = [];
        save.style.display = 'none';
        if (onStop) {
            stop.disabled = false;
            stop.style.display = '';
        }
        let result;
        try {
            // **強度はここから渡さない。** 上書きレイヤに入っていて、
            // 呼び手が組み立てる直前に重ねる（値の出どころは1つ）。
            //
            // 計画（seed の本数・置き換えの軸）は**この面が組む**。呼び手は
            // 受け取った雛形をそのまま回すだけ——同じ組み立てを2箇所に置かない。
            // **1枚ずつ届くたびに描き直す。** 全部揃うまで何も出さないと、
            // 24枚の計画では数分間「押しただけ」の画面になる。
            result = await onRun({ ...changes }, currentPlan().plan, (job) => {
                drawCells(job);
                const list = Array.isArray(job?.cells) ? job.cells : [];
                const done = list.filter(cell => cell?.output || cell?.error).length;
                status.textContent = t('detail.progress', { done, total: list.length });
            });
        } catch (error) {
            result = { ok: false, error: error?.message || String(error) };
        }
        busy = false;
        stop.style.display = 'none';
        updateRun();
        lastStatusWasPlanError = false;
        // **出した絵をその場で保存できるようにする。** 口が無ければ出さない。
        produced = (result?.ok && Array.isArray(result.outputs)) ? result.outputs : [];
        save.style.display = (onCapture && produced.length) ? '' : 'none';
        status.textContent = result?.ok
            ? (result.count > 1 ? t('detail.ranMany', { count: result.count }) : t('detail.ran'))
            : t('detail.runFailed', { detail: String(result?.error || '') });
    });

    // **モデルは欄のすぐ下。** 値とモデルは一緒に決めるものなので、
    // 間に画面の切り替えを挟まない（2026-08-22 利用者の指示でタブから移した）。
    const modelsHost = element('div', { class: 'unbake-detail-models-host' });
    box.append(element('div', { class: 'unbake-detail-top' }, [
        media,
        element('div', { class: 'unbake-detail-side' }, [
            fields,
            modelsHost,
            element('div', { class: 'unbake-detail-actions' }, [run, stop, save, extract]),
            status,
            cells,
        ]),
    ]));

    // 開いた時点のプロンプトにも `{...}` は在りうる（記録が持っている）。
    syncPlaceholders();

    /** 呼び手が厚い面を持っていればそれを、無ければ作り付けの一覧を出す。 */
    let modelsPane = null;
    if (mountModels) modelsPane = mountModels(modelsHost);
    else if (modelEntries.length) modelsHost.append(models);

    // --- 下半分（タブ）------------------------------------------------------
    //
    // **面を増やすのをやめ、1枚の中へ畳んだ**（2026-08-22 利用者の指示）。
    // 元は「振る」「出た絵」「使っているモデル」が別々の面で、行き来のたびに
    // **今どのレコードを見ていたのかが画面から消えていた**。上半分（絵と値）を
    // 出したまま下だけ差し替えれば、対象を見失わない。
    //
    // **中身はここで作らない。** 呼び手が `mount` で差す——詳細が Sweep の
    // 作り方を知り始めると、あちらを直すたびにここも直すことになる。
    const paneBox = element('div', { class: 'unbake-detail-pane' });
    const strip = element('div', { class: 'unbake-detail-tabs', role: 'tablist' });
    const tabButtons = new Map();
    /** 差した面。**押されたとき1回だけ作る**（開くたびに全部作ると重い）。 */
    const mounted = new Map();
    let current = null;

    // **モデルはもうタブではない**（上の `modelsHost` を見よ）。
    const allTabs = Array.isArray(tabs) ? tabs : [];

    function selectTab(id) {
        if (!allTabs.length) return null;
        const tab = allTabs.find(item => item.id === id) || allTabs[0];
        current = tab.id;
        for (const [key, button] of tabButtons) {
            button.setAttribute('aria-selected', key === tab.id ? 'true' : 'false');
            button.setAttribute('data-on', key === tab.id ? 'true' : 'false');
        }
        paneBox.replaceChildren();
        if (!mounted.has(tab.id)) {
            const host = element('div', { class: 'unbake-detail-pane-host' });
            let handle = null;
            try {
                handle = tab.mount?.(host) || null;
            } catch (error) {
                host.append(element('p', {
                    class: 'unbake-sweep-help',
                    text: t('detail.tab.failed', { detail: error?.message || String(error) }),
                }));
            }
            mounted.set(tab.id, { host, handle });
        }
        paneBox.append(mounted.get(tab.id).host);
        return tab.id;
    }

    for (const tab of allTabs) {
        const button = element('button', {
            class: 'unbake-detail-tab', type: 'button', role: 'tab',
            text: tab.label, 'aria-selected': 'false', 'data-on': 'false',
        });
        button.addEventListener('click', () => selectTab(tab.id));
        tabButtons.set(tab.id, button);
        strip.append(button);
    }
    if (allTabs.length) {
        box.append(strip);
        box.append(paneBox);
        selectTab(openTab || allTabs[0].id);
    }

    show(0);
    updateRun();

    return {
        root,
        box,
        show,
        drawCells,
        selectTab,
        /**
         * ボタンの字を描き直す。**下の面が値を変えたら呼ぶ。**
         *
         * 強度の本数も比べる相手も**外で持っている**（口はモデルの面）ので、
         * 知らせるだけでは何も起きない——実機で「＋で足したのに枚数が
         * 増えない」を踏んだ（2026-08-22）。
         */
        refresh: updateRun,
        /**
         * 取り出した値を欄へ流し込む。**呼び手からも押せるようにしておく**
         * ——升目から直接戻す口を後で足すときに、面の中のボタンを模して
         * 叩くのではなく、この1本を呼べば済む。
         */
        applyParams,
        get index() { return index; },
        get sequence() { return sequence; },
        /**
         * 取り出した値を欄へ流し込む（2026-08-24 に外へ出した）。
         *
         * **「出た絵」の面からも呼ぶ**ので、面の中だけの関数にしておけない
         * ——あちらは差してあるだけで、欄を持っているのはこちら。
         * **流し込みを2箇所に書かない**（空を弾く規則も `sync()` を通す約束も1本で持つ）。
         */
        applyParams,
        get changes() { return { ...changes }; },
        get tab() { return current; },
        get modelsPane() { return modelsPane; },
        destroy() {
            // **差した面も畳む。** 置き去りにすると、Sweep の待ちや監視が生き残る。
            for (const { handle } of mounted.values()) handle?.destroy?.();
            mounted.clear();
            root.remove();
        },
    };
}
