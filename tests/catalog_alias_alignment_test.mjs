/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **台帳引きは1本**（`I-20260830-27`）。
 *
 * `recipeWorkflowBuilder.js` には `recipeMissingModels.findCatalogEntry` の写しが
 * 置いてあり、コメント自身が「規則を変えたら両方直す」と人間頼みを宣言していた。
 * 判定側と実行側で答えが割れると、画面は「導入済み」と表示するのに投入は
 * `value_not_in_list` で拒否され、**絵が1枚も出ない**——2026-08-14 に
 * 346件中296件が投入不能になったのと同じ形である。
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * `knownModelCatalog` を渡している検査は1本だけで、渡していたのは
 * **8箇所すべて `{ models: [] }`（空配列）**。空配列への `.find()` は必ず
 * `undefined` を返すので、**この関数の本体は全検査を通して一度も評価されない**。
 * `aliases` という語は tests 配下に1件も無かった。
 *
 * だからここでは**台帳の実体を読んで**、別名で記録された名前が実際に
 * 揃え直されるところまで通す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecipeWorkflow } from '../web/core/recipeWorkflowBuilder.js';
import { findCatalogEntry } from '../web/core/recipeMissingModels.js';
import { toRecipeShape } from '../web/core/recordShape.js';
import { setLocale } from '../web/i18n/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
setLocale('en');

/** 台帳の実体（Python）を読む。**写しを持たない**——古くなるのが写しの罪。 */
function realCatalog() {
    const source = fs.readFileSync(
        path.join(ROOT, 'unbake/services/known_model_catalog.py'), 'utf8')
        .split('\r\n').join('\n');
    const models = [];
    for (const block of source.split('KnownModel(').slice(1)) {
        const end = block.indexOf('),\n');
        const body = block.slice(0, end < 0 ? block.length : end + 1);
        const filename = /filename\s*=\s*"([^"]+)"/.exec(body)?.[1];
        if (!filename) continue;
        const aliasBlock = /aliases\s*=\s*\(([\s\S]*?)\)/.exec(body)?.[1] || '';
        models.push({ filename, aliases: [...aliasBlock.matchAll(/"([^"]+)"/g)].map(m => m[1]) });
    }
    return { models, installed: [], unavailable: null };
}

const CATALOG = realCatalog();

/** 別名を持ち、かつ**別名から機械的には導けない**項目（＝台帳が要る項目）。 */
function aliasOnlyEntries() {
    const stem = (value) => String(value).replaceAll('\\', '/').split('/').pop()
        .replace(/\.(safetensors|sft|ckpt|pth|pt|bin|onnx|pkl|pt2)$/i, '').toLowerCase();
    const out = [];
    for (const model of CATALOG.models) {
        for (const alias of model.aliases || []) {
            if (stem(alias) !== stem(model.filename)) out.push({ alias, filename: model.filename });
        }
    }
    return out;
}

test('台帳に「別名からは導けない対応」が在る（前提）', () => {
    const pairs = aliasOnlyEntries();
    assert.ok(pairs.length >= 1,
        '台帳の別名がすべてファイル名から機械的に導ける＝この検査は何も測れない');
});

/** 拡大器1本だけのグラフ。**揃え直しの対象は `model_name`。** */
const graphWith = (upscalerName) => ({
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: 'neg', clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: 'pos', clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    5: { class_type: 'KSampler', inputs: {
        seed: 1, steps: 20, cfg: 4, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
        model: ['1', 0], positive: ['3', 0], negative: ['2', 0], latent_image: ['4', 0] } },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    8: { class_type: 'UpscaleModelLoader', inputs: { model_name: upscalerName } },
    9: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['8', 0], image: ['6', 0] } },
    7: { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'x' } },
});

/**
 * 実機と同じ形の `object_info`（`['COMBO', {options}]`）。
 *
 * **グラフに出る節を全部宣言する。** 1つでも欠けると組み立て側は
 * 「未導入の節が在る」と判断して**埋め込みグラフを丸ごと捨て**、標準構成へ
 * 組み直す——拡大器ごと消えるので、揃え直しを一度も通らない
 * （最初この宣言が足りず、対照まで落ちて気づいた）。
 */
const objectInfoWith = (options) => {
    const info = {};
    for (const node of Object.values(graphWith('x'))) {
        info[node.class_type] = { input: { required: {} } };
    }
    info.UpscaleModelLoader = { input: { required: { model_name: ['COMBO', { options }] } } };
    return info;
};

const RECORD = {
    id: 'x.png', title: 'x', checkpoint: 'a.safetensors',
    seed: 1, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'normal',
    positive: 'pos', negative: 'neg',
};

const upscalerOf = (prompt) => Object.values(prompt || {})
    .find(node => node?.class_type === 'UpscaleModelLoader')?.inputs?.model_name ?? null;

function build(upscalerName, options, catalog) {
    const recipe = toRecipeShape({ ...RECORD, prompt: graphWith(upscalerName) });
    return buildRecipeWorkflow(recipe, {
        objectInfo: objectInfoWith(options), embeddings: [],
        ...(catalog ? { knownModelCatalog: catalog } : {}),
    });
}

test('台帳の別名で記録された名前が、手元の一覧の綴りへ揃う', () => {
    const failures = [];
    for (const { alias, filename } of aliasOnlyEntries()) {
        const built = build(alias, [filename], CATALOG);
        const got = upscalerOf(built.prompt);
        if (got !== filename) failures.push(`${alias} → ${got}（${filename} のはず）`);
    }
    assert.deepEqual(failures, [],
        '台帳の別名が揃え直されていない。**判定側は「導入済み」と出るのに投入は拒否される**');
});

test('判定側と実行側が、同じ答えを返す', () => {
    // 写しが在ると、ここが割れる。割れた瞬間に「導入済みなのに投入不能」になる。
    const mismatched = [];
    for (const { alias, filename } of aliasOnlyEntries()) {
        const judged = findCatalogEntry(CATALOG, alias)?.filename ?? null;
        const executed = upscalerOf(build(alias, [filename], CATALOG).prompt);
        if (judged !== executed) mismatched.push(`${alias}: 判定=${judged} / 実行=${executed}`);
    }
    assert.deepEqual(mismatched, [], '判定側と実行側で答えが違う');
});

test('[対照] 台帳を渡さなければ、揃え直さない', () => {
    // **台帳が働いていることの証拠。** 別の規則（完全一致・末尾・語幹）で
    // たまたま揃っているなら、台帳を外しても同じ答えになるはず。
    const pairs = aliasOnlyEntries();
    const [{ alias, filename }] = pairs;
    const got = upscalerOf(build(alias, [filename], null).prompt);
    assert.notEqual(got, filename,
        `台帳なしでも ${alias} が ${filename} へ揃っている（台帳を測れていない）`);
});

test('[対照] 台帳に無い名前は、揃え直さない', () => {
    const got = upscalerOf(build('まったく無い拡大器', ['4x_foolhardy_Remacri.pth'], CATALOG).prompt);
    assert.equal(got, 'まったく無い拡大器',
        '台帳に無い名前を勝手に別のモデルへ揃えている（違うモデルで生成して「再現した」と言うことになる）');
});

test('[対照] 候補が2つ以上に当たるときは、揃え直さない', () => {
    /*
     * 曖昧なまま当てると、**別のモデルで生成して「再現した」と主張する**ことになる。
     *
     * **本当に当たる2つを置く。** 正規化は語幹から英数字以外を落として小文字に
     * するので、区切りや拡張子だけ違う綴りは**同じ鍵になる**。前版は
     * `_copy` を足した囮を置いていて、それは別の鍵になるため候補は1つのまま
     * ——「一意でないときは触らない」を一度も測っていなかった（変異で素通りした）。
     *
     * **囮を先に置く。** 後ろに置くと、1つ目を採る実装でも正解に当たってしまう。
     */
    const { alias, filename } = aliasOnlyEntries()[0];
    const decoy = filename.replaceAll('_', '-').replace(/\.[a-z0-9]+$/i, '.safetensors');
    assert.notEqual(decoy, filename, '前提: 囮は綴りが違う');
    const got = upscalerOf(build(alias, [decoy, filename], CATALOG).prompt);
    assert.equal(got, alias,
        `候補が2つ当たるのに ${got} を選んでいる（一意でないときは触らない）`);
});

test('ファイル名側も正規化して引く（綴り違いで取り逃さない）', () => {
    /*
     * 記録に残る名前は、拡張子や区切りが手元と違うことがある
     * （`ae.sft` 対 `ae.safetensors` で投入ごと拒否された前例が在る）。
     * **別名だけ見ていると、ここは一度も測られない**——別名の枝で先に
     * 当たってしまうため、ファイル名側の正規化を殺しても緑のままだった。
     */
    const missed = [];
    for (const model of CATALOG.models.slice(0, 40)) {
        const variants = [
            model.filename.toUpperCase(),
            model.filename.replaceAll('_', '-'),
            model.filename.replace(/\.[a-z0-9]+$/i, ''),
        ];
        for (const variant of variants) {
            const got = findCatalogEntry(CATALOG, variant)?.filename ?? null;
            if (got !== model.filename) missed.push(`${variant} → ${got}`);
        }
    }
    assert.deepEqual(missed, [], 'ファイル名の綴り違いを取り逃している');
});

test('別名を持たない項目でも、ファイル名の綴り違いで引ける', () => {
    /*
     * **今の台帳ではこの枝は何も決めていない。**
     *
     * 実測（2026-08-30）: 台帳26件は**すべて**「ファイル名の語幹と同じに
     * 正規化される別名」を持っているので、`filename` 側の照合を殺しても
     * 別名側が拾ってしまい、実データでは差が出ない（変異が等価になる）。
     *
     * だが関数の契約は「`filename` と `aliases` を見る」であって、別名を
     * 持たない項目が台帳へ足された瞬間にこの枝が唯一の道になる。
     * **実データで差が出ないものは、契約のほうで留める。**
     */
    const lone = { models: [{ filename: '4x_Nomos8kSC.pth', aliases: [] }] };
    for (const variant of ['4x_Nomos8kSC.pth', '4X_NOMOS8KSC.PTH', '4x-nomos8ksc', 'sub/4x_Nomos8kSC.safetensors']) {
        assert.equal(findCatalogEntry(lone, variant)?.filename, '4x_Nomos8kSC.pth',
            `別名の無い項目を ${variant} で引けない`);
    }
    // **対照**: 別物は引かない（何を渡しても当たる形になっていないこと）。
    assert.equal(findCatalogEntry(lone, '4x-UltraSharp.pth'), null, '別のモデルを引いている');
});

test('台帳の別名は、ファイル名の語幹を覆っている（覆っていないなら上の枝が唯一の道）', () => {
    // 実測 26/26。**この前提が崩れたこと自体を知りたい**ので、数を凍らせずに
    // 「覆っていない項目が在るなら、それは別名の無い項目と同じ扱いになる」を記録する。
    const uncovered = CATALOG.models.filter(model =>
        !(model.aliases || []).some(alias =>
            findCatalogEntry({ models: [model] }, alias)?.filename === model.filename
            && findCatalogEntry({ models: [{ filename: model.filename, aliases: [] }] }, alias)
                ?.filename === model.filename));
    // 覆っていない項目が在っても**壊れてはいない**（上の検査が守る）。数だけ見える形にする。
    assert.ok(Array.isArray(uncovered), '走査が壊れている');
    assert.ok(CATALOG.models.length >= 20,
        `台帳を ${CATALOG.models.length} 件しか読めていない＝走査が壊れている`);
});

test('台帳引きの写しを持たない（規則が2箇所に無い）', () => {
    // **人間頼みの「両方直す」を、機械の検査に置き換える。**
    const source = fs.readFileSync(path.join(ROOT, 'web/core/recipeWorkflowBuilder.js'), 'utf8');
    assert.match(source, /import \{[^}]*findCatalogEntry[^}]*\} from '\.\/recipeMissingModels\.js'/,
        '本家を輸入していない');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /function findKnownModelEntry/,
        '台帳引きの写しが残っている（規則を変えたとき片方だけ直る）');
});
