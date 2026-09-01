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

/**
 * **記録が LoRA を持つのに、絵が1本も使っていないなら別の絵**（`I-20260830-31`）。
 *
 * 空は「未知」として飛ばす作りなので、**7項目のうち一番強い `loras` を落としたまま
 * 「6項目を比べて100%一致」**と主張していた。実データで `inferred` は
 * 4,275枚中3,065枚（72%）＝主流の経路である。しかも**正解の記録が同居すると
 * 同点になり**、合っている絵まで「どの記録のものでもない」へ落ちる。
 *
 * **向きは片方だけ。** 絵の側はグラフを歩いて数えているので `[]` は
 * 「確かに0本」だが、**記録の側の `[]` は当てにならない**——一覧が持つ要約は
 * LoRA を持たないことがあり（`libraryRowToRecord` は無ければ `[]` を入れる）、
 * そちらを「確かに0本」と読むと**薄い記録が軒並み帰属できなくなる**。
 * だから塞ぐのは「記録は持つ・絵は持たない」だけにする。
 */
const LORAS_INDEX = MATCH_KEYS.indexOf('loras');

/**
 * **絵は自分の持ち主を名乗っている**（2026-08-27 実機の報告・`civitai_77742180`）。
 *
 * 出す絵の名前は `filename_prefix` で決まり、その値は**再現した記録の
 * `civitai_image_id`** から作られる（`civitai_78353204_00002_.png`）。
 * つまり**書いた側が「どの記録から出したか」を名前に残している。**
 *
 * この手掛かりを1つも使っていなかったので、`civitai_78353204_*` の3枚が
 * **指紋だけで別の記録（`civitai_77742180`）へぶら下がっていた**
 * ——実測の一致率 0.857（7項目中6項目）で、閾値 0.70 を普通に超える。
 * 2つの記録は土台も LoRA も似ているので、**指紋には区別できない。**
 *
 * ---
 *
 * **名乗りは指紋より強い。** 指紋は「条件が似ている」しか言えないが、
 * 名前は**生成した本人が書いた出所**である。だから順番は
 * **刻印 > 名乗り > 指紋**にする（刻印より下なのは、名前は人が付け替えられるため）。
 *
 * **名乗っているのに持ち主が居ない絵は、誰のものでもない。**
 * 記録を消した後の絵がこれに当たる。ここで指紋へ落とすと、
 * **消した記録の絵が、生き残った似た記録へ移る**——直したはずの症状がそのまま戻る。
 */
/*
 * **名乗りの形は2つ。** どちらも記録の id をそのまま前置きにしたもの:
 *
 *   `civitai_78353204_00002_.png`                    … 記録の `civitai_image_id`
 *   `e7e67434-3144-4141-b5d2-9927e2c508a7_current_1_` … 記録の id（UUID）
 *
 * **UUID の側も同じに扱う。** 実データで、消した記録の UUID を名乗る3枚が
 * `civitai_77742180` の「出た絵」に出ていた——名乗りを `civitai_` だけに限ると、
 * この形が指紋へ落ちて**別の記録の絵として出続ける**。
 */
const DECLARED_PREFIX = new RegExp(
    '^(?:civitai_\\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[_.]',
    'i',
);

/** その記録が出す絵の名前になりうる鍵。**長い方から当てる**（`_` 区切りで誤爆しない）。 */
export function nameKeysOf(record) {
    const keys = [];
    const civitai = String(record?.civitaiImageId ?? record?.civitai_image_id ?? '').trim();
    if (civitai) keys.push(`civitai_${civitai}`);
    const id = String(record?.libraryId ?? record?.id ?? '').trim();
    // **id そのものも名前になる**（過去の実験は記録の id を前置きにしている）。
    if (id && id !== civitai) keys.push(id);
    return keys;
}

/**
 * 名前から持ち主を引く。
 *
 * @returns {{recordId: string|null, declared: boolean}}
 *   `declared` は「`civitai_<id>` と名乗っていた」——持ち主が見つからなくても、
 *   **指紋へ落としてはいけない**ことを呼び手へ伝える。
 */
export function namedRecordId(filename, byName) {
    const text = String(filename || '');
    if (!text) return { recordId: null, declared: false };
    let found = null;
    for (const [key, recordId] of byName) {
        if (text !== key && !text.startsWith(`${key}_`) && !text.startsWith(`${key}.`)) continue;
        // **2つの記録が同じ名前を名乗ったら決めない。** 片方を選ぶ理由が無い。
        if (found !== null && found !== recordId) return { recordId: null, declared: true };
        found = recordId;
    }
    return { recordId: found, declared: found !== null || DECLARED_PREFIX.test(text) };
}

/** 焼かれた印から記録の id を取る。**どの印かで鍵の名前が違う。** */
/**
 * 印の在りか。**ここが唯一の表。**
 *
 * 起動時の走査はこの鍵だけを取りに行く（`I-20260829-01`）。表を2箇所に持つと、
 * 印を1つ足したときに**走査だけが取り落として、帰属が黙って減る**
 * ——減ったことは画面のどこにも出ない。だから走査側は `STAMP_KEYS` を読む。
 */
const STAMP_SOURCES = Object.freeze([
    ['unbake_sweep', ['record_id', 'recipe_id']],
    // **試行の印も表に入れる**（2026-09-01・走査8周目）。
    // `recipeTrialRunner` は `extra_pnginfo: { unbake_trial: stamp }` を焼いており、
    // その注記は「**これが無いと、出た画像を Unbake へ落とし直したときに
    // 『どの試行の何番目か』が失われる**」と書いている。ところが実測で
    // **`unbake_trial` の読み手は repo 全体で0件**だった——この表にも
    // `outputs.RAW_KEYS` にも無いので、焼いた印は誰にも読まれずに捨てられていた。
    // `outputs.py` が名指しする失敗（JS が `unbake_*` で書き、Python が
    // `lora_manager_*` で読もうとして「焼いた3枚が1枚も読めなかった」）の3度目。
    ['unbake_trial', ['record_id']],
    ['lora_manager_recipe', ['recipe_id', 'record_id']],
    ['lora_manager_sweep', ['recipe_id', 'record_id']],
]);

/** 印の鍵だけ。**走査へ渡す値はここから作る。** */
export const STAMP_KEYS = Object.freeze(STAMP_SOURCES.map(([key]) => key));

export function stampedRecordId(raw) {
    for (const [key, idKeys] of STAMP_SOURCES) {
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
    /*
     * **名前の索引を、条件の有無より前に作る**（2026-08-27）。
     *
     * 下の `continue` より前に置いてあるのは順番の都合ではなく意図で、
     * **名乗りは条件を1つも読めない記録でも効く**べきだからである。
     * 後ろに置くと「条件が薄い記録の絵」だけが名乗りを無視され、
     * **薄い記録ほど他人の絵を掴む**という一番まずい形になりうる。
     *
     * **今その `continue` はほぼ通らない**——`conditionsFromRecord()` は
     * object を渡す限り空欄だらけの条件を返し、`null` は返さない（実測）。
     * つまり現状ここは効いていない。**それでも順番は保つ**: 抽出器が
     * 「読めないものは `null`」へ変わった日に、名乗りが黙って死ぬのを避けるため。
     *
     * **配列に持たせる。** 返す形を変えると呼び手を全部直すことになり、直し漏れは
     * 「名乗りが黙って効かない」という気づけない壊れ方をする。配列としての使い方
     * （`for...of`）はそのままで、名前の索引だけを添える。
     */
    const byName = new Map();
    for (const record of records || []) {
        const id = String(record?.libraryId ?? record?.id ?? '');
        for (const key of nameKeysOf(record)) {
            if (!key) continue;
            // 同じ名前を2つの記録が名乗ったら、**どちらでもない**印として空を入れる。
            byName.set(key, byName.has(key) && byName.get(key) !== id ? '' : id);
        }
        const conditions = conditionsFromRecord(record?.recipe || record);
        if (!conditions) continue;
        out.push({ id, row: rowOf(conditions), conditions });
    }
    out.byName = byName;
    return out;
}

/**
 * 画像1枚を記録へ帰属させる。
 *
 * @returns {{recordId: string|null, evidence: 'stamped'|'named'|'inferred'|'none',
 *            agreement: number, compared: number, tied: number}}
 */
export function attributeOutput(output, indexed, {
    minAgreement = MIN_AGREEMENT, minCompared = MIN_COMPARED, promptsLoaded = true,
} = {}) {
    const stamped = stampedRecordId(output?.raw);
    if (stamped) {
        return { recordId: stamped, evidence: 'stamped', agreement: 1, compared: 0, tied: 0 };
    }
    /*
     * **名乗りは指紋より先に見る**（2026-08-27・順番が意味を持つ）。
     *
     * 出す絵の名前は再現した記録の id から作られるので、**書いた本人の申告**である。
     * 指紋は「条件が似ている」しか言えず、**似た記録どうしは区別できない**
     * ——実データで `civitai_78353204_*` が 0.857 の一致率で `civitai_77742180` に
     * ぶら下がっていた（名前は最初から正解を書いていた）。
     */
    const named = namedRecordId(output?.filename, indexed?.byName || new Map());
    if (named.recordId) {
        return { recordId: named.recordId, evidence: 'named', agreement: 1, compared: 0, tied: 0 };
    }
    if (named.declared) {
        // **名乗っているのに持ち主が居ない。** 記録を消した後の絵がこれ。
        // ここで指紋へ落とすと、**消した記録の絵が似た記録へ移る**。
        return { recordId: null, evidence: 'none', agreement: 0, compared: 0, tied: 0 };
    }
    // **`prompt` を取っていないことを「無かった」と読ませない**（`I-20260829-01`）。
    //
    // 起動時の走査は印だけを取るので、ここへ来た絵の `prompt` は**手元に無いだけ**で
    // 「持っていない」わけではない。`none` に混ぜると、推定が**走っていない**ことが
    // 「推定したが当たらなかった」に見える——未記録を 0 と読む形そのもの。
    if (promptsLoaded === false && !output?.raw?.prompt) {
        return { recordId: null, evidence: 'deferred', agreement: 0, compared: 0, tied: 0 };
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
        /*
         * **記録が LoRA を持つのに、絵が1本も使っていないなら別の絵。**
         *
         * `entry.row` は記録の側、`row` は絵の側（実行されたグラフを歩いて
         * 数えている）。絵の側の空は**確かに0本**なので、記録が3本持っている
         * なら、その絵はその記録から出ていない。
         *
         * 一致率で落とせない: 7項目中6項目が合えば 0.857 で、閾値 0.70 を
         * 普通に超える。**強い手掛かりは、率へ薄めずに単独で効かせる。**
         */
        if (LORAS_INDEX >= 0) {
            const recorded = entry.row[LORAS_INDEX];
            const drawn = row[LORAS_INDEX];
            if (recorded && !drawn) continue;
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
    // 走査で `prompt` を取ったかどうかを、1枚ごとの判定へそのまま渡す。
    const indexed = indexRecords(records);
    const byRecord = new Map();
    // **`named` を数に足す**（2026-08-27）。足さないと `tally[evidence] += 1` が
    // `undefined + 1` になり、**内訳が NaN になって画面から消える**。
    // **`deferred` を必ず持つ。** 無い鍵へ `tally[evidence] += 1` すると
    // `undefined + 1` で NaN になり、**内訳が画面から消える**（一度踏んでいる）。
    const tally = {
        total: 0, stamped: 0, named: 0, inferred: 0, none: 0, unreadable: 0, deferred: 0,
    };
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
