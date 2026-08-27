/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **到達性の棚卸し**——製品の入口から辿れない module を固定する。
 *
 * ## なぜ検査にするのか
 *
 * 2026-08-26 の実機検証で `RecipeOutputIndex` が Sweep の印を**読んで控えにも
 * 入れているのに照合に一度も使っていない**ことが見つかった。**Unbake 自身が
 * 出した絵を、Unbake の口から1枚も引けない**という状態が、誰にも気づかれずに
 * 残っていた——検査は全部緑だったし、画面も何も言わなかった。
 *
 * 同じ日の棚卸しで、**製品から辿れない module が 12件（約2,900行）**在ることも
 * 判った。辿れないこと自体は必ずしも誤りではない（入口を外したのが正しい判断
 * だったものも在る）。困るのは**それが一覧になっていないこと**で、
 *
 *   - 繋いだつもりで繋がっていない（`sweep` の照合と同じ形）
 *   - 直したつもりが、動いていない側を直していた
 *   - 消してよいのか、まだ使う予定なのかが誰にも判らない
 *
 * のどれなのかが、読んでも判らない。**だから一覧を検査として置く。**
 * 増えたら赤、繋いだのに一覧へ残っていても赤にする。
 *
 * ## 数えていないこと
 *
 * ここが見るのは **module の到達性だけ**。`sweep` のように「module は辿れるが
 * 値が使われていない」形は捕まらない——別の網が要る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 製品の入口。ComfyUI が読み込むのはここ1つ。 */
const ENTRY = 'web/unbake.js';

/**
 * **入口から辿れないと判っている module**と、その覚え書き。
 *
 * 覚え書きは「なぜ今そうなっているか」を書く場所で、**推測は推測と書く**。
 * 繋いだら、ここから外すこと（外し忘れも赤になる）。
 */
const PARKED = new Map([
    ['web/panel/sweepView.js',
     'Sweep の面。一覧からの入口は利用者の指示で外した（2026-08-22「入口は置かず、状態だけを出す」）。'
     + ' panel.js には受け皿（変数と後始末）だけが残っている。'],
    ['web/core/experimentTypes.js', 'Sweep の軸宣言を保存する入れ物。上の面と対なので、一緒に外れている。'],
    ['web/core/recipeTrialRunner.js', '記録を流して再現を目で確かめる試行。再現は sweepRunner へ一本化された。'],
    ['web/core/recipeMissingResources.js', '不足素材を取得待ち行列の形へ揃える。不足の算出は recipeReplayCapability が担っている。'],
    ['web/core/recipeCompositionScore.js', '再現結果を参照画像と突き合わせて自己採点する。採点はしない方針（勝者は人間が選ぶ）。'],
    ['web/core/recipeRunList.js', '順番に回す記録を名前付きで束ねる。選択＋「まとめて出す」に置き換わっている。'],
    ['web/core/a1111LoraMerge.js', 'A1111 の <lora:> タグを本文へ合成する。LoRA は別ノードとして組むので、今の道では通らない。'],
    ['web/core/recipeNotes.js', '記録のメモを構造として拾う。面に入口が無い。'],
    ['web/core/recipeReferenceInfo.js', '参照情報の表示文。detailView が自前で組む方に寄っている。'],
    ['web/core/recipeOutputs.js', '出力を /view の URL へ直す。unbake.js が自前で組んでいる。'],
    ['web/core/recipeMetadata.js', '再現に要る項目の一覧。使い手が居ない。'],
]);

/** `web/` 配下の .js を全部。 */
function collectModules() {
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(join(ROOT, dir))) {
            if (entry === 'node_modules') continue;
            const rel = `${dir}/${entry}`;
            if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
            else if (rel.endsWith('.js')) out.push(rel);
        }
    };
    walk('web');
    return out;
}

/**
 * 取り込みの辺。**動的取り込み（`await import('...')`）も数える。**
 * 静的だけ見ると、実際に動いている面まで「辿れない」に出る。
 */
function importsOf(rel, text, known) {
    const found = new Set();
    const patterns = [
        /from\s+['"](\.[^'"]+)['"]/g,
        /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
            // **区切りを揃える。** Windows では join が円記号を返すので、
            // そのままだと web/core/... の形と一致しない（辺が1本も張れない）。
            let target = normalize(join(dirname(rel), match[1]))
                .split(String.fromCharCode(92)).join('/');
            if (!target.endsWith('.js')) target += '.js';
            if (known.has(target)) found.add(target);
        }
    }
    return found;
}

function reachable() {
    const modules = collectModules();
    const known = new Set(modules);
    const text = new Map(modules.map(rel => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    const seen = new Set();
    const stack = [ENTRY];
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of importsOf(cur, text.get(cur) || '', known)) stack.push(next);
    }
    return { modules, seen, unreachable: modules.filter(rel => !seen.has(rel)).sort() };
}

test('数えられている（検出器の生死）', () => {
    // **壊れた検出器は「全部辿れない」か「1件も辿れない」を返す。**
    // どちらも上の比較を素通りしてしまうので、先に生死を見る。
    assert.ok(existsSync(join(ROOT, ENTRY)), `入口が無い: ${ENTRY}`);
    const { modules, seen } = reachable();
    assert.ok(modules.length > 60, `module を数えられていない: ${modules.length}`);
    assert.ok(seen.size > 50, `入口から辿れた数が少なすぎる（歩けていない）: ${seen.size}`);
    // 中核が辿れていること。ここが落ちるなら歩き方が壊れている。
    for (const must of ['web/panel/panel.js', 'web/core/sweepRunner.js', 'web/core/recipeWorkflowBuilder.js']) {
        assert.ok(seen.has(must), `辿れているはずの module が漏れている: ${must}`);
    }
});

test('入口から辿れない module は、一覧のとおり', () => {
    const { unreachable } = reachable();
    const listed = [...PARKED.keys()].sort();
    const added = unreachable.filter(rel => !PARKED.has(rel));
    const gone = listed.filter(rel => !unreachable.includes(rel));
    assert.deepEqual(added, [],
        `入口から辿れない module が増えた。繋ぎ忘れなら繋ぐ、意図的なら理由つきで一覧へ足すこと:\n  ${added.join('\n  ')}`);
    assert.deepEqual(gone, [],
        `一覧に載っているのに辿れるようになっている。繋いだなら一覧から外すこと:\n  ${gone.join('\n  ')}`);
});

test('一覧の module が実在する（改名・削除に気づく）', () => {
    for (const rel of PARKED.keys()) {
        assert.ok(existsSync(join(ROOT, rel)), `一覧に在るが実体が無い: ${rel}`);
    }
});

test('覚え書きが空でない（「なぜ」を残す）', () => {
    // **理由の無い一覧は、次に読む人にとって「消してよいか判らない塊」になる。**
    for (const [rel, why] of PARKED) {
        assert.ok(String(why).trim().length >= 15, `覚え書きが短すぎる: ${rel}`);
    }
});

test('動的取り込みも辺として数える', () => {
    // **これを落とすと、実際に動いている面まで「辿れない」に出る。**
    // 実測（2026-08-26）: modelCompanions.js は動的取り込みでしか繋がっていない。
    const { seen } = reachable();
    assert.ok(seen.has('web/core/modelCompanions.js'),
        '動的取り込みを辺にできていない（modelCompanions が辿れていない）');
});

// --- 口（export）単位の棚卸し（2026-08-26）----------------------------------

/**
 * **辿れる module の中で、誰も取り込まない口**と、その覚え書き。
 *
 * module が辿れることと、その中の口が使われていることは別。実機で見つかった
 * `isDownloadResolvable` はまさにこれで、**「1件でも落とせる」ではなく
 * 「打つ手の無い遮断が1件も無い」で判定する**という正しい規則を持っているのに
 * 誰も呼んでいなかった——画面の側は弱い規則のままで、落とし切っても再現
 * できない記録を「落とせば試せる」に出していた。
 *
 * ただし**そのまま繋げばよいとは限らない**。実測（記録 200件）では
 * `isDownloadResolvable` を通すと該当が 0 件になる——`unexplainedReasons` が
 * `reasons` を遮断理由とみなすのに、今の `reasons` には
 * 「A1111互換パーサで解釈します」のような**組み立ての注記**が入るため。
 * だから覚え書きには「繋げば効く」と「今の形では繋げない」を書き分ける。
 *
 * **同じ module の中で使われている口は数えない**（外へ出しているだけで
 * 死んではいない）。
 */
const UNUSED_EXPORTS = new Map([
    ['web/core/civitaiModelLookup.js searchTermFor', '単数形の検索語。複数形の searchTermsFor に置き換わっている。'],
    ['web/core/downloadSizeEstimate.js resetDownloadSizeCache', '控えを捨てる口。検査用に出してあるが、今は誰も呼んでいない。'],
    ['web/core/environment.js hasEnvironment', '環境が据わっているかの述語。呼び手は requireEnvironment / …OrNull を使っている。'],
    ['web/core/modelFileNames.js COMFYUI_SUPPORTED_PT_EXTENSIONS', 'ComfyUI が読む .pt 系の一覧。判定は MODEL_EXTENSION_PATTERN 側で足りている。'],
    ['web/core/pngText.js parseJsonValue', 'PNG のテキストを JSON として読む口。呼び手は自前で try/catch している。'],
    ['web/core/recipeMissingModels.js resetKnownModelCatalogCache', '台帳の控えを捨てる口。台帳は今 not-wired なので出番が無い。'],
    ['web/core/recipeMissingModels.js resetResourceAvailabilityCache', '在庫の控えを捨てる口。上と同じ理由。'],
    ['web/core/recipeMissingModels.js isDownloadResolvable',
     '「落とせば試せる」の正しい規則。**今の形では繋げない**——実測で該当が 0 件になる'
     + '（unexplainedReasons が、組み立ての注記まで遮断理由として数えるため）。'
     + ' 画面側は数えられる方（遮断が1件も無いこと）だけを採っている。'],
    ['web/core/recipeSweep.js estimateSweep', 'Sweep の所要見積り。Sweep の面と対なので、一緒に外れている。'],
    ['web/host/comfyHost.js resetHostCaches', '宿主の控えを捨てる口。判定の側は verdicts.resetInputs を使う。'],
    ['web/panel/civitaiImageId.js extractIdFromFilenameForConfirmationOnly',
     'ファイル名から画像IDらしきものを拾う。名前のとおり**確認用**で、'
     + ' 取り込みの判断には使わない約束になっている（使うと別人の記録を掴む）。'],
]);

/** `web/` の中で、誰も取り込まず、自分の中でも使っていない口。 */
function unusedExports() {
    const { modules, seen } = reachable();
    const text = new Map(modules.map(rel => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    const testDir = join(ROOT, 'tests');
    const testText = readdirSync(testDir)
        .filter(name => name.endsWith('.mjs') || name.endsWith('.js'))
        .map(name => readFileSync(join(testDir, name), 'utf8')).join('\n');
    const namesIn = (body) => {
        const out = new Set();
        for (const m of body.matchAll(/import\s*{([^}]*)}\s*from/g)) {
            for (const raw of m[1].split(',')) {
                const name = raw.trim().split(' as ')[0].trim();
                if (name) out.add(name);
            }
        }
        return out;
    };
    const taken = new Set([...namesIn([...text.values()].join('\n')), ...namesIn(testText)]);
    const dead = [];
    for (const rel of [...seen].sort()) {
        if (rel.includes('/locales/')) continue;
        const body = text.get(rel) || '';
        for (const m of body.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) {
            const name = m[1];
            if (taken.has(name)) continue;
            // **自分の中で使っているなら死んでいない。**（定義の1回だけなら死んでいる）
            // **語境界に \\b を使わない。** 文字列の中では 0x08（後退）になり、
            // 何にも一致しなくなる——数え上げが黙って 0 になり、全部が「死んでいる」に出る。
            const boundary = new RegExp('(?<![A-Za-z0-9_])' + name + '(?![A-Za-z0-9_])', 'g');
            if ((body.match(boundary) || []).length > 1) continue;
            dead.push(`${rel} ${name}`);
        }
    }
    return dead.sort();
}

test('誰も使っていない口は、一覧のとおり', () => {
    const dead = unusedExports();
    assert.ok(dead.length > 0, '数えられていない（検出器が死んでいる）');
    const listed = [...UNUSED_EXPORTS.keys()].sort();
    const added = dead.filter(k => !UNUSED_EXPORTS.has(k));
    const gone = listed.filter(k => !dead.includes(k));
    assert.deepEqual(added, [],
        `誰も使っていない口が増えた。繋ぎ忘れなら繋ぐ、要らないなら消す、残すなら理由つきで一覧へ:\n  ${added.join('\n  ')}`);
    assert.deepEqual(gone, [],
        `一覧に在るのに使われるようになっている。繋いだなら一覧から外すこと:\n  ${gone.join('\n  ')}`);
});

test('口の覚え書きも空でない', () => {
    for (const [key, why] of UNUSED_EXPORTS) {
        assert.ok(String(why).trim().length >= 15, `覚え書きが短すぎる: ${key}`);
    }
});
