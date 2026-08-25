/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * 再現結果を参照画像と突き合わせて自己採点する。
 *
 * これまで再現の質を測っていたのは人間の目だけで、機械は「再現できるか」
 * しか見ていなかった。警告の分類（recipeWarningSeverity）は「builder が
 * 何をしたか」を語るが、**出てきた絵が参照とどれだけ違うか**は語らない。
 * ここはその欠けている側を埋める。
 *
 * ## 測れるもの／測れないもの（実測に基づく）
 *
 * レシピの参照画像は 480px 幅の WebP で、記録寸法の中央値 0.577 倍。
 * 等倍のものは 238 件中 **0 件**（2026-08-10 実測）。したがって
 * **鮮明さ・描き込み量の比較は原理的に無効**で、測れるのは配置と輝度だけ。
 *
 * ## 閾値の出どころ（2026-08-10・257レシピの再現出力で実測）
 *
 * 配置一致度（16x16 RGB のブロック平均どうしの相関）:
 *   一致対   中央値 0.475 / p25 0.201 / p75 0.787
 *   無関係対 中央値 0.036 / p95 **0.301**       ← DIVERGENT の根拠
 *   AUC 0.860
 * B-1 の懸念件数と単調に対応する（懸念0件 0.791 → 4件以上 0.261、r=-0.49）。
 * 懸念の分類を一切見ずに算出しているので、独立した裏取りになっている。
 *
 * 輝度比（再現/参照）:
 *   中央値 1.00 / p05 0.78 / p95 1.37
 *   比 <0.5 または >2.0 は 257件中 **5件**。5件とも目視で明確な別物だった
 *   （真っ黒に潰れた1件、画風ごと変わった1件ほか）。よってここは判定にする。
 *
 * ## 判定にしないもの
 *
 * 配置一致度は**順位づけであって合否ではない**。低い側13件を目視した内訳は
 * 明確な不一致 7 / 画角と細部だけの差 3 / 判断が割れる 3。画角がずれただけの
 * 再現を「失敗」と呼ぶと偽の不合格を作るので、文言は「目視を勧める」に留める。
 *
 * シードが記録されていないレシピは対象外にする。実測でその19件の中央値は
 * 0.089 で、無関係な画像どうし（0.036）とほぼ同じ。**種が違えば絵が違うのは
 * 当たり前**で、これを減点すると記録の欠落を再現の失敗として報告してしまう。
 */

import { t } from '../i18n/index.js';
export const GRID = 16;

/** 輝度比がこの範囲を外れたら、配置を見るまでもなく別物。 */
export const LUMA_RATIO_MIN = 0.5;
export const LUMA_RATIO_MAX = 2.0;

/** 無関係な画像どうしの95パーセンタイル。これ以下は無関係と区別できない。 */
export const LAYOUT_DIVERGENT = 0.30;
/** 一致対の中央値より上。ここを超えたら配置が合っていると言ってよい。 */
export const LAYOUT_CLOSE = 0.55;

export const VERDICT = {
    close: 'close',
    partial: 'partial',
    divergent: 'divergent',
    broken: 'broken',
    notComparable: 'not_comparable',
};

/**
 * ブロック平均どうしのピアソン相関。
 *
 * 分散が0の面（単色画像）は相関が定義できない。0 を返すと「無関係」と
 * 読めてしまうので null を返し、呼び出し側で判定不能として扱う。
 */
export function pearson(a, b) {
    if (!a?.length || a.length !== b?.length) return null;
    const n = a.length;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i += 1) {
        const xa = a[i] - ma;
        const xb = b[i] - mb;
        num += xa * xb; da += xa * xa; db += xb * xb;
    }
    if (da === 0 || db === 0) return null;
    return num / Math.sqrt(da * db);
}

/** グリッド（RGBの平坦配列）から平均輝度を出す。 */
export function meanLuma(grid) {
    if (!grid?.length) return 0;
    let sum = 0;
    for (let i = 0; i + 2 < grid.length; i += 3) {
        sum += 0.299 * grid[i] + 0.587 * grid[i + 1] + 0.114 * grid[i + 2];
    }
    return sum / (grid.length / 3);
}

/**
 * 参照グリッドと候補グリッドを比べる。
 *
 * 相関は **チャンネルごとに取ってから平均する**。RGBを1本に潰して相関を
 * 取ると別の統計量になり、同じ絵でも値が最大 0.27 ずれた（実測）。上の
 * 閾値はチャンネル別の分布から出しているので、ここを揃えないと判定が狂う。
 */
export function compareGrids(reference, candidate) {
    const channels = [];
    for (let channel = 0; channel < 3; channel += 1) {
        const a = [];
        const b = [];
        for (let i = channel; i < reference.length; i += 3) { a.push(reference[i]); b.push(candidate[i]); }
        channels.push(pearson(a, b));
    }
    const usable = channels.filter(value => typeof value === 'number' && Number.isFinite(value));
    const layout = usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
    const referenceLuma = meanLuma(reference);
    const lumaRatio = referenceLuma > 0 ? meanLuma(candidate) / referenceLuma : null;
    return { layout, lumaRatio };
}

/**
 * 判定。輝度の乖離を先に見る。配置の相関は、絵が丸ごと潰れていても
 * 偶然高く出ることがあるため、後段に置くと破綻を見逃す。
 */
export function classifyComposition({ layout, lumaRatio, hasRecordedSeed = true } = {}) {
    if (!hasRecordedSeed) {
        return { verdict: VERDICT.notComparable, reason: t('core.recipeCompositionScore.1') };
    }
    if (typeof lumaRatio === 'number' && Number.isFinite(lumaRatio)
        && (lumaRatio < LUMA_RATIO_MIN || lumaRatio > LUMA_RATIO_MAX)) {
        return {
            verdict: VERDICT.broken,
            reason: t('core.recipeCompositionScore.2', { p1: lumaRatio.toFixed(2) }),
        };
    }
    if (typeof layout !== 'number' || !Number.isFinite(layout)) {
        return { verdict: VERDICT.notComparable, reason: t('core.recipeCompositionScore.3') };
    }
    if (layout >= LAYOUT_CLOSE) {
        return { verdict: VERDICT.close, reason: t('core.recipeCompositionScore.4') };
    }
    if (layout < LAYOUT_DIVERGENT) {
        return {
            verdict: VERDICT.divergent,
            reason: t('core.recipeCompositionScore.5'),
        };
    }
    return { verdict: VERDICT.partial, reason: t('core.recipeCompositionScore.6') };
}

/**
 * ピクセル配列を n×n のRGBグリッドへ箱平均で落とす。
 *
 * canvas の `drawImage` による縮小に任せると、実装ごとに再標本化が違う。
 * 上の閾値は箱平均で測った分布から出しているので、そこを合わせないと
 * 同じ絵に別の判定が出る（実測: 平滑化される分だけ相関が最大 0.24 高く出た）。
 */
export function boxGrid(data, width, height, size = GRID) {
    if (!data?.length || !width || !height) return null;
    // グリッドより小さい絵は空セルを生み、そこが黒として相関に効く。
    // 0 で埋めて返すと「暗い側がずれている」という嘘の観測になる。
    if (width < size || height < size) return null;
    const grid = new Float64Array(size * size * 3);
    const counts = new Float64Array(size * size);
    for (let y = 0; y < height; y += 1) {
        const gy = Math.min(size - 1, Math.floor(y * size / height));
        for (let x = 0; x < width; x += 1) {
            const gx = Math.min(size - 1, Math.floor(x * size / width));
            const cell = gy * size + gx;
            const src = (y * width + x) * 4;
            grid[cell * 3] += data[src];
            grid[cell * 3 + 1] += data[src + 1];
            grid[cell * 3 + 2] += data[src + 2];
            counts[cell] += 1;
        }
    }
    for (let cell = 0; cell < counts.length; cell += 1) {
        const n = counts[cell] || 1;
        grid[cell * 3] /= n; grid[cell * 3 + 1] /= n; grid[cell * 3 + 2] /= n;
    }
    return grid;
}

/** 画像URLを n×n のRGBグリッドに落とす。ブラウザ専用。 */
export async function loadGrid(url, { size = GRID, documentRef = globalThis.document, ImageRef = globalThis.Image } = {}) {
    if (typeof url !== 'string' || !url) return null;
    const image = await new Promise((resolve, reject) => {
        const element = new ImageRef();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error(t('core.recipeCompositionScore.7', { p1: url })));
        element.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return null;
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    // 等倍で置いてから自前で平均する。アスペクトは無視して正方へ潰すので、
    // 寸法が違う再現でも比較できる。
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    return boxGrid(data, width, height, size);
}

/**
 * 候補一覧を参照画像に対して採点する。
 *
 * 読み込みに失敗した候補は落とさず `notComparable` で返す。黙って消すと
 * 「採点されなかった候補」が「問題なし」に見えてしまう。
 */
export async function scoreCandidates(referenceUrl, candidates, options = {}) {
    const { hasRecordedSeed = true, load = loadGrid } = options;
    const list = Array.isArray(candidates) ? candidates : [];
    let reference = null;
    try {
        reference = await load(referenceUrl, options);
    } catch (error) {
        reference = null;
    }
    if (!reference) {
        return list.map(candidate => ({
            candidate,
            verdict: VERDICT.notComparable,
            reason: t('core.recipeCompositionScore.8'),
            layout: null,
            lumaRatio: null,
        }));
    }
    return Promise.all(list.map(async candidate => {
        let grid = null;
        try {
            grid = await load(candidate?.url, options);
        } catch (error) {
            grid = null;
        }
        if (!grid) {
            return {
                candidate,
                verdict: VERDICT.notComparable,
                reason: t('core.recipeCompositionScore.9'),
                layout: null,
                lumaRatio: null,
            };
        }
        const measured = compareGrids(reference, grid);
        return { candidate, ...measured, ...classifyComposition({ ...measured, hasRecordedSeed }) };
    }));
}
