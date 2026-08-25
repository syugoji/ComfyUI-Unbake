/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * 軸を**書く**ところと、記録から軸を**提案する**ところ。
 *
 * `recipeSweep.js` は「軸が決まった後」を扱う（展開・適用・変更検査）。ここはその手前で、
 * **人が軸を1本書くまでの距離**を縮めるためだけに在る。白紙から `{id, kind, values,
 * baseline}` を組める人はいないので、そこで止まると Sweep は誰にも使われない。
 *
 * 決めごとを2つ置いてある。
 *
 * 1. **基準は明示させる。** 各軸はちょうど1つの baseline を要求する（行頭 `*`）。
 *    自動で「真ん中」を基準にすると、値を1つ足しただけで基準が動き、
 *    **前の実験と比べられなくなる**——比較の土台が黙って入れ替わるのが一番困る。
 *    `recipeSweep.js` 側も同じ条件を検査するので、ここは早く教えるためだけの重複。
 * 2. **プロンプトへ入る文字列は訳さない。** ラベルは訳すが、`highly detailed` のような
 *    値そのものは**モデルへの入力**であって文章ではない。訳すと別の実験になる。
 */

import { t } from '../i18n/index.js';

/** 値の書式: `ラベル = 値`。`=` が無ければラベルと値が同じ。行頭 `*` が基準。 */
function parseScalar(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    try {
        return JSON.parse(text);
    } catch {
        // JSON でないものはそのまま文字列として扱う（`euler_ancestral` など）。
        return text;
    }
}

/**
 * 人が書いた複数行を軸の値の配列へ変える。
 *
 * ```
 * 低 = 0.6
 * *現在 = 0.8
 * 高 = 1.0
 * ```
 */
export function parseAxisValues(text) {
    const values = String(text ?? '').split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => {
            const baseline = line.startsWith('*');
            const clean = baseline ? line.slice(1).trim() : line;
            const separator = clean.indexOf('=');
            const label = separator >= 0 ? clean.slice(0, separator).trim() : clean;
            const rawValue = separator >= 0 ? clean.slice(separator + 1).trim() : clean;
            if (!label) throw new Error(t('core.sweep.axis.emptyLabel', { line: index + 1 }));
            return { label, value: parseScalar(rawValue), baseline };
        });
    if (values.length < 2) throw new Error(t('core.sweep.axis.needTwo'));
    if (values.filter(value => value.baseline).length !== 1) {
        throw new Error(t('core.sweep.axis.needOneBaseline'));
    }
    return values;
}

/** 軸の値を人が書いた形へ戻す（編集して回すため）。 */
export function formatAxisValues(values) {
    return (Array.isArray(values) ? values : [])
        .map(item => {
            const value = typeof item?.value === 'string' ? item.value : JSON.stringify(item?.value ?? '');
            return `${item?.baseline ? '*' : ''}${item?.label ?? ''} = ${value}`;
        })
        .join('\n');
}

/**
 * LoRA を軸の対象として指す名前。**ファイル名より `modelVersionId` を優先する。**
 * ファイル名は改名で動くが、版IDは記録が指す版そのもの。
 */
export function loraTargetIdentity(lora, index = 0) {
    return String(lora?.modelVersionId ?? lora?.file_name ?? lora?.name ?? index);
}

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function rounded(value, digits = 2) {
    const scale = 10 ** digits;
    return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function loraStrength(lora) {
    return finiteNumber(lora?.strength ?? lora?.strength_model ?? lora?.strength_clip, 1);
}

/**
 * 現在値の前後で3点。**現在値は必ず入り、必ず基準になる。**
 *
 * 端に張り付いているときは反対側へ2倍振る——下限に当たって「現在」と「低」が
 * 同じ値になると、**2点あるように見えて実質1点**になり、軸として何も測れない。
 *
 * **範囲は必ず現在値を含むところまで広げる。** 実データで踏んだ（2026-08-20・
 * レシピ `1b5b0457…` の5本目）: 明るさの slider LoRA が **強度 -0.7** で記録されており、
 * 範囲を `[0, 2]` に決め打ちしていたため `低` も `高` も `0` へ潰れて
 * **`[0, -0.7, 0]`** になった。値は3つあるので `validateAxis` も通り、
 * 3セルのうち2セルが**同じグラフ**を組む——`signature` が一致するので、
 * 実行側は片方を「既に出ている」と見なして**別条件のはずの絵を使い回す。**
 * 赤くならないまま比較が壊れる形なので、ここで潰す。
 */
function numericValues(currentValue, delta, options = {}) {
    const current = rounded(finiteNumber(currentValue, options.fallback ?? 1));
    // 現在値が既定の範囲の外にあるなら、範囲のほうを広げる。
    const minimum = Math.min(finiteNumber(options.minimum, Number.NEGATIVE_INFINITY), current);
    const maximum = Math.max(finiteNumber(options.maximum, Number.POSITIVE_INFINITY), current);
    const clamp = value => rounded(Math.min(maximum, Math.max(minimum, value)));
    let low = clamp(current - delta);
    let high = clamp(current + delta);
    if (low === current) high = clamp(current + (delta * 2));
    if (high === current) low = clamp(current - (delta * 2));

    const seen = new Set([current]);
    const values = [{ label: t('core.sweep.value.current', { value: current }), value: current, baseline: true }];
    // **重複を出さない。** 出すと「3点に見えて2点」になる（上の実例）。
    if (!seen.has(low)) {
        seen.add(low);
        values.unshift({ label: t('core.sweep.value.low', { value: low }), value: low, baseline: false });
    }
    if (!seen.has(high)) {
        seen.add(high);
        values.push({ label: t('core.sweep.value.high', { value: high }), value: high, baseline: false });
    }
    return values;
}

/**
 * LoRA 強度の3点。
 *
 * **範囲を `[0, 2]` にしない。** 負の強度は誤りではなく、明るさや年齢の
 * slider LoRA は**負で使うことが正しい使い方**である（実データ346件に実在）。
 * 0 で切ると、その種類の LoRA を振る実験そのものができなくなる。
 */
function loraStrengthValues(lora) {
    return numericValues(loraStrength(lora), 0.2, { minimum: -2, maximum: 2 });
}

function displayLoraName(lora, index = 0) {
    return String(
        lora?.modelName || lora?.name || lora?.file_name
        || t('core.sweep.lora.fallbackName', { n: index + 1 })
    );
}

function limitedText(value, limit = 120) {
    const text = String(value ?? '');
    return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}…`;
}

/**
 * 選択肢に出す LoRA の説明。
 *
 * **「prompt token ではない」と書いてある理由**——ここに並ぶ名前は
 * プロンプトへ書く語ではなく、記録が指している LoRA の識別子である。
 * 同じ文字列がプロンプトにも出ることがあるので、混ざると別のものを振ってしまう。
 */
export function describeLoraTarget(lora, index = 0) {
    const identity = loraTargetIdentity(lora, index);
    const name = displayLoraName(lora, index);
    const versionName = String(lora?.modelVersionName || '').trim();
    const versionId = lora?.modelVersionId;
    const hasVersionId = versionId !== undefined && versionId !== null;
    const current = rounded(loraStrength(lora));
    const fileName = String(lora?.file_name || lora?.localPath || '').trim();
    const detail = hasVersionId
        ? t('core.sweep.lora.helpVersionId', { id: versionId })
        : t('core.sweep.lora.helpIdentifier', { id: identity });
    return {
        value: identity,
        name,
        versionName,
        fileName,
        baseModel: String(lora?.baseModel || lora?.base_model || '').trim(),
        previewUrl: String(lora?.preview_url || lora?.thumbnailUrl || '').trim(),
        label: t('core.sweep.lora.option', {
            name,
            version: versionName ? t('core.sweep.lora.versionSuffix', { version: versionName }) : '',
            current,
            id: hasVersionId
                ? t('core.sweep.lora.civitaiVersionId', { id: versionId })
                : t('core.sweep.lora.identifier', { id: identity }),
        }),
        help: t('core.sweep.lora.helpNotToken', {
            detail: (fileName ? t('core.sweep.lora.helpFile', { file: fileName }) : '') + detail,
        }),
    };
}

/** 記録の seed。無ければ null（＝「元の seed で固定」ができない印）。 */
export function originalRecipeSeed(record) {
    const seed = Number(record?.gen_params?.seed);
    return Number.isSafeInteger(seed) && seed >= 0 ? seed : null;
}

/** まだ軸に使われていない LoRA。軸を足すときの既定の対象。 */
export function nextUnusedLoraTarget(record, usedTargets = []) {
    const loras = Array.isArray(record?.loras) ? record.loras : [];
    const used = new Set([...usedTargets].map(String));
    const index = loras.findIndex((lora, loraIndex) => !used.has(loraTargetIdentity(lora, loraIndex)));
    if (index >= 0) return loraTargetIdentity(loras[index], index);
    return loras[0] ? loraTargetIdentity(loras[0], 0) : '0';
}

/** プロンプトに書かれている `{差し替え口}`。 */
export function extractPromptPlaceholders(record) {
    return [...new Set(String(record?.gen_params?.prompt ?? '').match(/\{[^{}]+\}/g) || [])];
}

/**
 * 記録の seed から始まる連番。**元の seed が必ず1つ目**＝基準になる。
 *
 * 連番にしてあるのは、**再現できること**を優先したから。無作為に採ると
 * 「良かったあの1枚」の seed を後から言えなくなる（実験を再開しても同じ絵が出ない）。
 * seed の分布に偏りがあるわけではないので、連番でも比較の意味は変わらない。
 */
function seedSeries(record, count = 3) {
    const seed = originalRecipeSeed(record);
    const maximum = Number.MAX_SAFE_INTEGER - 1;
    const baseline = seed === null ? 0 : Math.min(seed, maximum);
    const step = baseline <= maximum - (count - 1) ? 1 : -1;
    return Array.from({ length: count }, (_, index) => baseline + (index * step));
}

function loraAxis(lora, index) {
    const description = describeLoraTarget(lora, index);
    return {
        id: `lora-${index + 1}`,
        kind: 'lora_strength',
        target: description.value,
        label: limitedText(t('core.sweep.lora.axisLabel', { name: description.name })),
        values: loraStrengthValues(lora),
    };
}

function parameterAxis(id, label, parameter, values) {
    return { id, kind: 'generation_parameter', label, parameter, values };
}

/**
 * 記録から**そのまま回せる**雛形を並べる。
 *
 * 白紙ではなく「これで回す／ここを直す」から始められるようにするためのもの。
 * どれも**元の seed を固定した直積**が既定で、seed を振るのは1本だけ——
 * seed を振ると同じ軸でもセル数が3倍になるので、**既定にすると最初の1回が重くなる。**
 */
/**
 * 導入済みモデルの一覧を `/object_info` から読む。
 *
 * **記録が名指しするモデルと、手元に在るモデルは別物。** 差し替えの軸は
 * 「手元に在るもの」からしか選べない——無い物へ差し替えると、組み立てが
 * その LoRA を鎖から外すか、ComfyUI が投入を拒む。**選ばせてから落とすより、
 * 最初から在る物だけを並べる。**
 *
 * 形は2通りある（実測 2026-08-14）。素の配列と `['COMBO', {options}]` で、
 * 片方だけ見ると**その環境でだけ0件**になる。
 *
 * @returns {string[]} 導入済みの名前。読めなければ空配列。
 */
export function installedModelOptions(objectInfo, classType, inputName) {
    const spec = objectInfo?.[classType]?.input?.required?.[inputName]
        ?? objectInfo?.[classType]?.input?.optional?.[inputName];
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0].map(String);
    if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
    return [];
}

/**
 * 同じ系統から候補を選ぶ。
 *
 * **無作為に選ばない。** 手元の導入済み checkpoint は101本あり（実測）、
 * 系統が違うもの（Illustrious と Flux）へ差し替えると、絵が変わるのではなく
 * **壊れる**——比べる意味が無い出力に1本ぶんの生成時間を使うことになる。
 * 名前は `Illustrious\anime\...` のようにフォルダを持っているので、
 * **同じ先頭フォルダ**を系統の代わりに使う。手がかりが無ければ全体から採る。
 */
function sameFamilyCandidates(options, current, count) {
    const normalize = value => String(value || '').replaceAll('\\', '/');
    const familyOf = value => normalize(value).split('/').slice(0, -1).join('/');
    const family = familyOf(current);
    const others = options.filter(option => normalize(option) !== normalize(current));
    const sameFamily = family ? others.filter(option => familyOf(option) === family) : [];
    const pool = sameFamily.length >= count ? sameFamily : others;
    return pool.slice(0, count);
}

export function buildBuiltinSweepTemplates(record, { objectInfo = null } = {}) {
    const loras = Array.isArray(record?.loras) ? record.loras : [];
    const templates = [];

    loras.forEach((lora, index) => {
        const description = describeLoraTarget(lora, index);
        templates.push({
            id: `builtin-lora-${index + 1}`,
            name: limitedText(t('core.sweep.tpl.loraOnly.name', { name: description.name })),
            description: t('core.sweep.tpl.loraOnly.desc', { name: description.name }),
            mode: 'cartesian',
            axes: [loraAxis(lora, index)],
            seeds: [],
        });
    });

    // **seed だけを振る。** 「同じ条件で、たまたま良い1枚が出ただけではないか」は
    // 再現の作業で最も多い問いなので、これを一番上に置く。
    //
    // **新しい画面は足さない。** 既にある雛形の一覧に1つ増えるだけで、
    // 覚えることは増えない——UI を機能ごとに足すと、Sweep 全体が使われなくなる。
    const seedBaseline = originalRecipeSeed(record);
    templates.unshift({
        id: 'builtin-seed-only',
        name: t('core.sweep.tpl.seedOnly.name'),
        description: seedBaseline === null
            // **記録に seed が無いことを言う。** 黙って 0 から並べると、
            // 「元の1枚と同じもの」が1枚も無いまま4枚が並ぶ。
            ? t('core.sweep.tpl.seedOnly.descNoSeed')
            : t('core.sweep.tpl.seedOnly.desc', { seed: seedBaseline }),
        mode: 'seeds_only',
        axes: [],
        seeds: seedSeries(record, 4),
    });

    if (loras[0]) {
        templates.push({
            id: 'builtin-lora-seeds',
            name: limitedText(t('core.sweep.tpl.loraSeeds.name', { name: displayLoraName(loras[0], 0) })),
            description: t('core.sweep.tpl.loraSeeds.desc'),
            mode: 'single_axis_seeds',
            axes: [loraAxis(loras[0], 0)],
            seeds: seedSeries(record),
        });
    }

    if (loras.length >= 2) {
        templates.push({
            id: 'builtin-two-lora-balance',
            name: limitedText(t('core.sweep.tpl.twoLora.name', {
                a: displayLoraName(loras[0], 0), b: displayLoraName(loras[1], 1),
            })),
            description: t('core.sweep.tpl.twoLora.desc'),
            mode: 'cartesian',
            axes: [loraAxis(loras[0], 0), loraAxis(loras[1], 1)],
            seeds: [],
        });
    }

    const cfg = finiteNumber(record?.gen_params?.cfg_scale, 7);
    const steps = Math.max(1, Math.round(finiteNumber(record?.gen_params?.steps, 20)));
    const stepDelta = Math.max(4, Math.round(steps * 0.25));

    if (loras[0]) {
        templates.push({
            id: 'builtin-lora-cfg',
            name: limitedText(t('core.sweep.tpl.loraCfg.name', { name: displayLoraName(loras[0], 0) })),
            description: t('core.sweep.tpl.loraCfg.desc'),
            mode: 'cartesian',
            axes: [
                loraAxis(loras[0], 0),
                parameterAxis('cfg', 'CFG', 'cfg_scale', numericValues(cfg, 1, { minimum: 0.1 })),
            ],
            seeds: [],
        });
    }

    templates.push({
        id: 'builtin-cfg-steps',
        name: t('core.sweep.tpl.cfgSteps.name'),
        description: t('core.sweep.tpl.cfgSteps.desc'),
        mode: 'cartesian',
        axes: [
            parameterAxis('cfg', 'CFG', 'cfg_scale', numericValues(cfg, 1, { minimum: 0.1 })),
            parameterAxis('steps', 'Steps', 'steps', numericValues(steps, stepDelta, { minimum: 1 })),
        ],
        seeds: [],
    });

    templates.push({
        id: 'builtin-prompt-detail',
        name: t('core.sweep.tpl.promptDetail.name'),
        description: t('core.sweep.tpl.promptDetail.desc'),
        mode: 'cartesian',
        axes: [{
            id: 'prompt-detail',
            kind: 'prompt_append',
            label: t('core.sweep.tpl.promptDetail.axisLabel'),
            // **値はモデルへの入力なので訳さない。** ラベルだけ訳す。
            values: [
                { label: t('core.sweep.tpl.promptDetail.none'), value: '', baseline: true },
                { label: t('core.sweep.tpl.promptDetail.detailed'), value: 'highly detailed', baseline: false },
                { label: t('core.sweep.tpl.promptDetail.sharp'), value: 'sharp focus, intricate details', baseline: false },
            ],
        }],
        seeds: [],
    });

    // --- 導入済みから選ぶ軸（`objectInfo` が要る）-------------------------
    //
    // **裁定②の本体はここ。** 「実行リスト」の正体は
    // 「レコードの一部を固定し、キャラ／checkpoint／LoRA を変数にした画像群」で、
    // 足りていなかったのは束ではなく**この2本の軸**だった。
    // `checkpoint` 軸は `recipeSweep.js` に実装済みだったが**雛形が無く、
    // 導入済みから選ぶ口も無かった**ので、画面からは一度も使えなかった。
    if (objectInfo) {
        const checkpoints = installedModelOptions(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name');
        const currentCheckpoint = String(
            record?.checkpoint?.file_name || record?.checkpoint?.name || record?.checkpoint || ''
        );
        const otherCheckpoints = sameFamilyCandidates(checkpoints, currentCheckpoint, 2);
        if (currentCheckpoint && otherCheckpoints.length >= 1) {
            templates.push({
                id: 'builtin-checkpoint-swap',
                name: t('core.sweep.tpl.checkpointSwap.name'),
                description: t('core.sweep.tpl.checkpointSwap.desc', { count: checkpoints.length }),
                mode: 'cartesian',
                axes: [{
                    id: 'checkpoint',
                    kind: 'checkpoint',
                    label: t('core.sweep.tpl.checkpointSwap.axisLabel'),
                    values: [
                        { label: t('core.sweep.value.current', { value: shortModelName(currentCheckpoint) }), value: currentCheckpoint, baseline: true },
                        ...otherCheckpoints.map(name => ({ label: shortModelName(name), value: name, baseline: false })),
                    ],
                }],
                seeds: [],
            });
        }

        // --- LoRA の差し替え ------------------------------------------
        //
        // **記録が指す LoRA ごとに1本出す。** 元は先頭の1本ぶんしか作らず、
        // しかも**同じ系統の候補が手元に1つ以上あるとき**だけ並べていた。
        // 実データでは記録が6本の LoRA を指すこともあり、
        // 「2本目を差し替えたい」に画面から到達する道が無かった。
        //
        // **同系統の候補が無くても並べる。** 候補は画面側で絵から選ぶので
        // （見本を出す `/unbake/model-preview`）、ここで先に絞る理由が消えた。
        // 名前の綴りが似ているかどうかは、欲しい絵かどうかとは関係が無い。
        const installedLoras = installedModelOptions(objectInfo, 'LoraLoader', 'lora_name');
        if (installedLoras.length > 0) {
            loras.forEach((lora, index) => {
                const currentLoraFile = String(lora?.file_name || lora?.localPath || '');
                if (!currentLoraFile) return;
                const suggested = sameFamilyCandidates(installedLoras, currentLoraFile, 2);
                templates.push({
                    id: `builtin-lora-swap-${index + 1}`,
                    name: limitedText(t('core.sweep.tpl.loraSwap.name', { name: displayLoraName(lora, index) })),
                    description: t('core.sweep.tpl.loraSwap.desc', { count: installedLoras.length }),
                    mode: 'cartesian',
                    axes: [{
                        id: `lora-swap-${index + 1}`,
                        kind: 'lora_swap',
                        label: t('core.sweep.tpl.loraSwap.axisLabel'),
                        target: loraTargetIdentity(lora, index),
                        values: [
                            { label: t('core.sweep.value.current', { value: shortModelName(currentLoraFile) }), value: currentLoraFile, baseline: true },
                            // **似た名前を初期値として置くだけ。** 外すのも足すのも画面でできる。
                            ...suggested.map(name => ({ label: shortModelName(name), value: name, baseline: false })),
                        ],
                    }],
                    seeds: [],
                });
            });
        }
    }

    return templates.map(template => ({ ...template, recipeId: String(record?.id ?? '') }));
}

/** ラベル用にフォルダと拡張子を落とす。**値そのものは触らない。** */
function shortModelName(value) {
    const base = String(value || '').replaceAll('\\', '/').split('/').at(-1) || String(value || '');
    return limitedText(base.replace(/\.(safetensors|ckpt|pt|pth|sft)$/i, ''), 40);
}
