/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **発音区別符号が落ちた訳文を、これ以上増やさない**（2026-08-31・走査3周目）。
 *
 * tr / fr / es / pt-BR の文言に、**その言語の字を ASCII へ潰した綴り**が
 * 混ざっていた。`reviewed: false`（母語話者の確認を通っていない）とは別の話で、
 * これは**訳の良し悪しではなく、字が落ちている**という機械的な欠陥である:
 *
 *     es  `pestana`   → **`pestaña`**（前者は「まつげ」＝**別語**）
 *     tr  `dugum`     → **`düğüm`** ／ `uc` → `üç`（**別語**）
 *     pt  `Nao`       → **`Não`** ／ `possivel` → `possível`
 *     fr  `deja`      → **`déjà`** ／ `lateral` → `latéral`
 *
 * **同じファイルの中で正しい文言と混ざっている**（fr は `modèle` と `lateral`
 * が隣り合う）。鍵の接頭辞もばらけているので、一括の取り込み事故ではなく
 * **1件ずつそう書かれた**——だから機械で見張る。
 *
 * ## 直せる分は直した／直せない分はここに並べる
 *
 * 25件は語を戻した。**半端に直した文言は残していない**——1つの文言の中に
 * 直せない綴りが1つでも残るなら、その文言は元へ戻してある
 * （`süzgece … suzgeci` のように同じ文で揺れるほうが読みにくい）。
 *
 * 残る 23件は下に並べてある。**母語話者の目が要る**ので、ここでは直さない
 * （`I-20260831-74`）。**この一覧は増やさない**——増えたらこの検査が赤くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **その綴りで現れたら符号が落ちている**と言い切れる語だけ。
 *
 * 正しい形が一意で、かつその言語の普通の語と重ならないものに限る。
 * 「符号が無くても正しい文」を赤くしないため、**語を増やすときは
 * 辞書で確かめること**。
 */
const STRIPPED = {
    tr: ['dugum', 'yuzden', 'varsayilan', 'goruntu', 'seridi', 'suzge', 'sari',
         'kapali', 'kararin', 'kalabalik', 'isaretler', 'degistir', 'baglanti',
         'calistir', 'yukleyici', 'acildi', 'gomulu', 'gercekten', 'agacinin',
         'klasorunun', 'ornek', 'uretilmis', 'birlestir', 'dogrudan', 'yazildi'],
    fr: ['deja', 'apres', 'lateral', 'genere', 'chaines', 'noeud', 'ete',
         'demandes', 'etait'],
    es: ['pestana', 'tambien', 'segun', 'tamano', 'configuracion', 'imagenes',
         'informacion', 'numero', 'despues'],
    'pt-BR': ['nao', 'possivel', 'entao', 'tambem', 'configuracao', 'versao',
              'padrao', 'informacao', 'grafico'],
};

/**
 * **まだ直っていない文言。** 母語話者の目が要るもの（`I-20260831-74`）。
 *
 * `core.recipeWorkflowBuilder.*` に固まっているのが手掛かり——
 * **3言語とも同じ3つの鍵**が落ちているので、その回に書いた分だと判る。
 */
const KNOWN_STRIPPED = {
    tr: [
        'core.recipeWorkflowBuilder.sizeFromGraph',
        'core.recipeWorkflowBuilder.powerLora',
        'core.recipeWorkflowBuilder.joinString',
        'settings.downloadRoot.help',
        'tile.needsNode',
        'nodes.mappingFailed',
        'replay.alreadyMade.quiet',
        'settings.extraBands.help',
    ],
    fr: [
        'core.recipeWorkflowBuilder.sizeFromGraph',
        'core.recipeWorkflowBuilder.powerLora',
        'core.recipeWorkflowBuilder.joinString',
        'tile.needsNode',
        'tile.needsNode.install',
        'download.recheck',
        'download.lookupBusy',
        'replay.alreadyMade',
        'filter.needsNode',
    ],
    es: [],
    'pt-BR': [
        'core.recipeWorkflowBuilder.sizeFromGraph',
        'settings.downloadRoot.help',
        'replay.none',
        'nodes.missing.help',
        'settings.extraBands',
        'settings.extraBands.help',
    ],
};

const LETTER = 'a-zà-ÿşğıçöü';

async function offendersIn(code) {
    const text = await readFile(join(ROOT, 'web/i18n/locales', `${code}.js`), 'utf8');
    const found = [];
    for (const line of text.split(/\r?\n/)) {
        const match = /^\s*"([^"]+)"\s*:\s*"(.*)",?\s*$/.exec(line);
        if (!match) continue;
        const [, key, value] = match;
        const lowered = value.toLowerCase();
        const hit = STRIPPED[code].filter(word =>
            new RegExp(`(?<![${LETTER}])${word}(?![${LETTER}])`).test(lowered));
        if (hit.length) found.push(key);
    }
    return found;
}

test('符号の落ちた文言を数えられている（検出器の生死）', async () => {
    // **0件を合格と読まない。** 当て方が壊れると全言語が素通りする。
    const declared = Object.values(KNOWN_STRIPPED).flat().length;
    assert.ok(declared >= 20, `一覧が痩せている（${declared}）`);
    const tr = await offendersIn('tr');
    assert.ok(tr.length > 0, 'tr で1件も拾えていない＝当て方が壊れている');
});

for (const code of Object.keys(STRIPPED)) {
    test(`符号の落ちた文言が増えていない（${code}）`, async () => {
        const found = await offendersIn(code);
        const known = new Set(KNOWN_STRIPPED[code]);
        const added = found.filter(key => !known.has(key));
        assert.deepEqual(added, [],
            `${code}: その言語の字を ASCII へ潰した文言が増えた。`
            + `**直すか、直せないなら KNOWN_STRIPPED へ理由つきで足すこと**:\n  `
            + added.join('\n  '));
    });

    test(`直った文言が一覧に残っていない（${code}）`, async () => {
        // **一覧が腐らないようにする。** 直したのに載ったままだと、
        // 次に同じ鍵が落ちても「既知」として素通りする。
        const found = new Set(await offendersIn(code));
        const gone = KNOWN_STRIPPED[code].filter(key => !found.has(key));
        assert.deepEqual(gone, [],
            `${code}: 直っているのに一覧に残っている（外すこと）:\n  ${gone.join('\n  ')}`);
    });
}

test('直した文言に、直し残しが混ざっていない', async () => {
    /*
     * **半端な文言を作らない。** 1つの文言の中で `süzgece … suzgeci` のように
     * 揺れると、一様に落ちているより読みにくい。だから
     * 「その文言の綴りを全部戻せるときだけ直す」で通してある——
     * 一覧に無い文言は、**1つも落ちていない**はずである。
     */
    for (const code of Object.keys(STRIPPED)) {
        const found = await offendersIn(code);
        const known = new Set(KNOWN_STRIPPED[code]);
        assert.deepEqual(found.filter(key => !known.has(key)), [],
            `${code}: 一覧の外に落ちている文言が在る`);
    }
});
