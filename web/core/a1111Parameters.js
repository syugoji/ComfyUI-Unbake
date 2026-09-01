/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * A1111 形式の `parameters` テキストを読む（2026-08-23 利用者の報告）。
 *
 * **書いてあるのに1つも読んでいなかった。** civitai から落とした PNG を
 * 落とし込むと、記録は `hasA1111: true` を立てながら checkpoint も LoRA も
 * seed も steps も **全部 `null`** で保存されていた——中の文字列には
 * `Model:` も `Seed: 941290178` も `<lora:…:0.7>` も入っていたのに、
 * それを**生のまま1本の文字列として持ち回るだけ**だったため。
 * 利用者から見ると「保存されない」で、実際ディスクには空の殻が残る。
 *
 * **形は「最後の1行が設定行」。** その上が prompt で、途中に
 * `Negative prompt:` の行があればそこから下が negative。
 *
 * **設定行をカンマで素朴に切らない。** `Hashes: {"a":"b"}` や
 * `Civitai resources: [{…},{…}]` の中にカンマが入っている——切ると
 * JSON が割れ、**版 ID も hash も丸ごと落ちる**（実データの1件で
 * LoRA 9本ぶんの版 ID がそこに在った）。
 */

// **種別を寄せる規則は1箇所**（`civitaiClient.js` の `resourceKind`）。
// ここで手書きすると、`embed` / `vae` / `upscaler` が LoRA になる。
import { resourceKind } from './civitaiClient.js';

/** 設定行に出る鍵。**1つも当たらない行は設定行と見なさない。** */
const KNOWN_KEYS = new Set([
    'steps', 'sampler', 'cfg scale', 'seed', 'size', 'model', 'model hash',
    'clip skip', 'denoising strength', 'schedule type', 'scheduler', 'version',
    'hashes', 'civitai resources', 'vae', 'vae hash',
]);

/**
 * 設定行を `鍵: 値` へ切る。**括弧の内側のカンマでは切らない。**
 *
 * 引用符の中も見る——`"a,b"` は1つの値の一部である。
 */
export function splitParameterLine(line) {
    const out = [];
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let start = 0;
    const text = String(line ?? '');
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (quoted) {
            if (ch === '\\') escaped = true;
            else if (ch === '"') quoted = false;
            continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
            out.push(text.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
}

/** その行は設定行か。**知っている鍵が2つ以上**そろって初めて認める。 */
export function looksLikeParameterLine(line) {
    const keys = splitParameterLine(line)
        .map(part => part.slice(0, part.indexOf(':')).trim().toLowerCase())
        .filter(key => key && KNOWN_KEYS.has(key));
    return keys.length >= 2;
}

function parseJsonOrNull(text) {
    try {
        const value = JSON.parse(text);
        return (value && typeof value === 'object') ? value : null;
    } catch {
        return null;
    }
}

/** `urn:air:<系統>:<種別>:<出所>:<模型>@<版>` を解く。**読めなければ null。** */
export function parseAirUrn(value) {
    const match = /^urn:air:[^:]*:([^:]+):([^:]+):(\d+)@(\d+)$/i.exec(String(value ?? '').trim());
    if (!match) return null;
    return {
        kind: match[1].toLowerCase(),
        source: match[2].toLowerCase(),
        modelId: Number(match[3]),
        modelVersionId: Number(match[4]),
    };
}

/**
 * プロンプトに書かれた `<lora:…>` の綴り。**知っているのはここだけ**
 *（`D-20260828-01` 群B）。
 *
 * A1111 が正式に受ける形は3つある:
 *
 *     <lora:name>              重み省略（＝1）
 *     <lora:name:0.8>          model と clip に同じ重み
 *     <lora:name:0.8:0.5>      model と clip で別の重み
 *
 * **毎回新しい正規表現を返す。** `g` 付きを使い回すと `lastIndex` が持ち越され、
 * 呼ぶ順番で結果が変わる（`replace` と `matchAll` を両方使う側が居る）。
 */
export function loraTagRegex() {
    return /<lora:([^:>]+)(?::([^:>]*))?(?::([^:>]*))?[^>]*>/gi;
}

/** プロンプトに直接書かれた `<lora:名前:効き目>`。 */
export function loraTagsIn(text) {
    const out = [];
    for (const match of String(text ?? '').matchAll(loraTagRegex())) {
        const name = String(match[1] || '').trim();
        if (!name) continue;
        const weight = Number(match[2]);
        const clip = Number(match[3]);
        const strength = Number.isFinite(weight) ? weight : 1;
        out.push({
            name,
            strength,
            // **model と clip が別なら、別のまま持つ。** 同じ値へ潰すと
            // 実測32本で clip 側が落ちる（`recipeWorkflowBuilder` の既知の轍）。
            clipStrength: Number.isFinite(clip) ? clip : strength,
        });
    }
    return out;
}

/** 数へ。**読めなければ `null`**（`Number('')` の 0 を通さない）。 */
function toNumber(value) {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

/**
 * A1111 の `parameters` を読む。
 *
 * @param {string} raw
 * @returns {{ok: boolean, positive: string|null, negative: string|null,
 *   params: object, hashes: object|null, resources: object[]}}
 */
export function parseA1111Parameters(raw) {
    const empty = {
        ok: false, positive: null, negative: null, params: {}, hashes: null, resources: [],
    };
    const text = String(raw ?? '');
    if (!text.trim()) return empty;

    const lines = text.split(/\r?\n/);
    // **最後の非空行だけを設定行の候補にする。** 途中の行を拾うと、
    // プロンプトの中の `something: value, other: value` を設定と読む。
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last -= 1;
    const hasParams = last >= 0 && looksLikeParameterLine(lines[last]);

    const params = {};
    let hashes = null;
    let resources = [];
    if (hasParams) {
        for (const part of splitParameterLine(lines[last])) {
            const at = part.indexOf(':');
            if (at < 0) continue;
            const key = part.slice(0, at).trim().toLowerCase();
            const value = part.slice(at + 1).trim();
            if (!key) continue;
            if (key === 'hashes') { hashes = parseJsonOrNull(value); continue; }
            if (key === 'civitai resources') {
                const parsed = parseJsonOrNull(value);
                resources = Array.isArray(parsed) ? parsed : [];
                continue;
            }
            params[key] = value;
        }
    }

    // 設定行を除いた残りが prompt 側。
    const body = (hasParams ? lines.slice(0, last) : lines).join('\n');
    const negativeAt = body.search(/^Negative prompt:/mi);
    const positive = (negativeAt >= 0 ? body.slice(0, negativeAt) : body).trim();
    const negative = negativeAt >= 0
        ? body.slice(negativeAt).replace(/^Negative prompt:/i, '').trim()
        : '';

    return {
        // **設定行が無くても prompt だけは返す。** 「読めなかった」と
        // 「設定を書いていない画像だった」は別で、後者でも文字列は使える。
        ok: hasParams || Boolean(positive),
        positive: positive || null,
        negative: negative || null,
        params,
        hashes,
        resources,
    };
}

/**
 * 読んだ結果を、記録の項目（`summarizePrompt` と同じ形）へ写す。
 *
 * **既に入っている値は上書きしない。** グラフから取れた値の方が確かで、
 * A1111 のテキストは「グラフが無いときの次善」である。
 *
 * @param {object} summary `summarizePrompt()` の戻り
 * @param {string} raw     `parameters` の生テキスト
 * @returns {object} 写した後の summary（引数は変えない）
 */
/**
 * `Lora hashes: "名前: ハッシュ, 名前2: ハッシュ2"` を読む
 * （2026-08-31・監査 I-20260831-24）。
 *
 * **`Hashes: {…}` とは別の鍵**で、A1111 / Forge / Civitai が実際に書くのは
 * こちら。実測: 手元の A1111 画像168枚のうち **39枚が `Lora hashes` を持ち、
 * そのうち `Hashes` も持つものは0枚**——つまり片方しか読まないと、
 * その39枚の LoRA 52本すべてが `hash=null` になる。
 *
 * ハッシュが無いと `modelResolver` はハッシュ照合の段を素通りして名前一致まで
 * 落ちる（`modelEvidence.js` が「同名の別物を掴みうる」と警告する状態）。
 * 12桁で来るので `shortHash` の条件を満たし、**拾えばバイト同一まで格上げできる。**
 *
 * @returns {Map<string, string>} 小文字の名前 → ハッシュ
 */
function loraHashesIn(params) {
    const raw = String(params?.['lora hashes'] ?? '').trim().replace(/^"|"$/g, '');
    const out = new Map();
    if (!raw) return out;
    for (const piece of raw.split(',')) {
        // 名前に `:` は入りうるので、**最後の `:` で割る**。
        const at = piece.lastIndexOf(':');
        if (at <= 0) continue;
        const name = piece.slice(0, at).trim().toLowerCase();
        const hash = piece.slice(at + 1).trim();
        if (name && hash) out.set(name, hash);
    }
    return out;
}

export function applyA1111ToSummary(summary, raw) {
    const out = { ...summary, loras: [...(summary?.loras || [])] };
    const parsed = parseA1111Parameters(raw);
    if (!parsed.ok) return out;
    const params = parsed.params;

    if (out.seed === null && params.seed !== undefined) out.seed = toNumber(params.seed);
    if (out.steps === null && params.steps !== undefined) out.steps = toNumber(params.steps);
    if (out.cfg === null && params['cfg scale'] !== undefined) out.cfg = toNumber(params['cfg scale']);
    if (!out.sampler && params.sampler) out.sampler = params.sampler;
    if (!out.scheduler && (params['schedule type'] || params.scheduler)) {
        out.scheduler = params['schedule type'] || params.scheduler;
    }
    if ((out.width === null || out.height === null) && params.size) {
        const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(params.size.trim());
        if (size) {
            if (out.width === null) out.width = Number(size[1]);
            if (out.height === null) out.height = Number(size[2]);
        }
    }
    // **`Model:` は拡張子の無い名前。** 手元のファイル名とは限らないので、
    // 索引での引き直し（hash・版 ID）はこの後の段が受け持つ。
    if (!out.checkpoint && params.model) out.checkpoint = params.model;
    if (!out.positive && parsed.positive) out.positive = parsed.positive;
    if (!out.negative && parsed.negative) out.negative = parsed.negative;

    if (out.loras.length === 0) {
        // hash は `LORA:<名前>` の形で入っている。**引き直しの手掛かりなので拾う。**
        const byName = new Map();
        for (const [key, value] of Object.entries(parsed.hashes || {})) {
            const name = key.replace(/^lora:/i, '').trim().toLowerCase();
            if (name) byName.set(name, String(value || '') || null);
        }
        // **`Lora hashes` も読む**（I-20260831-24）。実データでは
        // こちらしか持たない画像のほうが多い（39枚 対 0枚）。
        // 既に `Hashes` から拾えている分は上書きしない。
        for (const [name, hash] of loraHashesIn(params)) {
            if (!byName.has(name)) byName.set(name, hash);
        }
        out.loras = loraTagsIn(parsed.positive).map(item => ({
            name: item.name,
            strength: item.strength,
            hash: byName.get(item.name.toLowerCase()) || null,
        }));
    }

    // **版 ID を捨てない。** 名前で引けないモデルは、これでしか辿れない
    // （手元のファイル名と Civitai の表示名は一致しない）。
    const resources = normalizeResources(parsed.resources);
    if (resources.length) out.civitaiResources = resources;
    return out;
}

/**
 * `Civitai resources` を平たい形へ。**読めない `air` は null のまま残す。**
 *
 * ---
 *
 * **`air` が無い形が実データの多数派だった**（2026-08-27 実測）。
 *
 * ここは `urn:air:…` からしか種別と版IDを取っていなかったので、Civitai の
 * 生成画面が書く**素の形**——`{"type":"lora","modelVersionId":1056404,"weight":0.45}`
 * ——を渡すと **`kind` も `modelVersionId` も全部 `null` に潰れていた。**
 *
 * 潰れると `kind === 'lora'` で絞る側は**常に0件**になり、版IDでの突き合わせも
 * できない。`Civitai_Recipe_77742180` では、A1111 側が LoRA 4本を版ID付きで
 * 宣言しているのに**1本も読めず**、プロンプトのタグ1本だけが残って
 * **4本中3本が黙って落ちた絵**が出ていた。
 *
 * **`air` を優先し、無ければ素の欄を読む。** どちらも「Civitai が書いた出所」で、
 * 形が違うだけである。`versionName` も同じ理由で `modelVersionName` を見る。
 */
export function normalizeResources(list) {
    return (Array.isArray(list) ? list : []).map(item => {
        const air = parseAirUrn(item?.air);
        const plainKind = String(item?.type ?? '').trim().toLowerCase() || null;
        const plainVersionId = Number(item?.modelVersionId);
        const plainModelId = Number(item?.modelId);
        return {
            modelName: item?.modelName ?? null,
            versionName: item?.versionName ?? item?.modelVersionName ?? null,
            weight: typeof item?.weight === 'number' ? item.weight : null,
            /*
             * **種別は `resourceKind()` が決める**（`D-20260828-01` 群B）。
             *
             * 元は生の `type` をそのまま入れていた。読む側は
             * 「checkpoint でなければ LoRA」で振り分けるので、
             * **embed / vae / upscaler が `LoraLoader` へ押し込まれていた**。
             * リポジトリ自身の実測（`civitaiClient.js` の分布・316件）でも
             * embed 65 / upscaler 15 / vae 6 が在る——珍しい形ではない。
             */
            kind: resourceKind(air?.kind ?? plainKind),
            /** 寄せる前の値。**判らなかったときに何が来たのかを残す。** */
            rawKind: air?.kind ?? plainKind,
            modelId: air?.modelId ?? (Number.isFinite(plainModelId) ? plainModelId : null),
            modelVersionId: air?.modelVersionId
                ?? (Number.isFinite(plainVersionId) ? plainVersionId : null),
        };
    });
}

/**
 * A1111 のテキストから**レシピ**を組む。
 *
 * **これが無いと再現の側へ入れない。** 記録は項目が埋まっても、組み立ても
 * 「振る」も判定も**レシピの形**を受け取るように出来ている。グラフを持たない
 * 記録（実測でレシピ346件中298件）が通っているのと同じ道へ、A1111 の画像も
 * 乗せる——別の道を作らない。
 *
 * **`<lora:…>` と `Civitai resources` を添字で対応付けない。** 実データで
 * タグ9本に対し資源は8件だった（先頭の1本は手元にだけ在る LoRA で、
 * Civitai 側の並びに無い）。ずらして繋ぐと**全部が1つ隣の版 ID を持つ**。
 * だから LoRA は**タグから**作り、資源は資源として別に残す。
 *
 * checkpoint だけは対応が一意（資源のうち種別が `checkpoint` のものは1件）
 * なので、そこからは版 ID を採る。
 *
 * @param {string} raw `parameters` の生テキスト
 * @param {object} [meta] `{ id, title }`
 * @returns {object|null} 組めなければ `null`（checkpoint が判らないとき）
 */
export function recipeFromA1111(raw, meta = {}) {
    const parsed = parseA1111Parameters(raw);
    if (!parsed.ok) return null;
    const params = parsed.params;
    const name = String(params.model || '').trim();
    const resources = normalizeResources(parsed.resources);
    const checkpointResource = resources.find(item => item.kind === 'checkpoint') || null;
    /*
     * **checkpoint が判らないなら組まない。** 土台の無いグラフは投入できず、
     * 「組めた」と言った上で投入時に落ちるのが一番読みにくい。
     *
     * **ただし「判らない」は `Model:` が無いことではない**（2026-08-31・
     * 監査 I-20260831-25）。Civitai の素の形は `Model:` を書かず
     * `Civitai resources` に**版IDを持つ**。版IDをファイル名へ解決する口
     * （`civitaiResources.applyResolvedResources`）は `checkpoint.modelVersionId`
     * を要求するので、**ここで組まない限りその経路は一度も走らない**
     * ——版IDが在るのに版IDで引けない、という循環になっていた。
     *
     * 実測: 手元の A1111 画像168枚のうち122枚が `Model:` を持たず、
     * **そのうち97枚は版ID付きの checkpoint を持っている**。
     * 利用者からは「Civitai が版まで書いているのに再現不可」に見える。
     *
     * **名前は推測で埋めない。** 判らないものは空のままにして、
     * 版IDで引き直す段に任せる。
     */
    if (!name && !checkpointResource?.modelVersionId) return null;

    const hashes = new Map();
    for (const [key, value] of Object.entries(parsed.hashes || {})) {
        const stem = key.replace(/^lora:/i, '').trim().toLowerCase();
        if (stem) hashes.set(stem, String(value || '') || null);
    }
    // **`Lora hashes` も読む**（I-20260831-24）。既に在る分は上書きしない。
    for (const [name, hash] of loraHashesIn(params)) {
        if (!hashes.has(name)) hashes.set(name, hash);
    }

    const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(params.size || '').trim());
    return {
        id: meta.id ?? null,
        title: meta.title ?? null,
        checkpoint: {
            // 判らないなら空のまま（版IDで引き直す段が埋める）。
            file_name: name || null,
            modelName: checkpointResource?.modelName ?? null,
            modelVersionId: checkpointResource?.modelVersionId ?? null,
            hash: params['model hash'] || null,
            strength: 1,
        },
        loras: loraTagsIn(parsed.positive).map(item => ({
            file_name: item.name,
            // **`weight` と `strength` を両方入れる。** 読む側が割れている
            // （記録の組み立ては `weight`、組み立て器は `strength`）。
            weight: item.strength,
            strength: item.strength,
            hash: hashes.get(item.name.toLowerCase()) || null,
        })),
        gen_params: {
            prompt: parsed.positive || '',
            negative_prompt: parsed.negative || '',
            seed: toNumber(params.seed),
            steps: toNumber(params.steps),
            cfg_scale: toNumber(params['cfg scale']),
            sampler: params.sampler || null,
            scheduler: params['schedule type'] || params.scheduler || null,
            clip_skip: toNumber(params['clip skip']),
            size: size ? `${size[1]}x${size[2]}` : (params.size || null),
            denoising_strength: toNumber(params['denoising strength']),
        },
        // **組み立て器がここを読む。** 埋め込みの解決や乱数源の判断を
        // 生の書式から決めているので、原文を渡さないと判断材料ごと落ちる。
        a1111_parameters: String(raw ?? ''),
        // 対応付けられなかった分も捨てない（後から人が照合できる）。
        civitai_resources: resources,
    };
}
