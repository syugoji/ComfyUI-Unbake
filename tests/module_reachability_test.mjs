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
    ['web/core/recipeOutputs.js', '出力を /view の URL へ直す。使い手が居ない（2026-08-31: unbake.js は outputUrl.js の1本へ寄せたので、理由の後半は解消済み）。'],
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
 *
 * ---
 *
 * **「検査だけが使っている」を別の区分にした**（2026-08-31・`I-20260831-58`）。
 *
 * ここは長く `tests/` の import も「使っている」に数えており、
 * **製品から死んだ口を、検査の import が隠せた**。実際にそれが起きている——
 * `resetDownloadSizeCache` は下の一覧に「誰も使っていない」として載っていたのに、
 * 新しい検査が1行 import しただけで「使われている」に変わり、
 * **一覧から外す**ことになった（欠陥が消えたわけではないのに）。
 *
 * かといって `tests/` を数えないと、検査のために出してある口が全部赤くなる。
 * だから**2つの一覧に分ける**:
 *
 *   - `UNUSED_EXPORTS`    … 製品も検査も使っていない
 *   - `TEST_ONLY_EXPORTS` … **検査だけ**が使っている（製品からは死んでいる）
 *
 * 後者は「悪い」ではない。**見えることに意味がある**——製品側の呼び手が
 * 消えた口は、検査が触っているあいだ静かにここへ移動してくる。
 */
const UNUSED_EXPORTS = new Map([
    ['web/core/civitaiModelLookup.js searchTermFor', '単数形の検索語。複数形の searchTermsFor に置き換わっている。'],
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

/**
 * **検査だけが使っている口**（製品からは辿れない）。
 *
 * ここに在ること自体は不具合ではない——控えを捨てる口のように、
 * **検査のために出してある**ものが普通に混じる。
 * ただし**製品の呼び手が消えた口も、検査が触っていればここへ入る**ので、
 * 増えたときは「検査用か、繋ぎ忘れか」をその場で判断すること。
 */
const TEST_ONLY_EXPORTS = new Map([
    // -- 検査のために出してある（設計どおり）--------------------------------
    ['web/core/downloadSizeEstimate.js resetDownloadSizeCache',
     '控えを捨てる口。`tests/dormant_candidates_test.mjs` が回ごとに空にするために使う。'
     + ' 製品側は同じプロセスで測り直さないので呼ばない。'],
    ['web/core/environment.js resetEnvironment',
     '据えた環境を捨てる口。**元から「テストの後始末用」と書いてある**（`environment.js`）。'],
    ['web/core/storage.js resetMemoryStorage',
     '揮発の入れ物を空にする口。**元から「テストの後始末用」と書いてある**（`storage.js`）。'],
    ['web/i18n/index.js missingCodes',
     'ある言語に足りない鍵。**元から「（検査用）」と書いてある**——`i18n_test.mjs` が使う。'],
    ['web/i18n/index.js extraCodes',
     'ある言語にしか無い鍵。上と対で、**元から「（検査用）」と書いてある**。'],

    // -- 製品の呼び手が無い（`I-20260831-68` で調べる）----------------------
    //
    // **ここに在るのは「検査用に出した」ではなく「製品から呼ばれなくなった／
    // まだ繋いでいない」もの。** 混ぜて数えていた頃は、検査の import に隠れて
    // 一度も表に出なかった。**繋ぐか消すかは1件ずつの判断**なので、
    // この周では正体を書き留めるだけにする。
    ['web/core/civitaiClient.js folderKindOf',
     '版の種別を置き場の名前へ寄せる。**製品の呼び手が無い**（`I-20260831-68`）。'],
    ['web/core/modelEvidence.js needsEvidenceWarning',
     '同一性の根拠が弱い記録を「1本違えば絵は変わる」として警告する述語。'
     + ' **製品の呼び手が無い**（`I-20260831-68`）——判定の面に出ていない可能性がある。'],
    ['web/core/outputFingerprint.js fingerprintOf',
     '条件を1つの文字列へ畳む口。**製品の呼び手が無い**（`I-20260831-68`）。'],
    ['web/core/recipeLoraOverrides.js hasAnyOverride',
     'この記録に手が入っているかの述語。**製品の呼び手が無い**（`I-20260831-68`）'
     + '——強度のスライダーは 2026-08-22 に配線したが、「手が入っている印」は出ていない。'],
    ['web/core/recipeLoraOverrides.js clearAllOverrides',
     'この記録の手入れを全部消す口。上と対で、**戻す道が画面に無い**（`I-20260831-68`）。'],
    ['web/core/recipeModelUsage.js summarizeRecordModels',
     'この記録が要るモデルを、共有件数の少ない順に並べる。'
     + ' **製品の呼び手が無い**（`I-20260831-68`）。'],
    ['web/core/sweepAxes.js nextUnusedLoraTarget',
     'まだ軸に使っていない LoRA。**軸を足すときの既定の対象**のはずだが、'
     + ' **製品の呼び手が無い**（`I-20260831-68`）。'],
    ['web/core/sweepAxes.js extractPromptPlaceholders',
     'プロンプトの `{差し替え口}` を拾う。**製品の呼び手が無い**（`I-20260831-68`）。'],
    ['web/core/storage.js storageIsVolatile',
     '「この保存はセッション限りである」を呼び手へ知らせる口。'
     + ' **誰も聞いていない**（`I-20260831-68`）——消えることを利用者へ言えていない。'],
    ['web/i18n/index.js getLocale',
     '今の言語。**製品の呼び手が無い**（`I-20260831-68`）。据える側だけが使われている。'],
    ['web/i18n/index.js isReviewed',
     '母語話者の確認を通っているか。「通っていない訳を無いことにしない」ために出してあるが、'
     + ' **製品の呼び手が無い**（`I-20260831-68`）。'],
]);

/**
 * `web/` の口を、**使われ方で3つに分ける**（`I-20260831-58`）。
 *
 * @returns {{dead: string[], testOnly: string[]}}
 *   `dead` は製品も検査も使っていない口、`testOnly` は検査だけが使っている口。
 *   製品が使っている口はどちらにも出ない。
 */
function unusedExports() {
    const { modules, seen } = reachable();
    const text = new Map(modules.map(rel => [rel, readFileSync(join(ROOT, rel), 'utf8')]));
    const testDir = join(ROOT, 'tests');
    const testText = readdirSync(testDir)
        .filter(name => name.endsWith('.mjs') || name.endsWith('.js'))
        .map(name => readFileSync(join(testDir, name), 'utf8')).join('\n');
    /*
     * **取り込みの形は2つある**（`I-20260831-58` の実装中に判明）。
     *
     * ここは長く `import { … } from` しか見ておらず、
     * `const { … } = await import('…')` を**取り込みとして数えていなかった**。
     * 製品と検査を混ぜて数えていた頃は、検査が静的に import していたおかげで
     * 帳尻が合っていて**穴が見えなかった**——分けた瞬間に
     * `modelCompanions.js` の2つが「検査だけが使っている」として出た
     * （実際は `web/unbake.js:506,510` が動的取り込みで使っている）。
     */
    const namesIn = (body) => {
        const out = new Set();
        const add = (list) => {
            for (const raw of list.split(',')) {
                const name = raw.trim().split(' as ')[0].trim();
                if (name) out.add(name);
            }
        };
        for (const m of body.matchAll(/import\s*{([^}]*)}\s*from/g)) add(m[1]);
        // `const { a, b } = await import('…')`
        for (const m of body.matchAll(/(?:const|let|var)\s*{([^}]*)}\s*=\s*(?:await\s+)?import\s*\(/g)) add(m[1]);
        return out;
    };
    // **製品と検査を分けて数える**（`I-20260831-58`）。混ぜると、製品から
    // 死んだ口を検査の import が隠す。
    const takenByProduct = namesIn([...text.values()].join('\n'));
    const takenByTests = namesIn(testText);
    const dead = [];
    const testOnly = [];
    for (const rel of [...seen].sort()) {
        if (rel.includes('/locales/')) continue;
        const body = text.get(rel) || '';
        for (const m of body.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)) {
            const name = m[1];
            if (takenByProduct.has(name)) continue;
            // **自分の中で使っているなら死んでいない。**（定義の1回だけなら死んでいる）
            // **語境界に \\b を使わない。** 文字列の中では 0x08（後退）になり、
            // 何にも一致しなくなる——数え上げが黙って 0 になり、全部が「死んでいる」に出る。
            const boundary = new RegExp('(?<![A-Za-z0-9_])' + name + '(?![A-Za-z0-9_])', 'g');
            if ((body.match(boundary) || []).length > 1) continue;
            (takenByTests.has(name) ? testOnly : dead).push(`${rel} ${name}`);
        }
    }
    return { dead: dead.sort(), testOnly: testOnly.sort() };
}

/** 一覧と実測を突き合わせる（差分の両向きを別々に言う）。 */
function assertMatches(found, listed, label) {
    const declared = [...listed.keys()].sort();
    assert.deepEqual(found.filter(k => !listed.has(k)), [],
        `${label}が増えた。繋ぎ忘れなら繋ぐ、要らないなら消す、残すなら理由つきで一覧へ:\n  `
        + found.filter(k => !listed.has(k)).join('\n  '));
    assert.deepEqual(declared.filter(k => !found.includes(k)), [],
        `一覧に在るのに、そこには居ない。区分が変わったなら一覧を移すこと:\n  `
        + declared.filter(k => !found.includes(k)).join('\n  '));
}

test('誰も使っていない口は、一覧のとおり', () => {
    const { dead } = unusedExports();
    assert.ok(dead.length > 0, '数えられていない（検出器が死んでいる）');
    assertMatches(dead, UNUSED_EXPORTS, '誰も使っていない口');
});

test('検査だけが使っている口は、一覧のとおり', () => {
    /*
     * **製品から死んだ口を、検査の import に隠させない**（`I-20260831-58`）。
     * ここへ増えたら「検査用に出してある」のか「製品の呼び手が消えた」のかを
     * その場で判断する——混ぜていた頃は、後者が**何も言わずに消えて**いた。
     */
    const { testOnly } = unusedExports();
    assertMatches(testOnly, TEST_ONLY_EXPORTS, '検査だけが使っている口');
});

test('区分が重なっていない', () => {
    // **同じ口が2つの一覧に載らない。** 載ると、片方を直しても片方が残る。
    const both = [...UNUSED_EXPORTS.keys()].filter(key => TEST_ONLY_EXPORTS.has(key));
    assert.deepEqual(both, [], `2つの一覧に同じ口が在る: ${both.join(', ')}`);
});

test('口の覚え書きも空でない', () => {
    for (const [key, why] of [...UNUSED_EXPORTS, ...TEST_ONLY_EXPORTS]) {
        assert.ok(String(why).trim().length >= 15, `覚え書きが短すぎる: ${key}`);
    }
});
