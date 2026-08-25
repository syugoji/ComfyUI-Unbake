/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 多言語化。**訳の抜けは「静かに壊れる」種類**なので、検査で押さえる。
 *
 * 抜けたときに起きるのは例外ではなく、**その行だけ別の言語になる**ことである。
 * 開発者は自分の言語で見ているので気づかない。だからここで:
 *
 *   1. 全カタログの**鍵集合が完全に一致**すること（不足も余りも赤くする）
 *   2. 画面のコードが使う鍵が**全部カタログに在る**こと
 *   3. 差し込み `{name}` が**言語間で食い違わない**こと
 *   4. まだ訳していない日本語が**どれだけ残っているかを数える**（ラチェット）
 *
 * 4 が要るのは、`web/core/` に日本語の文言が164件残っているからで、
 * **「多言語対応した」と言いながら中核が日本語のまま**という状態を隠さないため。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CATALOGS,
    DEFAULT_LOCALE,
    LOCALE_META,
    extraCodes,
    getDirection,
    getLocale,
    isReviewed,
    missingCodes,
    resolveLocale,
    setLocale,
    t,
} from '../web/i18n/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JAPANESE = /[぀-ゟ゠-ヿ一-鿿]/;

async function filesUnder(dir, exts) {
    const out = [];
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name === '__pycache__' || e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) out.push(...await filesUnder(p, exts));
        else if (exts.some(x => e.name.endsWith(x))) out.push(p);
    }
    return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');

/**
 * コメントを落とす。**走査はコードだけを見る。**
 *
 * これを怠って一度踏んだ——「鍵を組み立てて書いてはいけない」という**説明文そのもの**を
 * 鍵の走査が拾い、その断片を「カタログに無い鍵」として赤くしていた。
 * **自分の説明で鳴る検査は 0 にならない。**
 */
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** コメントを落として、**文字列リテラルの中の日本語**だけ数える。 */
function japaneseLiterals(source) {
    const text = stripComments(source);
    const literals = [...text.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)]
        .map(m => m[1] ?? m[2] ?? m[3]);
    return literals.filter(v => v && JAPANESE.test(v));
}

test('既定は英語である（母数をここで切らない）', () => {
    // 発見経路は ComfyUI Manager。最初に読まれるのは英語で、
    // 日本語を既定にすると**その時点で読者が減る**。
    assert.equal(DEFAULT_LOCALE, 'en');
    setLocale(null);
    assert.equal(getLocale(), 'en');
    assert.equal(t('list.empty'), CATALOGS.en['list.empty']);
});

test('宿主の言語表記をカタログへ落とせる', () => {
    assert.equal(resolveLocale('ja'), 'ja');
    assert.equal(resolveLocale('ja-JP'), 'ja', '地域つきを落とせていない');
    assert.equal(resolveLocale('JA_jp'), 'ja');
    assert.equal(resolveLocale('zh-CN'), 'zh', '簡体字が中国語へ落ちていない');
    assert.equal(resolveLocale(''), 'en');
    assert.equal(resolveLocale(undefined), 'en');
    assert.equal(resolveLocale('xx'), 'en', '持っていない言語は既定へ');
    // **地域つきを先に見る。** `zh-TW` を `zh` へ落とすと繁体字の利用者が簡体字を読む。
    assert.equal(resolveLocale('zh-TW'), 'zh-TW');
    assert.equal(resolveLocale('pt-BR'), 'pt-BR');
    assert.equal(resolveLocale('pt'), 'en', 'pt 単独は持っていないので既定へ');
});

/**
 * **宿主が選べる12言語。** 実測（2026-08-20・ComfyUI frontend v1.42.15 の
 * `Comfy.Locale` の選択肢）。**持っていない言語の利用者は英語へ落ちる**ので、
 * ここが減ったら気づけるようにしておく。
 */
const HOST_LOCALES = ['en', 'zh', 'zh-TW', 'ru', 'ja', 'ko', 'fr', 'es', 'ar', 'tr', 'pt-BR', 'fa'];

test('宿主が選べる言語をすべて持っている', () => {
    const have = Object.keys(CATALOGS);
    assert.deepEqual(HOST_LOCALES.filter(l => !have.includes(l)), [],
        '宿主で選べるのに持っていない言語がある＝その利用者は英語へ落ちる');
    // 持っていても宿主から選べない言語は届かない（無駄に保守することになる）。
    assert.deepEqual(have.filter(l => !HOST_LOCALES.includes(l)), [],
        '宿主から選べない言語を持っている');
});

test('右横書きの言語に書字方向が付いている', () => {
    // **アラビア語とペルシア語は右から左。** CSS は論理方向で書いてあるので
    // `dir` を立てるだけで反転する。ここが抜けると帯も余白も逆側に出る。
    assert.equal(getDirection('ar'), 'rtl');
    assert.equal(getDirection('fa'), 'rtl');
    for (const locale of Object.keys(CATALOGS)) {
        if (locale === 'ar' || locale === 'fa') continue;
        assert.equal(getDirection(locale), 'ltr', locale);
    }
});

/**
 * 物理指定が「独り」で立っているか（＝直後に対応する論理指定が続かないか）。
 *
 * **順番が仕掛け。** 物理を先・論理を後に書けば、論理を読める実装では論理が
 * 勝つ（RTL で正しい）。読めない実装には物理が残る——そこは左横書きでだけ
 * 正しいが、**その実装では RTL はもとより崩れている。**
 */
function orphanPhysical(css) {
    const PHYSICAL = /\b(margin|padding|border)-(left|right)(-[a-z]+)?\s*:/g;
    const LOGICAL = { left: 'inline-start', right: 'inline-end' };
    const found = [];
    for (const match of css.matchAll(PHYSICAL)) {
        const [, group, side, suffix = ''] = match;
        const after = css.slice(match.index + match[0].length);
        const wanted = new RegExp('^[^;]*;\\s*' + group + '-' + LOGICAL[side] + suffix + '\\s*:');
        if (!wanted.test(after)) found.push(match[0].trim());
    }
    return found;
}

/** 後退先の物理指定が前に無い論理指定（＝当ててこない実装で黙って消えるもの）。 */
function orphanLogical(css) {
    const LOGICAL = /\b(margin|padding|border)-inline-(start|end)((?:-[a-z]+)?)\s*:/g;
    const PHYSICAL = { start: 'left', end: 'right' };
    const found = [];
    for (const match of css.matchAll(LOGICAL)) {
        const [, group, side, suffix = ''] = match;
        const before = css.slice(0, match.index);
        const wanted = new RegExp(
            group + '-' + PHYSICAL[side] + suffix + '\\s*:[^;]*;\\s*$');
        if (!wanted.test(before)) found.push(match[0].trim());
    }
    return found;
}

test('物理方向の CSS は、論理の後退先としてしか書かない（RTL で崩れないこと）', async () => {
    // `margin-left` などを単独で書くと、その1行のためだけに言語ごとの分岐が生える。
    //
    // **ただし後退先としては要る**（2026-08-23）。論理プロパティを当ててこない
    // 実装が実在し、`border-inline-start: 3px solid …` が**太さごと**無視されて
    // 色帯が 1px のままだった（実測 `borderLeftWidth: 0.8px` ＝ 表示80% × 1px。
    // 色の後退先を入れた後も直らなかったので、色ではなく論理指定の側だと判った）。
    const css = await readFile(join(ROOT, 'web/panel/theme.css'), 'utf8')
        .then(text => text.replace(/\/\*[\s\S]*?\*\//g, ' '));

    assert.deepEqual(orphanPhysical(css), [],
        '論理の指定が後ろに無い物理指定が在る（RTL で崩れる）');

    // **逆向きも見る。** 後退先の無い論理指定は、当ててこない実装で黙って
    // 消える——**それが今回の不具合そのもの**だった。片側だけ見張っていると、
    // 後退先を消す変更が素通りする（実際に素通りした）。
    assert.deepEqual(orphanLogical(css), [],
        '物理の後退先が前に無い論理指定が在る（当ててこない実装で消える）');

    assert.doesNotMatch(css, /text-align:\s*(?:left|right)\b/, 'text-align は start/end で書く');

    // **検出器が生きていること。** 対になっていないものを拾えること。
    assert.equal(orphanPhysical('a { margin-left: 3px; }').length, 1,
        '独りの物理指定を拾えていない');
    assert.equal(
        orphanPhysical('a { border-left-width: 3px; border-inline-start-width: 3px; }').length, 0,
        '対になっている後退先まで拾っている');
    assert.equal(orphanPhysical('a { border-left-width: 3px; color: red; }').length, 1,
        '別の指定が続いているのに対と見なしている');
});

test('母語話者の確認を通っていない訳が、そうと分かる', () => {
    // **通っていない訳を「無い」ことにしない。** 訂正を受けるために所在を明示する。
    assert.equal(isReviewed('en'), true);
    assert.equal(isReviewed('ja'), true);
    const unreviewed = Object.keys(CATALOGS).filter(l => !isReviewed(l));
    assert.ok(unreviewed.length > 0, '未確認の印がどこにも無い＝印の仕組みが死んでいる');
    for (const locale of Object.keys(CATALOGS)) {
        assert.equal(typeof LOCALE_META[locale]?.name, 'string', locale + ': 表示名が無い');
        assert.equal(typeof LOCALE_META[locale]?.reviewed, 'boolean', locale + ': reviewed が無い');
    }
});

test('全カタログの鍵が完全に一致する（不足も余りも赤くする）', () => {
    const locales = Object.keys(CATALOGS);
    assert.ok(locales.length >= 2, '言語が1つしかない＝多言語の検査になっていない');
    const problems = [];
    for (const locale of locales) {
        for (const code of missingCodes(locale)) problems.push(`${locale}: 不足 ${code}`);
        for (const code of extraCodes(locale)) problems.push(`${locale}: 余り ${code}`);
    }
    assert.deepEqual(problems, [], '訳の抜けや消し忘れがある');
});

test('差し込みの名前が言語間で食い違わない', () => {
    // `{total}` を片方の言語で `{count}` と書くと、**その言語でだけ数字が消える。**
    const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    const problems = [];
    for (const [code, template] of Object.entries(CATALOGS[DEFAULT_LOCALE])) {
        const base = names(template).join(',');
        for (const locale of Object.keys(CATALOGS)) {
            if (locale === DEFAULT_LOCALE) continue;
            const other = names(CATALOGS[locale][code] ?? '').join(',');
            if (other !== base) problems.push(`${code}: ${DEFAULT_LOCALE}=[${base}] ${locale}=[${other}]`);
        }
    }
    assert.deepEqual(problems, [], '差し込みの名前が言語で食い違っている');
});

test('外向きの3語はどの言語でも訳さない', () => {
    // 製品の語彙であって文章ではない。訳すと**同じ道具を使う人どうしで話が通じなくなる。**
    for (const locale of Object.keys(CATALOGS)) {
        assert.equal(CATALOGS[locale]['column.record.long'], 'Generation Record', locale);
        assert.equal(CATALOGS[locale]['column.manifest.long'], 'Replay Manifest', locale);
        assert.equal(CATALOGS[locale]['column.sweep'], 'Sweep', locale);
    }
});

test('押したボタンの語と、その後に出る文の語が揃っている', () => {
    // **押すと「再現しています…」と出るボタンが「再生」と書いてあった**（2026-08-24 に是正）。
    // 同じ操作を2つの語で呼ぶと、**画面のどこを読んでも同じ物だと確信できない。**
    //
    // 見るのは**同じ言語の中での揃い**であって、言語間の一致ではない
    // （`en`=Replay / `ko`=재현 のように、各言語内で整合していればよい）。
    // 判定は「進行中の文に出てくる語幹が、ボタンにも出ているか」。
    //
    // **写しの口でも同じことが起きていた**（2026-08-24 是正）——ボタンが「写す」で、
    // 押した後が「写しました。」。語は揃っていたが**利用者の語彙と違った**ので
    // 「コピー」へ改めた。**揃いだけを見て、どの語を選ぶかは決めない。**
    const FAMILIES = [
        { button: 'replay.one', after: 'replay.running',
          stems: { ja: '再現', ko: '재현', zh: '重现', 'zh-TW': '重現' } },
        { button: 'donate.copy', after: 'donate.copied',
          stems: { ja: 'コピー', en: 'Cop', ko: '복사', zh: '复制', 'zh-TW': '複製' } },
    ];
    const problems = [];
    for (const { button, after, stems } of FAMILIES) {
        for (const [locale, stem] of Object.entries(stems)) {
            const catalogue = CATALOGS[locale];
            if (!catalogue) { problems.push(`${locale}: カタログが無い`); continue; }
            // 検出器が生きているか——後の文にその語が無いなら、前提の方が動いている。
            if (!String(catalogue[after] || '').includes(stem)) {
                problems.push(`${locale}/${after}: 「${stem}」が無い（前提が変わった）`);
                continue;
            }
            if (!String(catalogue[button] || '').includes(stem)) {
                problems.push(`${locale}/${button}: 「${stem}」で書かれていない（${catalogue[button]}）`);
            }
        }
    }
    assert.deepEqual(problems, [], '同じ操作が2つの語で呼ばれている');
});

test('画面のコードが使う鍵は全部カタログに在る', async () => {
    // **`[code]` が画面に出るのを事前に止める。** 実行して初めて分かる形にしない。
    const files = [
        ...await filesUnder(join(ROOT, 'web/panel'), ['.js']),
        join(ROOT, 'web/unbake.js'),
    ];
    /** `t('…')` へ直接渡された鍵。**カタログに無ければ画面に `[code]` が出る。** */
    const passedToT = new Set();
    /** 鍵として書かれている文字列すべて（表に入れて間接的に使う形も拾う）。 */
    const referenced = new Set();
    const catalogue = CATALOGS[DEFAULT_LOCALE];

    for (const f of files) {
        // **コメントを落としてから拾う。** 落とさないと、悪い例として書いた
        // 説明文の断片がそのまま「使われている鍵」として拾われる。
        const text = stripComments(await readFile(f, 'utf8'));
        for (const m of text.matchAll(/\bt\(\s*'([^']+)'/g)) passedToT.add(m[1]);
        // 鍵を表へ入れて引く形（`VERDICT_CODES`）も使われているものとして数える。
        // **直接 `t()` へ渡すことだけを「使用」と数えると、間接参照が未使用に見える。**
        for (const m of text.matchAll(/'([a-z][\w.]*\.[\w.]+)'/g)) {
            if (Object.hasOwn(catalogue, m[1])) referenced.add(m[1]);
        }
    }

    assert.ok(passedToT.size >= 15, `t() へ渡している鍵が少なすぎる（${passedToT.size}）＝走査が壊れている`);
    const unknown = [...passedToT].filter(code => !Object.hasOwn(catalogue, code));
    // **組み立てた鍵は「不明な鍵」として赤くなる。** それでよい——
    // 鍵を文字列連結で作る形は機械で確かめられないので、literal で書き直させる。
    assert.deepEqual(unknown, [], 'カタログに無い鍵、または組み立てた鍵を画面が使っている');

    // **表へ入れて引く鍵も見る。** `t(field.label)` の形で使う鍵は
    // `t('…')` の走査に映らないので、**足し忘れると `[settings.foo]` が
    // 画面に出るまで気づけない**（実際に12個まとめて足し忘れた）。
    // ここは「鍵らしい形の文字列」を拾って、名前空間が既知のものだけを見る。
    const NAMESPACES = new Set(['app', 'mode', 'drop', 'filter', 'column', 'verdict',
        'list', 'log', 'reason', 'sweep', 'settings', 'host', 'core']);
    const tableKeys = new Set();
    for (const f of files) {
        const text = stripComments(await readFile(f, 'utf8'));
        for (const m of text.matchAll(/'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)'/g)) {
            const [namespace] = m[1].split('.');
            if (NAMESPACES.has(namespace)) tableKeys.add(m[1]);
        }
    }
    assert.ok(tableKeys.size >= 30, `鍵らしい文字列を拾えていない（${tableKeys.size}）`);
    const missingTableKeys = [...tableKeys].filter(code => !Object.hasOwn(catalogue, code));
    assert.deepEqual(missingTableKeys, [],
        `表から引く鍵がカタログに無い（画面に [鍵] が出る）: ${missingTableKeys.join(', ')}`);

    // 判定の8鍵が literal で書かれていること（連結へ戻ったら気づけるように）。
    for (const key of ['reproducible', 'approximate', 'blocked', 'pending']) {
        assert.ok(referenced.has(`verdict.${key}.long`), `verdict.${key}.long が literal で書かれていない`);
        assert.ok(referenced.has(`verdict.${key}.short`), `verdict.${key}.short が literal で書かれていない`);
    }
});

test('未訳の鍵は黙って消さず、鍵のまま見せる', () => {
    setLocale('en');
    assert.equal(t('does.not.exist'), '[does.not.exist]');
    // 値の無い差し込みも消さない（消すと「文言が変」でなく「情報が消えた」形で壊れる）。
    assert.match(t('list.noMatch', {}), /\{total\}/);
    assert.doesNotMatch(t('list.noMatch', { total: 7 }), /\{total\}/);
});

test('画面の層に日本語のべた書きが残っていない', async () => {
    // 開発者向けの例外文は英語にしてあるので、ここは0でなければならない。
    const files = [
        ...await filesUnder(join(ROOT, 'web/panel'), ['.js']),
        join(ROOT, 'web/unbake.js'),
        ...await filesUnder(join(ROOT, 'web/host'), ['.js']),
    ];
    const offenders = [];
    for (const f of files) {
        const found = japaneseLiterals(await readFile(f, 'utf8'));
        if (found.length) offenders.push(`${rel(f)}: ${found.length}件 例=${JSON.stringify(found[0])}`);
    }
    assert.deepEqual(offenders, [], '画面の層に訳せない文言が残っている');
});

/**
 * **中核の文言も鍵へ移し終えた。**
 *
 * 145件を機械で写し、実データ346レシピ・13,251件の文言を通した前後比較で
 * **日本語側が1件も変わっていない**ことを確かめてある（それが移し替えの正しさの根拠）。
 *
 * ここで固定するのは「戻っていないこと」。**べた書きが1件でも戻ったら赤くする。**
 */
test('中核に日本語のべた書きが残っていない', async () => {
    const files = await filesUnder(join(ROOT, 'web/core'), ['.js']);
    assert.ok(files.length >= 15, `走査が壊れている（${files.length}件）`);
    const offenders = [];
    for (const f of files) {
        const found = japaneseLiterals(await readFile(f, 'utf8'));
        if (found.length) offenders.push(`${rel(f)}: ${found.length}件 例=${JSON.stringify(found[0])}`);
    }
    assert.deepEqual(offenders, [], '中核に訳せない文言が戻っている');
});

test('エスケープで書かれた日本語も見逃さない', async () => {
    // **これで1件取りこぼした。** `生成…` と書かれた文言は、日本語の文字を探す走査に
    // 引っかからない。数え自体が過少になり、「移し終えた」という結論が誤りになる。
    const files = [
        ...await filesUnder(join(ROOT, 'web/core'), ['.js']),
        ...await filesUnder(join(ROOT, 'web/panel'), ['.js']),
        ...await filesUnder(join(ROOT, 'web/host'), ['.js']),
    ];
    // 正規表現は文字列から組む。**この検査自身がエスケープで壊れた**ので、
    // 逆スラッシュが道具を通るたびに化ける形を避ける。
    const BS = String.fromCharCode(92);
    const ESCAPE = new RegExp(BS + BS + 'u([0-9a-fA-F]{4})', 'g');
    const HAS_ESCAPE = new RegExp(BS + BS + 'u[0-9a-fA-F]{4}');
    const LITERAL = new RegExp(
        "'((?:[^'" + BS + BS + BS + "n]|" + BS + BS + '.)*)' + "'"
        + '|"((?:[^"' + BS + BS + BS + 'n]|' + BS + BS + '.)*)"',
        'g',
    );

    const decode = (s) => s.replace(ESCAPE, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const offenders = [];
    for (const f of files) {
        const text = stripComments(await readFile(f, 'utf8'));
        const literals = [...text.matchAll(LITERAL)].map(m => m[1] ?? m[2]).filter(Boolean);
        for (const lit of literals) {
            if (HAS_ESCAPE.test(lit) && JAPANESE.test(decode(lit))) {
                offenders.push(`${rel(f)}: ${JSON.stringify(decode(lit)).slice(0, 60)}`);
            }
        }
    }
    assert.deepEqual(offenders, [], 'エスケープで書かれた日本語が残っている');

    // **検査が発火することを示す。** 見つからなければ緑、の形なので。
    const sample = BS + 'u751f' + BS + 'u6210';
    assert.equal(HAS_ESCAPE.test(sample), true);
    assert.equal(JAPANESE.test(decode(sample)), true, '判定式がエスケープを実体へ戻せていない');
});

test('文へ差し込む値も訳されている（断片が日本語で残らない）', () => {
    // **文だけ訳して安心しない。** `join('・')` や `?? '不明'` のような断片は、
    // 英語の文の中に日本語で残る。実際に7箇所あった。
    setLocale('en');
    assert.equal(t('core.sep.list'), ', ');
    assert.equal(t('core.value.unknown'), 'unknown');
    assert.doesNotMatch(t('core.fragment.strength', { p1: 0.8 }), JAPANESE);
    setLocale('ja');
    assert.equal(t('core.sep.list'), '・');
    assert.equal(t('core.value.unknown'), '不明');
    setLocale('en');
});

test('助詞で変わる文は断片ではなく文ごと分かれている', () => {
    // 助詞の位置は言語で違うので、`{p1}の記録` のような差し替えでは組めない。
    for (const locale of Object.keys(CATALOGS)) {
        assert.ok(CATALOGS[locale]['core.recipeWorkflowBuilder.82'], `${locale}: 記録あり版が無い`);
        assert.ok(CATALOGS[locale]['core.recipeWorkflowBuilder.83'], `${locale}: 推定版が無い`);
        assert.ok(!CATALOGS[locale]['core.recipeWorkflowBuilder.57'], `${locale}: 断片版が残っている`);
    }
});
