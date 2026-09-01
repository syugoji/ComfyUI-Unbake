/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Sweep の面。**同じ器の中に描く**——別の窓を開かない。
 *
 * 決定⑤（面は1つ・密度は器の幅から決まる）を守るため、ここは独立したコンポーネントでは
 * なく `panel.js` が差し替える1枚である。全画面でもサイドバーでも同じ関数が描く。
 *
 * 画面の順序が、そのまま Sweep の主張になっている。
 *
 *   雛形を選ぶ → **軸を確かめる** → **検査する（投げない）** → 回す → 並べて見る
 *
 * 「検査する」を回す前に置いてあるのは、**Sweep が売っているのが比較そのものではなく
 * 比較の正しさ**だから。宣言した軸以外が動いていたら、投げる前にここで止まる。
 * 順番を入れ替えると、**間違った比較を先に見せてから正しさを検査する**ことになり、
 * 見てしまった絵の印象は取り消せない。
 */

import { t } from '../i18n/index.js';
import {
    buildBuiltinSweepTemplates, formatAxisValues, installedModelOptions,
    LORA_STRENGTH_RANGE, parseAxisValues,
} from '../core/sweepAxes.js';
import { summarizeSweep, sweepableRecord } from '../core/sweepRunner.js';
import { expandSweepTemplate, SWEEP_MODES } from '../core/recipeSweep.js';
import {
    applyExperimentType, experimentTypeFromTemplate,
    readExperimentTypes, saveExperimentType,
} from '../core/experimentTypes.js';
import { gateForSubmission } from '../core/batchQueue.js';
// **大域の fetch を掴まない。** 器が据えた口だけを使う（`web/core/` と同じ約束）。
import { environmentRequestOrNull } from '../core/environment.js';

/**
 * 回し方 → 文言の鍵。**一覧そのものは中核から取る**（`SWEEP_MODES`）。
 *
 * 写して2箇所に置いていたせいで、中核へ `seeds_only` を足したのに選択肢が増えず、
 * `select.value = 'seeds_only'` が**存在しない選択肢なので空文字へ落ちて**、
 * 「Unsupported sweep mode」で検査が落ちた（実機で踏んだ・2026-08-20）。
 * ここを中核由来にしておけば、次に回し方が増えたときは
 * **鍵の抜けとして検査が赤くなる**——選択肢が静かに欠けることはもう起きない。
 */
const MODE_CODES = {
    seeds_only: 'sweep.mode.seedsOnly',
    cartesian: 'sweep.mode.cartesian',
    single_axis_seeds: 'sweep.mode.singleAxisSeeds',
    cartesian_seeds: 'sweep.mode.cartesianSeeds',
};

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

/** 秒を「約N分」へ。**0分と出さない**——1セルでも待たせるので。 */
function minutesOf(seconds) {
    return Math.max(1, Math.round(Number(seconds || 0) / 60));
}

function parseSeeds(text) {
    return String(text ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
        .filter(value => Number.isSafeInteger(value) && value >= 0);
}

/**
 * Sweep の面を作る。
 *
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {object} options.record パネルが持っている記録
 * @param {object} options.runner `SweepRunner`（**呼び手が材料つきで作る**）
 * @param {() => void} [options.onClose] 一覧へ戻る
 * @param {(cell: object) => Promise<void>} [options.onCapture] 出た画像を記録として取り込む
 */
export function createSweepView({
    documentRef,
    record,
    runner = null,
    onClose = null,
    onCapture = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    const root = element('div', { class: 'unbake-sweep' });
    const back = element('button', { class: 'unbake-sweep-back', type: 'button', text: t('sweep.back') });
    back.addEventListener('click', () => onClose?.());
    // **何を振っているのかを、絵で見せたまま作業させる。**
    // 名前だけだと、10件も開くうちに「今どれを触っているか」が判らなくなる。
    // 名前は一覧・出力ファイルと同じ規則（`civitai_<id>`）にそろえる。
    const headTitle = String(record?.displayName || record?.title || record?.id || '');
    const headChildren = [back];
    if (record?.previewUrl) {
        headChildren.push(element('img', {
            class: 'unbake-sweep-head-image', src: record.previewUrl, alt: '', loading: 'lazy',
        }));
    }
    headChildren.push(element('span', { class: 'unbake-sweep-title', text: headTitle }));
    root.append(element('div', { class: 'unbake-sweep-head' }, headChildren));

    const gate = sweepableRecord(record);
    if (!gate.ok) {
        // **押せないボタンを出さない。理由を出す。**
        root.append(element('p', { class: 'unbake-sweep-unavailable', text: t('sweep.unavailable') }));
        return { root, destroy() { root.remove(); }, available: false, reason: gate.reason };
    }
    const recipe = gate.recipe;

    // --- 雛形 ---------------------------------------------------------
    //
    // **一覧は2つの出どころを1つの選択肢にまとめる。**
    //
    //   1. 組み込みの雛形（記録から組む）
    //   2. **保存した実験の型**（別の記録で作った軸の宣言をここへ当てる）
    //
    // 型のための画面を別に作らない——Sweep を機能ごとの画面へ割ると、
    // 「どこから始めるか」が増えて全体が使われなくなる。
    let templates = [];
    const templateSelect = element('select', { class: 'unbake-sweep-template', 'aria-label': t('sweep.template') });
    const templateHelp = element('p', { class: 'unbake-sweep-help' });

    /** 型を当てたときに落ちた軸。**当たらなかったことを黙らせない。** */
    let lastApplyNotice = '';

    function collectTemplates() {
        // `objectInfo` は面を開いた後に届く（**待つと「押したのに何も起きない」時間ができる**）。
        // 届いていれば導入済みから選ぶ軸も並ぶ。
        const builtin = buildBuiltinSweepTemplates(recipe, { objectInfo: runner?.objectInfo || null });
        const saved = [];
        for (const type of readExperimentTypes()) {
            const applied = applyExperimentType(type, recipe);
            // **当たらない型は並べない。** 選べるのに0軸で開くのが一番わかりにくい。
            if (!applied.template) continue;
            saved.push({
                ...applied.template,
                id: `saved:${type.id}`,
                name: t('sweep.savedTypeName', { name: type.name }),
                description: [
                    type.name,
                    applied.dropped.length ? t('sweep.typeDropped', { count: applied.dropped.length }) : '',
                    applied.rebound.length ? t('sweep.typeRebound', { count: applied.rebound.length }) : '',
                ].filter(Boolean).join(' — '),
            });
        }
        return [...builtin, ...saved];
    }

    function renderTemplateOptions(keepId = null) {
        templates = collectTemplates();
        templateSelect.replaceChildren();
        for (const template of templates) {
            templateSelect.append(element('option', { value: template.id, text: template.name }));
        }
        const wanted = templates.some(item => item.id === keepId) ? keepId : templates[0]?.id;
        if (wanted) {
            templateSelect.value = wanted;
            loadTemplate(wanted);
        }
    }

    /**
     * **押す前に、何枚出るかを出す。**
     *
     * ここが無いのが「直感的でない」の中身だった。軸の値を1つ足すと枚数が
     * 何倍になるかは、回し方（直積・seed 付き）と軸の本数で決まる——
     * 頭の中で掛け算させると、**押してから初めて40枚だと判る**。
     *
     * 数え方は**実際に展開する関数から取る**（`expandSweepTemplate`）。
     * ここで掛け算を書き直すと、本物の展開と食い違ったときに
     * 画面のほうが嘘をつく。
     */
    const planLine = element('p', { class: 'unbake-sweep-plan', 'aria-live': 'polite' });

    function updatePlanLine() {
        if (!axisEditors) return;
        let cells = null;
        let detail = '';
        try {
            const template = readTemplate();
            cells = expandSweepTemplate(template).length;
            const parts = template.axes.map(axis => `${axis.label || axis.id} ${axis.values.length}`);
            if (template.seeds?.length && template.mode !== 'cartesian') {
                parts.push(t('sweep.plan.seeds', { n: template.seeds.length }));
            }
            detail = parts.join(' × ');
        } catch (error) {
            // **数えられない理由をそのまま出す。** 「まだ揃っていない」と
            // 「書き方が違う」を混ぜない。
            planLine.setAttribute('data-state', 'invalid');
            planLine.textContent = t('sweep.plan.unknown', { detail: error?.message || String(error) });
            return;
        }
        planLine.setAttribute('data-state', cells > 0 ? 'ok' : 'empty');
        planLine.textContent = detail
            ? t('sweep.plan.detail', { n: cells, detail })
            : t('sweep.plan.count', { n: cells });
    }

    // --- 軸 -----------------------------------------------------------
    const modeSelect = element('select', { class: 'unbake-sweep-mode', 'aria-label': t('sweep.mode') });
    for (const mode of SWEEP_MODES) {
        modeSelect.append(element('option', { value: mode, text: t(MODE_CODES[mode]) }));
    }
    // **種は一行に収まらない。** 15桁が3つで 455px 要るのに、サイドバーの
    // 器は 414px しか無く、**入力欄の中で横へ流れていた**（実測 2026-08-20）。
    // 見えない値は直せないので、軸の値と同じく折り返す器で受ける。
    // `parseSeeds()` は空白でも改行でも切るので、読み書きの規則は変えていない。
    const seedsInput = element('textarea', {
        class: 'unbake-sweep-seeds unbake-sweep-values', rows: '2',
        'aria-label': t('sweep.seeds'),
    });
    const axesBox = element('div', { class: 'unbake-sweep-axes' });
    /** @type {Array<{axis: object, read: () => object[], setDisabled: (flag: boolean) => void}>} */
    let axisEditors = [];

    /** ラベル用にフォルダと拡張子を落とす。**値そのものは触らない。** */
    function shortModelLabel(value) {
        const base = String(value || '').replaceAll('\\', '/').split('/').at(-1) || String(value || '');
        return base.replace(/\.(safetensors|ckpt|pt|pth|sft)$/i, '');
    }

    /**
     * モデルを**絵で選ぶ**軸（差し替え）。
     *
     * ---
     *
     * **名前だけでは選べない。** 差し替えの軸に並ぶのはファイル名で、
     * hassakuXLIllustrious_v13 と waiNSFWIllustrious_v110 の**どちらが欲しい絵か**は
     * 名前からは判らない。今までは判らないまま「ラベル = 値」を手で書かせていたので、
     * 実際には差し替えの軸は使われなかった。見本はモデルの隣に置かれている
     * （それを返すのが `/unbake/model-preview`）。
     *
     * **基準は動かせない。** 記録が今使っているものが基準で、外せない
     * ——基準が動くと前の実験と比べられなくなる（`sweepAxes.js` の決めごと1）。
     * 選ぶのは「基準に**足して**比べる相手」だけなので、
     * 「基準はちょうど1つ」を人に守らせる必要そのものが消える。
     *
     * @param {object} axis 軸の宣言（`values[].baseline` が基準）
     * @param {string} kind 見本を引く種類（`loras` / `checkpoints`）
     * @param {string[]} installed 導入済みの名前
     */
    /**
     * 見本が無かったモデルを、**まとめて1回だけ**取りに行く。
     *
     * ---
     *
     * **網羅的に集めるのは LoRA Manager の仕事。** ここがやるのは、画面に出ていて
     * かつ見本が無かったぶんだけを取りに行くこと（実測: LoRA は9割が既にあるが、
     * checkpoint は 0/1 だった——あちらが集めていない種類がある）。
     *
     * **1枚ずつ投げない。** 400本の一覧で1枚ずつ問い合わせると、
     * 開いただけで数百本の要求が出る。溜めてから12件ずつ送る。
     */
    const missingPreviews = new Set();
    let previewFetchTimer = null;

    /**
     * **上限に当たったら、次の束まで待つ**（2026-08-31・走査3周目）。
     *
     * サーバは 429 のとき `rateLimited` と `retryAfter` を載せて返す
     * （`unbake/model_previews.py`）。ところがここは `if (!item?.ok) continue;`
     * で**理由を見ずに全部落として**いたので、
     *
     *   - 上限に当たった名前が**待ち行列から消える**（次に描き直すまで戻らない）
     *   - 描き直した瞬間に**同じ勢いでまた叩く**（待っていない）
     *
     * という形になっていた。**中核がわざわざ渡している事実を、唯一の消費者が
     * 捨てていた**——`I-20260830-16`（`unknownTotals`）と同じ型である。
     */
    let previewBackoffUntil = 0;

    function requestPreview(kind, name, image) {
        if (!name || missingPreviews.has(name)) return;
        missingPreviews.add(name);
        drainPreviews(kind, name, image);
    }

    /**
     * 待ち行列を12件ずつ捌く。**空になるまで自分で次を組む**（2026-09-01・走査14周目）。
     *
     * 元はここが `requestPreview` の中にしか無く、**次を組む所がどこにも無かった**。
     * `requestPreview` は既に行列に居る名前で早退する（`missingPreviews.has(name)`）ので、
     * 一度溜まった13件目から先は**二度と取りに行かれない**——見本が無いことは
     * 一度しか判らない（`error` は一度きり）ので、外から突く手も無い。
     *
     * **上限に当たったぶんを行列へ戻す仕掛けも、同じ理由で効いていなかった。**
     * 走査3周目に「捨てると次に描き直すまで戻らない」として戻す側を足したが、
     * **戻した先を誰も捌かない**ので、捨てるのと結果が変わらない
     * ——直したつもりの片側だけが入っていた形。
     */
    function drainPreviews(kind, name, image) {
        if (previewFetchTimer) globalThis.clearTimeout?.(previewFetchTimer);
        // 待てと言われている間は、その分だけ後ろへ倒す。
        const wait = Math.max(400, previewBackoffUntil - Date.now());
        previewFetchTimer = globalThis.setTimeout?.(async () => {
            previewFetchTimer = null;
            const names = [...missingPreviews].slice(0, 12);
            if (!names.length) return;
            for (const item of names) missingPreviews.delete(item);
            let result = null;
            try {
                const doFetch = environmentRequestOrNull();
                if (!doFetch) return;   // 器が口を据えていなければ、名前だけで並ぶ
                const response = await doFetch('/unbake/model-preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind, names }),
                });
                result = await response.json();
            } catch {
                return;   // 取れなくても名前だけで並ぶ（画面は壊れない）
            }
            // **上限に当たった名前は待ち行列へ戻す。** 捨てると、次に
            // 描き直すまで二度と取りに行かない（画面からは戻す手段が無い）。
            const limited = (result?.items || []).filter(item => item?.rateLimited);
            if (limited.length) {
                for (const item of limited) missingPreviews.add(item.name);
                const seconds = Math.max(
                    ...limited.map(item => Number(item.retryAfter) || 0), 0);
                previewBackoffUntil = Date.now() + (seconds > 0 ? seconds * 1000 : 30_000);
                console.warn(
                    `[Unbake] Civitai asked us to slow down; retrying ${limited.length}`
                    + ` preview(s) in ${Math.round((previewBackoffUntil - Date.now()) / 1000)}s`);
            }
            for (const item of result?.items || []) {
                if (!item?.ok) continue;
                // **取れたぶんだけ描き直す。** 同じ URL では再取得されないので、
                // 印を付けて取り直させる。
                /*
                 * **`root` を引く**（2026-09-01・走査14周目）。
                 *
                 * ここは `box` と書いてあったが、**その名前はこの関数のどこからも
                 * 見えない**——`box` は `modelPicker()` と `numberPicker()` の中で
                 * `const` 宣言されている別物で、`requestPreview` の scope には無い。
                 * つまりこの行は毎回 `ReferenceError` を投げていた。
                 *
                 * 実測（実物の面を組んで見本を1枚失敗させた）:
                 *
                 *   送った名前: [ 'charB.safetensors' ]
                 *   ★ 未処理の拒否: ReferenceError - box is not defined
                 *
                 * **問い合わせは成立していて、返事も届いている。** 落ちるのは
                 * その返事を絵へ当てる最後の一歩なので、外から見ると
                 * 「取りに行っているのに、いつまでも見本が出ない」になる
                 * ——`await` の中の投げなので**画面にも記録にも何も出ない**。
                 *
                 * `root` はこの面の根なので、どの器の札も引ける（見本の要求は
                 * 器をまたいで溜まる）。偽の DOM は `querySelector` を持たないが、
                 * その時は下の `item.name === name` の逃げ道が拾う。
                 */
                const card = root.querySelector?.(`[data-model="${cssEscape(item.name)}"]`);
                const target = card?.querySelector?.('img') || (item.name === name ? image : null);
                if (!target) continue;
                target.setAttribute('src',
                    `/unbake/model-preview?kind=${encodeURIComponent(kind)}`
                    + `&name=${encodeURIComponent(item.name)}&v=${names.length}`);
                card?.removeAttribute?.('data-preview');
            }
            // **残りが在れば、自分で次の束を組む。** ここが無いと13件目から先と、
            // 上限で戻したぶんが行列に居座ったまま誰にも捌かれない。
            // 待ち幅は `previewBackoffUntil` を見るので、待てと言われている間は
            // その分だけ後ろへ倒れる（叩き続けない）。
            if (missingPreviews.size) drainPreviews(kind, name, image);
        }, wait);
    }

    /** `querySelector` へ入れる名前を安全にする（区切りや記号が入る）。 */
    function cssEscape(value) {
        return String(value ?? '').replace(/["\\]/g, '\\$&');
    }

    function modelPicker(axis, kind, installed) {
        const baseline = (axis.values || []).find(value => value.baseline)
            || { value: axis.values?.[0]?.value ?? '' };
        const baselineName = String(baseline.value ?? '');
        /** 選ばれている相手。**基準は含めない。** */
        const chosen = new Set((axis.values || [])
            .filter(value => !value.baseline)
            .map(value => String(value.value)));

        const box = element('div', { class: 'unbake-sweep-picker' });
        const search = element('input', {
            class: 'unbake-sweep-picker-search', type: 'search',
            placeholder: t('sweep.picker.filter'), 'aria-label': t('sweep.picker.filter'),
        });
        const countLine = element('p', { class: 'unbake-sweep-picker-count' });
        const gallery = element('div', { class: 'unbake-sweep-picker-grid' });

        const cardOf = (name, isBaseline) => {
            const on = isBaseline || chosen.has(name);
            const card = element('button', {
                class: 'unbake-sweep-pick', type: 'button',
                'data-on': on ? 'true' : 'false',
                'data-baseline': isBaseline ? 'true' : 'false',
                'data-model': name,
                title: name,
                'aria-pressed': on ? 'true' : 'false',
            });
            const image = element('img', {
                class: 'unbake-sweep-pick-image', loading: 'lazy', alt: '',
                src: '/unbake/model-preview?kind=' + encodeURIComponent(kind)
                    + '&name=' + encodeURIComponent(name),
            });
            // **見本が無いことを、壊れた絵で見せない。**
            // 無ければ**その1枚だけ取りに行く**（上流が集めていない種類がある）。
            image.addEventListener('error', () => {
                card.setAttribute('data-preview', 'none');
                requestPreview(kind, name, image);
            });
            card.append(image, element('span', { class: 'unbake-sweep-pick-name', text: shortModelLabel(name) }));
            if (isBaseline) {
                card.append(element('span', { class: 'unbake-sweep-pick-badge', text: t('sweep.picker.baseline') }));
            }
            card.addEventListener('click', () => {
                // **基準は外せない。** 外すと比べる土台が消える。
                if (isBaseline) { setStatus(t('sweep.picker.baselineFixed')); return; }
                if (chosen.has(name)) chosen.delete(name);
                else chosen.add(name);
                const now = chosen.has(name);
                card.setAttribute('data-on', now ? 'true' : 'false');
                card.setAttribute('aria-pressed', now ? 'true' : 'false');
                refresh();
            });
            return card;
        };

        function refresh() {
            countLine.textContent = t('sweep.picker.count', { n: chosen.size + 1 });
            updatePlanLine();
        }

        function draw() {
            const query = String(search.value || '').toLowerCase();
            const others = installed
                .filter(name => name !== baselineName)
                .filter(name => !query || name.toLowerCase().includes(query))
                // **選んだものを先に出す。** 何百件の中から探し直させない。
                .sort((a, b) => (chosen.has(b) ? 1 : 0) - (chosen.has(a) ? 1 : 0));
            gallery.replaceChildren(cardOf(baselineName, true), ...others.map(name => cardOf(name, false)));
            refresh();
        }

        search.addEventListener('input', draw);
        box.append(search, gallery, countLine);
        draw();

        return {
            root: box,
            setDisabled(flag) {
                search.disabled = flag;
                for (const card of gallery.children || []) card.disabled = flag;
            },
            read() {
                return [
                    { label: t('core.sweep.value.current', { value: shortModelLabel(baselineName) }), value: baselineName, baseline: true },
                    ...[...chosen].map(name => ({ label: shortModelLabel(name), value: name, baseline: false })),
                ];
            },
        };
    }

    /**
     * 数の軸の触り方。**軸ごとに幅と刻みが違う。**
     *
     * 同じ「数」でも、LoRA の強度（0〜2 を 0.05 刻み）と Steps（1〜60 を 1 刻み）では
     * 動かし方が違う。1つのスライダーで両方を賄うと、**どちらかが必ず使いにくくなる**
     * ——強度を 1 刻みで動かしても意味が無いし、Steps を 0.05 刻みで動かすのは苦行。
     */
    const NUMBER_RANGES = {
        // **下限は負**（2026-08-31・監査 I-20260831-07）。理由は
        // `LORA_STRENGTH_RANGE` の所に書いてある——「負の強度は誤りではなく、
        // 明るさや年齢の slider LoRA は負で使うことが正しい使い方である」。
        // ここだけ 0 で切っていたので、**中核が出した候補を画面が入れられなかった**。
        //
        // **数を書き写さず、中核から引く**（2026-09-01・走査15周目）。
        // 写していたせいで `modelsView.js` の強度つまみが 0 のまま残っていた
        // ——同じ「LoRA の強度」を触る口が2つ在り、直ったのは片方だけだった。
        lora_strength: {
            min: LORA_STRENGTH_RANGE.minimum, max: LORA_STRENGTH_RANGE.maximum,
            step: 0.05, digits: 2,
        },
        cfg_scale: { min: 1, max: 20, step: 0.5, digits: 1 },
        steps: { min: 1, max: 60, step: 1, digits: 0 },
    };

    function numberRangeOf(axis) {
        if (axis?.kind === 'lora_strength') return NUMBER_RANGES.lora_strength;
        if (axis?.kind === 'generation_parameter') {
            return NUMBER_RANGES[axis.parameter] || null;
        }
        return null;
    }

    /**
     * 数を**スライダーで足す**軸。
     *
     * ---
     *
     * **今までは `ラベル = 値` を手で書かせていた。** 強度を 0.05 動かしたいだけでも
     * 書式を思い出す必要があり、実機で「直感的でない」と言われたのがここ。
     *
     * **基準は動かせない。** 記録が今使っている値が基準で、外せない
     * ——動かすと前の実験と比べられなくなる。足すのは「比べる相手」だけ。
     * だから「基準はちょうど1つ」を人に守らせる必要そのものが無い。
     */
    function numberPicker(axis, range) {
        const values = axis.values || [];
        const baseline = values.find(value => value.baseline) || values[0] || { value: range.min };
        const baseNumber = Number(baseline.value);
        const format = (value) => Number(value).toFixed(range.digits);
        /** 足した相手。**基準は含めない。** */
        const chosen = new Map(values
            .filter(value => !value.baseline)
            .map(value => [format(value.value), Number(value.value)]));

        const box = element('div', { class: 'unbake-sweep-numbers' });
        const chips = element('div', { class: 'unbake-sweep-chips' });
        const slider = element('input', {
            class: 'unbake-sweep-slider', type: 'range',
            min: String(range.min), max: String(range.max), step: String(range.step),
            'aria-label': String(axis.label || axis.id),
        });
        const readout = element('span', { class: 'unbake-sweep-readout' });
        const addButton = element('button', {
            class: 'unbake-sweep-add', type: 'button', text: t('sweep.number.add'),
        });

        const setReadout = () => {
            const value = Number(slider.value);
            readout.textContent = t('sweep.number.readout', {
                value: format(value),
                delta: value === baseNumber ? '' : t('sweep.number.delta', {
                    delta: (value > baseNumber ? '+' : '') + format(value - baseNumber),
                }),
            });
            addButton.disabled = chosen.has(format(value)) || format(value) === format(baseNumber);
        };

        function drawChips() {
            const nodes = [element('span', {
                class: 'unbake-sweep-chip', 'data-baseline': 'true',
                text: t('sweep.number.baselineChip', { value: format(baseNumber) }),
                title: t('sweep.picker.baselineFixed'),
            })];
            for (const [key, value] of chosen) {
                const chip = element('button', {
                    class: 'unbake-sweep-chip', type: 'button',
                    text: `${key} ×`, title: t('sweep.number.remove', { value: key }),
                });
                chip.addEventListener('click', () => {
                    chosen.delete(key);
                    drawChips();
                    setReadout();
                    updatePlanLine();
                });
                nodes.push(chip);
                // 値そのものは Map に入っている（表示は文字、比較は数）。
                void value;
            }
            chips.replaceChildren(...nodes);
        }

        slider.value = String(baseNumber);
        slider.addEventListener('input', setReadout);
        addButton.addEventListener('click', () => {
            const key = format(Number(slider.value));
            if (key === format(baseNumber)) return;   // 基準は足さない（同じものを2回組む）
            chosen.set(key, Number(slider.value));
            drawChips();
            setReadout();
            updatePlanLine();
        });

        box.append(
            element('div', { class: 'unbake-sweep-slider-row' }, [slider, readout, addButton]),
            chips,
        );
        drawChips();
        setReadout();

        return {
            root: box,
            setDisabled(flag) {
                slider.disabled = flag;
                for (const chip of chips.children || []) chip.disabled = flag;
                /*
                 * **戻すときは、値から決め直す**（2026-09-01・走査14周目）。
                 *
                 * 元は `addButton.disabled = flag` で、**基準と同じ値でも押せる**
                 * 状態に戻していた。押しても `key === format(baseNumber)` で
                 * 黙って帰るので、**押せるのに何も起きない口**になる
                 * ——この面が「押せないボタンを出さない。理由を出す。」として
                 * 避けているものそのもの。
                 *
                 * しかも `syncButtons()` は**開いた直後にも走る**ので、
                 * 実測では開いた瞬間からこうなっていた:
                 *
                 *   開いた直後: slider = 0.8（＝基準）／「足す」は押せる
                 *   押した後の chip 数: 3（前: 3）＝何も増えない
                 */
                if (flag) addButton.disabled = true;
                else setReadout();
            },
            read() {
                return [
                    { label: format(baseNumber), value: baseNumber, baseline: true },
                    ...[...chosen.entries()].map(([key, value]) => ({ label: key, value, baseline: false })),
                ];
            },
        };
    }

    /** 見本を引ける軸か。**引けるものだけ絵で選ばせる**（数や語は絵にならない）。 */
    function pickerKindOf(axis) {
        if (axis?.kind === 'lora_swap') return 'loras';
        if (axis?.kind === 'checkpoint') return 'checkpoints';
        return null;
    }

    function installedFor(kind) {
        if (!runner?.objectInfo) return [];
        if (kind === 'loras') return installedModelOptions(runner.objectInfo, 'LoraLoader', 'lora_name');
        if (kind === 'checkpoints') return installedModelOptions(runner.objectInfo, 'CheckpointLoaderSimple', 'ckpt_name');
        return [];
    }

    function loadTemplate(templateId) {
        const template = templates.find(item => item.id === templateId) || templates[0];
        if (!template) return;
        templateHelp.textContent = template.description || '';
        modeSelect.value = template.mode;
        seedsInput.value = (template.seeds || []).join(' ');
        syncSeedField();
        axesBox.replaceChildren();
        let anyText = false;
        axisEditors = template.axes.map((axis, index) => {
            const label = element('label', {
                class: 'unbake-sweep-axis-label',
                text: t('sweep.axis', { n: index + 1, label: axis.label || axis.id }),
            });
            const kind = pickerKindOf(axis);
            const installed = kind ? installedFor(kind) : [];
            // **絵で選べるのは、見本を引ける軸で、導入済みが判っているときだけ。**
            // 判らないうちは今までどおり字で書く（届くのを待たせない）。
            if (kind && installed.length > 0) {
                const picker = modelPicker(axis, kind, installed);
                axesBox.append(element('div', { class: 'unbake-sweep-axis' }, [label, picker.root]));
                return { axis, read: () => picker.read(), setDisabled: picker.setDisabled };
            }
            // **数はスライダーで触る。** 書式を思い出さずに 0.05 動かせる。
            const range = numberRangeOf(axis);
            if (range) {
                const picker = numberPicker(axis, range);
                axesBox.append(element('div', { class: 'unbake-sweep-axis' }, [label, picker.root]));
                return { axis, read: () => picker.read(), setDisabled: picker.setDisabled };
            }

            anyText = true;
            const area = element('textarea', {
                class: 'unbake-sweep-values',
                rows: String(Math.max(3, (axis.values || []).length)),
                'aria-label': t('sweep.axis', { n: index + 1, label: axis.label || axis.id }),
            });
            area.value = formatAxisValues(axis.values);
            area.addEventListener('input', () => updatePlanLine());
            axesBox.append(element('div', { class: 'unbake-sweep-axis' }, [label, area]));
            return {
                axis,
                read: () => parseAxisValues(area.value),
                setDisabled: (flag) => { area.disabled = flag; },
            };
        });
        // **字で書く軸が1本も無いなら、書き方の説明も出さない。**
        if (anyText) {
            axesBox.append(element('p', { class: 'unbake-sweep-help', text: t('sweep.axisHelp') }));
        }
        updatePlanLine();
    }

    /**
     * seed の欄を出すかどうか。**使わない回し方では出さない。**
     *
     * 直積（seed 固定）では seed を振らないので、この欄は**常に空**だった。
     * 空の入力欄が黙って居座ると、「ここに何か書くべきなのか」を毎回考えさせる
     * ——実機で、差し替えの画面に空欄が1つ浮いていた。
     */
    function syncSeedField() {
        const usesSeeds = modeSelect.value !== 'cartesian';
        seedsInput.style.display = usesSeeds ? '' : 'none';
    }

    modeSelect.addEventListener('change', () => { syncSeedField(); updatePlanLine(); });
    seedsInput.addEventListener('input', () => updatePlanLine());

    templateSelect.addEventListener('change', () => {
        loadTemplate(templateSelect.value);
        setStatus('');
        plan = null;
        syncButtons();
    });

    /** 画面に書かれているものから宣言を組み直す。**表示ではなく入力が真実。** */
    function readTemplate() {
        const base = templates.find(item => item.id === templateSelect.value) || templates[0];
        return {
            ...base,
            mode: modeSelect.value,
            seeds: parseSeeds(seedsInput.value),
            axes: axisEditors.map(({ axis, read }) => ({ ...axis, values: read() })),
            recipeId: String(recipe.id ?? ''),
        };
    }

    // --- 操作 ---------------------------------------------------------
    const status = element('p', { class: 'unbake-sweep-status', role: 'status' });
    const summary = element('p', { class: 'unbake-sweep-summary' });
    const grid = element('div', { class: 'unbake-sweep-grid' });
    const checkButton = element('button', { class: 'unbake-sweep-check', type: 'button', text: t('sweep.preflight') });
    const runButton = element('button', { class: 'unbake-sweep-run', type: 'button', text: t('sweep.run') });
    const stopButton = element('button', { class: 'unbake-sweep-stop', type: 'button', text: t('sweep.stop') });
    const rerunButton = element('button', { class: 'unbake-sweep-rerun', type: 'button', text: t('sweep.rerunAll') });
    const saveTypeButton = element('button', {
        class: 'unbake-sweep-save-type', type: 'button', text: t('sweep.saveType'),
        title: t('sweep.saveType.help'),
    });

    let plan = null;
    let running = false;

    const setStatus = (message) => { status.textContent = String(message || ''); };

    function syncButtons() {
        saveTypeButton.disabled = running;
        // **検査を先に押させない。** 検査は投げる前に必ず通すが、それは
        // こちらの都合で、押す人にとっては「回す」までが1つの操作
        // ——実機で「左上を選んでから編集するのが手間」と言われたのと同じ形。
        // `run()` が中で検査を済ませるので、ここで押せなくする理由が無くなった。
        runButton.disabled = running;
        rerunButton.disabled = running || plan === null;
        checkButton.disabled = running;
        stopButton.disabled = !running;
        templateSelect.disabled = running;
        modeSelect.disabled = running;
        seedsInput.disabled = running;
        // **回している間は軸を触らせない。** 途中で値が変わると、
        // 出た絵がどの宣言のものか判らなくなる。
        // （編集器は絵で選ぶ器と字で書く器の2種類あるので、**畳み方も編集器が持つ**
        //  ——ここで要素を直接触ると、器を1つ足すたびにここが壊れる。）
        for (const editor of axisEditors) editor.setDisabled?.(running);
    }

    function check() {
        try {
            plan = runner.preflight(recipe, readTemplate());
        } catch (error) {
            // **落ちた理由をそのまま出す。** `assertOnlySweepInputsChanged` は
            // 動いてしまった入力の名前を持っているので、それが一番早い手掛かりになる。
            plan = null;
            setStatus(t('sweep.preflightFailed', { detail: error?.message || String(error) }));
            grid.replaceChildren();
            syncButtons();
            return null;
        }
        setStatus(t('sweep.preflightOk', {
            cells: plan.cellCount,
            minutes: minutesOf(plan.estimatedSeconds),
        }));
        renderGrid(plan.cells);
        syncButtons();
        return plan;
    }

    async function run({ reuseExisting = true } = {}) {
        if (running) return null;
        // **検査を先に押させない。** 検査は投げる前に必ず通すが、それはこちらの都合で、
        // 押す人にとっては「回す」までが1つの操作——実機で「左上を選んでから編集するのが
        // 手間」と言われたのと同じ形。**順番は変えていない**（間違った比較を先に見せて
        // から正しさを検査する、にはしない）。
        if (!plan) {
            check();
            if (!plan) return null;   // 検査で止まったなら、その理由がもう出ている
        }

        // **投入の直前に静的な門を置く。**（手順12）
        //
        // 1件ずつなら投げ損ねても「1件失敗した」で済むが、束にすると同じ投げ損が
        // **「N分待ってからまとめて失敗」**に化ける。だから束にするより先に門を置く。
        //
        // **判定はここで作り直さない。** 表（`verdictTable.js`）が持っている値を
        // 読むだけ——門が独自に判定すると「一覧では再現可なのに投げると弾かれる」
        // が起きて、どちらが正しいかを毎回人間が決めることになる。
        const gate = gateForSubmission([record]);
        if (gate.blocked.length > 0) {
            setStatus(t('sweep.blockedByVerdict', {
                detail: record?.blockedReason || t('verdict.blocked.long'),
            }));
            return null;
        }

        const template = (() => {
            try { return readTemplate(); } catch (error) {
                setStatus(t('sweep.preflightFailed', { detail: error?.message || String(error) }));
                return null;
            }
        })();
        if (!template) return null;
        running = true;
        syncButtons();
        setStatus(t('sweep.running'));
        let job = null;
        try {
            job = await runner.run({
                record: recipe,
                template,
                reuseExisting,
                onUpdate: (snapshot) => {
                    renderGrid(snapshot.cells);
                    renderSummary(snapshot);
                },
            });
            renderGrid(job.cells);
            renderSummary(job);
            setStatus(job.status === 'completed' ? t('sweep.done') : t('sweep.paused'));
        } catch (error) {
            setStatus(t('sweep.preflightFailed', { detail: error?.message || String(error) }));
        } finally {
            running = false;
            syncButtons();
        }
        return job;
    }

    checkButton.addEventListener('click', () => check());
    runButton.addEventListener('click', () => run());
    rerunButton.addEventListener('click', () => run({ reuseExisting: false }));

    /**
     * 画面に書かれている宣言を**実験の型**として保存する。
     *
     * **保存するのは軸だけ。** 記録の id は落とす（`experimentTypeFromTemplate`）
     * ——持たせると「この記録専用の型」になり、2回目から使えない。
     */
    saveTypeButton.addEventListener('click', () => {
        let declaration;
        try { declaration = readTemplate(); } catch (error) {
            setStatus(t('sweep.preflightFailed', { detail: error?.message || String(error) }));
            return;
        }
        const type = experimentTypeFromTemplate(declaration, {
            id: `type-${declaration.id}`,
            name: declaration.name,
        });
        if (!type) { setStatus(t('sweep.saveType.needAxis')); return; }
        saveExperimentType(type);
        setStatus(t('sweep.saveType.saved', { name: type.name }));
        renderTemplateOptions(templateSelect.value);
    });
    stopButton.addEventListener('click', () => { runner.stop(); setStatus(t('sweep.paused')); });

    // --- 表示 ---------------------------------------------------------
    function renderSummary(job) {
        const counts = summarizeSweep(job);
        summary.textContent = t('sweep.summary', {
            comparable: counts.comparable,
            total: counts.total,
            completed: counts.completed,
            reused: counts.reused,
            failed: counts.failed,
            unknown: counts.unknown,
            pending: counts.pending,
        });
        // **基準の画像が無ければ、そう言う。** 何と比べているのかが無い状態で
        // 絵だけ並べると、「良く見えたもの」を勝ちにしてしまう。
        summary.setAttribute('data-baseline', counts.baselineHasOutput ? 'ok' : 'missing');
        if (counts.comparable > 0 && !counts.baselineHasOutput) {
            summary.textContent += ` — ${t('sweep.noBaselineOutput')}`;
        }
    }

    /**
     * **「順次投入します」と書く。**
     *
     * ComfyUI のキューには**1件ずつしか入らない**（実測: 4セルを回している間、
     * 待ち行列の深さは常に 1 だった）。束で投げると ComfyUI が不安定になるので
     * こうしてあるのだが、**キューが空に見えるせいで「入っていない」と読まれ**、
     * 何度も回されてしまう——だから、残り何件をこちらが抱えているかを出す。
     */
    function renderQueueLine(cells) {
        const list = cells || [];
        const waiting = list.filter(cell => !['completed', 'reused', 'failed', 'skipped'].includes(cell.status)).length;
        const done = list.filter(cell => ['completed', 'reused'].includes(cell.status)).length;
        queueLine.style.display = list.length ? '' : 'none';
        queueLine.textContent = waiting > 0
            ? t('sweep.queueing', { waiting, total: list.length, done })
            : t('sweep.queueDone', { done, total: list.length });
    }

    function renderGrid(cells) {
        renderQueueLine(cells);
        grid.replaceChildren();
        // **空のときは、何がここへ出るのかを字で置く。**
        gridEmpty.style.display = (cells || []).length ? 'none' : '';
        for (const cell of cells || []) {
            const labelText = [
                ...(cell.labels || []).map(label => `${label.label}: ${label.valueLabel}`),
                ...(cell.seed === null || cell.seed === undefined ? [] : [t('sweep.cell.seed', { seed: cell.seed })]),
            ].join(' / ');
            const card = element('article', {
                class: 'unbake-sweep-cell',
                'data-status': cell.status || 'pending',
                'data-baseline': cell.baseline === true ? 'true' : 'false',
                'data-cell-id': cell.id,
            }, [
                element('div', { class: 'unbake-sweep-cell-labels', text: labelText }),
            ]);
            if (cell.baseline === true) {
                card.append(element('span', { class: 'unbake-sweep-badge', text: t('sweep.cell.baseline') }));
            }
            // **順番が来る前なら外せる。** ComfyUI のキューから消すのと同じことを、
            // まだ投げていないぶんに対してできるようにする。
            const waiting = !['completed', 'reused', 'failed', 'skipped'].includes(cell.status);
            if (waiting) {
                const drop = element('button', {
                    class: 'unbake-sweep-drop', type: 'button', text: '×',
                    title: t('sweep.drop'), 'aria-label': t('sweep.drop'),
                });
                drop.addEventListener('click', (event) => {
                    event?.stopPropagation?.();
                    /*
                     * **実行器の実体へ伝える**（`D-20260828-01` E6）。
                     *
                     * ここで手にしている `cells` は `onUpdate` が渡した**写し**
                     *（`clone()`）なので、書き換えても実行器には届かない。
                     * 元はそれだけをして「実行器は `skipped` を投げない」と
                     * 書いてあったが、**投げないのは実体の側の `skipped` を見た時**で、
                     * 写しの `skipped` は誰も見ていない——タイルは即
                     * `skipped` に見えるのに、**順番が来ると投入されて GPU を使い**、
                     * 次の更新で `completed` に戻る。
                     */
                    runner?.dropCell?.(cell.id);
                    // 写しの側も変える。**次の更新まで待たせない**（押した手応えが要る）。
                    cell.status = 'skipped';
                    renderGrid(cells);
                });
                card.append(drop);
            }
            if (cell.output?.url) {
                card.append(element('img', {
                    class: 'unbake-sweep-cell-image', src: cell.output.url, alt: labelText, loading: 'lazy',
                }));
            }
            card.append(element('div', {
                class: 'unbake-sweep-cell-status',
                text: cell.error || cell.status || 'pending',
            }));
            if (cell.output?.url && onCapture) {
                const capture = element('button', {
                    class: 'unbake-sweep-capture', type: 'button', text: t('sweep.capture'),
                });
                capture.addEventListener('click', async () => {
                    capture.disabled = true;
                    try {
                        await onCapture(cell);
                    } catch (error) {
                        setStatus(t('sweep.captureFailed', { detail: error?.message || String(error) }));
                    } finally {
                        capture.disabled = false;
                    }
                });
                card.append(capture);
            }
            grid.append(card);
        }
    }

    // **結果の場所に、比べる相手を最初から置く。**
    //
    // 元は下に 800px 近い余白が空いていて、「ここに絵が並ぶ」ことが押すまで
    // 判らなかった（実機で指摘された）。空箱を置くだけでは余白が四角くなるだけなので、
    // **元の1枚をそこへ出す**——Sweep は「これと比べてどう変わるか」を見る道具で、
    // 比べる相手は最初から決まっている。回すと、その隣に結果が並ぶ。
    const queueLine = element('p', { class: 'unbake-sweep-queue', 'aria-live': 'polite' });
    queueLine.style.display = 'none';
    const gridEmpty = element('div', { class: 'unbake-sweep-grid-empty' }, [
        ...(record?.previewUrl
            ? [element('img', { class: 'unbake-sweep-baseline-image', src: record.previewUrl, alt: '', loading: 'lazy' })]
            : []),
        element('p', { class: 'unbake-sweep-baseline-caption', text: t('sweep.gridEmpty') }),
    ]);
    const results = element('div', { class: 'unbake-sweep-results' }, [queueLine, gridEmpty, grid]);

    root.append(
        element('div', { class: 'unbake-sweep-controls' }, [
            templateSelect, modeSelect, seedsInput,
        ]),
        templateHelp,
        axesBox,
        planLine,
        element('div', { class: 'unbake-sweep-actions' }, [
            checkButton, runButton, stopButton, rerunButton, saveTypeButton,
        ]),
        status,
        summary,
        // **「採点しない」という決めごとは、画面から外した。**
        //
        // 元は「勝ちは人が選びます。Unbake はセルに順位を付けません——自動採点は、
        // あなたが見ようとしていたものを先に決めてしまいます。」と出していた。
        // これは**次に実装する人へ向けた注意**であって、絵を見比べに来た人には
        // 何を言っているのか分からない（実機でそう言われた）。
        //
        // **決めごと自体は消していない。** 置き場所をここ（コメント）と検査へ移した
        // ——`sweep_view_test.mjs` が「セルに順位・点数を付けていない」ことを見ている。
        // 画面に書いてあることが守らせているのではなく、検査が守らせている。
        results,
    );

    renderTemplateOptions();
    syncButtons();

    // **導入済み一覧は後から届く。** 届いた時点で雛形を組み直す
    // ——待って開くと「押したのに何も起きない」時間ができ、
    // 待たずに諦めると差し替えの軸が永久に出ない。
    if (runner?.inputsReady && typeof runner.inputsReady.then === 'function') {
        runner.inputsReady.then(() => {
            if (running) return; // 走っている最中に選択肢を入れ替えない。
            renderTemplateOptions(templateSelect.value);
        }).catch(() => {
            // 取れなければ導入済みから選ぶ軸が出ないだけ。組み込みの雛形は残る。
        });
    }

    return {
        root,
        available: true,
        reason: null,
        check,
        run,
        readTemplate,
        get plan() { return plan; },
        get running() { return running; },
        destroy() {
            // **見本の待ち行列を止める**（2026-09-01・走査14周目）。
            // 捌く側が自分で次を組むようになったので、止めないと**面を閉じても
            // 回り続ける**——上限に当たっている間は30秒ごとに叩き直す。
            if (previewFetchTimer) globalThis.clearTimeout?.(previewFetchTimer);
            previewFetchTimer = null;
            missingPreviews.clear();
            root.remove();
        },
    };
}
