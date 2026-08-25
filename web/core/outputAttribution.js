/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 出力画像を記録へ帰属させる。**証拠の強さを段階で持つ。**
 *
 * ---
 *
 * **刻印 > 指紋。** 順番を混ぜない。
 *
 *   `stamped`  … 生成時に焼いた印。**確実**。実測（2026-08-20・出力4,275枚）で
 *                 695枚（16.3%）。ここが「自分が回した分が貯まる」経路で、
 *                 **新しい環境でも2回目の実験から効く**。
 *   `inferred` … 条件の指紋。**推定**。過去の絵にも当たる。この環境では
 *                 3,065枚に当たり、合わせて **3,760枚（88.0%）**が帰属した。
 *
 * **推定の当たり具合は、刻印を隠した盲検で測った**（刻印つきの絵から印を外して
 * 指紋だけで当てさせ、隠した印と突き合わせる）:
 *
 *   ==================================  =======================
 *   当てにいった                          609 / 695（87.6%）
 *   当てにいった中で正しかった             **604 / 609（99.2%）**
 *   ==================================  =======================
 *
 * **当てにいかなかった134枚は「外した」ではない。** 比べられる項目が足りないか
 * 同点が複数のときは黙って諦める形にしてある。**当てた中での正しさ**と
 * **当てにいけた割合**は別の数なので、片方だけを「精度」と呼ばないこと。
 *
 * **この98.6%は刻印つきの絵でしか測れていない。** 刻印が付いているのは
 * LoRA Manager 経由で作った絵で、**測れた部分集合が母集団と同じとは限らない**。
 *
 * この2つを同じ見た目で出さない。**推定を確実と混ぜると、
 * 「この画像はこの記録から出た」という一番強い主張が一番弱い根拠で通る。**
 *
 * ---
 *
 * **「持っていない」を「違う」と数えない。**
 *
 * 記録は寸法を241/346件、scheduler を88/346件しか持たない。
 * 空欄を不一致として数えると、**記録が薄いほど帰属できなくなる**
 * ——それは画像の性質ではなく記録の性質で、測りたいものではない。
 * だから**両方が値を持つ項目だけ**を比べ、比べられた本数も一緒に返す。
 *
 * ---
 *
 * **閾値は機構から決める。**
 *
 * 実測（4,275枚 × 346記録・比較4項目以上・最良が一意）:
 *
 *   ========  ==============  ==================================
 *   閾値       指紋で帰属した   刻印つき692枚のうち正しく当てた数
 *   ========  ==============  ==================================
 *   0.70       76.7%           547（79.0%）
 *   0.80       54.7%           426（61.6%）
 *   0.90       22.9%           214（30.9%）
 *   ========  ==============  ==================================
 *
 * （この表は `size` / `scheduler` を照合に入れていた時の値。向きは同じ。）
 *
 * **上げるほど当たりが減る。** 厳しくすると当てにいく件数そのものが減るからで、
 * 右の列は「692枚のうち何枚を正しく当てられたか」＝**当てにいけた割合を含む**数。
 * 当てにいった中での正しさは上の盲検のほうで、**2つを混ぜないこと。**
 * 既定は 0.70 ——**上げれば良くなるという直感が実測で否定されている。**
 */

import {
    conditionsFromPrompt, conditionsFromRecord, FINGERPRINT_FIELDS,
} from './outputFingerprint.js';

/**
 * **照合に使わない項目。**（差分ラベルには使う——外すのは比較だけ）
 *
 *   `seed`      … Sweep が振る軸そのもの。
 *   `size`      … 記録が持つのは**注文した寸法**で、グラフが持つのは
 *                  **hires 前の latent の寸法**。hires を使うと定義上ずれるので、
 *                  正しい対でも食い違う（実測の一致率 **23.4%**）。
 *   `scheduler` … 記録が持つのは 88/346件だけで、A1111 の表記では
 *                  サンプラー名に畳み込まれている（実測の一致率 **36.8%**）。
 *
 * **外すと当たりが良くなる。** 実測（4,275枚 × 346記録）:
 *
 *   ==========================  ======  ================
 *   照合に使う項目                被覆    当てた中の正しさ
 *   ==========================  ======  ================
 *   seed 以外すべて               77.0%   98.6%
 *   ＋ scheduler も外す           78.8%   98.6%
 *   ＋ size も外す              **88.0%**  **99.2%**
 *   一致率の高い5本だけ            70.4%   99.0%
 *   ==========================  ======  ================
 *
 * **「合わない項目を外したら当たった」は、指標を都合よく削ったのではない。**
 * 外した2本はどちらも**正しい対でも食い違う**ことが先に測れていて、
 * その理由（hires・表記の畳み込み）も判っている。合わない理由が判らないまま
 * 外すのは、ここでやってはいけないことのほう。
 */
const NOT_FOR_MATCHING = new Set(['seed', 'size', 'scheduler']);

/** 比較に使う項目。 */
export const MATCH_KEYS = Object.freeze(
    FINGERPRINT_FIELDS.map(field => field.key).filter(key => !NOT_FOR_MATCHING.has(key)),
);

/** 最低これだけの項目を比べられないと、帰属を主張しない。 */
export const MIN_COMPARED = 4;

/** 一致率の下限。**上の表のとおり、上げると当たりが悪くなる。** */
export const MIN_AGREEMENT = 0.7;

/**
 * **土台のモデルが食い違ったら帰属しない。**
 *
 * 一致率だけで見ると、checkpoint が別物でも**残りの項目で 0.7 を超えて**
 * しまう。実データで `Civitai_Recipe_115941302`（ntdmixvpredv1.5）へ、
 * `waiillustrioussdxl_v140` で出た絵が7枚ぶら下がっていた——
 * **土台が違う絵は、その記録から出たものではない。**
 *
 * 比べられない（どちらかが空）ときは今までどおり「未知」として扱う
 * ——ここで落とすと、名前を持っていない記録が全部帰属できなくなる。
 */
const CHECKPOINT_INDEX = MATCH_KEYS.indexOf('checkpoint');

/** 焼かれた印から記録の id を取る。**どの印かで鍵の名前が違う。** */
export function stampedRecordId(raw) {
    for (const [key, idKeys] of [
        ['unbake_sweep', ['record_id', 'recipe_id']],
        ['lora_manager_recipe', ['recipe_id', 'record_id']],
        ['lora_manager_sweep', ['recipe_id', 'record_id']],
    ]) {
        const text = raw?.[key];
        if (!text) continue;
        let payload = text;
        if (typeof text === 'string') {
            try { payload = JSON.parse(text); } catch { continue; }
        }
        for (const idKey of idKeys) {
            if (payload?.[idKey]) return String(payload[idKey]);
        }
    }
    return null;
}

/** 比較用の文字列へ落とす（`outputFingerprint` と同じ値の見方）。 */
function cell(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        return value.map(item => (item && typeof item === 'object'
            ? `${item.name}@${item.strength ?? ''}`
            : String(item))).join(',');
    }
    return String(value);
}

const rowOf = (conditions) => MATCH_KEYS.map(key => cell(conditions?.[key]));

/**
 * 記録の側を一度だけ畳んでおく。**画像ごとに組み直さない**
 * （4,275枚 × 346記録＝約150万回の比較になる）。
 */
export function indexRecords(records) {
    const out = [];
    for (const record of records || []) {
        const conditions = conditionsFromRecord(record?.recipe || record);
        if (!conditions) continue;
        out.push({
            id: String(record?.libraryId ?? record?.id ?? ''),
            row: rowOf(conditions),
            conditions,
        });
    }
    return out;
}

/**
 * 画像1枚を記録へ帰属させる。
 *
 * @returns {{recordId: string|null, evidence: 'stamped'|'inferred'|'none',
 *            agreement: number, compared: number, tied: number}}
 */
export function attributeOutput(output, indexed, {
    minAgreement = MIN_AGREEMENT, minCompared = MIN_COMPARED,
} = {}) {
    const stamped = stampedRecordId(output?.raw);
    if (stamped) {
        return { recordId: stamped, evidence: 'stamped', agreement: 1, compared: 0, tied: 0 };
    }
    const conditions = conditionsFromPrompt(output?.raw?.prompt);
    if (!conditions) {
        return { recordId: null, evidence: 'none', agreement: 0, compared: 0, tied: 0 };
    }
    const row = rowOf(conditions);

    let bestId = null;
    let best = -1;
    let bestCompared = 0;
    let tied = 0;
    for (const entry of indexed) {
        let compared = 0;
        let agreed = 0;
        for (let i = 0; i < row.length; i += 1) {
            const left = entry.row[i];
            const right = row[i];
            // **どちらかが空なら「未知」。** 不一致として数えない。
            if (!left || !right) continue;
            compared += 1;
            if (left === right) agreed += 1;
        }
        if (compared < minCompared) continue;
        // **土台が食い違うなら、ほかがいくら合っていても別の記録。**
        if (CHECKPOINT_INDEX >= 0) {
            const left = entry.row[CHECKPOINT_INDEX];
            const right = row[CHECKPOINT_INDEX];
            if (left && right && left !== right) continue;
        }
        const ratio = agreed / compared;
        if (ratio > best) {
            best = ratio; bestId = entry.id; bestCompared = compared; tied = 1;
        } else if (ratio === best) {
            tied += 1;
        }
    }

    // **同点が複数なら帰属しない。** どれか1つを選ぶと、選んだ理由が無いのに
    // 「この記録から出た」と言うことになる。
    if (bestId === null || best < minAgreement || tied !== 1) {
        return {
            recordId: null, evidence: 'none',
            agreement: Math.max(0, best), compared: bestCompared, tied,
        };
    }
    return {
        recordId: bestId, evidence: 'inferred',
        agreement: best, compared: bestCompared, tied,
    };
}

/**
 * まとめて帰属させる。**内訳を必ず返す**——「N枚を紐付けました」だけだと、
 * そのうち何枚が推定なのかが読めない。
 *
 * @returns {{byRecord: Map<string, object[]>, tally: object}}
 */
export function attributeOutputs(outputs, records, options = {}) {
    const indexed = indexRecords(records);
    const byRecord = new Map();
    const tally = { total: 0, stamped: 0, inferred: 0, none: 0, unreadable: 0 };
    for (const output of outputs || []) {
        tally.total += 1;
        const result = attributeOutput(output, indexed, options);
        if (result.evidence === 'none' && result.compared === 0 && !output?.raw?.prompt) {
            tally.unreadable += 1;
        }
        tally[result.evidence] += 1;
        if (!result.recordId) continue;
        if (!byRecord.has(result.recordId)) byRecord.set(result.recordId, []);
        byRecord.get(result.recordId).push({ ...output, attribution: result });
    }
    return { byRecord, tally };
}
