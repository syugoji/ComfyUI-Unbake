/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * テーマの**外し方**そのものを確かめる（2026-08-25 利用者の指示
 * 「撤去も簡単に行えるようにしてください」）。
 *
 * **手順書は腐る。** 足す場所が増えた日に、手順書だけが古くなる
 * ——外した気になって名簿や訳語が残り、「選べるのに何も起きないテーマ」ができる。
 * だから外し方を道具として持ち、ここで**実際に外して**確かめる。
 *
 * 本物の木は触らない。**要るファイルだけを写した小さな木**を組んで、そこで外す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPlan, planRemoval } from '../tools/remove-skin.mjs';
import { SKINS } from '../web/panel/skin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 外す相手は**名簿から取る**。
 *
 * 名前を書き込んでいたら、**この道具を実際に使った日に検査が落ちた**
 * （2026-08-25: `vinyl` を外して全体を回したら、製品は緑のままで
 * ここだけが「vinyl が無い」で赤くなった）。外し方の検査が、
 * **外す操作そのものに耐えられない**のはおかしい。
 */
const TARGET = SKINS.find(skin => skin !== 'classic') || null;

/** 本物と同じ形の、小さな木を作る。 */
function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unbake-remove-'));
    fs.mkdirSync(path.join(dir, 'web/panel'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'web/i18n/locales'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'web/panel/skin.js'), path.join(dir, 'web/panel/skin.js'));
    for (const skin of SKINS.filter(name => name !== 'classic')) {
        const from = path.join(ROOT, 'web/panel', `skin-${skin}.css`);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, 'web/panel', `skin-${skin}.css`));
    }
    // 訳語は2つで足りる（**改行の違う2本**を選ぶ——壊し方が改行で変わる）。
    for (const name of ['ja.js', 'en.js']) {
        fs.copyFileSync(path.join(ROOT, 'web/i18n/locales', name),
            path.join(dir, 'web/i18n/locales', name));
    }
    return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

test('外すと、紙・名簿・訳語の3つとも消える', (t) => {
    if (!TARGET) { t.skip('テーマ1しか残っていない'); return; }
    const dir = sandbox();
    const sheet = path.join(dir, 'web/panel', `skin-${TARGET}.css`);
    assert.ok(read(dir, 'web/panel/skin.js').includes(`'${TARGET}'`), '前提が崩れている（名簿に無い）');

    const plan = planRemoval(dir, TARGET);
    assert.equal(plan.ok, true, plan.reason || '');
    // **見るだけでは何も変わらない。**
    assert.ok(fs.existsSync(sheet), '見ただけで消えている');

    applyPlan(plan);
    assert.equal(fs.existsSync(sheet), false, '紙が残っている');
    const after = read(dir, 'web/panel/skin.js');
    assert.ok(!after.includes(`'${TARGET}'`), '名簿に残っている');
    for (const locale of ['ja.js', 'en.js']) {
        assert.ok(!read(dir, `web/i18n/locales/${locale}`).includes(`settings.uiSkin.${TARGET}`),
            `${locale} に訳語が残っている`);
    }
});

test('外しても、残りのテーマは1つも欠けない', (t) => {
    // **巻き添えを出さない。** 名前の一部が重なる訳語や紙を消してはいけない。
    if (!TARGET) { t.skip('テーマ1しか残っていない'); return; }
    const dir = sandbox();
    applyPlan(planRemoval(dir, TARGET));

    const after = read(dir, 'web/panel/skin.js');
    const ja = read(dir, 'web/i18n/locales/ja.js');
    for (const kept of SKINS.filter(skin => skin !== TARGET)) {
        assert.ok(after.includes(`'${kept}'`), `${kept} まで名簿から消えている`);
        assert.ok(ja.includes(`settings.uiSkin.${kept}`), `${kept} の訳語まで消えている`);
        if (kept === 'classic') continue;
        assert.ok(fs.existsSync(path.join(dir, 'web/panel', `skin-${kept}.css`)),
            `${kept} の紙まで消えている`);
    }
    // **設定の項目そのものは残す**（他のテーマを選ぶ口が消えると詰む）。
    assert.ok(ja.includes('"settings.uiSkin":'), '設定の項目名まで消えている');
});

test('名前が頭から重なる別の鍵を、巻き添えにしない', (t) => {
    // **`vinyl` を外して `vinyl2` まで消えたら、生きているテーマが黙って壊れる。**
    // 行の頭で一致を見ているか（含んでいるだけで消していないか）をここで固定する。
    if (!TARGET) { t.skip('テーマ1しか残っていない'); return; }
    const dir = sandbox();
    const localePath = path.join(dir, 'web/i18n/locales/ja.js');
    const text = fs.readFileSync(localePath, 'utf8');
    // **改行はコードで作る**（この木は CRLF と LF が混在している）。
    const CRLF = String.fromCharCode(13, 10);
    const nl = text.indexOf(CRLF) >= 0 ? CRLF : String.fromCharCode(10);
    const line = `    "settings.uiSkin.${TARGET}":`;
    assert.ok(text.indexOf(line) >= 0, '前提が崩れている（訳語の行が無い）');
    // 頭が重なる別の鍵と、その名前に触れた注釈を1行ずつ足す。
    const decoy = `    "settings.uiSkin.${TARGET}2": "巻き添えにしてはいけない",`;
    const note = `    // settings.uiSkin.${TARGET} のことを書いた注釈`;
    fs.writeFileSync(localePath, text.replace(line, decoy + nl + note + nl + line), 'utf8');

    applyPlan(planRemoval(dir, TARGET));
    const after = fs.readFileSync(localePath, 'utf8');
    assert.ok(after.indexOf(line) < 0, '外す相手が残っている');
    assert.ok(after.indexOf(decoy) >= 0, '頭が重なる別の鍵を巻き添えにした');
    assert.ok(after.indexOf(note) >= 0, '注釈まで消している');
});

test('全部外しても、テーマ1だけは残って面が出る', () => {
    const dir = sandbox();
    for (const skin of SKINS.filter(name => name !== 'classic')) applyPlan(planRemoval(dir, skin));
    const after = read(dir, 'web/panel/skin.js');
    // **戻り先が残ること。** ここが畳めていないと、外した後に面が出ない。
    const listed = after.match(/export const SKINS = \[[^\]]*\];/);
    assert.ok(listed, '名簿を読めない');
    assert.equal(listed[0], "export const SKINS = ['classic'];",
        '名簿が畳めていない: ' + listed[0]);
    const sheets = fs.readdirSync(path.join(dir, 'web/panel')).filter(name => name.startsWith('skin-'));
    assert.deepEqual(sheets, [], '紙が残っている: ' + sheets.join(','));
});

test('テーマ1は外せない（戻り先が消える）', () => {
    const dir = sandbox();
    const plan = planRemoval(dir, 'classic');
    assert.equal(plan.ok, false);
    assert.match(String(plan.reason), /classic/);
    assert.ok(fs.existsSync(path.join(dir, 'web/panel/skin.js')));
});

test('綴り違いは、黙って成功にしない', () => {
    // **「外した」と言われて何も外れていない**のが一番困る。
    const dir = sandbox();
    const plan = planRemoval(dir, (TARGET || 'prism') + 'e');
    assert.equal(plan.ok, false);
    assert.match(String(plan.reason), /名簿にも紙にも無い/);
});

test('改行の種類を変えない（外した後の差分が全行にならない）', (t) => {
    if (!TARGET) { t.skip('テーマ1しか残っていない'); return; }
    const dir = sandbox();
    const target = 'web/i18n/locales/ja.js';
    const CRLF = String.fromCharCode(13, 10);
    const count = (text) => text.split(CRLF).length - 1;
    const before = count(read(dir, target));
    applyPlan(planRemoval(dir, TARGET));
    const after = count(read(dir, target));
    if (before === 0) {
        assert.equal(after, 0, '無かった CRLF を持ち込んでいる');
    } else {
        // 消した1行分だけ減る。
        assert.equal(after, before - 1, '改行を書き換えている（' + before + ' → ' + after + '）');
    }
});

test('機械で外せない跡を、黙って残さない（`I-20260831-44`）', (t) => {
    if (!TARGET) { t.skip('テーマ1しか残っていない'); return; }
    /*
     * `settings.uiSkin.help` の説明文は**12言語すべてが各テーマの表示名を
     * 本文に含む**。自由文なので機械が安全に切り取れない——だから
     * **消せないことを名指しで出す**。黙って残すと「跡を残さない」が嘘になり、
     * 次にテーマを足す人が古い名前を見る。
     */
    const dir = sandbox();
    const plan = planRemoval(dir, TARGET);
    assert.equal(plan.ok, true);

    assert.ok(plan.leftovers.length > 0,
        '説明文に表示名が残っているのに、残ると言っていない');
    for (const left of plan.leftovers) {
        assert.equal(left.key, 'settings.uiSkin.help',
            `思っていない鍵が残ると出ている: ${left.key}`);
        assert.ok(left.name, '残る名前を出していない');
    }

    // **本当に残っている**ことを、外したあとの現物で確かめる
    //（出しているだけで実際は残っていない、では検出器が嘘になる）。
    applyPlan(plan);
    for (const left of plan.leftovers) {
        assert.ok(fs.readFileSync(left.path, 'utf8').includes(left.name),
            `残ると出したのに残っていない: ${left.path} / ${left.name}`);
    }
});

test('[対照] 説明文から名前を消せば、残るものが無くなる', (t) => {
    if (!TARGET) { t.skip('テーマ1しか残っていない'); return; }
    const dir = sandbox();
    const localesDir = path.join(dir, 'web/i18n/locales');

    // **表示名は言語ごとに違う。** 人がやる直しと同じく、その言語の名前を
    // その言語の説明文からだけ抜く（名前を定義している行は触らない）。
    for (const file of fs.readdirSync(localesDir)) {
        const full = path.join(localesDir, file);
        const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
        const defined = lines.find(
            line => line.trimStart().startsWith(`"settings.uiSkin.${TARGET}":`));
        if (!defined) continue;
        const display = defined.match(/:\s*"((?:[^"\\]|\\.)*)"/)[1].replace(/\\(.)/g, '$1');
        const next = lines.map(line => (
            line.trimStart().startsWith('"settings.uiSkin.help":')
                ? line.split(display).join('…')
                : line
        ));
        fs.writeFileSync(full, next.join('\n'), 'utf8');
    }

    const plan = planRemoval(dir, TARGET);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.leftovers, [],
        `残っていないのに残ると言っている: ${JSON.stringify(plan.leftovers)}`);
});
