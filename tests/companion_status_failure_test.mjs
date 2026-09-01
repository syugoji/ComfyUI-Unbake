/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * **伴走の問い合わせが失敗したことを、「要らない」と混ぜない**（`I-20260830-17`）。
 *
 * 拡散モデルは本体だけでは動かない。Civitai は Flux / Krea 2 などについて
 * 拡散モデルしか配らず、テキストエンコーダと VAE は別に要る（実測で Krea 2 は
 * +8.3GB、Flux は +5.4GB）。その問い合わせが1度でも失敗すると:
 *
 *   - `statusCache` に **null が入る**ので、**ページの寿命いっぱい**「伴走は要らない」
 *     扱いになる。控えを捨てる口は production から一度も呼ばれない＝**自力で回復しない**
 *   - 呼び手が `!status` を `missingCount <= 0` と同じ `continue` に落とすので、
 *     総量が過少に出るうえ「判らない分が在る」とも言わない
 *
 * ## なぜ既存の検査が素通りしたか
 *
 * `companionIo.status` のダブルが**すべて成功オブジェクトを返す**。失敗を返す対が
 * 1本も無いので、失敗経路が一度も走らなかった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchCompanionStatus, resetCompanionCache } from '../web/core/modelCompanions.js';

/** 実物のサーバが返す形（`ok` と `companions` が要る）。 */
const OK_BODY = {
    ok: true,
    companions: [{ name: 't5xxl.safetensors', bytes: 8_300_000_000 }],
    missingCount: 2, missingBytes: 8_300_000_000, missingUnknown: 0,
};

/** N 回目までは失敗し、その後は成功する偽の口。**呼ばれた回数を数える。** */
function flaky(failures) {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        if (calls <= failures) throw new Error('network');
        return { ok: true, json: async () => OK_BODY };
    };
    return { fetchImpl, calls: () => calls };
}

test('失敗しても控えに入れない（次の問い合わせで本物が返る）', async () => {
    resetCompanionCache?.();
    const { fetchImpl, calls } = flaky(1);
    const first = await fetchCompanionStatus('Krea 2', { fetchImpl });
    assert.equal(first, null, '前提: 1回目は失敗する');

    const second = await fetchCompanionStatus('Krea 2', { fetchImpl });
    assert.equal(calls(), 2, '2回目を問い合わせていない（失敗を控えている）');
    assert.ok(second, `失敗が控えに残っている: ${JSON.stringify(second)}`);
    assert.equal(second.missingCount, 2);
});

test('[対照] 成功は控える（同じ系統を何度も問い合わせない）', async () => {
    resetCompanionCache?.();
    const { fetchImpl, calls } = flaky(0);
    const a = await fetchCompanionStatus('Krea 2', { fetchImpl });
    const b = await fetchCompanionStatus('Krea 2', { fetchImpl });
    assert.ok(a && b, '成功が返っていない');
    assert.equal(calls(), 1, `成功を控えていない: ${calls()}回`);
});

test('呼び手が「読めなかった」を判らない分として数える', async () => {
    // 実装の分岐を原文で見る。**ダブルでは測れない**——呼び手側の `unknown` は
    // 面の内側の変数で、外から読める形になっていない。
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const panel = fs.readFileSync(path.join(root, 'web/panel/panel.js'), 'utf8');
    const at = panel.indexOf('const status = await companionIo.status(base);');
    assert.ok(at > 0, '伴走の問い合わせが見つからない');
    const body = panel.slice(at, at + 700);
    assert.match(body, /if \(!status\) \{ unknown \+= 1; continue; \}/,
        '「読めなかった」を「0個」と同じ道に落としている');
});
