/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * テーマ（`ui_skin`）を1つ、跡を残さず外す。
 *
 * **「捨てられる」を手順書で持たない。**（2026-08-25 利用者の指示
 * 「撤去も簡単に行えるようにしてください」）
 *
 * 手順を文章で書くと、**足す場所が増えた日に手順書だけが古くなる**
 * ——外した気になって名簿や訳語が残り、選べるのに何も起きないテーマができる。
 * だから外し方は道具として持ち、`tests/remove_skin_test.mjs` が
 * **実際に外して確かめる**。
 *
 * 使い方（PowerShell 7）:
 *
 *   node tools/remove-skin.mjs vinyl            # 何が変わるかだけ出す
 *   node tools/remove-skin.mjs vinyl --apply    # 実際に外す
 *
 * 外すのは3箇所:
 *   1. `web/panel/skin-<名前>.css`（紙そのもの）
 *   2. `web/panel/skin.js` の `SKINS`（名簿）
 *   3. 各言語の `settings.uiSkin.<名前>`（設定画面に出す名前）
 *
 * **保存済みの設定は触らない。** 外したテーマを指したままでも、画面側が
 * `classic` へ倒すので面は消えない（`normalizeSkin`）。触りに行くと、
 * 稼働中の ComfyUI の設定ファイルを書き換えることになる——道具の分をわきまえる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 外せない名前。**戻り先が消えると、面そのものが出せなくなる。** */
const PROTECTED = ['classic'];

const LOCALES_DIR = 'web/i18n/locales';

/** 改行を壊さない（この木は CRLF と LF が混在している）。 */
function eolOf(text) {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 何を変えるかを組み立てる。**書き込みはしない。**
 *
 * @param {string} root パッケージの根（`ComfyUI-Unbake`）
 * @param {string} name 外すテーマ
 * @returns {{ok: boolean, reason?: string, deletes: string[], edits: {path: string, next: string, note: string}[]}}
 */
export function planRemoval(root, name) {
    const skin = String(name || '').trim();
    if (!skin) return { ok: false, reason: '名前が空', deletes: [], edits: [] };
    if (PROTECTED.includes(skin)) {
        return { ok: false, reason: `${skin} は外せない（戻り先が消える）`, deletes: [], edits: [] };
    }

    const deletes = [];
    const edits = [];

    // 1. 紙
    const sheet = path.join(root, 'web/panel', `skin-${skin}.css`);
    if (fs.existsSync(sheet)) deletes.push(sheet);

    // 2. 名簿
    const skinJsPath = path.join(root, 'web/panel/skin.js');
    const skinJs = fs.readFileSync(skinJsPath, 'utf8');
    const listMatch = skinJs.match(/export const SKINS = \[([^\]]*)\];/);
    if (!listMatch) {
        return { ok: false, reason: 'skin.js の名簿を読めない', deletes: [], edits: [] };
    }
    const names = listMatch[1].split(',').map(part => part.trim()).filter(Boolean);
    const kept = names.filter(entry => entry.replace(/['"]/g, '') !== skin);
    const known = kept.length !== names.length;
    if (known) {
        edits.push({
            path: skinJsPath,
            next: skinJs.replace(listMatch[0], `export const SKINS = [${kept.join(', ')}];`),
            note: `名簿から外す（残り ${kept.length} 種）`,
        });
    }

    // **名簿にも紙にも無いなら、外す物が無い。** 綴り違いを黙って成功にしない。
    if (!known && deletes.length === 0) {
        return { ok: false, reason: `${skin} は名簿にも紙にも無い`, deletes: [], edits: [] };
    }

    // 3. 訳語
    const localesDir = path.join(root, LOCALES_DIR);
    for (const file of fs.readdirSync(localesDir).filter(entry => entry.endsWith('.js'))) {
        const full = path.join(localesDir, file);
        const text = fs.readFileSync(full, 'utf8');
        const eol = eolOf(text);
        const lines = text.split(eol);
        const next = lines.filter(line => !line.trimStart().startsWith(`"settings.uiSkin.${skin}":`));
        if (next.length !== lines.length) {
            edits.push({ path: full, next: next.join(eol), note: `${file} の訳語を外す` });
        }
    }

    return { ok: true, deletes, edits };
}

/** 組み立てた変更を書き込む。 */
export function applyPlan(plan) {
    if (!plan.ok) return plan;
    for (const file of plan.deletes) fs.rmSync(file);
    for (const edit of plan.edits) fs.writeFileSync(edit.path, edit.next, 'utf8');
    return plan;
}

/** 道具として呼ばれた時だけ動く（読み込みで副作用を出さない）。 */
const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
    const [, , name, ...flags] = process.argv;
    const apply = flags.includes('--apply');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const plan = planRemoval(root, name);
    if (!plan.ok) {
        console.error(`外せない: ${plan.reason}`);
        process.exit(1);
    }
    const rel = (file) => path.relative(root, file).split(path.sep).join('/');
    for (const file of plan.deletes) console.log(`${apply ? '消した' : '消す'}: ${rel(file)}`);
    for (const edit of plan.edits) console.log(`${apply ? '直した' : '直す'}: ${rel(edit.path)} — ${edit.note}`);
    if (apply) {
        applyPlan(plan);
        console.log('');
        console.log('外し終わり。**保存済みの設定は触っていない**——外したテーマを');
        console.log('指したままでも、画面側が classic へ倒すので面は消えない。');
        console.log('');
        console.log('配るには: pwsh -File ../scripts/deploy-to-comfyui.ps1 -Apply');
        // **配り先には古い紙が残る。** 配布は差分を上書きするだけで消さないので、
        // 名簿から外れた紙は**誰にも読まれないまま置き去りになる**。
        // 害は無いが「跡を残さない」と言った以上、消す先を必ず出す。
        for (const file of plan.deletes) {
            const leftover = `custom_nodes/ComfyUI-Unbake/${rel(file)}`;
            console.log(`配り先に残る紙（消してよい）: ${leftover}`);
        }
    } else {
        console.log('');
        console.log('（何も変えていない。実際に外すには --apply を付ける）');
    }
}
