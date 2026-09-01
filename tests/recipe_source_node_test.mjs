/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 供給ノード（`UnbakeRecipeSource`）の**繋ぎ先の決め方**を固定する。
 *
 * ここで守っているのは3つ:
 *
 *   1. **読めなかった項目へは繋がない。** 繋ぐと、組み上げたグラフが持っていた
 *      正しい値を既定値（seed 0・steps 20）で上書きする。**画像を読み込んだ
 *      のに絵が変わる**という、原因の判らない壊れ方をする。
 *   2. **既に配線されている口へは繋がない。** API グラフの入力値が配列なら
 *      それは配線であって値で、上書きすると構造ごと壊れる。
 *   3. **本文はサンプラーから辿って決める。** 節を総なめにすると、
 *      使われていない `CLIPTextEncode` が残っているグラフで**繋がっていない方**
 *      へ書く（実際に在る形——組み直しの残骸が浮いたまま残る）。
 *
 * 出力の並びが `unbake/nodes.py` と一致することもここで見る。番号で繋ぐので、
 * 片方だけ並べ替えると**プロンプトが seed の欄へ流れる**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    OUTPUT_INDEX,
    OUTPUT_NAMES,
    UNBAKE_NODE_TYPE,
    alignBundleToGraph,
    planRecipeWiring,
    recipeBundle,
} from '../web/core/recipeSourceNode.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 素の再現グラフ（`buildRecipeWorkflow()` が吐く形の最小版）。 */
const SIMPLE = {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
    3: {
        class_type: 'KSampler',
        inputs: {
            seed: 12345, steps: 28, cfg: 6.5, sampler_name: 'dpmpp_2m',
            model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
        },
    },
};

const FULL = { prompt: 'a cat', negative: 'blurry', seed: 1, steps: 28, cfg: 6.5 };

test('出力の並びが nodes.py の FIELDS と一致する', () => {
    const source = fs.readFileSync(path.join(ROOT, 'unbake/nodes.py'), 'utf8');
    const block = source.match(/^FIELDS\s*=\s*\(([\s\S]*?)^\)/m);
    assert.ok(block, 'nodes.py の FIELDS が読めない');
    const names = [...block[1].matchAll(/\(\s*"([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(names, OUTPUT_NAMES, '出力の並びが Python と JS で食い違う');
});

test('型名が Python と同じ字である', () => {
    const source = fs.readFileSync(path.join(ROOT, 'unbake/nodes.py'), 'utf8');
    assert.ok(source.includes(`"${UNBAKE_NODE_TYPE}"`), '型名が nodes.py に無い');
});

test('値の在る項目だけを繋ぐ', () => {
    const plan = planRecipeWiring(SIMPLE, FULL);
    const pairs = plan.map(p => `${p.node}.${p.input}<-${p.from}`).sort();
    assert.deepEqual(pairs, [
        '3.cfg<-cfg', '3.seed<-seed', '3.steps<-steps', '6.text<-prompt', '7.text<-negative',
    ]);
});

test('束に無い項目へは1本も繋がない（既定値での上書きを作らない）', () => {
    // 読めたのはプロンプトだけ、という記録は普通に在る（メタが欠けた絵）。
    const plan = planRecipeWiring(SIMPLE, { prompt: 'a cat' });
    assert.deepEqual(plan, [{ node: '6', input: 'text', from: 'prompt' }]);
});

test('束が空なら何も繋がない', () => {
    assert.deepEqual(planRecipeWiring(SIMPLE, {}), []);
    assert.deepEqual(planRecipeWiring(null, FULL), []);
});

test('既に別の節から配線されている口へは繋がない', () => {
    const wired = JSON.parse(JSON.stringify(SIMPLE));
    wired[3].inputs.seed = ['9', 0];          // 種は外部のノードが決めている
    wired[9] = { class_type: 'Seed', inputs: {} };
    const plan = planRecipeWiring(wired, FULL);
    assert.equal(plan.some(p => p.input === 'seed'), false, '配線済みの口を上書きしている');
    assert.equal(plan.some(p => p.input === 'steps'), true, 'ほかの口まで諦めている');
});

test('浮いた CLIPTextEncode があっても、繋がっている方へ書く', () => {
    const withOrphan = JSON.parse(JSON.stringify(SIMPLE));
    withOrphan[99] = { class_type: 'CLIPTextEncode', inputs: { text: '組み直しの残骸', clip: ['4', 1] } };
    const plan = planRecipeWiring(withOrphan, FULL);
    assert.equal(plan.some(p => p.node === '99'), false, '繋がっていない節へ書いている');
});

test('条件の間に節が挟まっていても本文まで辿る', () => {
    const chained = JSON.parse(JSON.stringify(SIMPLE));
    chained[20] = { class_type: 'ControlNetApply', inputs: { conditioning: ['6', 0] } };
    chained[3].inputs.positive = ['20', 0];
    const plan = planRecipeWiring(chained, FULL);
    assert.ok(plan.some(p => p.node === '6' && p.from === 'prompt'), '本文まで辿れていない');
});

test('KSamplerAdvanced の noise_seed も種として扱う', () => {
    const advanced = JSON.parse(JSON.stringify(SIMPLE));
    advanced[3].class_type = 'KSamplerAdvanced';
    delete advanced[3].inputs.seed;
    advanced[3].inputs.noise_seed = 12345;
    const plan = planRecipeWiring(advanced, FULL);
    assert.ok(plan.some(p => p.input === 'noise_seed' && p.from === 'seed'), '種を繋げていない');
});

test('環になったグラフでも止まらない', () => {
    const looped = {
        1: { class_type: 'KSampler', inputs: { positive: ['2', 0], seed: 1, steps: 1, cfg: 1 } },
        2: { class_type: 'ConditioningCombine', inputs: { a: ['3', 0] } },
        3: { class_type: 'ConditioningCombine', inputs: { a: ['2', 0] } },
    };
    assert.doesNotThrow(() => planRecipeWiring(looped, FULL));
});

test('束は空の項目を持たない（読めなかったことを 0 に化けさせない）', () => {
    const bundle = recipeBundle(
        { gen_params: { prompt: 'a cat', seed: 0, cfg_scale: null }, checkpoint: null },
        { prompt: 'a cat', seed: 0 },
    );
    assert.equal('cfg' in bundle, false, '読めなかった項目が束へ入っている');
    assert.equal(bundle.seed, 0, '0 を落としている（seed 0 は正当な値）');
    assert.equal('checkpoint' in bundle, false, '空のモデル名が束へ入っている');
});

test('束は出どころ（画像名か URL）を持ち回る', () => {
    // **これが無いと、共有されたグラフを受け取った人が差し替えの起点を持てない**
    // ——ノードは在るのに、何を差し替えれば動き直すのかが判らない。
    const recipe = { gen_params: { prompt: 'a cat' } };
    assert.equal(recipeBundle(recipe, {}, { image: 'a.png' }).image, 'a.png');
    assert.equal(recipeBundle(recipe, {}, { url: 'https://example.test/i/1' }).url,
        'https://example.test/i/1');
    // 出どころが無い呼び方でも落ちない（既存のグラフ生成経路がこれを通る）。
    const bare = recipeBundle(recipe, {});
    assert.equal('image' in bare, false);
    assert.equal('url' in bare, false);
});

test('URL 1本を被せた dataTransfer が、パネルと同じ振り分けになる', async () => {
    // **ノード側は判定を自前で持たない。** ここが割れると
    // 「パネルでは通るのにノードでは通らない」が生まれ、しかもどちらが
    // 正しいのか誰にも判らなくなる。被せ物の形だけをここで固定する。
    const { DROP_ROUTES, UNSUPPORTED_CODES, routeDrop } = await import('../web/panel/dropRouting.js');
    const asDrop = (url) => ({ getData: (type) => (type === 'text/plain' ? url : ''), files: [] });

    assert.equal(routeDrop(asDrop('https://civitai.com/images/12345'))?.route,
        DROP_ROUTES.CIVITAI, 'Civitai の画像ページを拾えていない');
    assert.equal(routeDrop(asDrop('http://127.0.0.1:8188/api/view?filename=a.png&type=output&subfolder='))?.route,
        DROP_ROUTES.COMFY_OUTPUT, 'ComfyUI の出力を拾えていない');
    const post = routeDrop(asDrop('https://civitai.com/posts/999'));
    assert.equal(post?.route, DROP_ROUTES.UNSUPPORTED, '投稿URLを扱えない扱いにしていない');
    assert.equal(post?.code, UNSUPPORTED_CODES.CIVITAI_POST, '理由を名指しできていない');
    assert.equal(routeDrop(asDrop('https://example.test/not-an-image-page')), null,
        '判らないものを判った扱いにしている');
});

test('モデル名は3通りの形から拾える', () => {
    assert.equal(recipeBundle({ checkpoint: 'a.safetensors' }).checkpoint, 'a.safetensors');
    assert.equal(recipeBundle({ checkpoint: { name: 'b.safetensors' } }).checkpoint, 'b.safetensors');
    assert.equal(recipeBundle({ checkpoint: { file_name: 'c.safetensors' } }).checkpoint, 'c.safetensors');
});

test('出力の見出しの鍵が、出力の並びと同じ順で書かれている', () => {
    // **番号で繋ぐので、片方だけ並べ替えると別の値が別の口へ入る。**
    // 見出しだけがずれた場合は「プロンプト」と書かれた口から種が出る形になり、
    // **画面上は正常に見えたまま**下流が全部おかしくなる。
    const entry = fs.readFileSync(path.join(ROOT, 'web/unbake.js'), 'utf8');
    const block = entry.match(/const RECIPE_SOURCE_SLOT_KEYS = \[([\s\S]*?)\];/);
    assert.ok(block, 'unbake.js に見出しの表が無い');
    const keys = [...block[1].matchAll(/'node\.recipeSource\.out\.(\w+)'/g)].map(m => m[1]);
    assert.deepEqual(keys, OUTPUT_NAMES, '見出しの並びが出力の並びと違う');
});

test('出力の番号が名前と対応している', () => {
    assert.equal(OUTPUT_INDEX.prompt, 0);
    assert.equal(OUTPUT_INDEX.checkpoint, OUTPUT_NAMES.length - 1);
});
/**
 * 選択肢（COMBO）の口へ繋ぐ側（`I-20260829-04`）。
 *
 * ここで守るのは2つ:
 *
 *   1. **流す値はグラフに焼かれている値**であること。記録の生の値
 *      （`"Euler a"`）を流すと、組み立て側が `resolveSamplerScheduler()` で
 *      寄せた正しい名前を壊す。**繋ぐまでは害が出ない**ので、繋いだ瞬間に
 *      退行する形になる。
 *   2. **値が割れていたら繋がない**こと。出力は1本なので、複数のサンプラーが
 *      別々の値を持つグラフでは、片方に合わせるともう片方を静かに書き換える。
 */
const SAMPLED = {
    3: {
        class_type: 'KSampler',
        inputs: {
            seed: 1, steps: 28, cfg: 6.5,
            sampler_name: 'euler_ancestral', scheduler: 'karras',
            model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
        },
    },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
};

test('束の sampler / scheduler を、グラフに焼かれている値へ揃える', () => {
    // 記録側は A1111 の表記。**そのまま流すと選択肢の口に無い値になる。**
    const raw = { prompt: 'a cat', sampler: 'Euler a', scheduler: 'Karras' };
    const aligned = alignBundleToGraph(SAMPLED, raw);
    assert.equal(aligned.sampler, 'euler_ancestral', 'グラフの値へ揃っていない');
    assert.equal(aligned.scheduler, 'karras', 'グラフの値へ揃っていない');
    assert.equal(raw.sampler, 'Euler a', '渡された束を書き換えている');
});

test('グラフに無い項目は束から落とす（既定値での上書きを作らない）', () => {
    // `SIMPLE` の KSampler は `scheduler` を持たない。
    const aligned = alignBundleToGraph(SIMPLE, { sampler: 'Euler a', scheduler: 'Karras' });
    assert.equal(aligned.sampler, 'dpmpp_2m');
    assert.ok(!('scheduler' in aligned), '無い値を束へ残している');
});

test('サンプラーが複数在って値が割れていたら繋がない', () => {
    const split = {
        ...SAMPLED,
        30: { class_type: 'KSampler', inputs: { sampler_name: 'dpmpp_2m', scheduler: 'karras' } },
    };
    const aligned = alignBundleToGraph(split, { sampler: 'Euler a', scheduler: 'Karras' });
    assert.ok(!('sampler' in aligned), '割れている値を片方へ寄せている');
    // scheduler は両方 karras で一致しているので残る（割れているのは sampler だけ）。
    assert.equal(aligned.scheduler, 'karras', '一致している項目まで落としている');
});

test('配線済みの口は、揃える判断にも配線にも入れない', () => {
    const wired = {
        3: {
            class_type: 'KSampler',
            inputs: { sampler_name: ['99', 0], scheduler: 'karras', positive: ['6', 0] },
        },
        6: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
    };
    const aligned = alignBundleToGraph(wired, { sampler: 'Euler a', scheduler: 'Karras' });
    assert.ok(!('sampler' in aligned), '配線済みの口の値を束へ持ち込んでいる');
    const plan = planRecipeWiring(wired, aligned);
    assert.ok(!plan.some(p => p.input === 'sampler_name'), '配線済みの口へ繋ごうとしている');
});

test('揃えたあとは sampler と scheduler が実際に配線される', () => {
    const aligned = alignBundleToGraph(SAMPLED, { prompt: 'a cat', sampler: 'Euler a', scheduler: 'Karras' });
    const plan = planRecipeWiring(SAMPLED, aligned);
    const pairs = plan.map(p => `${p.node}.${p.input}<-${p.from}`).sort();
    assert.deepEqual(pairs, ['3.sampler_name<-sampler', '3.scheduler<-scheduler', '6.text<-prompt']);
});

test('checkpoint は繋がない（出力を選択肢型にできないため）', () => {
    // 繋げないことを**検査で固定する**。`nodes.py` の `_return_types()` が
    // `checkpoint` を選択肢から外している理由（一覧の現物を握れない）と対で、
    // 片方だけ変えると投入不能なグラフを作る。
    const plan = planRecipeWiring(SIMPLE, { checkpoint: 'x.safetensors' });
    assert.deepEqual(plan, [], 'モデル名を繋ごうとしている');
});

test('nodes.py が checkpoint を選択肢に入れていない', () => {
    const source = fs.readFileSync(path.join(ROOT, 'unbake/nodes.py'), 'utf8');
    const block = source.match(/^CHOICE_FIELDS = \{([\s\S]*?)^\}/m);
    assert.ok(block, 'nodes.py の CHOICE_FIELDS が読めない');
    const names = [...block[1].matchAll(/"([^"]+)":/g)].map(m => m[1]);
    assert.deepEqual(names, ['sampler', 'scheduler'], '選択肢にする項目が JS 側の前提と違う');
});
test('入口が、配線を決める前に束をグラフへ揃えている', () => {
    // **単体では緑のまま実機だけ壊れる形を塞ぐ。** `alignBundleToGraph()` を
    // 通さずに `planRecipeWiring()` を呼ぶと、記録の生の値（`"Euler a"`）が
    // 選択肢の口へ流れて、組み立て側が寄せた正しい名前を上書きする。
    // その退行はこのファイルのどの単体検査にも当たらない（入口は素通し）。
    const entry = fs.readFileSync(path.join(ROOT, 'web/unbake.js'), 'utf8');
    assert.match(entry, /alignBundleToGraph\(\s*prompt\s*,\s*recipeBundle\(/,
        '入口が束をグラフへ揃えずに配線している');
});
test('口が空文字のグラフからは値を採らない', () => {
    // 手で作ったグラフや、組み立てが途中で止まったグラフには空の口が在る。
    // 空を「値」として採ると、記録側に正しい値が在っても空で上書きし、
    // **選択肢に無い値**が KSampler へ流れる（投入が拒否される）。
    const blank = {
        3: { class_type: 'KSampler', inputs: { sampler_name: '', scheduler: 'karras' } },
    };
    const aligned = alignBundleToGraph(blank, { sampler: 'Euler a', scheduler: 'Karras' });
    assert.ok(!('sampler' in aligned), '空文字を値として採っている');
    assert.equal(aligned.scheduler, 'karras');
    assert.ok(!planRecipeWiring(blank, aligned).some(p => p.input === 'sampler_name'),
        '空の口へ繋ごうとしている');
});
