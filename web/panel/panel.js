/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * Unbake の面。**`el` を受け取って中を描く1コンポーネント。**
 *
 * サイドバーにも全画面コンテナにも**同じものを差す**。切り替えは
 * 「どの `el` に差すか」だけで、中身は1つしか無い（決定⑤）。
 *
 * ---
 *
 * **狭い器で件数が増えると使えなくなる問題への答え。**
 *
 * 素直に一覧を並べると、300px の桁にレコードが増えた分だけスクロールが伸びる。
 * **解き方を「仮想スクロール」にしない**——それは長い列を速くするだけで、
 * 「目的の1件に辿り着けない」という問題は残る。ここでは3つを組み合わせる:
 *
 *   1. **要約を先に出す。** 判定ごとの件数を常に上に置く。
 *      スクロールしなくても**全体の形**が分かる。
 *   2. **描く前に絞る。** 検索と判定フィルタで、描画する集合そのものを小さくする。
 *   3. **狭いときは行数に上限を置く。** 残りは件数として示し、全画面へ送る。
 *      **サイドバーのスクロール量がデータ量に比例しなくなる**のがこの3番目の効果で、
 *      1・2 だけでは「絞り込みを間違えたときに元の地獄へ戻る」。
 *
 * ---
 *
 * **語の使い分け（2026-08-20 ユーザー決定）**
 *
 *   主語     … 日本語は **「記録」**（レシピ3字より短い）／英語は `Record`／
 *              正式名は `Generation Record`。見出しは長短を両方描いて CSS で出し分ける。
 *   「レシピ」… **LoRA Manager が書き出したものを名指しするときだけ**使う。
 *              主語にはしない——**受け取る4経路のうち3つはレシピではない**からで
 *              （Civitai の画像・ローカルの PNG・ComfyUI の出力）、
 *              主語にした瞬間に名前と中身が合わなくなる。
 *   `recipe` … 内部識別子としてはそのまま（決定④・510回は変えない）。
 *
 * ---
 *
 * **密度は `mode` ではなく器の幅で決める。** `mode` で分けると
 * 「サイドバー用の実装」と「全画面用の実装」に割れて、決定⑤が崩れる。
 * 幅で決めれば**同じコードが両方を出す**し、全画面を狭くすれば同じ挙動になる。
 */

import { DROP_ROUTES, UNSUPPORTED_CODES, routeDrop } from './dropRouting.js';

/**
 * 扱えなかった種類ごとの文言。**表で持つ**——鍵を組み立てると、
 * 訳の足し忘れが画面に `[鍵]` として出るまで気づけない。
 */
const UNSUPPORTED_LOG = { [UNSUPPORTED_CODES.CIVITAI_POST]: 'log.civitaiPost' };

/**
 * 走っている間の印（2026-08-24 利用者の指示「アイコンで示して」）。
 *
 * **語ではなく印にする。** ここはタイルの上にも並ぶので、字を入れると
 * 横に伸びて枠から出る（同じ理由で通常時も `▶` だけにしてある）。
 * **回すのは CSS 側**——`prefers-reduced-motion` で止められるように。
 */
const BUSY_GLYPH = '⟳';

/**
 * **待たされている**印（2026-08-24 利用者の指示）。
 *
 * 走っている `⟳` は回るが、**こちらは動かない**——「受け付けて処理中」と
 * 「今は取られていて始まっていない」は、別の状態として見えないといけない。
 */
const HELD_GLYPH = '⏸';
import { createSettingsView } from './settingsView.js';
import { createVariantsView, outputViewUrl } from './variantsView.js';
import { createRaindropView, imageIdOfRecord } from './raindropView.js';
import { createConfirmView, sizeText } from './confirmView.js';
import { createModelsView } from './modelsView.js';
import { createModelPicker } from './modelPicker.js';
import { createDonateView } from './donateView.js';
import {
    applyRecordOverrides, getLoraOverride, getModelOverride, setLoraOverride, setModelOverride,
} from '../core/recipeLoraOverrides.js';
import { createDetailView } from './detailView.js';
import { applySkin, normalizeSkin } from './skin.js';
import { createBatchRunner } from '../core/batchRunner.js';
import { QUEUE_NOT_EMPTY, sweepableRecord } from '../core/sweepRunner.js';
import { getDirection, t } from '../i18n/index.js';
import { readStored, writeStored } from '../core/storage.js';
import { createRecipeWorkflowName } from '../core/recipeWorkflowName.js';
import { classifyMissing } from '../core/recipeMissingModels.js';
import { estimateDownloadSize, formatBytes } from '../core/downloadSizeEstimate.js';

/**
 * 判定の並び。**文言は持たず鍵だけ持つ**——ここに文字列を書くと、
 * 言語を足すたびにこの配列を触ることになる。
 *
 * `pending` は「まだ組んでいない」で、**「不足」とは別**。
 * レシピの86%はグラフを持たず、`buildRecipeWorkflow()` を通して初めて可否が決まる
 * （実測346件中298件）。混ぜると、組む前のものが理由もなく捨てられたように見える。
 */
const VERDICTS = ['reproducible', 'approximate', 'blocked', 'pending'];

/**
 * 取得の結果 → 理由を出す文言の鍵。**組み立てず、鍵をそのまま書く。**
 *
 * 組み立てると**カタログに在るかを機械で確かめられない**——検査から見えるのは
 * 断片だけで、鍵の抜けは画面に `[download.why.foo]` が出るまで分からない
 * （判定の語で同じことを踏んである）。
 */
const WHY_KEYS = {
    already: 'download.why.already',
    failed: 'download.why.failed',
};

/**
 * 落とせなかった理由の**種類** → 文言の鍵（2026-08-23 利用者の指示）。
 *
 * **文言を読んで種類を当てない。** サーバが `code` で返す——「HTTP 404」と
 * 「could not reach the Civitai API」が**同じこと（もう配布されていない）**を
 * 指すことは、文言からは読めない（実データの失敗5件がその2つだった）。
 *
 * 鍵は**組み立てず字で書く**。組み立てると、抜けが画面に出るまで判らない。
 */
const FAIL_CODES = {
    gone: 'download.fail.gone',
    forbidden: 'download.fail.forbidden',
    network: 'download.fail.network',
    corrupt: 'download.fail.corrupt',
    space: 'download.fail.space',
    setup: 'download.fail.setup',
    unknown: 'download.fail.unknown',
};

/** 種類の並び。**打つ手のある側を先に出す。** */
const FAIL_ORDER = ['forbidden', 'network', 'space', 'corrupt', 'setup', 'gone', 'unknown'];

/**
 * 絞り込みに出す判定（2026-08-23 利用者の指示で `pending` を外した）。
 *
 * **`pending` は通り道であって行き先ではない。** 開いた直後は全件がこれで、
 * 判定を回し終えると 0 になる——つまり見出しには常に「未確認 0」が居座る。
 *
 * **記録の側からは消えない。** タイルには今までどおり印が出るので、
 * 判定が回らなかった1件は見つけられる。消したのは*集計の欄*だけ。
 */
const CHIP_VERDICTS = VERDICTS.filter(key => key !== 'pending');

/**
 * 土台モデルの系統を、**短い札**にする（2026-08-23 利用者の指示・LoRA Manager を参考に）。
 *
 * 実データ350件で出た値と件数（2026-08-23 実測）:
 * Illustrious 207 / Pony 70 / Flux.1 D 17 / 無し 16 / Anima 11 / SD 1.5 7 /
 * NoobAI 6 / Krea 2 5 / ZImageTurbo 3 / SDXL 1.0 3 / Other 2 / 残り3種は各1。
 *
 * **知らない名前も出す。** 表から落とすと、新しい系統が出たときだけ札が消える
 * ——「対応していない」ではなく「この記録には無い」と読まれてしまう。
 * 短くする規則（英数だけ・大文字・8文字まで）を当てて、そのまま出す。
 */
export function baseModelBadge(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const known = {
        'illustrious': 'IL',
        'pony': 'PONY',
        'flux.1 d': 'F1D',
        'flux.1 s': 'F1S',
        'flux.1 kontext': 'F1K',
        'anima': 'ANI',
        'sd 1.5': 'SD1.5',
        'sd 2.1': 'SD2.1',
        'sd 3.5': 'SD3.5',
        'noobai': 'NAI',
        'krea 2': 'KREA',
        'zimageturbo': 'ZIMG',
        'sdxl 1.0': 'SDXL',
        'sdxl turbo': 'SDXL-T',
        'sdxl lightning': 'SDXL-L',
        'openai': 'OAI',
        'other': 'OTHER',
    };
    const hit = known[text.toLowerCase()];
    if (hit) return hit;
    // Wan Video 14B i2v 480p のような長い名前は、頭から詰めて8文字まで。
    return text.toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 8) || text.slice(0, 8);
}

/**
 * 判定 → 文言の鍵。**組み立てず、鍵をそのまま書く。**
 *
 * 最初は `t('verdict.' + key + '.long')` と組み立てていたが、そうすると
 * **カタログに在るかを機械で確かめられない**——検査から見えるのは `'verdict.'` という
 * 断片だけで、鍵の抜けは実行して `[verdict.foo.long]` が画面に出るまで分からない。
 * 冗長でも literal で書く。
 */
const VERDICT_CODES = {
    reproducible: { long: 'verdict.reproducible.long', short: 'verdict.reproducible.short' },
    approximate: { long: 'verdict.approximate.long', short: 'verdict.approximate.short' },
    blocked: { long: 'verdict.blocked.long', short: 'verdict.blocked.short' },
    pending: { long: 'verdict.pending.long', short: 'verdict.pending.short' },
};
const verdictLong = (key) => (VERDICT_CODES[key] ? t(VERDICT_CODES[key].long) : String(key));

/**
 * 判定に添える一言。**「再現可」を「同じ絵が出る」と読ませない。**
 *
 * この判定が言えるのは「組むのに要るものが揃っている」ことだけで、
 * サンプラーの実装差・計算精度・GPU の違いは**判定の外**にある。
 * 実際、記録と同じ条件で回しても画素は一致しないことがある——
 * だから **`再現可` が出ている所には必ずこの一言を添える**（吹き出しと読み上げ）。
 */
function verdictNote(key) {
    return key === 'reproducible' ? t('verdict.reproducible.caveat') : '';
}

/** 判定の吹き出し。**語＋（あれば）注意**。 */
function verdictTitle(key) {
    const note = verdictNote(key);
    return note ? `${verdictLong(key)} — ${note}` : verdictLong(key);
}
const verdictShort = (key) => (VERDICT_CODES[key] ? t(VERDICT_CODES[key].short) : String(key));

/** 一覧の見せ方。**モードではなく器**——記録も絞り込みも並びも共通で、変わるのは並べ方だけ。 */
export const LIST_VIEWS = new Set(['table', 'tiles']);

/** 狭い器と判断する幅。ComfyUI のサイドバー既定はこれより狭い。 */
export const COMPACT_WIDTH = 520;

/**
/**
 * 最後に測れた器の幅を覚えておく鍵。
 *
 * **再起動の直後は測れないことがある。** ComfyUI はサイドバーの幅を
 * `localStorage['unified-sidebar']` に割合で持っていて、**復元がこちらの描画より
 * 後**に起きうる。測り直しは 0/50/250/1000ms と `ResizeObserver` で張ってあるが、
 * **まだ配置されていない要素へ張った監視は後から挿入されても鳴らない**（実機で踏んだ穴）。
 * 復元が遅いと、広げてあるのに狭い版のまま固まる。
 *
 * だから**前回測れた幅を初期値にする**。実測より弱い根拠なので、
 * **測れた瞬間に上書きされる**——食い違っても最初の1回の描画だけの話に留まる。
 */
const LAST_WIDTH_KEY = 'unbake.panel.last_width';

/**
 * 並び替えに使える軸。**設定から来た未知の値は既定へ落とす**
 * ——落とさないと、綴り違いで一覧が黙って元の順のままになる。
 */
export const SORT_KEYS = new Set(['modified', 'title', 'checkpoint', 'verdict', 'favorite']);

/** 判定の並び（再現できるものを上へ）。 */
const VERDICT_RANK = { reproducible: 0, approximate: 1, pending: 2, blocked: 3 };

function positiveOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** 一覧の並び。**同着は id で決める**——決めないと描くたびに順が動く。 */
/**
 * 並べ替え。**向きを外から渡せる**（2026-08-22 利用者の指示）。
 *
 * 元は鍵ごとに向きが決め打ちで、画面から変えられなかった——「新しい順」しか無く、
 * **古い順に見たい**が言えなかった。`descending` は「その鍵にとって自然な向き」を
 * 基準にした反転で、鍵ごとの自然な向きは下の `compare` が持つ
 * （日付は新しい順、名前は五十音順、判定は良い順が自然）。
 */
/** 並び替えの名札。**`t(`sort.${key}`)` の形で書かない**（鍵の走査に映らない）。 */
function sortLabel(key) {
    if (key === 'modified') return t('sort.modified');
    if (key === 'title') return t('sort.title');
    if (key === 'checkpoint') return t('sort.checkpoint');
    if (key === 'verdict') return t('sort.verdict');
    if (key === 'favorite') return t('sort.favorite');
    return String(key);
}

function sortRecords(list, key, groupByCheckpoint, descending = false) {
    const idOf = (record) => String(record?.id ?? '');
    const compare = (a, b) => {
        switch (key) {
            case 'title':
                return String(a?.title ?? '').localeCompare(String(b?.title ?? ''));
            case 'checkpoint':
                return modelName(a?.checkpoint).localeCompare(modelName(b?.checkpoint));
            case 'verdict':
                return (VERDICT_RANK[a?.verdict] ?? 9) - (VERDICT_RANK[b?.verdict] ?? 9);
            case 'favorite':
                // **お気に入りが先。** 実データで `favorite: true` は64件。
                return (b?.favorite === true ? 1 : 0) - (a?.favorite === true ? 1 : 0);
            case 'modified':
            default:
                // **既定は新しい順。** 一覧の主語は「最近いじった記録」。
                return Number(b?.modified ?? 0) - Number(a?.modified ?? 0);
        }
    };
    // **同点は id で決める。** ここを入れないと並びが実行ごとに揺れて、
    // 「押すたびに並びが変わる」に見える。**向きを反転しても同点の解き方は変えない**
    // ——反転するのは主の鍵だけで、安定性は保つ。
    const direction = descending ? -1 : 1;
    const sorted = [...list].sort((a, b) => (compare(a, b) * direction) || idOf(a).localeCompare(idOf(b)));
    if (!groupByCheckpoint) return sorted;
    // **モデルでまとめる。** まとめた中の順序は上の並びのまま。
    const groups = new Map();
    for (const record of sorted) {
        const name = modelName(record?.checkpoint);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(record);
    }
    return [...groups.values()].flat();
}

/**
 * まとめが入っているときの切れ目。**並びは1件も動かさない**——連なりを数えるだけ。
 *
 * **なぜ要るか。** `sortRecords` は日付で並べた後にモデルでクラスタ化するので、
 * 「新しい順」でも2番目に新しい記録が一番上の次に来ない——実機で
 * 「取り込んだ記録の次に、その次に新しい記録が続くはず」と報告された（2026-08-25）。
 * 並びは設定どおりで正しいのに、**まとめが効いていることが画面のどこにも出ていない**
 * のが正体だった。名札を挟めば、続いている理由がその場で読める。
 *
 * @param {object[]} list 並べ終えた記録
 * @returns {{name: string, raw: string, records: object[]}[]} 連なりごとの塊
 */
export function checkpointRuns(list) {
    const runs = [];
    for (const record of list || []) {
        const name = modelName(record?.checkpoint);
        const last = runs.at(-1);
        // **同じ名前でも、離れていれば別の塊。** 隣り合わせだけを1つにする
        // ——並びを組み替えないと決めた以上、飛び地は飛び地のまま出す。
        if (last && last.name === name) {
            last.records.push(record);
            continue;
        }
        const raw = String(record?.checkpoint ?? '');
        // **名札は文字数で切らない。** 表のモデル列は狭いので `shorten` で
        // 切っているが、名札は1行を丸ごと使えるので、**幅に合わせて CSS が切る**
        // ——実機で `hassakuXLIllustrious_v13Sty…` と、広い所でも切れていた。
        const label = raw.replaceAll('\\', '/').split('/').at(-1) || '';
        runs.push({ name, raw, label, records: [record] });
    }
    return runs;
}

function makeElement(documentRef, tag, attributes = {}, children = []) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
}

/** 表示用に短くする。**元の値は record に残っている。** */
/**
 * 一覧に出す名前。**出す絵のファイル名と同じ規則で作る。**
 *
 * 記録の題は上流（LoRA Manager）が付けた `Civitai_Recipe_137337754` で、
 * こちらが出す絵は `civitai_137337754_00001_.png`。**同じものが2つの名前を持つ**ので、
 * 出力フォルダと一覧を突き合わせるたびに読み替えが要る（実測: 出力3,110枚のうち
 * 2,410枚が旧い名前だった）。名前を作る規則は既に1箇所にあるので、それをそのまま使う。
 *
 * **元の題は捨てない。** 行の吹き出しと絞り込みの対象には残す
 * ——上流の画面で見た名前で探せなくなると、突き合わせが逆に難しくなる。
 */
export function displayName(record) {
    const raw = String(record?.title ?? '').trim();
    const named = createRecipeWorkflowName(record);
    // **書き換えるのは `civitai_<id>` になるものだけ。**
    // 名前を作る側はファイル名を作る道具なので、`my local png` を
    // `my_local_png` のように**安全な字へ潰す**。画面の名前にそれを使うと、
    // Civitai 由来でない記録（落とし込んだ手元の画像など）の題が
    // 理由もなく崩れる。揃えたいのは**出す絵と対になる名前**だけ。
    if (/^civitai_\d+$/.test(named)) return named;
    return raw || String(record?.id ?? '');
}

function shorten(value, max = 28) {
    const text = String(value ?? '');
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
}

function modelName(value) {
    return shorten(String(value ?? '').replaceAll('\\', '/').split('/').at(-1) || '—');
}

/**
 * 面を1つ作って `el` の中に描く。
 *
 * @param {HTMLElement} el 差し込み先。**サイドバーでも全画面でも同じ扱い。**
 * @param {object} options
 * @param {'sidebar'|'fullscreen'} [options.mode] 表示の名札だけに使う（**挙動は変えない**）
 * @param {(drop: object) => Promise<{records?: object[], errors?: string[]}>} [options.ingest]
 *   振り分け結果を Generation Record へ変える。**取得と解析は呼び手の責務。**
 * @param {() => void} [options.onRequestFullscreen] 「全画面で開く」を押されたとき
 * @param {Document} [options.documentRef] テスト用の差し替え口
 * @param {number} [options.width] 器の幅（`ResizeObserver` が無い環境用）
 * @param {(record: object) => object} [options.makeSweepRunner] 記録1件ぶんの `SweepRunner`
 *   を作る。**判定材料（`/object_info`）を持っているのはホストだけ**なので、
 *   面は作り方を知らない。渡されなければ Sweep は開かない。
 * @param {(cell: object, record: object) => Promise<void>} [options.onCaptureSweepCell]
 *   出たセルを記録として取り込む（Sweep → 記録 → Sweep の輪を閉じる）
 * @param {{list: (options: {page: number}) => Promise<object>}} [options.raindropIo]
 *   「あとで読む箱」を読む口（裁定⑦）。**読むだけ**——取り込みは `ingest` を通す。
 *   渡されなければ入口そのものを出さない。
 */
export function createUnbakePanel(el, {
    mode = 'sidebar',
    ingest = null,
    onRequestFullscreen = null,
    documentRef = null,
    width = null,
    makeSweepRunner = null,
    /**
     * 出た絵を1枚消す口（2026-08-25 利用者の指示）。
     * `({filename, subfolder}) => Promise<{ok, error}>`。**無ければ口を出さない。**
     */
    deleteOutputIo = null,
    /**
     * 宿主のキューの混み具合を読む口。`() => Promise<{running, pending}>`。
     * **無ければ待たない**（今まで通り、実行器が断ったところで終わる）。
     */
    hostQueue = null,
    /**
     * その記録が**そもそも組めるか**を確かめる口。`(recipe) => {ok, error}`。
     *
     * **代理の印で判断しない。** 実データ350件で測ると、判定の `norecord` は
     * 組めない8件を全部含むが**組める20件も巻き込む**——それで押せなくすると、
     * 出せる記録が出せなくなる。組めるかは組んでみれば判る。
     */
    canBuild = null,
    onCaptureSweepCell = null,
    /**
     * 出た絵から設定を読み取る口。`(item) => Promise<{ok, params, reason}>`。
     *
     * **`onCaptureSweepCell` の逆向き。** 絵を取りに行くのはホストの仕事なので
     * （`/api/view` を叩ける口を持っているのはあちらだけ）、面は結果だけ受け取る。
     */
    onExtractParams = null,
    loadRecord = null,
    settingsIo = null,
    display = null,
    loadVariants = null,
    batchIo = null,
    downloadIo = null,
    openInComfy = null,
    favoritesIo = null,
    raindropIo = null,
    recordsIo = null,
    modelsIo = null,
    /**
     * 手元に在るモデルの名前。**差し替えは在る物からしか選ばせない**
     * ——無い物を選ばせると、組み立てがその LoRA を鎖から外すか、
     * ComfyUI が投入を拒む（選ばせてから落とすより、最初から並べない）。
     *
     * `async (kind) => string[]`。読めなければ空配列を返す。
     */
    loadInstalledModels = null,
} = {}) {
    if (!el || typeof el.append !== 'function') {
        throw new TypeError('createUnbakePanel: needs a container element to render into');
    }
    // 差し込み先が属する document を使う。**大域の `document` を掴まない**
    // ——器が違っても同じ関数で描けることが決定⑤の全部で、
    // 大域を掴むとテストからも別 document からも差せなくなる。
    const doc = documentRef || el.ownerDocument || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    // --- 表示の設定（裁定⑥: **閾値で持つ・モードは足さない**）------------
    //
    // 既定は下の定数のまま。設定が来たときだけ差し替える——**設定を読めない
    // 環境でも面は開く**（読めないことと 0 を混ぜない）。
    /** 詰めた見せ方へ切り替わる幅。**`let`**（設定で変えたらその場で測り直す）。 */
    let compactWidth = positiveOr(display?.compactWidth, COMPACT_WIDTH);
    /** 前回測れた幅。**測れたら必ず上書きする。** */
    const rememberedWidth = positiveOr(readStored(LAST_WIDTH_KEY, null), null);
    let sortKey = SORT_KEYS.has(String(display?.sortKey)) ? String(display.sortKey) : 'modified';
    /** 並びの向き。**既定は鍵ごとの自然な向き**（日付なら新しい順）。 */
    /**
     * 並びを**逆さにする**か（既定は素のまま）。
     *
     * **鍵ごとに「自然な順」が違う。** 日付は新しい順、お気に入りは先、
     * 名前は A→Z。1つの旗で全部を「昇順/降順」と呼ぶと嘘になるので、
     * ここは**反転するかどうか**だけを持ち、**今どちらなのかは言葉で出す**
     * （2026-08-25 実機: 取り込んだばかりの記録が一番上に来ない、の正体は
     * この旗が立っていたこと。矢印だけでは何が起きるか読めなかった）。
     */
    let sortDescending = display?.sortDescending === true;
    /** 一覧の見せ方。**表とタイルは同じ記録・同じ絞り込みを描く**（データは1つ）。 */
    let listView = LIST_VIEWS.has(String(display?.listView)) ? String(display.listView) : 'table';
    /**
     * タイルの**大きさ**。0 は「幅に合わせる」、1 が最大で 4 が最小。
     *
     * **列数では持たない。** 列数で固定すると、全画面で横に広げたときに
     * 1枚が際限なく大きくなるか、右が余るかのどちらかになる（実機で後者が起きた）。
     * 大きさで持てば**広い画面では列が自動で増える**——1枚の見え方は変わらない。
     */
    let tileSize = Math.max(0, Math.min(4, Number(display?.tileSize) || 0));
    /**
     * モデルごとにまとめるか。**`const` にしない。**
     *
     * 元は読み込み時の値で固定していたので、設定で切っても**ページを
     * 読み直すまで並びが変わらなかった**（2026-08-25 実機）。並びを変える
     * 設定が、切った直後に効かないと「効いていない」と読まれる。
     */
    let groupByCheckpoint = display?.groupByCheckpoint === true;
    /** 商用可否の列を出すか。**同じ理由で `let`**（列の増減はその場で効くこと）。 */
    let showCommercialOk = display?.showCommercialOk !== false;
    /**
     * 消す前に確認を出すか（2026-08-22 利用者の指示で切れるようにした）。
     *
     * **切っても結果は黙らせない。** 確認を出さないことと、何が起きたかを
     * 伝えないことは別なので、消したものは履歴へ必ず出す。
     */
    let confirmBeforeDelete = display?.confirmBeforeDelete !== false;
    /** 判定の配色。**色だけに頼らないうえで、色そのものも選べるようにする。** */
    let verdictPalette = display?.verdictPalette === 'deuteranopia' ? 'deuteranopia' : 'default';
    /**
     * 見た目を厚くするか（2026-08-24 利用者の指示）。
     *
     * **旗は1本。** 影・浮き上がり・動きを全部この属性の下へ閉じ込めてあるので、
     * 切ったときの見た目が「元のまま」であることが構造で決まる
     * ——項目ごとに切ると、切ったつもりで残る所が必ず出る。
     */
    let richUi = display?.richUi !== false;
    /**
     * 大きすぎる再現を縮める上限（メガピクセル）。**0 は記録どおり。**
     *
     * 記録どおりの寸法では復号できない機械が在り、そこでは**絵が1枚も出ない**
     * （2026-08-25 実機 `civitai_87384188`）。小さくても出るほうが使える。
     */
    let replayMaxMegapixels = Number.isFinite(Number(display?.replayMaxMegapixels))
        ? Math.max(0, Number(display.replayMaxMegapixels)) : 4.5;
    /**
     * 画面の作り（2026-08-25 利用者の指示「テーマ2を作れ・却下する可能性がある」）。
     *
     * **既定は `classic`＝今までの面そのもの。** テーマ2の指定は別の紙に
     * 全部入っていて、選ばれていない間は**読み込みもしない**——
     * だから捨てるときに、この行と `data-skin` を消せば跡が残らない。
     */
    let uiSkin = normalizeSkin(display?.uiSkin);

    /** 見た目のテーマ。既定は琥珀。 */
    let theme = ['host', 'amber', 'ember', 'moss', 'paper'].includes(String(display?.theme))
        ? String(display.theme) : 'host';

    /** @type {object[]} 新しいものが先頭。 */
    let records = [];
    /**
     * 選んだ記録の id。**絞り込みとは別物。**
     *
     * 絞り込みは「何が見えるか」で、選択は「これに何かする」。混ぜると、
     * 絞り込みを変えた瞬間に**操作の対象が黙って入れ替わる**——
     * 束で回すのも落とすのも取り返しがつかないので、対象は明示させる。
     *
     * **見えなくなっても選択は消さない。** 絞り込みを変えて確かめてから
     * 戻ってくる、という使い方を壊さないため。ただし**操作するのは
     * 「選ばれていて、かつ今見えているもの」**だけにする（下の `chosenRecords`）
     * ——画面に出ていないものを動かさない、という決めごとは変えない。
     */
    const selected = new Set();
    /** 範囲選択の起点。**Shift+クリックで「ここから」を決める。** */
    let anchorId = null;
    let query = '';
    /**
     * 隠している判定。**「見せる方」ではなく「隠す方」を持つ**
     * ——見せる方で持つと、判定の種類が増えた日に**新しい判定が既定で隠れる**。
     */
    const hidden = new Set(
        (Array.isArray(display?.hiddenVerdicts) ? display.hiddenVerdicts
            : Array.isArray(display?.hidden_verdicts) ? display.hidden_verdicts : [])
            .map(String),
    );
    let density = 'full';
    /** 開いている Sweep の面。**同じ器の中で一覧と差し替わる。** */
    // **「振る」の面は畳んだ**（2026-08-22 利用者の指示）。中身は詳細へ移した。
    // 名前だけ残すのは、閉じる口（`closeOverlays`）と検査が「出ていないこと」を
    // 見ているから——**出す道はもう無い**。
    let sweepView = null;
    /** 開いている設定の面。Sweep と同じ扱い（窓は開かない）。 */
    /** 浮かべている器。**閉じるときに中身と一緒に片付ける。** */
    const openLayers = new Set();

    /**
     * 走っている記録の id。**DOM ではなくここに持つ**（2026-08-24）。
     *
     * **これが「押したら印が消える」の真因だった。** タイルの操作列は
     * `opacity: 0` で普段は見えておらず、タイルを hover したときだけ浮かび上がる。
     * そこへ**一覧の描き直し**が重なると、ボタンは作り直されて `data-busy` を失い、
     * 列ごと `opacity: 0` へ戻る——**色の問題ではなかった。**
     *
     * 走っているのは**記録**であってボタンではないので、
     * **描き直しても残る場所**へ置く。
     */
    const busyRecords = new Set();

    /**
     * 走っている記録ごとの、**今画面に居るボタン**。
     *
     * **押した相手を戻すだけでは足りない**（2026-08-24 に検査が捕まえた）。
     * 押した処理が一覧を描き直すと**新しいボタンが作られ**、
     * 作った時点では `busyRecords` に居るので**走っている姿で生まれる**。
     * その後で終わっても、戻しに行くのは**もう画面に居ない古いボタン**なので、
     * **新しい方が押せないまま固まる**——お気に入りを2度押しできなくなっていた。
     */
    const busyButtons = new Map();

    /**
     * **順番待ちの記録**（2026-08-24 利用者の指示）。
     *
     * 元は「他の生成が走っていたら断る」だった。断る理由は
     * **他人の生成に混ぜない**（出た画像がどの投入から来たか辿れなくなる）ことで、
     * それ自体は今も正しい。**変えたのは、断ってから先。**
     *
     * **自分で並べて、1件ずつ流せば混ざらない。** ComfyUI のキューへ入れるのは
     * いつでも1件だけなので、**混ぜない約束は保ったまま**「押したら順に回る」にできる。
     *
     * 走っている記録と同じく、**DOM ではなくここに持つ**——描き直しで消えないため。
     */
    const heldRecords = new Set();
    /** 順番待ちの本体。**先に押したものから流す。** */
    const replayQueue = [];
    /** 流し役が動いているか。**2本走らせない**（走らせると混ざる）。 */
    let replayPumping = false;
    /** 待っている記録ごとの、いま画面に居るボタン（`busyButtons` と同じ理由）。 */
    const heldButtons = new Map();

    /**
     * 再現のボタンを**記録ごとに覚える**。
     *
     * **待ちと走りで別々の登録簿を持たない。** 分けると、
     * `clearBusy` が消した側だけ登録が落ちて**もう片方の姿を当てられなくなる**
     * （実際に「1件目が走っていない」で検査が捕まえた）。
     * 状態は `busyRecords` / `heldRecords` が持ち、ここは**宛先**だけを持つ。
     */
    const replayButtons = new Map();

    function trackReplay(key, button) {
        if (!key) return;
        if (!replayButtons.has(key)) replayButtons.set(key, new Set());
        replayButtons.get(key).add(button);
    }

    /** その記録の全ボタンへ、いまの状態（走り／待ち／押せる）を当て直す。 */
    function applyReplayState(key) {
        for (const button of replayButtons.get(key) || []) {
            if (busyRecords.has(key)) { applyHeld(button, false); applyBusy(button, true); }
            else if (heldRecords.has(key)) { applyBusy(button, false); applyHeld(button, true, t('replay.queued')); }
            else { applyBusy(button, false); applyHeld(button, false); }
        }
    }

    function trackHeld(key, button) {
        if (!key) return;
        if (!heldButtons.has(key)) heldButtons.set(key, new Set());
        heldButtons.get(key).add(button);
    }

    function clearHeld(key) {
        heldRecords.delete(key);
        for (const button of heldButtons.get(key) || []) applyHeld(button, false);
        heldButtons.delete(key);
    }

    /** 鍵に紐づくボタンを1つ覚える（描き直しのたびに増える）。 */
    function trackBusy(key, button) {
        if (!key) return;
        if (!busyButtons.has(key)) busyButtons.set(key, new Set());
        busyButtons.get(key).add(button);
    }

    /** その鍵で走っている**全部**のボタンを押せる状態へ戻す。 */
    function clearBusy(key) {
        busyRecords.delete(key);
        for (const button of busyButtons.get(key) || []) applyBusy(button, false);
        busyButtons.delete(key);
    }

    /**
     * ボタン1つへ「走っている／いない」を当てる。
     *
     * **押せる状態の字は器で違う**（タイルは印だけ・行は語も出る）ので、
     * **作り直さずに控えて戻す**。控えは要素へ持たせる——
     * 一覧が描き直されても、新しいボタンは自分の字を自分で控える。
     */
    /**
     * **待てば通る断りを、動かない印で示す**（2026-08-24 利用者の指示）。
     *
     * 他の生成が走っている間に押すと、Unbake は**混ぜずに断る**
     * （どの投入から出た絵かを辿れなくするため）。だが押した人は何も間違えていない。
     *
     * **走っている `⟳` と同じ姿にしない。** 受け付けたように見えて何も起きない。
     * **止まった印なら「今は取られている」と読める。**
     *
     * **しばらくで元へ戻す。** 残すと、後から見た人には「壊れたボタン」に見える。
     */
    /**
     * ボタン1つへ「順番待ち／そうでない」を当てる。
     *
     * **走っている姿とは別**（`applyBusy` と同じ形にしてあるのは、
     * 描き直しに耐える置き場を1つの作法で揃えるため）。
     *
     * **時間で消さない。** 元は4秒で戻していたが、あれは「断った」を知らせる印だった。
     * 今は**順番が来るまで本当に待っている**ので、消すと**待っていることが画面から消える**。
     */
    /**
     * 再現を**順番待ちへ入れる**（2026-08-24 利用者の指示）。
     *
     * **押した順に、1件ずつ流す。** ComfyUI のキューへ入れるのはいつでも1件だけなので、
     * 「他人の生成に混ぜない」という元の約束は**保ったまま**、
     * 「押したら断られる」を「押したら順番が来る」に変えられる。
     *
     * **同じ記録を二重に並べない。** 押し直しは順番を早めないので、
     * 並べると同じ絵を2回出すだけになる。
     */
    function enqueueReplay(record) {
        const key = `${record?.id ?? ''}`;
        // **待っている間にもう一度押したら、並びから外す**（2026-08-24 利用者の指示）。
        // 並べたのは自分なので、**気が変わったら取り消せる**べき。
        // 走り始めた後は外さない——**投げた後に消しても絵は出る**ので、
        // 「取り消した」と言いながら出てくるほうが分かりにくい。
        if (heldRecords.has(key)) { cancelReplay(key); return; }
        if (busyRecords.has(key)) return;

        // **並ばせる前に、開けるかどうかを試す**（2026-08-25 実機の指摘）。
        //
        // 行列は1件ずつしか流さないので、走っている生成が終わるまで
        // **既に絵が在る記録まで待たされていた**——その回はキューへ1件も
        // 投げないので、待つ理由が無い。実行器は**投げる分が在るときだけ**
        // キューを確かめるので、**先に試しても混ざらない**
        // （投げる必要が在れば、投げる前に断ってくれる）。
        if (replayPumping) {
            openIfAlreadyMade(record, key);
            return;
        }
        replayQueue.push({ record, key });
        heldRecords.add(key);
        applyReplayState(key);
        pumpReplayQueue();
    }

    /**
     * 既に出ている絵だけで開けるなら開く。**投げる必要が在れば並ばせる。**
     *
     * 走っている生成の裏で押されたときの道。**混ざらないのは実行器のおかげ**で、
     * ここが判断しているわけではない——実行器は投げる分が在るときだけ
     * キューを確かめ、混んでいれば投げる前に断る。
     */
    async function openIfAlreadyMade(record, key) {
        busyRecords.add(key);
        applyReplayState(key);
        let outcome = null;
        try {
            outcome = await reproduceOne(record);
        } catch {
            outcome = null;
        } finally {
            busyRecords.delete(key);
            applyReplayState(key);
        }
        // 断られた＝投げる必要が在った。**そのときだけ並ばせる。**
        if (outcome?.held) {
            replayQueue.push({ record, key });
            heldRecords.add(key);
            applyReplayState(key);
            pumpReplayQueue();
        }
    }

    /**
     * 順番待ちを1件ずつ流す。**2本走らせない**（走らせると混ざる）。
     *
     * **待っている印は、順番が来た時点で走っている印へ変わる。**
     * 変えないと「押したのに何も起きない」時間が、そのまま続いて見える。
     */
    /**
     * 順番待ちから外す（2026-08-24 利用者の指示）。
     *
     * **走っているものは外さない。** 既に ComfyUI へ投げた後なら絵は出るので、
     * 「取り消した」と言いながら出てくるほうが分かりにくい。
     */
    function cancelReplay(key) {
        const at = replayQueue.findIndex(item => item.key === key);
        if (at >= 0) replayQueue.splice(at, 1);
        heldRecords.delete(key);
        applyReplayState(key);
        appendLog(t('replay.cancelled'));
    }

    /** 宿主のキューを見に行く間隔（ミリ秒）。 */
    const HOST_QUEUE_POLL_MS = 1500;
    /**
     * 1回の問い合わせを待つ上限（ミリ秒）。
     *
     * **返ってこない返事は、例外より質が悪い。** 例外なら「読めない」として
     * 先へ進む道が在るが、返らないと待ち役がそこで止まり、
     * **以降の押下が全部 ⏸ のまま**になる——読み込み直すまで戻らない
     * （2026-08-24 実機。ComfyUI を再起動した直後に踏んだ）。
     */
    const HOST_QUEUE_TIMEOUT_MS = 5000;

    /**
     * 約束に締め切りを付ける。**時間切れは失敗として投げる**
     * ——呼び手の `catch` が「読めない」と同じ扱いにできる形にしておく。
     */
    function withDeadline(promise, ms) {
        if (typeof setTimeout !== 'function') return promise;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('host queue check timed out')), ms);
            Promise.resolve(promise).then(
                (value) => { clearTimeout(timer); resolve(value); },
                (error) => { clearTimeout(timer); reject(error); }
            );
        });
    }
    /**
     * 断られたときに並び直す回数の上限。
     *
     * **無制限にしない。** 断る理由が「混んでいる」以外へ変わった日に、
     * 同じ1件を永久に回し続ける輪になる。
     */
    const REPLAY_RETRY_LIMIT = 20;

    /**
     * 宿主のキューが空くまで待つ。**待っている間は ⏸ のまま、押せば取り消せる。**
     *
     * これが無いと、**Unbake の外で始まった生成**（ComfyUI の Run など）に
     * 気づけない。押した1件目はその場で断られて止まった印のまま終わり、
     * 後から押した分だけが待ちに見える——2026-08-24 の実機報告
     * 「一件目が開始されない」はこの形だった。
     *
     * @returns {Promise<boolean>} 進んでよければ true、取り消されたら false
     */
    async function waitForHostQueue(key) {
        if (typeof hostQueue !== 'function') return true;
        for (;;) {
            // **取り消しはここで効く。** 待っている間に外されたら、走らせない。
            if (!heldRecords.has(key)) return false;
            let busyHost = false;
            try {
                const state = await withDeadline(hostQueue(), HOST_QUEUE_TIMEOUT_MS);
                busyHost = Number(state?.running || 0) > 0 || Number(state?.pending || 0) > 0;
            } catch {
                // **読めないなら止めない。** 読めないことを「混んでいる」と読むと、
                // 口が1つ落ちただけで再現が永久に始まらなくなる。
                return true;
            }
            if (!busyHost) return true;
            if (typeof setTimeout !== 'function') return true;
            await new Promise((resolve) => setTimeout(resolve, HOST_QUEUE_POLL_MS));
        }
    }

    async function pumpReplayQueue() {
        if (replayPumping) return;
        replayPumping = true;
        try {
            while (replayQueue.length) {
                const { record, key } = replayQueue[0];
                // **並び直した回数は行列の項目が持つ。** 変数で持つと、
                // 別の件を挟んだ時点で数が混ざる。
                const retries = Number(replayQueue[0].retries || 0);
                // **先に行列から外す。** 外してから回せば、**この件で何が起きても
                // 行列は必ず前へ進む**——外すのを後回しにすると、姿を当てる途中で
                // 例外が出ただけで**行列が永久に止まり、以降の press は ⏸ のまま**になる
                // （2026-08-24 実機の報告「2件目以降が ⏸ になるが1件目が開始されない」）。
                replayQueue.shift();
                try {
                    // **先に待たない**（2026-08-25 実機の報告）。
                    //
                    // ここで宿主のキューを待つと、**既に出ている絵を開くだけの回**まで
                    // 待たされる——その回はキューへ1件も投げないので、待つ理由が無い。
                    // 実行器は**本当に投げる分が在るときだけ**キューを確かめるので、
                    // **断られてから待つ**のが正しい順番になる。
                    heldRecords.delete(key);
                    busyRecords.add(key);
                    applyReplayState(key);
                    const outcome = await reproduceOne(record);
                    // **断られたら行き止まりにしない**（2026-08-24）。
                    // 落とすと**その1件だけが押しても始まらない**形になるので、
                    // **空くまで待ってから**並びの末尾へ戻す。
                    if (outcome?.held && retries < REPLAY_RETRY_LIMIT) {
                        busyRecords.delete(key);
                        heldRecords.add(key);
                        applyReplayState(key);
                        if (await waitForHostQueue(key)) {
                            replayQueue.push({ record, key, retries: retries + 1 });
                        }
                    }
                } catch (error) {
                    appendLog(t('replay.failed', { detail: error?.message || String(error) }));
                } finally {
                    // **どの道を通っても、押せる状態へ戻す。**
                    busyRecords.delete(key);
                    // **並び直した分は待ちのまま残す。** ここで消すと、
                    // 行列に居るのに ▶ に見え、押すと二重に並ぶ。
                    if (!replayQueue.some(item => item.key === key)) heldRecords.delete(key);
                    try { applyReplayState(key); } catch { /* 姿を当て損ねても行列は進める */ }
                }
            }
        } finally {
            replayPumping = false;
        }
    }

    function applyHeld(button, on, reason) {
        if (on) {
            if (button.getAttribute('data-held') !== 'true') {
                button.setAttribute('data-idle-label', String(button.textContent ?? ''));
                button.setAttribute('data-idle-title', button.getAttribute('title') || '');
            }
            // **待っている間は押せる。** もう一度押せば並びから外れるので、
            // disabled にすると**取り消しの口を自分で塞ぐ**
            // （2026-08-24 実機：⏸ を押しても何も起きなかった）。
            button.disabled = false;
            button.setAttribute('data-held', 'true');
            button.textContent = HELD_GLYPH;
            if (reason) button.setAttribute('title', String(reason));
            // **列ごと消えないようにする**（走っている間と同じ。出さないと印が在っても見えない）。
            button.parentElement?.setAttribute?.('data-busy', 'true');
            return;
        }
        button.disabled = false;
        button.setAttribute('data-held', 'false');
        const idle = button.getAttribute('data-idle-label');
        if (idle !== null) button.textContent = idle;
        const idleTitle = button.getAttribute('data-idle-title');
        if (idleTitle !== null) button.setAttribute('title', idleTitle);
        button.parentElement?.setAttribute?.('data-busy', 'false');
    }

    /**
     * **今、実際に走っているか**を面の根へ出す（2026-08-25）。
     *
     * 作りによっては「走っている間だけ動く」見せ方をする（円盤が回る・湯気が立つ）。
     * その判断を紙の側でできるように、**状態を属性として1つ出しておく**
     * ——見せ方ごとに JS を足すと、テーマを捨てるときに JS 側へ痕が残る。
     *
     * **待たされている分は数えない。** 並んでいるだけで動かすと、
     * 「動いている＝進んでいる」という読みが嘘になる（待ちは `data-held`）。
     */
    const runningButtons = new Set();
    function markRunning(button, on) {
        if (on) runningButtons.add(button);
        else runningButtons.delete(button);
        root.setAttribute('data-running', runningButtons.size > 0 ? 'true' : 'false');
    }

    function applyBusy(button, on) {
        markRunning(button, on);
        if (on) {
            if (button.getAttribute('data-busy') !== 'true') {
                button.setAttribute('data-idle-label', String(button.textContent ?? ''));
            }
            button.disabled = true;
            button.setAttribute('data-busy', 'true');
            button.textContent = BUSY_GLYPH;
            // **列ごと消えないようにする。** hover でしか出ない列に居るので、
            // 走っている間は hover と無関係に見せる（これをしないと印が在っても見えない）。
            button.parentElement?.setAttribute?.('data-busy', 'true');
            return;
        }
        button.disabled = false;
        button.setAttribute('data-busy', 'false');
        const idle = button.getAttribute('data-idle-label');
        if (idle !== null) button.textContent = idle;
        button.parentElement?.setAttribute?.('data-busy', 'false');
    }
    let settingsView = null;
    /** 開いているバリアントの面。 */
    let variantsView = null;
    /** 開いている「あとで読む箱」の面（裁定⑦）。 */
    let raindropView = null;
    /** 開いている「使っているモデル」の面。 */
    let modelsView = null;
    /** 開いている確認の面。**取り消せない操作の直前にだけ出る。** */
    let confirmView = null;
    /** 開いている詳細のポップアップ。**絵を押したらまずこれ。** */
    let detailView = null;

    const root = element('div', {
        class: 'unbake-root',
        'data-mode': mode,
        'data-density': density,
        // **書字方向は言語から取る。** 物理方向の CSS を書いていないので、
        // これ1つで帯も余白も反転する。
        dir: getDirection(),
        'data-palette': verdictPalette,
        'data-theme': theme,
        'data-rich': richUi ? 'on' : 'off',
        'data-skin': uiSkin,
        // 走っている間だけ動かす作り（テーマ3・4）が読む印。
        'data-running': 'false',
    });
    // **紙は選ばれてから積む。** 常に積むと、テーマ1の人にも解析を負わせるうえ
    // 「読み込んでいるが効いていない」という一番追いにくい状態を作る。
    applySkin(doc, uiSkin);

    // --- 見出し --------------------------------------------------------
    //
    // **判定の要約は見出しに出さない**（2026-08-22 利用者の指示）。
    // すぐ下の絞り込みが**同じ数を種別ごとに出している**ので、同じことを
    // 2箇所で言っていた——器の狭いサイドバーでは、その1行が丸ごと無駄になる。
    // 合計は絞り込みの数を足せば判る。
    // **束で回す入口。** 口が渡されていなければ出さない（押せないボタンを出さない）。
    const batchButton = batchIo ? element('button', {
        class: 'unbake-batch-run', type: 'button', text: t('batch.run'),
        title: t('batch.run.help'),
    }) : null;
    const batchStopButton = batchIo ? element('button', {
        class: 'unbake-batch-stop', type: 'button', text: t('batch.cancel'),
        title: t('batch.cancel.help'),
    }) : null;

    const settingsButton = element('button', {
        class: 'unbake-settings-open', type: 'button',
        text: '⚙', title: t('settings.open'), 'aria-label': t('settings.open'),
    });
    settingsButton.addEventListener('click', () => openSettings());

    // **「あとで読む箱」の入口**（裁定⑦）。口が渡されていなければ出さない
    // ——押せないボタンを出すと「壊れている」と読まれる。
    const raindropButton = raindropIo?.list ? element('button', {
        class: 'unbake-raindrop-open', type: 'button',
        text: '🔖', title: t('raindrop.open'), 'aria-label': t('raindrop.open'),
    }) : null;
    raindropButton?.addEventListener('click', () => openRaindrop());

    // **♡ は案内だけ**（2026-08-22 利用者の指示）。金額も決済もここでは扱わない。
    const donateButton = element('button', {
        class: 'unbake-donate-open', type: 'button',
        text: '♡', title: t('donate.open'), 'aria-label': t('donate.open'),
    });
    donateButton.addEventListener('click', () => openDonate());

    // **全画面への入口を常に出す。** 元は「残り N 件」からしか行けず、
    // 全件描くようにした時点で**その入口ごと消えていた**（実機で「見当たらない」）。
    const fullscreenButton = onRequestFullscreen ? element('button', {
        class: 'unbake-fullscreen-open', type: 'button',
        text: '⛶', title: t('app.openFullscreen'), 'aria-label': t('app.openFullscreen'),
    }) : null;
    fullscreenButton?.addEventListener('click', () => onRequestFullscreen?.());
    const header = element('div', { class: 'unbake-header' }, [
        // **名前の左にも印を置く**（2026-08-22 利用者の指示）。サイドバーの
        // 並びと同じ絵なので、開いた面がどれなのかが見出しだけで判る。
        element('span', { class: 'unbake-icon unbake-title-icon', 'aria-hidden': 'true' }),
        element('span', { class: 'unbake-title', text: t('app.title') }),
        ...(fullscreenButton ? [fullscreenButton] : []),
        raindropButton,
        donateButton,
        // **器の名前の札は置かない**（2026-08-22 利用者の指示で「サイドバー」を消した）。
        //
        // **片方だけ出す形にはしない。** 器によって構造が変わると、
        // 「1つのコンポーネントを両方の器へ差す」という決めごとが崩れる
        //（`panel_mount_test` がそこを見ている）。全画面には閉じる口が別に在るので、
        // 札そのものが要らない——**両方から外す**のが筋。
        batchButton,
        batchStopButton,
        settingsButton,
    ].filter(Boolean));

    // --- 受け口 -------------------------------------------------------
    const dropzone = element('div', {
        class: 'unbake-dropzone',
        'data-active': 'false',
        text: t('drop.hint'),
    });

    // --- 絞り込み -----------------------------------------------------
    const search = element('input', {
        class: 'unbake-search',
        type: 'search',
        placeholder: t('filter.placeholder'),
        'aria-label': t('filter.aria'),
    });
    /**
     * お気に入りだけを見るか。**保存する**（2026-08-24 利用者の指示）。
     *
     * 元は「絞り込みは保存しない」と決めていたが、実機では**開き直すたび絞り込み直す**
     * ことになっていた。並び替えや見せ方は残しているので、**同じ帯に並んでいる
     * 操作なのに片方だけ忘れる**のは揃わない。
     */
    let favoritesOnly = display?.favoritesOnly === true || display?.favorites_only === true;
    const chips = element('div', { class: 'unbake-chips' });
    const chipOf = new Map();
    for (const key of CHIP_VERDICTS) {
        const chip = element('button', {
            class: 'unbake-chip',
            type: 'button',
            'data-verdict': key,
            'data-on': 'true',
            title: verdictTitle(key),
        });
        chip.addEventListener('click', () => {
            if (hidden.has(key)) hidden.delete(key);
            else hidden.add(key);
            persistFilters();
            render();
        });
        chipOf.set(key, chip);
        chips.append(chip);
    }

    // **お気に入りだけを見る**（2026-08-22 利用者の指示）。判定の絞り込みと
    // 同じ場所・同じ形にする——別の場所へ置くと「どこにあったか」を覚える羽目になる。
    const favoritesChip = element('button', {
        class: 'unbake-chip unbake-chip-favorite', type: 'button',
        'data-on': 'false', title: t('favorite.only'),
    });
    favoritesChip.addEventListener('click', () => {
        favoritesOnly = !favoritesOnly;
        persistFilters();
        render();
    });
    chips.append(favoritesChip);
    // --- 見せ方（表 ⇄ タイル）と列数 --------------------------------
    //
    // **モードを足しているのではない。** 記録も絞り込みも並びも1つのままで、
    // 変わるのは並べ方だけ（密度は今までどおり器の幅が決める）。
    // 絵で選びたい・字で比べたいは**同じ人が場面で切り替える**ので、
    // 設定の奥ではなく一覧の手元に置く。
    const viewToggle = element('button', {
        class: 'unbake-view-toggle', type: 'button', 'aria-label': t('list.view.toggle'),
    });
    const columnsSelect = element('select', {
        class: 'unbake-view-columns', 'aria-label': t('list.columns'),
    });
    // 0 は「幅に合わせる」。1 が最大で 4 が最小。
    for (const value of ['0', '1', '2', '3', '4']) {
        columnsSelect.append(element('option', {
            value, text: value === '0' ? t('list.columns.auto') : t(`list.size.${value}`),
        }));
    }
    columnsSelect.value = String(tileSize);

    /**
     * 絞り込みを保存する（2026-08-24）。**保存できなくても画面は絞り込む。**
     * 見せ方・並び替えと同じ形にする——同じ帯の操作を別の仕組みで持たない。
     */
    function persistFilters() {
        settingsIo?.write?.({
            hidden_verdicts: [...hidden],
            favorites_only: favoritesOnly,
        })?.catch?.(() => appendLog(t('list.view.notSaved')));
    }

    /** 見せ方の設定を保存する。**保存できなくても画面は切り替わる。** */
    function persistView() {
        settingsIo?.write?.({ list_view: listView, tile_size: tileSize })
            ?.catch?.(() => appendLog(t('list.view.notSaved')));
    }

    viewToggle.addEventListener('click', () => {
        listView = listView === 'tiles' ? 'table' : 'tiles';
        persistView();
        render();
    });
    columnsSelect.addEventListener('change', () => {
        tileSize = Math.max(0, Math.min(4, Number(columnsSelect.value) || 0));
        persistView();
        render();
    });

    // --- 並び替え（2026-08-22 利用者の指示で画面へ出した）--------------------
    //
    // **元は設定の中にしか無かった。** 並べ替えは絞り込みと同じくらい頻繁に変えるので、
    // 設定画面を開かないと変えられないのは、無いのとあまり変わらない。
    const sortSelect = element('select', {
        class: 'unbake-sort-key', 'aria-label': t('sort.key'), title: t('sort.key'),
    });
    for (const value of ['modified', 'title', 'checkpoint', 'verdict', 'favorite']) {
        sortSelect.append(element('option', { value, text: sortLabel(value) }));
    }
    sortSelect.value = sortKey;
    // **向きは別のボタン。** 選択肢を「新しい順／古い順／名前順／名前逆順…」と
    // 10個に増やすと、鍵と向きという別の軸が1つの列に潰れて選びにくくなる。
    const sortDirection = element('button', {
        class: 'unbake-sort-direction', type: 'button',
        'aria-label': t('sort.direction'), 'data-descending': sortDescending ? 'true' : 'false',
    });

    function persistSort() {
        settingsIo?.write?.({ sort_key: sortKey, sort_descending: sortDescending })
            ?.catch?.(() => appendLog(t('sort.notSaved')));
    }
    sortSelect.addEventListener('change', () => {
        const wanted = String(sortSelect.value);
        if (!SORT_KEYS.has(wanted)) return;
        sortKey = wanted;
        persistSort();
        render();
    });
    sortDirection.addEventListener('click', () => {
        sortDescending = !sortDescending;
        sortDirection.setAttribute('data-descending', sortDescending ? 'true' : 'false');
        persistSort();
        render();
    });

    const viewControls = element('div', { class: 'unbake-view-controls' }, [
        viewToggle, columnsSelect, sortSelect, sortDirection,
    ]);

    // --- 選んだものに対してやること -----------------------------------
    //
    // **選択が無いときは出さない。** 何に効くか判らないボタンを置くと、
    // 「今どれに効くのか」を毎回確かめさせることになる。
    const selectionCount = element('span', { class: 'unbake-selection-count' });
    const selectAllButton = element('button', {
        class: 'unbake-select-all', type: 'button', text: t('select.all'), title: t('select.all.help'),
    });
    selectAllButton.addEventListener('click', () => selectAllShown());
    const clearSelectionButton = element('button', {
        class: 'unbake-select-clear', type: 'button', text: t('select.clear'),
    });
    clearSelectionButton.addEventListener('click', () => clearSelection());
    const downloadButton = element('button', {
        class: 'unbake-download-missing', type: 'button',
        text: t('download.missing.all'), title: t('download.missing.help'),
    });
    downloadButton.addEventListener('click', () => downloadMissing());
    const downloadStopButton = element('button', {
        class: 'unbake-download-stop', type: 'button', text: t('download.cancel'),
    });
    downloadStopButton.addEventListener('click', () => cancelDownload());
    downloadStopButton.disabled = true;

    /**
     * 進み具合（2026-08-23 利用者の指示）。
     *
     * **押してから何分も無音だった。** 1本ぶんの取得はサーバが終わるまで
     * 返ってこないので、画面には「始めた」という行が1本出たきりになる
     * ——数百MBなら数分かかり、**止まっているのか進んでいるのか区別が付かない。**
     * 実際に「落とせないようだ」と報告された（サーバ側は正常に引けていた）。
     *
     * 進み具合は `GET /unbake/download` が持っているので、引いている間だけ
     * 定期的に読む。**ログには流さない**——1本につき何十行も出ることになる。
     */
    // **帯には置かない。** 文が伸びるとボタンの並びが崩れる（上の `toast` へ出す）。

    const selectionBar = element('div', { class: 'unbake-selection' }, [
        selectionCount, selectAllButton, clearSelectionButton,
        ...(downloadIo ? [downloadButton, downloadStopButton] : []),
        ...(batchButton ? [batchButton] : []),
        ...(batchStopButton ? [batchStopButton] : []),
    ]);

    const controls = element('div', { class: 'unbake-controls' }, [search, chips, viewControls]);
    search.addEventListener('input', () => { query = String(search.value || '').toLowerCase(); render(); });

    // --- 一覧 ---------------------------------------------------------
    const tableBody = element('tbody', {});
    /**
     * 商用可否の列見出し。**本文と一緒に出し入れするために掴んでおく。**
     *
     * 見出しは器を作るときに1回しか組まないので、本文だけを設定で出し入れすると
     * **見出しと中身が1列ずれる**。並びのまとめを切った瞬間に効かせる（`applyDisplay`）
     * のと同じ話で、**その場で効かせるなら、変わる所を全部掴んでおく。**
     */
    const commercialHead = element('th', { class: 'unbake-col-license', text: t('column.commercial') });
    const headRow = element('tr', {}, [
                element('th', { class: 'unbake-col-pick', title: t('select.column') }),
                element('th', { class: 'unbake-col-preview', title: t('column.preview') }),
                // 見出しも長短を両方描いて、出し分けは CSS に任せる。
                // **短くしても語彙3層は残す**（Record / Manifest / Sweep）。
                element('th', { class: 'unbake-col-title', title: t('column.record.long') }, [
                    element('span', { class: 'unbake-v-long', text: t('column.record.long') }),
                    element('span', { class: 'unbake-v-short', text: t('column.record.short') }),
                ]),
                element('th', { class: 'unbake-col-verdict', title: t('column.manifest.long') }, [
                    element('span', { class: 'unbake-v-long', text: t('column.manifest.long') }),
                    element('span', { class: 'unbake-v-short', text: t('column.manifest.short') }),
                ]),
                element('th', { class: 'unbake-col-model', text: t('column.checkpoint') }),
                element('th', { class: 'unbake-col-sweep', text: t('column.sweep') }),
                // **どの列も名前（class）で指す。** 元は狭いときの列幅を
                // `nth-child` で指定していたので、**先頭へ列を1つ足しただけで
                // 幅指定が全部1つ隣へずれた**（参照画像の列を足したときに踏んだ）。
                // ずれても画面は出るので、気づけるのは幅が変わったときだけ。
                ...(showCommercialOk ? [commercialHead] : []),
    ]);
    const table = element('table', { class: 'unbake-table' }, [
        element('thead', {}, [headRow]),
        tableBody,
    ]);
    /** タイルの器。**表と同じ記録を、同じ順で並べる。** */
    const tiles = element('div', { class: 'unbake-tiles' });
    const empty = element('div', { class: 'unbake-empty' });
    const log = element('div', { class: 'unbake-log' });
    const body = element('div', { class: 'unbake-body' }, [
        dropzone, controls, selectionBar, empty, table, tiles, log,
    ]);
    /**
     * 浮かせて出す1行（2026-08-23 利用者の指示）。
     *
     * **帯の中に置いていたので、文が伸びると並びが崩れた**
     * （「完了: 0 件を取得、8 件は既存、5 件が失敗、43 件は落とせません。」）。
     * 帯はボタンの並びで、幅は器で決まる——長い文の置き場ではない。
     *
     * **操作を止めない。** 覆いも押し返しも作らない（`pointer-events: none`）ので、
     * 出ている間も一覧はそのまま触れる。押して閉じる的も作らない
     * ——閉じるために手を止めさせるくらいなら、黙って消える方がよい。
     */
    const toast = element('div', {
        class: 'unbake-toast', role: 'status', 'data-open': 'false',
    });
    let toastTimer = null;
    function showToast(text, { sticky = false } = {}) {
        const message = String(text || '');
        if (!message) {
            toast.setAttribute('data-open', 'false');
            toast.textContent = '';
            return;
        }
        toast.textContent = message;
        toast.setAttribute('data-open', 'true');
        if (toastTimer && typeof clearTimeout === 'function') clearTimeout(toastTimer);
        toastTimer = null;
        // **走っている間は消さない。** 進み具合は次の値で上書きされる。
        if (sticky || typeof setTimeout !== 'function') return;
        toastTimer = setTimeout(() => {
            toastTimer = null;
            toast.setAttribute('data-open', 'false');
        }, 6000);
    }

    root.append(header, body, toast);

    /**
     * 履歴へ1行足す。
     *
     * **押せる口も置けるようにした**（2026-08-25 利用者の指示「元に戻せるように」）。
     * 取り消しは**言った場所に置く**——別の所に置くと、消えた直後に探すことになる。
     */
    const appendLog = (message, { action = null } = {}) => {
        const line = element('div', { text: String(message) });
        if (action?.run) {
            const button = element('button', {
                class: 'unbake-log-action', type: 'button',
                text: String(action.label || ''), title: String(action.label || ''),
            });
            button.addEventListener('click', () => {
                if (button.disabled) return;
                button.disabled = true;
                action.run();
            });
            line.append(button);
        }
        log.append(line);
        log.scrollTop = log.scrollHeight;
        return line;
    };

    // --- 拡大して見る -------------------------------------------------
    //
    // **開いたのと同じ操作で閉じる。** 小さな絵を確かめたいだけなので、
    // 閉じるために別の的（×印）を探させない——どこを押しても閉じる。
    // Esc でも閉じる（全画面と同じ約束）。
    /** @type {object|null} 開いている拡大。**同時に2つ開かない。** */
    let lightbox = null;
    /** 突き合わせの索引を温めたか。**共有なので1回でよい。** */
    let variantsWarmed = false;

    function closeLightbox() {
        if (!lightbox) return;
        lightbox.root.remove?.();
        doc.removeEventListener?.('keydown', lightbox.onKey);
        lightbox = null;
    }

    /**
     * 絵を大きく出し、**元の1枚と見比べる**。
     *
     * ---
     *
     * **拡大だけの面は作らない。** この道具で絵を大きくしたい理由は
     * 「元とどう違うか」を見るためで、1枚だけ大きくしても答えは出ない。
     * だから同じ面が3つを兼ねる:
     *
     *   1. 記録の絵をそのまま大きく見る（相手が無いとき）
     *   2. 再現した結果を、元の1枚と並べて見る
     *   3. 既に出ている絵を**ホイールで送りながら**元と見比べる
     *
     * **ホイールで送る。** 何十枚もあるとき、押して閉じて次を押す、では比べられない
     * （実機で「ホイールを回しても下に進めない」と言われた）。
     * 左右キーでも送る。Esc とどこかを押すと閉じるのは今までどおり。
     *
     * @param {object} record 元の記録（左に置く基準）
     * @param {Array<{url: string, label?: string}>} others 見比べる相手
     */
    function openCompare(record, others = [], { single = false } = {}) {
        closeLightbox();
        const list = (others || []).filter(item => item?.url);
        let index = 0;

        const baseImage = record?.previewUrl
            ? element('img', { class: 'unbake-compare-image', src: record.previewUrl, alt: '' })
            : element('div', { class: 'unbake-compare-image', 'data-state': 'none', text: '·' });
        const otherImage = element('img', { class: 'unbake-compare-image', alt: '' });
        const otherCaption = element('p', { class: 'unbake-compare-caption' });
        const baseCaption = element('p', {
            class: 'unbake-compare-caption', text: t('compare.baseline', { title: displayName(record) }),
        });

        // **相手がいなければ、その場所ごと作らない。** 「まだ比べる相手がありません」
        // と書いても何も進まないし、その一文のぶんだけ絵が小さくなる
        // （実機で「文章は無しにして大きく」と言われた）。
        // **1枚で大きく見る形**（2026-08-22 利用者の指摘「拡大が小さい」）。
        // 左右に割ると、990px の窓で1枚が478pxしかない——縦長の絵では
        // **1枚にすれば866px**まで伸びる。見比べはホイールの送りが担う
        // （その場で切り替わる方が、並べるより差に気づきやすい）。
        const otherSide = (!single && list.length)
            ? element('div', { class: 'unbake-compare-side', 'data-side': 'other' }, [otherImage, otherCaption])
            : null;
        const shell = element('div', {
            class: 'unbake-compare', role: 'dialog', 'aria-modal': 'true',
            'aria-label': t('image.enlarged'),
        }, [
            element('div', {
                class: 'unbake-compare-pair',
                'data-single': (single || !list.length) ? 'true' : 'false',
            }, [
                element('div', { class: 'unbake-compare-side', 'data-side': 'base' }, [baseImage, baseCaption]),
                ...(otherSide ? [otherSide] : []),
            ]),
            // 送り方の案内も、送る相手がいるときだけ。
            ...(list.length > 1
                ? [element('p', { class: 'unbake-compare-hint', text: t('compare.hint') })]
                : []),
        ]);

        function show(next) {
            if (!list.length) return;
            index = (next + list.length) % list.length;
            const item = list[index];
            // **1枚で見るときは、基準の側を差し替える**（右の枠は作っていない）。
            const image = single ? baseImage : otherImage;
            const caption = single ? baseCaption : otherCaption;
            image.setAttribute?.('src', item.url);
            caption.textContent = list.length > 1
                ? t('compare.nth', { index: index + 1, total: list.length, label: item.label || '' })
                : String(item.label || '');
        }
        show(0);

        const onKey = (event) => {
            const key = String(event?.key || '');
            if (key === 'Escape') { closeLightbox(); return; }
            if (key === 'ArrowRight' || key === 'ArrowDown') { event.preventDefault?.(); show(index + 1); }
            if (key === 'ArrowLeft' || key === 'ArrowUp') { event.preventDefault?.(); show(index - 1); }
        };
        const onWheel = (event) => {
            if (!list.length) return;
            // **面の外へ送らない。** 後ろの一覧が一緒に動くと、閉じたときに
            // どこを見ていたか判らなくなる。
            event.preventDefault?.();
            show(index + (Number(event?.deltaY) >= 0 ? 1 : -1));
        };
        // **どこを押しても閉じる**（絵の上も外側も同じ）。
        shell.addEventListener('click', () => closeLightbox());
        shell.addEventListener('wheel', onWheel);
        doc.addEventListener?.('keydown', onKey);
        root.append(shell);
        lightbox = { root: shell, onKey, count: list.length, show, get index() { return index; } };
        return lightbox;
    }

    /** 絵1枚を大きく見る。**相手がいなければ、元の1枚だけを出す。** */
    function openLightbox(url, caption, record = null) {
        if (!url) return null;
        return openCompare(record || { previewUrl: url, title: caption }, []);
    }

    /**
     * この記録の詳細を出す（2026-08-22 利用者の指示）。
     *
     * **元は絵を押すと拡大だけだった。** 大きくしても、どのモデルで・どのプロンプトで
     * 出したのかが見えないので次の一手が決まらない。詳細を先に出し、
     * **絵を押したらそこから窓いっぱいの拡大へ進む**。
     *
     * **出ている絵は押されてから取りに行く。** 実測で出力は4,275枚あり、
     * 開いた瞬間に全部突き合わせると画面が固まる（初回だけ索引を組むので2秒）。
     */
    async function openDetail(record, { tab = null } = {}) {
        let recipe = record?.recipe || null;
        if (!recipe && record?.libraryId && loadRecord) {
            try { recipe = await loadRecord(record.libraryId); } catch { recipe = null; }
        }
        // **押す前に確かめる。** 組めない記録で「出す」を押させると、
        // 待たされた末に「チェックポイント情報がありません」と出る
        // ——押す前から判っていたことなので、先に言う（2026-08-23 利用者の報告）。
        // 実データ350件のうち、この形は8件。
        let runBlockedReason = null;
        if (recipe && typeof canBuild === 'function') {
            try {
                const check = await canBuild(recipe);
                if (check && check.ok === false) {
                    runBlockedReason = check.error || t('detail.run.cannot');
                }
            } catch {
                // **確かめられないことを「組めない」と混ぜない。** そのときは
                // 今までどおり押させて、失敗したらそこで理由を出す。
                runBlockedReason = null;
            }
        }

        let outputs = [];
        if (typeof loadVariants === 'function') {
            try { outputs = (await loadVariants(record))?.outputs || []; } catch { outputs = []; }
        }
        // **記録どおりでない強度の本数。** ボタンの字に出すためだけに持つ
        // ——値そのものは上書きレイヤ（`recipeLoraOverrides`）が持っている。
        let strengthCount = 0;
        // **比べたい LoRA。** 口はモデルの面が出し、計画を組むのは詳細
        // ——押す前に出る枚数を1箇所で数えるため、ここで橋渡しする。
        const loraAlternates = new Map();
        /** 土台のモデルの差し替え先（2つ以上で軸になる）。 */
        const checkpointAlternates = [];
        detailView?.destroy();
        detailView = createDetailView({
            documentRef: doc,
            record,
            recipe,
            outputs,
            title: displayName(record),
            openTab: tab,
            // **既存の面を書き直さず、そのまま差す。** どれも
            // `{documentRef, record, …, onClose}` を受けて `root` を返す形なので、
            // タブの中身として使える——**同じ物を2つ作らない**。
            tabs: buildDetailTabs(record, recipe, outputs),
            mountModels: (host) => mountUsedModels(record, recipe, host,
                (count) => { strengthCount = count; detailView?.refresh?.(); },
                (target, values, label, role) => {
                    // 2つ未満は軸にならないので持たない（計画側も落とす）。
                    const enough = target && Array.isArray(values) && values.length >= 2;
                    // **土台は別の口。** `checkpoint` 軸は `target` を取らない
                    // （記録の checkpoint は1つなので、指す先が1つに決まる）。
                    if (role === 'checkpoint') {
                        checkpointAlternates.length = 0;
                        if (enough) checkpointAlternates.push(...values);
                    } else if (!enough) loraAlternates.delete(target);
                    else loraAlternates.set(target, { target, values, label });
                    // **描き直すところまでが1つの動き。** 知らせるだけでは
                    // ボタンの枚数が古いままになる。
                    detailView?.refresh?.();
                }),
            loraAlternates: () => [...loraAlternates.values()],
            checkpointAlternates: () => [...checkpointAlternates],
            // **原寸は押されたときだけ取りに行く。** 一覧のために346件を落とすと、
            // Civitai への問い合わせが346回走る。取れなければサムネイルへ戻る。
            originalUrl: record?.libraryId
                ? `/unbake/record-original?id=${encodeURIComponent(record.libraryId)}`
                : null,
            // **拡大は「進む」。** 詳細を閉じずに重ねるので、戻ると詳細が残っている。
            //
            // **基準は元画像、送るのは生成画像だけ。** 並び全部を相手側へ渡すと、
            // 出力が1枚も無い記録で**同じ絵が左右に2枚並ぶ**（実際にそうなった）。
            onEnlarge: (url, list, index) => {
                // **1枚で窓いっぱいに出し、並び全部をホイールで送る**
                // （2026-08-22 利用者の指摘「拡大が小さい」）。左右に割ると
                // 縦長の絵が半分の幅になり、比べるどころではなくなる。
                const box = openCompare(
                    record,
                    (list || []).map(item => ({ url: item.url, label: item.label })),
                    { single: true },
                );
                box?.show?.(Number(index) || 0);
                return box;
            },
            // **「一つだけ変えて結果を見比べます」がここに入る。**
            // **モデルの変更は詳細1回ぶん。** 閉じたら消える——記録は書き換えない。
            onRun: makeSweepRunner
                ? (changes, plan, onProgress) => runOneWithChanges(record, recipe, changes, plan, onProgress)
                : null,
            // **止めるのは旗を立てるだけ。** 既に投入した1枚は出てくる
            // ——そこまで含めて「止まった」と読めるよう、升目はそのまま残す。
            runBlockedReason,
            onStop: () => { detailRunner?.stop?.(); },
            // **出した絵をその場でレコードにする。** 既にある捕捉の口を使う
            // ——Sweep の升目から取り込むのと同じ経路で、新しい実装を作らない。
            onCapture: onCaptureSweepCell
                ? async (outputs) => {
                    const kept = [];
                    const failed = [];
                    for (const output of outputs || []) {
                        try {
                            const result = await onCaptureSweepCell({ output });
                            kept.push(...(result?.records || []));
                            failed.push(...(result?.errors || []));
                        } catch (error) {
                            failed.push(error?.message || String(error));
                        }
                    }
                    if (kept.length) {
                        // **一覧へその場で足す。** 取り込んだのに画面が変わらないと、
                        // 「押しても何も起きない」ようにしか見えない（削除で踏んだ形）。
                        replaceRecords([...kept, ...records]);
                        appendLog(t('detail.saved', { count: kept.length }));
                    }
                    if (failed.length) appendLog(t('detail.saveFailed', { detail: failed.join(' / ') }));
                    return { ok: kept.length > 0, count: kept.length, errors: failed };
                }
                : null,
            // **出た絵の設定を、開いている欄へ戻す。** 保存の逆向きで、
            // **記録は書き換えない**——欄が変わるだけなので、閉じれば元へ戻る。
            // **ここで数を作り直さない。** 流し込んだ数を知っているのは詳細の面で、
            // ここで `params` の件数を数えて記録すると、**同じ操作に食い違う2つの数**が出る
            // （欄に無い項目は流し込まれないので、必ず一致するとは限らない）。
            onExtractParams,
            // **強度は記録ごとの上書きレイヤへ。** 記録そのものは書き換えない
            // ——比較の基準点が回を追うごとに動くと、見比べる意味が消える。
            // **数だけ受け取る。** 口は「使っているモデル」の面が出す
            // ——詳細の作り付けの帯は、その面を差すと丸ごと出ない。
            changedStrengths: () => strengthCount,
            onSwapModel: (entry) => {
                // **面を閉じない。** 差し替えの口は下の「振る」タブが持っている
                // ——閉じて開き直すと、今どのレコードを見ていたかが画面から消える。
                detailView?.selectTab?.('sweep');
                appendLog(t('detail.swapHint', { name: entry.name }));
            },
            onClose: () => { detailView?.destroy(); detailView = null; },
        });
        root.append(detailView.root);
        return detailView;
    }

    /** 開いている「絵で選ぶ」面。**2枚目は出さない。** */
    let pickerView = null;
    /** 開いている寄付の案内。 */
    let donateView = null;

    /**
     * 支援の案内を出す。**送り先は `donateView` が持つ**——設定から渡さない。
     *
     * 以前は設定の `donate_url` を1本だけ渡していた（2026-08-24 に撤去）。
     * 送り先が決まり実測で通ったので、**空にできる設定を残すほうが害**になった。
     */
    function openDonate() {
        donateView?.destroy();
        donateView = createDonateView({
            documentRef: doc,
            onCopy: (text) => globalThis.navigator?.clipboard?.writeText?.(text),
            onClose: () => { donateView = null; },
        });
        root.append(donateView.root);
        return donateView;
    }

    /**
     * モデルを絵で選ぶ面を出す。
     *
     * **素の `<select>` をやめた**（2026-08-22 利用者の指摘）。開いた一覧は
     * OS 側が描くので面の色が届かず**白飛び**し、しかも**絵を出せない**。
     */
    function openModelPicker({ kind, current, names, onPick }) {
        pickerView?.close?.();
        pickerView = createModelPicker({
            documentRef: doc,
            kind,
            current,
            names: names || [],
            onPick,
            onClose: () => { pickerView = null; },
        });
        root.append(pickerView.root);
        return pickerView;
    }

    /**
     * 使っているモデルの面を、詳細の**欄のすぐ下**へ差す（2026-08-22 利用者の指示）。
     *
     * タブだと、値を直すのとモデルを直すのが別の画面になる。**同じ1枚の絵に
     * ついて決めることなので、間に画面の切り替えを挟まない。**
     */
    function mountUsedModels(record, recipe, host, onCount, onAlternates) {
        if (!modelsIo?.plan) return null;
        const view = createModelsView({
            documentRef: doc,
            record,
            recipe,
            io: modelsIo,
            onClose: null,
            onDelete: (entry, plan, refresh) => confirmDeleteModel(entry, plan, refresh),
            // **手入れは記録ごとの上書きレイヤへ。** 記録そのものは書き換えない
            // ——比較の基準点が回を追うごとに動くと、見比べる意味が消える。
            loraStrengthOf: (lora, index) => getLoraOverride(record?.id, lora, index),
            onLoraStrength: (lora, index, value) => {
                if (!setLoraOverride(record?.id, lora, index, value)) {
                    // **容量超過を黙って飲まない。** 指した値が消えたのに
                    // 画面だけ動いていると、次の1枚が「効かない」ことになる。
                    appendLog(t('models.strength.saveFailed'));
                }
            },
            // **差し替えもその場で。** 押して別の面へ飛ぶ形をやめた。
            modelNameOf: (source, index, role) => getModelOverride(
                record?.id, role === 'checkpoint' ? null : source, index),
            onModelName: (source, index, role, name) => {
                if (!setModelOverride(record?.id, role === 'checkpoint' ? null : source, index, name)) {
                    appendLog(t('models.strength.saveFailed'));
                }
            },
            loadInstalled: loadInstalledModels
                ? (kind) => loadInstalledModels(kind)
                : null,
            onStrengthCount: onCount,
            onAlternates,
            // **絵で選ぶ面はここで出す。** 面（`modelsView`）は器の中に居るので、
            // 自分の上へ重ねると**中でスクロールする箱に閉じ込められる**。
            onOpenPicker: (request) => openModelPicker(request),
        });
        host.append(view.root);
        return view;
    }

    /**
     * 詳細の下半分に差す面を組む（2026-08-22 利用者の指示で1枚へ畳んだ）。
     *
     * **中身は既存の面をそのまま使う。** `createSweepView` も `createVariantsView` も
     * `root` を返すので、タブの器へ入れれば動く——**同じ物を2つ作らない**。
     *
     * **押されたときに作る。** 全部を先に作ると、詳細を開くたびに Sweep の材料も
     * 突き合わせも走って待たされる（既出の面は初回だけ索引を組むので2秒）。
     */
    function buildDetailTabs(record, recipe, outputs) {
        const tabs = [];

        // **「振る」のタブは無くした**（2026-08-22 利用者の指示）。
        //
        // 中身は全部この詳細の上半分へ移してある:
        //   seed の複数振り → シードの隣の「枚数」
        //   プロンプトの置換 → `{...}` の候補欄／語の追記 → 「語を足す」
        //   ステップ・CFG の軸 → 欄の「枚数」と刻み
        //   LoRA の強度 → 行のスライダー／差し替え → 行の「＋」
        //   土台のモデルの差し替え → checkpoint 行の「＋」
        //   結果の格子・進捗・取消・1枚ずつの取り込み → 実行ボタンの下
        //
        // **軸を宣言してから回す**という言い方ごと畳んだ——やりたいことは
        // たいてい1つの値を動かすことで、*軸*はその手前に挟まっていただけだった。

        if (typeof loadVariants === 'function') {
            tabs.push({
                id: 'variants',
                label: t('detail.tab.variants'),
                mount: (host) => {
                    const view = createVariantsView({
                        documentRef: doc,
                        record,
                        outputs: outputs || [],
                        recipe,
                        onClose: null,
                        onCompare: (index) => {
                            // 既出の面から絵を押したら、詳細と同じ拡大へ進む。
                            // **`url` を持たない出力が在る。** 製品が渡すのは
                            // `filename` / `subfolder` で、`url` が入るのは一部だけ
                            // ——ここで落とすと**一覧が空になり、拡大は元画像のまま**
                            // 残る（2026-08-22 利用者の報告「出た絵を押すと元画像が出る」）。
                            const items = (outputs || []).map(output => ({
                                url: output?.url || outputViewUrl(output),
                                label: output?.differenceLabel || output?.filename || '',
                            })).filter(item => item.url);
                            const box = openCompare(record, items, { single: true });
                            box?.show?.(Number(index) || 0);
                            return box;
                        },
                        // **消す口も、見ている場所に置く**（2026-08-25 実機の指摘）。
                        // 出た絵の面にだけ差していたので、**詳細ウィンドウからは
                        // 見つけられなかった**——見つけられない機能は、無いのと同じ。
                        onDelete: (output) => deleteOutputLater(output, record),
                        // **出た絵を見ている場所から、記録にする／設定を戻す**
                        // （2026-08-24 利用者の指示）。どちらも既にある口を差すだけで、
                        // **2本目の取り込み器も2本目の読み取りも作らない**
                        // ——片方にだけ直しが入って静かに食い違うのを避ける。
                        onCapture: onCaptureSweepCell
                            ? (output) => onCaptureSweepCell({
                                url: output?.url || outputViewUrl(output),
                                filename: output?.filename || '',
                                record,
                            })
                            : null,
                        onExtract: onExtractParams
                            ? async (output) => {
                                const result = await onExtractParams({
                                    url: output?.url || outputViewUrl(output),
                                    kind: 'output',
                                });
                                if (!result?.ok) return result;
                                // **流し込む先は開いている詳細の欄。**
                                // ここで欄を触らずに数だけ返すと、「読めた」と出るのに
                                // **画面が変わらない**——押した人には壊れて見える。
                                const applied = detailView?.applyParams?.(result.params);
                                return { ...result, ...(applied || {}) };
                            }
                            : null,
                    });
                    host.append(view.root);
                    return view;
                },
            });
        }

        return tabs;
    }

    /**
     * 書き換えた条件で出す。**新しい実行器を作らない。**
     *
     * `SweepRunner` へ計画をそのまま渡す。投入・待ち・取消・捕捉・3つの安全装置は
     * 既にあちらが持っているので、ここがやるのは**書き換えを記録の写しへ入れる**
     * ことだけ。
     *
     * **計画は詳細の面が組む**（`detailRunPlan`）。seed の本数も置き換えの軸も
     * あちらの欄から出るので、ここで組み直すと**同じ組み立てが2箇所**になる。
     * 渡されなければ今までどおり seed 1つの1枚。
     *
     * **書き換えは記録の写しへ入れる。** 元の記録は触らない——
     * 「1枚出したら元の記録が変わっていた」が一番困る。
     */
    /** 回っている実行器。**止める口が触れるように持つ**（1度に1つだけ）。 */
    let detailRunner = null;

    async function runOneWithChanges(record, recipe, changes, plan = null, onProgress = null) {
        if (!makeSweepRunner) return { ok: false, error: 'no-runner' };
        const base = recipe || record?.recipe;
        if (!base) return { ok: false, error: 'no-recipe' };
        const edits = { ...(changes || {}) };

        // 数として書いてある欄は数へ戻す。**空欄は「変えていない」ではなく「空」**
        // なので、書き換えた項目だけをここへ通す（`changes` は変えた分しか持たない）。
        const numeric = new Set(['seed', 'steps', 'cfg_scale']);
        const genParams = { ...(base.gen_params || {}) };
        for (const [key, value] of Object.entries(edits)) {
            if (numeric.has(key)) {
                // **「20, 30, 40」は軸になる。** その場合ここへ入るのは基準の1つ目で、
                // 各セルは軸が上書きする。`Number('20, 30')` は NaN なので、
                // そのまま入れると**基準が空の計画**になり、軸が効かない絵が混ざる。
                const first = String(value).split(/[,、\s]+/).map(Number).find(Number.isFinite);
                genParams[key] = first === undefined ? null : first;
            } else {
                genParams[key] = value;
            }
        }
        // **手で指した強度と差し替えを重ねる。** 上書きは `record.id` で引くので、
        // recipe をそのまま渡すと**何も重ならない**（`id` を持っていない）。
        // 戻すのは `loras` と `checkpoint` だけ——`id` を recipe 側へ残さない。
        const overridden = applyRecordOverrides({
            id: record?.id, loras: base.loras, checkpoint: base.checkpoint,
        });
        const edited = {
            ...base,
            gen_params: genParams,
            ...(overridden.loras ? { loras: overridden.loras } : {}),
            ...(overridden.checkpoint ? { checkpoint: overridden.checkpoint } : {}),
        };

        // **候補が1つだけの置き換え口は、ここでプロンプトへ埋める。**
        // 軸にできない（軸は2つ以上要る）が、入れた以上は効かないと
        // 「入れたのに何も起きない欄」になる。
        for (const { token, value } of (plan?.substitutions || [])) {
            genParams.prompt = String(genParams.prompt ?? '').split(token).join(value);
        }

        const seed = Number.isFinite(Number(genParams.seed)) ? Number(genParams.seed) : 0;
        const template = plan?.template
            ? { ...plan.template, name: plan.template.name || t('detail.run.idle') }
            : { id: 'detail-one', name: t('detail.run.idle'), mode: 'seeds_only', axes: [], seeds: [seed] };

        // **実行器へ渡すのはレシピ**（2026-08-24 利用者の報告）。
        //
        // ここだけが記録の入れ物（`{...record, recipe}`）を渡していた。実行器は
        // 受け取ったものを**そのまま組み立てへ流す**ので、記録の `checkpoint`
        // ——書庫の要約では**ただの文字列**——が読まれ、「チェックポイント情報が
        // ありません」で1枚も投入されずに終わっていた。
        //
        // 束の実行も、1枚の再現も、Sweep も、**全部レシピを渡している**。
        // ここだけが違っていた。
        //
        // `id` は記録の側を優先する。刻印と再利用の索引がこれで引くので、
        // レシピ側の id と食い違うと「同じ条件をもう一度回さない」が効かなくなる。
        const forRunner = { ...edited, id: record?.id ?? edited.id ?? null };

        try {
            const runner = makeSweepRunner(forRunner);
            detailRunner = runner;
            // **材料が届くのを待つ。** `/object_info` は後から届くので、
            // 待たずに投げると1件中1件が落ちる（束の実行で実際に踏んだ形）。
            if (runner?.inputsReady) await runner.inputsReady;
            const result = await runner.run({
                record: forRunner, template,
                // **1枚ずつ画面へ返す。** 全部揃うまで黙っていると、
                // 24枚の計画では数分間「押しただけ」の画面になる。
                onUpdate: onProgress || null,
            });
            const done = (result?.cells || []).filter(item => item?.output);
            if (done.length) {
                // **出た枚数を返す。** 1枚のつもりで4枚出ていたら、
                // 画面がそう言えないと何が起きたのか判らない。
                if (done.length > 1) appendLog(t('detail.ranMany', { count: done.length }));
                else appendLog(t('detail.ranLog', { count: Object.keys(edits).length }));
                // **出した絵を全部返す。** 詳細がその場でレコードにできるように
     //（2026-08-22 利用者の指示）——1枚目だけ返すと、複数枚出したときに
     // 残りを保存する道が無くなる。
                return {
                    ok: true, output: done[0].output, count: done.length,
                    outputs: done.map(item => item.output),
                };
            }
            // **落ちた理由を捨てない。** 件数だけでは次の一手が決まらない。
            const failed = (result?.cells || []).find(item => item?.error);
            return { ok: false, error: failed?.error || result?.error || t('detail.run.idle') };
        } catch (error) {
            return { ok: false, error: error?.message || String(error) };
        } finally {
            // **持ちっぱなしにしない。** 終わった実行器を止めても何も起きないが、
            // 「止められるように見える」画面を残さない。
            detailRunner = null;
        }
    }

    /** 押したら詳細を開く絵にする。**押せることを字でも出す。** */
    function makeZoomable(image, record) {
        image.setAttribute('data-zoom', 'true');
        image.setAttribute('title', t('image.detail'));
        image.addEventListener('click', (event) => {
            event?.stopPropagation?.();
            // **まず詳細を出す**（2026-08-22 利用者の指示）。拡大だけでは
            // どのモデルで・どのプロンプトで出したのかが見えず、次の一手が決まらない。
            // 拡大はそこから進む先で、詳細の絵を押すと窓いっぱいで開く。
            openDetail(record);
        });
        return image;
    }

    // --- 描画 ---------------------------------------------------------
    function matches(record) {
        if (hidden.has(record?.verdict)) return false;
        if (favoritesOnly && !isFavorite(record)) return false;
        if (!query) return true;
        const hay = [
            // **両方の名前で引ける。** 出す絵の名前（`civitai_<id>`）でも、
            // 上流の画面で見た題（`Civitai_Recipe_<id>`）でも当たる。
            record?.title, displayName(record), record?.checkpoint, record?.positive,
            record?.origin?.filename, record?.sampler,
            ...(record?.loras || []).map(l => l.name),
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(query);
    }

    /** 今の絞り込みで見えている記録（並び順つき）。 */
    function shownRecords() {
        return sortRecords(records.filter(matches), sortKey, groupByCheckpoint, sortDescending);
    }

    /**
     * 操作の対象。**選ばれていれば選択、無ければ「今見えているもの」。**
     *
     * 選択が「見えているもの」の外へ出ることは在りうる（絞り込みを変えた後）。
     * その分は**外す**——画面に出ていないものを動かさない。
     */
    function chosenRecords() {
        const shown = shownRecords();
        if (selected.size === 0) return { list: shown, from: 'filter' };
        const list = shown.filter(record => selected.has(String(record?.id ?? '')));
        return { list, from: 'selection', hidden: selected.size - list.length };
    }

    function setSelected(id, on) {
        const key = String(id ?? '');
        if (!key) return;
        // **選び直したら、見せた総量は無効。** 顔ぶれと落とすものを食い違わせない。
        disarmDownload();
        if (on) selected.add(key);
        else selected.delete(key);
    }

    function clearSelection() {
        disarmDownload();
        if (selected.size === 0) return false;
        selected.clear();
        anchorId = null;
        render();
        return true;
    }

    function selectAllShown() {
        disarmDownload();
        const shown = shownRecords();
        // **押すたびに全選択と全解除を往復する。** 「全部選んだ後に戻せない」
        // をここで作らない（Ctrl+A をもう一度押すのが一番早い戻し方）。
        const everySelected = shown.length > 0
            && shown.every(record => selected.has(String(record?.id ?? '')));
        if (everySelected) selected.clear();
        else for (const record of shown) setSelected(record?.id, true);
        render();
        return selected.size;
    }

    /** Shift+クリックの範囲。**見えている並び順で切る**（内部の順ではない）。 */
    function selectRange(toId) {
        const shown = shownRecords().map(record => String(record?.id ?? ''));
        const from = shown.indexOf(String(anchorId ?? ''));
        const to = shown.indexOf(String(toId ?? ''));
        if (from < 0 || to < 0) return false;
        const [start, end] = from <= to ? [from, to] : [to, from];
        for (let index = start; index <= end; index += 1) selected.add(shown[index]);
        render();
        return true;
    }

    /**
     * お気に入り。**上流の印を書き換えない。**
     *
     * 記録は LoRA Manager が書いた `.recipe.json` で、こちらは読むだけと決めてある。
     * だから印はこちら側に持つ（設定の `favorite_ids`）——上流が既に立てている
     * `favorite` は**そのまま尊重**し、こちらの印と OR で見る。
     *
     * ---
     *
     * **上流の印も外せるようにした**（2026-08-22 利用者の指摘）。
     *
     * 元は「上流の印は消せない」で止めていた。実データでは**お気に入り128件の
     * ほとんどが上流由来**なので、お気に入り順に並べると上に来るのは全部
     * 外せないものになり、**押しても何も起きない**画面になっていた。
     *
     * **上流ファイルは書かない**——外したことを**こちら側の別の名簿**
     *（`unfavorite_ids`）に持ち、見るときに差し引く。次の走査で上流の印が
     * 戻ってきても、こちらの外し印は残る。
     */
    const ourFavorites = new Set(
        (Array.isArray(display?.favoriteIds) ? display.favoriteIds : []).map(String),
    );
    /** こちらで外した記録。**上流の印を打ち消す**（向こうは書き換えない）。 */
    const ourUnfavorites = new Set(
        (Array.isArray(display?.unfavoriteIds) ? display.unfavoriteIds : []).map(String),
    );

    function isFavorite(record) {
        const id = String(record?.id ?? '');
        if (ourUnfavorites.has(id)) return false;
        return record?.favorite === true || ourFavorites.has(id);
    }

    function toggleFavorite(record) {
        const id = String(record?.id ?? '');
        if (!id) return false;
        const on = isFavorite(record);
        if (on) {
            // **外す。** こちらの印を落とし、上流が立てているぶんは
            // 打ち消しの名簿へ入れる（向こうのファイルは書き換えない）。
            ourFavorites.delete(id);
            if (record?.favorite === true) ourUnfavorites.add(id);
        } else {
            ourFavorites.add(id);
            ourUnfavorites.delete(id);
        }
        favoritesIo?.write?.({
            favorite_ids: [...ourFavorites],
            unfavorite_ids: [...ourUnfavorites],
        })?.catch?.(() => appendLog(t('favorite.notSaved')));
        render();
        return isFavorite(record);
    }

    /**
     * 記録1件に対してできること。**表でもタイルでも同じ並び・同じ順。**
     *
     * 器ごとに違う操作を出すと、「あの機能はどっちの画面だったか」を覚える羽目になる。
     * 順は**使う頻度**で決めてある——まず再現を試し、その結果で次が決まる。
     */
    function recordActions(record, { compact = false, icons = false } = {}) {
        // **タイルでは印だけ。** 字を入れると横に伸びて枠から出る
        // （実機で「見切れていて煩雑」と言われた）。何のボタンかは吹き出しと
        // 読み上げが持つ——上流のカードも同じ考えで印だけを並べている。
        const label = (icon, text) => (icons || compact ? icon : text);
        const buttons = [];
        /**
         * **押した瞬間に見た目を変える**（2026-08-24 実機の指摘「大きなラグがある」）。
         *
         * 実測すると**サーバ側は速い**——`/unbake/records` 8ms・1件 5ms・`/queue` 10ms・
         * `/api/embeddings` 3ms（`/object_info` だけ 2MB で 590ms だが1度しか取らない）。
         * 遅かったのは通信ではなく**手応え**で、押しても `disabled` も状態も変わらず、
         * 唯一の反応が下の履歴に1行増えることだった。**画面が変わらなければ、
         * 人は「効いていない」と読んでもう一度押す。**
         *
         * **二度押しは実害になる。** ▶ は2件目で `requireEmptyQueue()` に当たり、
         * 「キューが空でない」で失敗する——**自分の1件目のせいなのに、
         * 他人の生成が居るように見える。** 押している間は受け付けない。
         */
        async function markBusyWhile(button, handler, key) {
            if (button.disabled) return;
            if (key) busyRecords.add(key);
            trackBusy(key, button);
            applyBusy(button, true);
            let result = null;
            try {
                result = await handler();
            } finally {
                // **鍵で戻す。** 押した相手だけ戻すと、処理の途中で描き直された
                // 新しいボタンが走ったまま固まる（実際にそうなっていた）。
                if (key) clearBusy(key);
                else applyBusy(button, false);
            }
            return result;
        }
        /**
         * **走っていることを DOM ではなく id で覚える**（2026-08-24）。
         *
         * これが「押したら印が消える」の真因だった。
         * タイルの操作列は `opacity: 0` で**普段は見えておらず**、
         * タイルを hover したときだけ浮かび上がる。そこへ**一覧の描き直し**が重なると、
         * ボタンは**作り直されて `data-busy` を失い**、列ごと `opacity: 0` へ戻る
         * ——**押した瞬間に印が消えるのは色の問題ではなかった**。
         *
         * **印を DOM に持たせない。** 走っているのは記録であってボタンでは無いので、
         * 描き直しても残る場所（id の集合）へ置く。
         */
        const busyKey = `${record?.id ?? ''}`;
        /**
         * @param {boolean} [busy] **走っている姿を出すか。**
         *
         * **既定は出さない。** お気に入りのような即座に終わる操作まで待たせると、
         * **同じ間に2度目を受け付けなくなる**——実際、押し戻せなくなって検査が捕まえた。
         * 出すのは**外へ投げて待つ操作**だけ（今は ▶ の1つ）。
         */
        const add = (className, label, title, handler, extra = {}, busy = false) => {
            const button = element('button', {
                class: `unbake-act ${className}`, type: 'button',
                text: label, title, 'aria-label': title, ...extra,
            });
            // **描き直されても走っている姿で出す。** 押した後の再描画で
            // 新しいボタンが作られるので、ここで**覚えている状態を当て直す**。
            // **`'queued'` を先に見る。** `busy` は真偽値と `'queued'` の両方を取るので、
            // 走っている記録の判定を先に書くと **`'queued'` が真として吸われ**、
            // 登録簿へ入らないまま走っている姿だけ当たる——**終わっても戻せなくなる**
            // （2026-08-24 に検査が「描き直された方が押せないまま固まっている」で捕まえた）。
            if (busy === 'queued') {
                // **描き直しを越えさせる。** 越えさせないと、一覧が描き直された瞬間に
                // **走っている／順番待ちが画面から消える**（押せるように見えて、押しても何も起きない）。
                trackReplay(busyKey, button);
                applyReplayState(busyKey);
            } else if (busy && busyRecords.has(busyKey)) {
                trackBusy(busyKey, button);
                applyBusy(button, true);
            } else if (busy && heldRecords.has(busyKey)) {
                // **待っている姿も描き直しを越えさせる**。
                // 越えさせないと、一覧が描き直された瞬間に
                // **順番待ちが画面から消える**（押せるように見えて、押しても何も起きない）。
                trackHeld(busyKey, button);
                applyHeld(button, true, t('replay.queued'));
            }
            button.addEventListener('click', (event) => {
                event?.stopPropagation?.();
                // `queued` は**姿を外が持つ**（流し役が待ちと走りを切り替える）。
                // ここで `markBusyWhile` を通すと、**順番待ちの間まで「走っている」姿**になる。
                if (busy === 'queued') { handler(); return; }
                if (!busy) { handler(); return; }
                markBusyWhile(button, handler, busyKey);
            });
            buttons.push(button);
            return button;
        };

        // **押せないものは出さない。** 「かけられるか」の判断は今までどおり
        // `sweepableRecord()` と「書庫から取り直せるか」で決める
        // ——ここで作り直すと、押しても何も起きないボタンが並ぶ。
        const fromLibrary = Boolean(record?.libraryId && loadRecord);
        // **実行器の有無で口を消さない。** 書庫の記録は押した時点で本体を取りに行く
        // ——ここで消すと「材料が無い」という理由が誰にも伝わらないまま口だけ消える。
        const canRun = fromLibrary || sweepableRecord(record).ok;

        // **まず再現。** 利用者が最初に試すのはこれで、結果で次の行動が決まる。
        if (canRun) {
            // **走っている姿を出すのはここだけ。** 外へ投げて待つのはこの操作だけで、
            // 二度押しが実害になる（自分の1件目のせいで「キューが空でない」へ当たる）のもここ。
            // **走っている姿の面倒は流し役が見る**（2026-08-24）。
            // ここで `markBusyWhile` を通すと、**順番待ちの間まで「走っている」姿**になり、
            // 「押したのに何も起きない」時間が走行中と区別できなくなる。
            // 押した合図だけ渡して、待ちと走りの切り替えは `pumpReplayQueue` が持つ。
            add('unbake-act-replay', label('▶', t('replay.one')), t('replay.one.help'),
                () => enqueueReplay(record), {}, 'queued');
        }
        if (openInComfy) {
            add('unbake-act-open', '⇱', t('openInComfy'), () => openRecordInComfy(record));
        }
        // **「振る」「出た絵」「使っているモデル」のアイコンは置かない**
        // （2026-08-22 利用者の指示）。どれも詳細の中に在るので、行にも置くと
        // **同じ場所への入口が2つ**になる。入口は「絵を押す」1つに寄せた。
        // 既に Sweep から出た絵は、どのセルから来たのかを出す（操作ではなく出自）。
        if (record?.sweep?.cellId) {
            buttons.push(element('span', {
                class: 'unbake-sweep-origin', text: String(record.sweep.cellId),
            }));
        }
        if (!canRun && !record?.sweep?.cellId) {
            buttons.push(element('span', {
                class: 'unbake-sweep-na', text: '—', title: t('sweep.unavailable'),
            }));
        }
        // **消す口は最後に置く。** 並びは使う頻度で決めてあり、
        // 取り返しのつかないものを、よく押すものの隣に置かない。
        if (recordsIo?.remove) {
            add('unbake-act-delete', '🗑', t('record.delete.help'), () => confirmDeleteRecord(record));
        }
        const favorite = isFavorite(record);
        add('unbake-act-favorite', favorite ? '★' : '☆',
            favorite ? t('favorite.remove') : t('favorite.add'),
            () => toggleFavorite(record),
            { 'data-on': favorite ? 'true' : 'false', 'aria-pressed': favorite ? 'true' : 'false' });
        return buttons;
    }

    /** 記録1件ぶんの選択の口。表でもタイルでも同じものを使う。 */
    function pickBox(record) {
        const id = String(record?.id ?? '');
        const box = element('input', {
            class: 'unbake-pick', type: 'checkbox',
            'aria-label': t('select.one', { title: displayName(record) }),
        });
        if (selected.has(id)) {
            box.checked = true;
            // 偽 DOM でも読めるように属性でも持つ（**表示ではなく入力が真実**）。
            box.setAttribute('data-checked', 'true');
        }
        box.addEventListener('click', (event) => {
            const on = box.checked === true || box.getAttribute?.('data-checked') === 'true';
            if (event?.shiftKey && anchorId && anchorId !== id) {
                selectRange(id);
                return;
            }
            setSelected(id, on);
            anchorId = id;
            render();
        });
        return box;
    }

    /**
     * 保存した設定を、**開いたままの面へ当て直す。**
     *
     * 見た目の設定は面を作るときに読んでいるので、保存しただけでは何も変わらない
     * ——実機で「テーマを変えても変化が無い」「判定の色も変わらない」と言われた。
     * **面を組み直さずに済むものは、属性を書き換えるだけ**で足りる（どちらも CSS）。
     */
    function applyDisplay(next = {}) {
        if (next.theme !== undefined) {
            const wanted = String(next.theme);
            if (['host', 'amber', 'ember', 'moss', 'paper'].includes(wanted)) {
                theme = wanted;
                root.setAttribute('data-theme', theme);
            }
        }
        if (next.replay_max_megapixels !== undefined || next.replayMaxMegapixels !== undefined) {
            const wanted = Number(next.replay_max_megapixels ?? next.replayMaxMegapixels);
            if (Number.isFinite(wanted)) replayMaxMegapixels = Math.max(0, wanted);
        }
        if (next.ui_skin !== undefined || next.uiSkin !== undefined) {
            uiSkin = normalizeSkin(next.ui_skin ?? next.uiSkin);
            root.setAttribute('data-skin', uiSkin);
            // **紙の出し入れも、その場で。** 属性だけ戻して紙を残すと、
            // テーマ1へ戻したつもりで規則が効き続ける。
            applySkin(doc, uiSkin);
        }
        if (next.rich_ui !== undefined || next.richUi !== undefined) {
            richUi = (next.rich_ui ?? next.richUi) !== false;
            root.setAttribute('data-rich', richUi ? 'on' : 'off');
        }
        if (next.verdict_palette !== undefined || next.verdictPalette !== undefined) {
            const wanted = String(next.verdict_palette ?? next.verdictPalette);
            verdictPalette = wanted === 'deuteranopia' ? 'deuteranopia' : 'default';
            root.setAttribute('data-palette', verdictPalette);
        }
        if (next.tile_size !== undefined || next.tileSize !== undefined) {
            tileSize = Math.max(0, Math.min(4, Number(next.tile_size ?? next.tileSize) || 0));
            columnsSelect.value = String(tileSize);
        }
        if (next.list_view !== undefined || next.listView !== undefined) {
            const wanted = String(next.list_view ?? next.listView);
            if (LIST_VIEWS.has(wanted)) listView = wanted;
        }
        // **設定画面から戻したら、その場で効くこと。** ここを見ていないと
        // 「二度と表示しない」を解除しても、開き直すまで確認が出ない。
        if (next.confirm_before_delete !== undefined || next.confirmBeforeDelete !== undefined) {
            confirmBeforeDelete = (next.confirm_before_delete ?? next.confirmBeforeDelete) !== false;
        }
        if (next.sort_key !== undefined || next.sortKey !== undefined) {
            const wanted = String(next.sort_key ?? next.sortKey);
            if (SORT_KEYS.has(wanted)) sortKey = wanted;
        }
        if (next.sort_descending !== undefined || next.sortDescending !== undefined) {
            sortDescending = (next.sort_descending ?? next.sortDescending) === true;
        }
        // **並びを変える設定は、切った瞬間に効くこと。** ここを見ていないと
        // 保存はできているのに一覧が古いままで、**設定が壊れているように見える**
        // （2026-08-25 実機: まとめを切っても、読み直すまで並びが戻らなかった）。
        if (next.group_by_checkpoint !== undefined || next.groupByCheckpoint !== undefined) {
            groupByCheckpoint = (next.group_by_checkpoint ?? next.groupByCheckpoint) === true;
        }
        if (next.compact_width !== undefined || next.compactWidth !== undefined) {
            const wanted = positiveOr(next.compact_width ?? next.compactWidth, null);
            // **測り直しは `render()` が先頭でやる。** ここでは閾値だけ入れ替える。
            if (wanted !== null) compactWidth = wanted;
        }
        if (next.show_commercial_ok !== undefined || next.showCommercialOk !== undefined) {
            showCommercialOk = (next.show_commercial_ok ?? next.showCommercialOk) !== false;
            // **見出しも一緒に動かす。** 本文だけ出し入れすると列がずれる。
            if (showCommercialOk) headRow.append(commercialHead);
            else commercialHead.remove?.();
        }
        render();
        return { theme, verdictPalette, tileSize, listView, confirmBeforeDelete };
    }

    /**
     * 並べる記録を差し替える。**中からも呼べるようにここへ置く。**
     *
     * 返り値のメソッド（`panel.setRecords`）は中から呼べない——呼ぶと
     * `ReferenceError` になり、`try`/`catch` に飲まれて**静かに何も起きない**
     *（2026-08-22 に取り込み後の読み直しで踏んだ）。
     */
    function replaceRecords(next) {
        records = [...(next || [])];
        render();
    }

    /** 幅を測って密度へ反映する。据えるまでは何もしない（下で定義する）。 */
    let measureWidth = () => {};

    /**
     * Sweep 欄の中身。**入口は置かず、状態だけを出す**（2026-08-22 利用者の指示）。
     *
     * 「振る」は詳細（絵を押して開く）の中へ全部移したので、ここから開く道は
     * 作らない——**同じ場所への入口を2つ持たない**。残しているのは2つだけ:
     *
     *   1. この記録が既に Sweep の産物 → そのセルの番号（どこから来たかを示す）
     *   2. かけられない → 印と理由（**開く前に読めないと判らなくなる**）
     */
    function sweepCell(record) {
        if (record?.sweep?.cellId) {
            return element('span', { class: 'unbake-sweep-origin', text: String(record.sweep.cellId) });
        }
        // **書庫の記録は本体をまだ持っていない。** 開いた時点で取りに行くので、
        // 「レシピ由来である」ことが判っていれば、かけられない印は出さない。
        const fromLibrary = Boolean(record?.libraryId && loadRecord);
        const gate = sweepableRecord(record);
        if (!gate.ok && !fromLibrary) {
            return element('span', {
                class: 'unbake-sweep-na',
                text: '—',
                title: t('sweep.unavailable'),
            });
        }
        return element('span', { class: 'unbake-sweep-cell-actions' });
    }

    /**
     * 記録を1枚だけ出し直す。**利用者が最初に押すのがこれ。**
     *
     * ---
     *
     * **実行器は新しく書かない。** 投げて待って結果を拾うところは `SweepRunner` が
     * 持っていて実機で形が固まっている。ここがやるのは「元の seed で1セルだけ」
     * という宣言を作って渡すことと、**出た絵を元の1枚の隣に並べる**ことだけ。
     *
     * **元の seed を使う。** 別の seed で出した絵は「再現できたか」の答えにならない
     * ——違って見えたときに、条件が違うのか再現できていないのかが切り分けられない。
     */
    /**
     * 止まり得る形かを、**投げずに**調べて聞く（2026-08-25 利用者の指示）。
     *
     * 分割復号になる形は、実測で ComfyUI が復号の段から進まなくなる
     * ——中断は効かず、再起動しか手が無い。**押した本人が知らないまま止まる**
     * のが一番困るので、そこだけ人に返す。
     *
     * **調べられなければ止めない。** 計画を組めないこと自体は別の失敗で、
     * ここで塞ぐと「押しても何も起きない」に化ける。
     *
     * @returns {Promise<boolean>} 投げてよいか
     */
    /** 投げずに計画だけ組む。**組めなければ null**（ここで止めない）。 */
    function planReplay(runner, recipe, template) {
        if (typeof runner.preflight !== 'function') return null;
        try {
            return runner.preflight(recipe, template);
        } catch {
            // **組めないこと自体は別の失敗。** ここで塞ぐと
            // 「押しても何も起きない」に化ける（実行器が改めて言う）。
            return null;
        }
    }

    /** 計画が言っている注意。**同じ文は1回だけ。** */
    function replayWarnings(plan) {
        const seen = new Set();
        for (const cell of plan?.cells || []) {
            for (const warning of cell?.workflow?.warnings || []) {
                const text = String(warning || '').trim();
                if (text) seen.add(text);
            }
        }
        return [...seen];
    }

    /** 分割して復号する形か（＝止まり得る形）。 */
    function usesTiledDecode(plan) {
        return (plan?.cells || []).some(cell => Object.values(cell?.workflow?.prompt || {})
            .some(node => String(node?.class_type || '') === 'VAEDecodeTiled'));
    }

    async function askBeforeHeavyReplay() {
        if (typeof createConfirmView !== 'function') return true;
        return new Promise((resolve) => {
            let answered = false;
            const done = (value) => { if (!answered) { answered = true; resolve(value); } };
            openConfirm({
                title: t('replay.heavy.title'),
                warnings: [t('replay.heavy.body')],
                onConfirm: async () => { done(true); return { ok: true }; },
                onReturn: () => done(false),
            });
        });
    }

    async function reproduceOne(record) {
        if (!makeSweepRunner) { appendLog(t('sweep.noRunner')); return null; }
        let target = record;
        if (!target?.recipe && target?.libraryId && loadRecord) {
            try {
                target = { ...record, recipe: await loadRecord(record.libraryId) };
            } catch (error) {
                appendLog(t('list.loadFailed', { detail: error?.message || error }));
                return null;
            }
        }
        const recipe = target.recipe || target;
        const seed = Number(recipe?.gen_params?.seed);
        appendLog(t('replay.running', { title: displayName(record) }));

        let runner;
        try {
            // **上限は面が持っている設定から渡す。** 渡さないと、設定は在るのに効かない。
            runner = makeSweepRunner(target, { maxReplayMegapixels: replayMaxMegapixels });
        } catch {
            appendLog(t('sweep.noRunner'));
            return null;
        }
        const template = {
            id: 'replay-one',
            mode: 'seeds_only',
            axes: [],
            // 記録に seed が無ければ 0（**そのことは判定の側が既に言っている**）。
            seeds: [Number.isSafeInteger(seed) && seed >= 0 ? seed : 0],
            recipeId: String(recipe.id ?? ''),
        };
        try {
            if (runner.inputsReady?.then) await runner.inputsReady;
            // **組み立てが言ったことを、そのまま人へ渡す**（2026-08-25 実機の指摘）。
            //
            // 実行器は組み立ての `warnings` を**一度も見ていなかった**ので、
            // 縮めたことも・推定で埋めたことも、画面には1行も出ていなかった
            // ——**黙って縮めると、次に比べたときの差が説明できない。**
            const plan = planReplay(runner, recipe, template);
            for (const warning of replayWarnings(plan)) appendLog(warning);

            // **止まり得る形は、投げる前に聞く**（2026-08-25 利用者の指示）。
            //
            // 縮める上限を切っている人には、記録どおりの寸法で回る。実測では
            // その形で ComfyUI が復号の段から進まなくなり、再起動しか手が無い
            // ——**押した本人が知らないまま止まる**のが一番困る。
            // 縮める設定が入っているときは、そもそも分割にならないので聞かない。
            if (replayMaxMegapixels <= 0 && usesTiledDecode(plan)
                && !(await askBeforeHeavyReplay())) {
                appendLog(t('replay.cancelled'));
                return null;
            }
            // **キューの確認は実行器へ任せる**（2026-08-24 実機の報告）。
            // ここで先に弾いていたので、**既に出ている絵をそのまま開くだけの回**まで
            // 「他の生成が走っている」で断られていた——その回はキューへ1件も投げない。
            // 実行器なら**本当に投げる分が在るときだけ**確かめられる。
            const job = await runner.run({
                requireEmptyQueueBeforeSubmit: true,
                record: recipe,
                template,
                reuseExisting: true,
            });
            const made = (job?.cells || []).filter(cell => cell?.output?.url);
            appendLog(t('replay.done', { n: made.length }));
            if (made.length) {
                // **出たら、元の1枚の隣に並べる。** 「再現できたか」は人が見て決める。
                openCompare(record, made.map(cell => ({
                    url: cell.output.url,
                    label: t('replay.result'),
                })));
            }
            return job;
        } catch (error) {
            appendLog(t('replay.failed', { detail: error?.message || String(error) }));
            // **待てば通る断りは、失敗と別に見せる**（2026-08-24 利用者の指示）。
            // 他の生成が走っているだけなので、**押した人は何も間違えていない**。
            // 呼び手（ボタン）が止まった姿にできるよう、種類をそのまま返す。
            if (error?.code === QUEUE_NOT_EMPTY) return { held: true, reason: error.message };
            return null;
        }
    }

    /**
     * ComfyUI の画面へワークフローを開く。**投げない。**
     *
     * 出すところまでで止めるのは、**開いてから直したい**ことがあるため
     * （足りないモデルを別のものへ差し替える、解像度だけ変える）。
     * 投げるのは「再現する」と Sweep の役目。
     */
    async function openRecordInComfy(record) {
        if (!openInComfy) { appendLog(t('openInComfy.unavailable')); return null; }
        let target = record;
        if (!target?.recipe && target?.libraryId && loadRecord) {
            try {
                target = { ...record, recipe: await loadRecord(record.libraryId) };
            } catch (error) {
                appendLog(t('list.loadFailed', { detail: error?.message || error }));
                return null;
            }
        }
        try {
            const opened = await openInComfy(target.recipe || target, displayName(record));
            appendLog(opened?.ok
                ? t('openInComfy.done', { how: opened.how })
                : t('openInComfy.failed', { detail: opened?.error || '' }));
            return opened;
        } catch (error) {
            appendLog(t('openInComfy.failed', { detail: error?.message || String(error) }));
            return null;
        }
    }


    /**
     * 面の中に浮かべる器を1つ作る（2026-08-24）。
     *
     * **設定・あとで読む箱・支援の3つで同じ物を使う。** 別々に作ると、
     * 片方にだけ「外を押すと閉じる」が入って**同じ見た目なのに挙動が違う**になる。
     *
     * **`fixed` にしない。** 画面いっぱいに広がって ComfyUI の上へ被さり、
     * 操作まで塞ぐ——支援の面で実際にそうなっていた（実測: 後ろ布が画面全域・
     * `pointer-events: auto`・キャンバス上で `elementFromPoint` が後ろ布を返す）。
     */
    function popupLayer(node, onClose) {
        const layer = element('div', {
            class: 'unbake-popup-layer', role: 'dialog', 'aria-modal': 'true',
        });
        // **器も一緒に片付ける。** 中の面だけ `destroy()` すると、
        // **空の覆いが残って一覧が押せなくなる**（見た目は何も無いので原因が読めない）。
        openLayers.add(layer);
        const box = element('div', { class: 'unbake-popup' }, [node]);
        layer.append(box);
        // **周りを押すと閉じる。中を押しても閉じない**（他の面と同じ約束）。
        layer.addEventListener('click', (event) => { if (event?.target === layer) onClose?.(); });
        box.addEventListener('click', (event) => event?.stopPropagation?.());
        return layer;
    }

    /**
     * 設定の面を浮かべる。
     *
     * **口が渡されていなければ開かない。** 開いて空の項目を並べると、
     * 「設定できるのに保存されない」という最悪の形になる。
     */
    function openSettings() {
        if (!settingsIo?.read || !settingsIo?.write) {
            appendLog(t('settings.unavailable'));
            return null;
        }
        closeOverlays();
        settingsView = createSettingsView({
            documentRef: doc,
            read: settingsIo.read,
            write: settingsIo.write,
            rescan: settingsIo.rescan || null,
            onClose: () => { closeOverlays(); render(); },
            onLanguageChange: settingsIo.onLanguageChange || null,
            // 保存した値を、開いたままの面へ当て直す。
            onSaved: (patch) => applyDisplay(patch),
        });
        // **一覧を隠さない**（2026-08-24 利用者の指示でページからポップアップへ）。
        // 隠していた間は、開いている最中に**何件あるのか・どれを見ていたのかが
        // 画面から消えて**いた。浮かべれば後ろに残る。
        root.append(popupLayer(settingsView.root, () => { closeOverlays(); render(); }));
        return settingsView;
    }

    /**
     * 「あとで読む箱」を開く（裁定⑦・手順19）。
     *
     * **取り込みは落とし込みと同じ道を通す。** ここで作るのは Civitai 経路の
     * `routed` だけで、取得も組み立ても記録への取り込みも `ingestRouted()` が担う
     * ——2本目の取り込み器を作ると、片方にだけ直しが入って静かに食い違う。
     */
    function openRaindrop() {
        if (typeof raindropIo?.list !== 'function') {
            appendLog(t('raindrop.unavailable'));
            return null;
        }
        closeOverlays();
        raindropView = createRaindropView({
            documentRef: doc,
            list: raindropIo.list,
            // 手元に在る記録の画像 ID。**書庫の分はサーバが返す**ので、
            // ここが足すのは落とし込みや取り込みで増えた分。
            knownIdsOf: () => records.map(imageIdOfRecord).filter(Boolean),
            importOne: (target) => ingestRouted({
                route: DROP_ROUTES.CIVITAI,
                imageId: target.id,
                domain: target.domain,
                url: target.url,
                source: 'raindrop',
            }),
            onClose: () => { closeOverlays(); render(); },
        });
        // 設定と同じ扱い（ページではなくポップアップ）。**器を2つ作らない。**
        root.append(popupLayer(raindropView.root, () => { closeOverlays(); render(); }));
        return raindropView;
    }

    /**
     * この記録が使っているモデルを並べる。**消す前に件数を出すのがこの面の役目。**
     *
     * 本体が取れるなら取ってから開く——要約の `loras` は名前と効き目しか無いが、
     * 本体には並びが揃っている。取れなくても要約で開く（**開けないより出す**）。
     */
    async function openModels(record) {
        if (!modelsIo?.plan) { appendLog(t('models.unavailable')); return null; }
        let recipe = record?.recipe || null;
        if (!recipe && record?.libraryId && loadRecord) {
            try { recipe = await loadRecord(record.libraryId); } catch { recipe = null; }
        }
        closeOverlays();
        modelsView = createModelsView({
            documentRef: doc,
            record,
            recipe,
            io: modelsIo,
            onClose: () => { closeOverlays(); render(); },
            onDelete: (entry, plan, refresh) => confirmDeleteModel(entry, plan, refresh),
        });
        body.style.display = 'none';
        root.append(modelsView.root);
        return modelsView;
    }

    /**
     * 確認をポップアップで出す（2026-08-22 利用者の指示）。
     *
     * **後ろの面は畳まない。** 一覧やモデルの並びが見えたまま重なるので、
     * 「どれを消そうとしているのか」が確認の最中も画面に残る
     * ——面を置き換える作りだと、そこが消えて選び間違いに気づけない。
     */
    function openConfirm(options) {
        // 確認だけは重ねてよい（2枚目の確認は出さない）。
        confirmView?.destroy();
        confirmView = null;
        confirmView = createConfirmView({
            documentRef: doc,
            ...options,
            // **切り替えは設定へ保存する。** 面の中だけで覚えると、
            // 開き直した瞬間に戻る／戻す口が無い、のどちらかになる。
            onSuppressChange: (hide) => {
                applyDisplay({ confirmBeforeDelete: !hide });
                // **保存できなかったことを黙らせない。** 黙ると、次に開いたときに
                // 確認がまた出て「切ったのに効かない」と読まれる。
                Promise.resolve(settingsIo?.write?.({ confirm_before_delete: !hide }))
                    .catch(() => appendLog(t('confirm.suppress.notSaved')));
            },
            onClose: () => {
                confirmView?.destroy();
                confirmView = null;
                options.onReturn?.();
            },
        });
        root.append(confirmView.root);
        return confirmView;
    }

    /**
     * 確認を出すか、出さずにそのまま走らせるか。
     *
     * **切ってあっても結果は必ず出す。** 「確認を出さない」は
     * 「何が起きたか伝えない」ではない。
     */
    function askThen(options) {
        if (confirmBeforeDelete) return openConfirm(options);
        Promise.resolve()
            .then(() => options.onConfirm())
            .then((result) => {
                options.onReturn?.();
                if (result?.ok) {
                    appendLog(t('confirm.done', { list: (result.removed || []).join(' / ') || '—' }));
                } else {
                    appendLog(t('confirm.failed', {
                        detail: String(result?.error || (result?.failed || []).join(' / ') || ''),
                    }));
                }
            })
            .catch((error) => appendLog(t('confirm.failed', { detail: error?.message || String(error) })));
        return null;
    }

    /**
     * 記録を1件消す。**LoRA Manager が書いたものも消せる**（2026-08-21 ユーザー決定）。
     *
     * ただし**向こうの DB からは消えない**ので、稼働中の LoRA Manager には
     * 再スキャンするまで残って見える。そこを書かないと「消えていない」と読まれる。
     */
    function confirmDeleteRecord(record) {
        if (!recordsIo?.remove) { appendLog(t('record.delete.unavailable')); return null; }
        const owner = record?.owner || (record?.libraryId ? 'lora-manager' : 'unbake');
        const warnings = [];
        if (owner !== 'unbake') warnings.push(t('record.delete.upstream'));
        if (!record?.libraryId) warnings.push(t('record.delete.notSaved'));
        return askThen({
            title: t('record.delete.title', { title: record?.title || record?.id || '' }),
            // **何が消えるかはサーバしか知らない**（画面はパスを持っていない）。
            // 消えるものの種類だけを先に書き、実際に消えた一覧は結果として出す。
            files: [{ name: t('record.delete.what'), bytes: null }],
            warnings,
            onConfirm: async () => {
                // **保存で付いた id を優先する。** `safe_id()` が使えない字を落とすので、
                // 画面の id とディスクの id は一致しないことがある。
                const result = await recordsIo.remove(record.savedId || record.id);
                if (result?.ok) {
                    records = records.filter(item => item.id !== record.id);
                    selected.delete(String(record.id));
                }
                return result;
            },
            // **消えたら一覧を描き直す。** 確認を切ってあるとポップアップも
            // 出ないので、ここを忘れると**押しても何も起きない画面**になる
            //（記録は消えているのに、消えていないようにしか見えない）。
            onReturn: () => render(),
        });
    }

    /** モデルを1つ消す。**巻き添えの件数と、数えた範囲を必ず出す。** */
    function confirmDeleteModel(entry, plan, refresh) {
        const used = plan?.usage?.count ?? 0;
        const warnings = [t('models.delete.scope')];
        if (used > 1) warnings.push(t('models.delete.shared', { count: used - 1 }));
        return askThen({
            title: t('models.delete.title', { name: entry.name }),
            files: plan?.files || [],
            warnings,
            onConfirm: () => modelsIo.remove(entry.kind, entry.name),
            onReturn: () => { refresh?.(); },
        });
    }

    /**
     * この記録から出た絵を並べる。**基準との差だけをラベルにする**（裁定③）。
     *
     * **押されたときに初めて突き合わせる。** 出力は実測で4,275枚あり、
     * 生の値で18.2 MiB になる——開いた瞬間に全部取ると画面が固まる。
     */
    async function openVariants(record, button = null) {
        if (typeof loadVariants !== 'function') {
            appendLog(t('variants.unavailable'));
            return null;
        }
        // **待っていることを、押した場所で見せる。** 初回は索引を組むので 2 秒かかる
        // ——記録は下の履歴に出ていたが、押した指の先には何も起きていなかった。
        const label = button?.textContent;
        if (button) {
            button.disabled = true;
            button.textContent = '…';
            button.setAttribute('title', t('variants.matching'));
        }
        appendLog(t('variants.matching'));
        let found;
        try {
            found = await loadVariants(record);
        } catch (error) {
            appendLog(t('variants.failed', { detail: error?.message || error }));
            return null;
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = label ?? '◫';
                button.setAttribute('title', t('variants.open.help'));
            }
        }
        closeOverlays();
        variantsView = createVariantsView({
            documentRef: doc,
            record,
            outputs: found?.outputs || [],
            recipe: found?.recipe || null,
            onClose: () => { flushPendingDeletes(); closeOverlays(); render(); },
            // **絵を押したら、元の1枚と並べてホイールで送れる。**
            // 差の一覧（何が違うか）はこの面が出し、見比べるのは向こうの面が担う
            // ——一覧の中で小さく並べたままでは、違いは見えない。
            onCompare: (index) => {
                // **`url` を持たない出力が在る**（上の面と同じ理由——落とすと
                // 一覧が空になり、拡大は元画像のまま残る）。
                const items = (found?.outputs || []).map(output => ({
                    url: output?.url || outputViewUrl(output),
                    label: output?.differenceLabel || output?.filename || '',
                }));
                const box = openCompare(record, items);
                box?.show?.(Number(index) || 0);
                return box;
            },
            // **消すのは猶予の後**（2026-08-25 利用者の指示）。
            // 押した瞬間は画面から外すだけ——戻せるうちは、まだ消していない。
            onDelete: (output) => deleteOutputLater(output, record),
        });
        body.style.display = 'none';
        root.append(variantsView.root);
        return variantsView;
    }

    /** 猶予（ミリ秒）。**この間は1枚も消えていない。** */
    const DELETE_GRACE_MS = 12000;
    /** 消す約束。**面を閉じたら流し切る**（開いたまま忘れない）。 */
    const pendingDeletes = new Map();

    /**
     * 出た絵を1枚消す（2026-08-25 利用者の指示）。
     *
     * **押した瞬間には消さない。** 画面から外して猶予を置き、
     * その間に「元に戻す」を押せば**1バイトも消えていない**状態へ戻る
     * ——消してから戻すには置き場が要り、置き場は必ず溜まる。
     *
     * 面を閉じるときは**流し切る**（消すと言ったものを、黙って残さない）。
     */
    async function deleteOutputLater(output, record) {
        const filename = String(output?.filename || '').trim();
        if (!filename) return { ok: false, reason: 'no filename' };
        if (!deleteOutputIo) return { ok: false, reason: 'unavailable' };
        const subfolder = String(output?.subfolder || '');
        const key = `${subfolder}/${filename}`;
        if (pendingDeletes.has(key)) return { ok: true };

        const run = async () => {
            pendingDeletes.delete(key);
            try {
                const result = await deleteOutputIo({ filename, subfolder });
                appendLog(result?.ok === false
                    ? t('detail.deleteFailed', { detail: String(result?.error || '') })
                    : t('detail.deleted', { name: filename }));
            } catch (error) {
                appendLog(t('detail.deleteFailed', { detail: error?.message || String(error) }));
            }
        };
        const timer = typeof setTimeout === 'function' ? setTimeout(run, DELETE_GRACE_MS) : null;
        pendingDeletes.set(key, { run, timer });

        /** 約束を取り消す。**呼べるのは猶予のあいだだけ。** */
        const undo = () => {
            const held = pendingDeletes.get(key);
            if (!held) return false;
            if (held.timer) clearTimeout(held.timer);
            pendingDeletes.delete(key);
            appendLog(t('detail.undone', { name: filename }));
            return true;
        };

        appendLog(t('detail.deletePending', {
            name: filename, seconds: Math.round(DELETE_GRACE_MS / 1000),
        }), {
            action: {
                label: t('detail.undo'),
                // 記録欄から戻したときは、面を読み直さないと絵が戻らない。
                run: () => { if (undo() && record) openVariants(record); },
            },
        });
        // **戻す口を、押した場所へ渡す**（2026-08-25 利用者の指摘）。
        // 記録欄は詳細に被さって見えないので、ここだけに置くと**見つけられない**。
        return { ok: true, undo, seconds: Math.round(DELETE_GRACE_MS / 1000) };
    }

    /** 約束を全部流し切る。**閉じても消すと言ったものは消す。** */
    function flushPendingDeletes() {
        for (const [, held] of pendingDeletes) {
            if (held.timer) clearTimeout(held.timer);
            held.run();
        }
    }

    /**
     * 絞ってから束で回す（手順13）。
     *
     * **飛ばした件数を必ず出す。** 「N件回しました」だけだと、回らなかった分が
     * 黙って消える——投げる前に落としたのか、既に出ていたのか、未判定だったのかで
     * 打つ手が違う。
     */
    let batchRunner = null;
    async function runBatch() {
        if (!batchIo) return null;
        if (batchRunner) { appendLog(t('batch.busy')); return null; }
        batchRunner = createBatchRunner(batchIo);
        if (batchStopButton) batchStopButton.disabled = false;
        if (batchButton) batchButton.disabled = true;
        try {
            // **回すのは「選んだもの」、無ければ「今見えているもの」だけ。**
            // 絞り込みを無視して全件回すと、押した人が見ていない287件が走り出す
            // ——**画面に出ていないものを動かさない。**
            const picked = chosenRecords();
            appendLog(picked.from === 'selection'
                ? t('batch.scopeSelected', { count: picked.list.length, total: records.length })
                : t('batch.scope', { count: picked.list.length, total: records.length }));
            // **キューが空に見えることを、先に言っておく。** ComfyUI へは1件ずつしか
            // 入れない（束で投げると不安定になるため）。何も見えないせいで
            // 「入っていない」と読まれ、何度も回されるのを防ぐ。
            appendLog(t('batch.queueing', { count: picked.list.length }));
            const result = await batchRunner.run(picked.list, {
                stampedSignatures: batchIo.stampedSignatures || null,
                wantedSignaturesOf: batchIo.wantedSignaturesOf || null,
                onProgress: ({ index, total, record, phase }) => {
                    if (phase !== 'start') return;
                    appendLog(t('batch.progress', {
                        index: index + 1, total, title: record?.title || record?.id || '',
                    }));
                },
            });
            appendLog(t('batch.done', {
                done: result.done.length,
                failed: result.failed.length,
                blocked: result.skipped.blocked,
                pending: result.skipped.pending,
                already: result.skipped.alreadyDone,
                trimmed: result.skipped.trimmed,
            }));
            // **並べ替えの効きを段で出す。** 足し算できない形で。
            appendLog(t('batch.loads', {
                all: result.loads.all, filtered: result.loads.filtered, ordered: result.loads.ordered,
            }));
            // **落ちた理由を出す。** 件数だけだと、次に何をすればよいか判らない
            // ——実機で「0 run, 1 failed」とだけ出て、理由を追うのに別の道具が要った。
            for (const item of result.failed) {
                appendLog(t('batch.itemFailed', {
                    title: item.record?.title || item.record?.id || '', detail: item.error,
                }));
            }
            if (result.stopped) appendLog(t('batch.stopped'));
            return result;
        } catch (error) {
            appendLog(t('batch.failed', { detail: error?.message || String(error) }));
            return null;
        } finally {
            batchRunner = null;
            if (batchStopButton) batchStopButton.disabled = true;
            if (batchButton) batchButton.disabled = false;
            render();
        }
    }

    /**
     * 選んだ記録に足りていないモデルを落とす。
     *
     * ---
     *
     * **これが「自動ダウンロードのボタンが無い」の中身だった。** 落とす仕掛けは
     * サーバ側に在り（`/unbake/download`）、不足を種類分けする層も在ったのに、
     * **画面から呼ぶ配線が1本も無かった**——この決定でずっと直しているのと同じ形。
     *
     * **落とせるのは版IDを持つものだけ。** 名前しか判らない不足は、どの版か
     * 決められないので落とせない（勝手に似た名前を落とすと、再現できない絵が
     * 「再現できた」ことになる）。落とせないものは**理由つきで数える**。
     *
     * **1つずつ落とす。** サーバは同時に1つしか受けないうえ、数GBを並行で
     * 引くと途中で切れたときにどれが壊れたのか判らなくなる。
     */
    let downloading = false;
    let downloadCanceled = false;
    /**
     * 「これだけ落とします」と出した後の待ち。**1回目の押しでは落とさない。**
     *
     * 実測（2026-08-20）: 59件を選んで押したら19本の待ち行列が走り出し、
     * **10本目が 34 GB のチェックポイント**だった。総量は Civitai が持っていて
     * 落とす前に引けるのだから、**引いてから人に見せて、もう一度押させる**。
     * 選び直したら待ちは捨てる（見せた総量と落とすものが食い違わないように）。
     */
    let armedDownload = null;
    /** 終わったあとに欄へ残す一行（**空に戻さない**）。 */
    let downloadSummary = '';

    /**
     * 落とすボタンの語。**未選択なら「全ての」と書く**（2026-08-23 利用者の指示）。
     *
     * 何も選んでいないときは表示中の全件が対象になる——楽なので残すが、
     * **語が同じだと範囲が違うことに気づけない。**
     */
    function downloadButtonText() {
        return selected.size === 0 ? t('download.missing.all') : t('download.missing');
    }

    /**
     * 数え上げている間の姿（2026-08-25 利用者の指示）。
     *
     * **押したのに何も起きない、を作らない。** 記録が多いと数え上げと
     * 大きさの問い合わせに間が空く。押せなくして、語も差し替える。
     */
    function setDownloadScanning(on) {
        if (on) {
            downloadButton.disabled = true;
            downloadButton.setAttribute('data-scanning', 'true');
            downloadButton.textContent = t('download.scanning');
            return;
        }
        downloadButton.disabled = false;
        downloadButton.removeAttribute('data-scanning');
        // **語は呼び手が決める。** arm した後はそちらが上書きする。
        if (!armedDownload) downloadButton.textContent = downloadButtonText();
    }

    function disarmDownload() {
        if (!armedDownload) return;
        armedDownload = null;
        downloadButton.textContent = downloadButtonText();
        downloadButton.removeAttribute('data-armed');
    }

    function downloadTargets(list) {
        /** 版ID → 落とすもの。**同じ版を2回落とさない。** */
        const wanted = new Map();
        const blocked = [];
        for (const record of list) {
            // 台帳は渡さない（`/api/lm/*` を新しく呼ばない）。**版IDで落とせるものだけ**を採る。
            const classified = classifyMissing(record?.missing, null);
            for (const item of classified.civitai) {
                const versionId = String(item?.versionId ?? '');
                if (!versionId) continue;
                if (!wanted.has(versionId)) wanted.set(versionId, { ...item, versionId });
            }
            blocked.push(...classified.blocked, ...classified.manual);
        }
        return { wanted: [...wanted.values()], blocked };
    }

    async function downloadMissing() {
        if (!downloadIo?.start) { appendLog(t('download.unavailable')); return null; }
        if (downloading) { appendLog(t('download.busy')); return null; }

        const chosen = chosenRecords();
        // **2回目の押しで初めて落とす。** 1回目に見せた顔ぶれと同じであること。
        if (armedDownload) {
            const armed = armedDownload;
            disarmDownload();
            return runDownload(armed.wanted, armed.blocked);
        }
        // **探している間を無音にしない**（2026-08-25 利用者の指示）。
        // 記録が多いと数え上げと大きさの問い合わせに間が空く——押した人からは
        // 「押したのに何も起きない」に見える。
        setDownloadScanning(true);
        let wanted;
        let blocked;
        try {
            ({ wanted, blocked } = downloadTargets(chosen.list));
        appendLog(t('download.scope', {
            count: chosen.list.length, models: wanted.length, blocked: blocked.length,
        }));

        // **落とすものが無いことを、失敗と混ぜない。**
        if (wanted.length === 0) {
            if (blocked.length === 0) {
                // **「不足が無い」と「不足はあるが落とせない」は別。**
                // ここを同じ文で出すと、`不足` と表示されている記録に対して
                // 「0件」とだけ言うことになり、**押した人は壊れたと読む**
                // ——実測で、遮断の理由が不足ノード・プロンプト欠落だった。
                appendLog(t('download.nothingMissing'));
            }
            for (const item of blocked.slice(0, 5)) {
                appendLog(t('download.blockedItem', {
                    name: item?.name || item?.versionId || '?', why: item?.why || item?.code || '',
                }));
            }
            return { downloaded: 0, already: 0, failed: 0, blocked: blocked.length };
        }

        // **押す前に、何をどれだけ引くのかを出す。**
        appendLog(t('download.list', {
            names: wanted.slice(0, 8).map(item => item.name || item.versionId).join(' / '),
            more: Math.max(0, wanted.length - 8),
        }));

        // 記録が持っている大きさ（外へ問い合わせずに判る分）。
        let bytes = 0;
        let unknown = wanted.length;
        try {
            const offline = await estimateDownloadSize(wanted, { lookup: false });
            bytes = offline.bytes;
            unknown = offline.unknown;
        } catch { /* 見積もれなくても続ける */ }

        // **判らない分は、落とさずに調べる。** レシピは大きさを持っていないことが
        // 多く（実測で19件中19件が不明）、そのまま押させると総量を知らずに始まる。
        if (unknown > 0 && downloadIo.plan) {
            try {
                const plan = await downloadIo.plan(wanted.map(item => item.versionId));
                if (plan?.ok) {
                    bytes = plan.bytes;
                    unknown = plan.unknown;
                    // 調べた結果を落とす側へも渡す（名前が判るものは名前で出す）。
                    const byId = new Map((plan.items || []).map(item => [String(item.versionId), item]));
                    for (const item of wanted) {
                        const found = byId.get(String(item.versionId));
                        if (found?.filename) item.name = found.filename;
                    }
                }
            } catch { /* 調べられなくても落とせる */ }
        }
        appendLog(unknown > 0
            ? t('download.sizePartial', { size: formatBytes(bytes), unknown })
            : t('download.size', { size: formatBytes(bytes) }));

        // **ここで一度止める。** 総量を見せてから、もう一度押させる。
        armedDownload = { wanted, blocked };
        downloadButton.textContent = t('download.confirm', { n: wanted.length, size: formatBytes(bytes) });
        downloadButton.setAttribute('data-armed', 'true');
        appendLog(t('download.armed', { n: wanted.length, size: formatBytes(bytes) }));
        return { armed: true, models: wanted.length, bytes };
        } finally {
            // **どの道を通っても戻す。** 戻さないと、押せない釦が残る。
            setDownloadScanning(false);
        }
    }

    /** 実際に落とす。**呼ばれるのは、総量を見せて押し直された後だけ。** */
    /**
     * 応答から**種類の言葉**を作る。判らないものは種類だけ言い、生の文言は
     * ログに残す——画面に英語の原文を並べても、打つ手は決まらない。
     */
    function failReason(response) {
        const code = String(response?.code || '');
        const key = FAIL_CODES[code] || FAIL_CODES.unknown;
        return code && FAIL_CODES[code] ? t(key) : t(key, { detail: response?.error || '' });
    }

    /** いま何本目か（進み具合の欄に添える）。 */
    let downloadAt = { index: 0, total: 0, name: '' };

    /** 進み具合を読み続ける。**返すのは止める関数。** */
    function watchDownloadProgress() {
        if (typeof downloadIo?.state !== 'function' || typeof setInterval !== 'function') {
            return () => {};
        }
        let stopped = false;
        const tick = async () => {
            if (stopped) return;
            let state;
            try {
                state = await downloadIo.state();
            } catch {
                // **読めないことを失敗と混ぜない。** 取得そのものは続いている。
                return;
            }
            if (stopped) return;
            // **走っていないことも書く。** 空にすると「出ない」と読まれる
            // ——実際に「進捗が出ない」と報告された（2026-08-23）。
            const done = Number(state?.bytes) || 0;
            const total = Number(state?.totalBytes) || 0;
            const bytes = state?.state === 'running'
                ? (total
                    ? t('download.bytes', {
                        done: sizeText(done), total: sizeText(total),
                        percent: Math.min(100, Math.floor((done / total) * 100)),
                    })
                    : t('download.bytesUnknown', { done: sizeText(done) }))
                : '';
            showToast(downloadAt.total
                ? t('download.at', {
                    index: downloadAt.index, total: downloadAt.total,
                    name: downloadAt.name, bytes,
                })
                : bytes, { sticky: true });
        };
        const timer = setInterval(tick, 700);
        tick();
        return () => {
            stopped = true;
            clearInterval(timer);
            // **結果は少し残してから消える。** 消えないと邪魔、すぐ消えると読めない。
            showToast(downloadSummary);
        };
    }

    async function runDownload(wanted, blocked) {
        downloading = true;
        downloadCanceled = false;
        downloadButton.disabled = true;
        downloadStopButton.disabled = false;
        downloadSummary = '';
        downloadAt = { index: 0, total: wanted.length, name: '' };
        const stopWatching = watchDownloadProgress();
        const result = {
            downloaded: 0, already: 0, failed: 0, canceled: 0, blocked: blocked.length,
        };
        /**
         * 何がどうなったか（**理由ごとにまとめる**）。
         *
         * **ログには出ていたが、誰も読めなかった。** サイドバーでは記録350件の
         * 下に埋まっていて、そこまで巻かないと見えない——実際に「詳細は確認
         * できませんでした」と報告された（2026-08-23）。**数の隣に理由を置く。**
         */
        const reasons = new Map();
        const note = (kind, text) => {
            const key = kind + '|' + text;
            reasons.set(key, (reasons.get(key) || 0) + 1);
        };
        try {
            for (const [index, item] of wanted.entries()) {
                if (downloadCanceled) break;
                downloadAt = {
                    index: index + 1, total: wanted.length, name: item.name || item.versionId,
                };
                appendLog(t('download.progress', {
                    index: index + 1, total: wanted.length, name: item.name || item.versionId,
                }));
                let response = null;
                try {
                    response = await downloadIo.start(item.versionId);
                } catch (error) {
                    result.failed += 1;
                    // 口そのものへ届かなかった＝繋がらなかった。
                    note('failed', t(FAIL_CODES.network));
                    appendLog(t('download.itemFailed', {
                        name: item.name || item.versionId, detail: error?.message || String(error),
                    }));
                    continue;
                }
                if (response?.ok) {
                    result.downloaded += 1;
                    appendLog(t('download.itemDone', {
                        name: response.path || item.name || item.versionId,
                        // **確かめたかどうかを言う。** ハッシュを照合できていない
                        // ファイルを「落とせました」と同じ顔で並べない。
                        verified: response.verified === true ? t('download.verified') : t('download.unverified'),
                    }));
                } else if (String(response?.error || '').startsWith('already there')) {
                    // **既に在ることは失敗ではない。** 同じ数に混ぜると、
                    // 「落ちなかった」のか「要らなかった」のか判らなくなる。
                    result.already += 1;
                    note('already', item.name || item.versionId);
                    appendLog(t('download.itemAlready', { name: item.name || item.versionId }));
                } else if (String(response?.error || '') === 'canceled' || downloadCanceled) {
                    // **止めたことは失敗ではない**（2026-08-23 利用者の指示）。
                    // 失敗に数えると、次に開いたときの「失敗 N 件」が嘘になる
                    // ——押した本人は止めたことを知っているので、余計に混乱する。
                    result.canceled += 1;
                    appendLog(t('download.itemCanceled', { name: item.name || item.versionId }));
                    break;
                } else {
                    result.failed += 1;
                    // **種類で束ねる。** 生の文言で束ねると、同じ意味の失敗が
                    // 別々の行に散る（「HTTP 404」と「API に届かない」は同じこと）。
                    note('failed', failReason(response));
                    appendLog(t('download.itemFailed', {
                        name: item.name || item.versionId, detail: response?.error || 'unknown',
                    }));
                }
            }
            appendLog(t('download.done', result));
            if (downloadCanceled) appendLog(t('download.stopped'));

            // **数の隣に理由を置く。** 「5 件が失敗」だけでは打つ手が決まらない。
            const grouped = new Map();
            for (const [key, count] of reasons) {
                const at = key.indexOf('|');
                const kind = key.slice(0, at);
                const text = key.slice(at + 1);
                const list = grouped.get(kind) || [];
                list.push(count > 1 ? `${text} ×${count}` : text);
                grouped.set(kind, list);
            }
            // **打つ手のある側を先に。** 「もう無い」は最後でよい——見ても
            // できることが無いので、上に置くと他が押し下げられる。
            for (const [kind, list] of grouped) {
                if (kind !== 'failed') continue;
                const rank = (text) => {
                    const at = FAIL_ORDER.findIndex(code => text.startsWith(t(FAIL_CODES[code])));
                    return at < 0 ? FAIL_ORDER.length : at;
                };
                list.sort((a, b) => rank(a) - rank(b));
            }
            const lines = [t('download.done', result)];
            for (const [kind, list] of grouped) {
                const key = WHY_KEYS[kind];
                if (!key) continue;
                // 長くなりすぎない。**切ったことは数で言う。**
                const shown = list.slice(0, 4).join(' / ');
                const more = Math.max(0, list.length - 4);
                lines.push(t(key, { list: shown, more }));
                // ログには全部（欄は狭いが、ログは巻けば読める）。
                appendLog(t(key, { list: list.join(' / '), more: 0 }));
            }
            // **結果を欄に残す。** 空に戻すと「何も起きなかった」ように見える。
            downloadSummary = lines.join(String.fromCharCode(10));
            return result;
        } finally {
            stopWatching();
            downloading = false;
            downloadButton.disabled = false;
            downloadStopButton.disabled = true;
        }
    }

    async function cancelDownload() {
        // **旗を立てるだけでは止まらない。** 今引いている1本はサーバ側で切る。
        downloadCanceled = true;
        if (downloadIo?.cancel) {
            try { await downloadIo.cancel(); } catch { /* 止められなくても旗は立っている */ }
        }
        appendLog(t('download.stopping'));
        return true;
    }

    async function cancelBatch() {
        if (!batchRunner) return null;
        const result = await batchRunner.cancel();
        appendLog(t('batch.canceled', {
            deleted: result.deleted.length, interrupted: result.interrupted.length,
        }));
        return result;
    }

    if (batchButton) batchButton.addEventListener('click', () => runBatch());
    if (batchStopButton) {
        batchStopButton.disabled = true;
        batchStopButton.addEventListener('click', () => cancelBatch());
    }

    /** 一覧の上に出ている面をすべて閉じる。**2枚同時に出さない。** */
    function closeOverlays() {
        closeLightbox();
        // **浮かせた器を先に片付ける。** 中の面だけ `destroy()` すると
        // **空の覆いが残って一覧が押せなくなる**（見た目は何も無いので原因が読めない）。
        for (const layer of openLayers) layer.remove();
        openLayers.clear();
        sweepView?.destroy();
        sweepView = null;
        settingsView?.destroy();
        settingsView = null;
        variantsView?.destroy();
        variantsView = null;
        raindropView?.destroy();
        raindropView = null;
        modelsView?.destroy();
        modelsView = null;
        confirmView?.destroy();
        confirmView = null;
        detailView?.destroy();
        detailView = null;
        body.style.display = '';
    }

    /** 後方互換の名前（Sweep だけを閉じる意図で呼ばれていた）。 */
    const closeSweep = closeOverlays;

    /**
     * 商用可否。**Unbake は判定しない・出すだけ。**
     *
     * **判定日を必ず併記する。** 実データ345件はすべて `2026-08-14` の
     * 一度きりの分類で、日付を書かないと「今の分類」と読まれる。
     * 日付が無い値は**値ごと出さない**——出典の無い可否は、
     * 出さないより悪い（読んだ人が根拠を持ったつもりになる）。
     */
    function commercialCell(record) {
        const value = record?.commercialOk;
        const checkedAt = record?.licenseCheckedAt;
        if (!value || !checkedAt) {
            return element('td', {
                class: 'unbake-col-license', text: '—',
                title: t('column.commercial.unknown'),
            });
        }
        return element('td', {
            class: 'unbake-col-license',
            'data-commercial': String(value).toUpperCase(),
            text: t('column.commercial.value', { value, date: checkedAt }),
            // 分類の文言そのものは長いので、ここへ入れる。
            title: t('column.commercial.title', {
                value, date: checkedAt, license: record?.license || '—',
            }),
        });
    }

    /**
     * 参照画像。**無い理由を区別する。**
     *
     * 一覧に絵が出ないことを「壊れている」と読まれた（実機で報告された）ので、
     * **出ない理由が3つある**ことを画面で分けられるようにする:
     *
     *   1. そもそも対の画像がディスクに無い（`preview: false`）
     *   2. 取りに行ったが読めなかった（`onerror`）
     *
     * **成人向けの関門は 2026-08-25 に撤去した**（利用者の判断）ので、
     * 「サーバが送っていない」という3つ目の理由はもう起きない。
     */
    function previewCell(record) {
        if (!record?.previewUrl) {
            return element('td', {
                class: 'unbake-col-preview', 'data-state': 'none',
                text: '·', title: t('list.preview.none'),
            });
        }
        const image = makeZoomable(element('img', {
            class: 'unbake-thumb', src: record.previewUrl, loading: 'lazy', alt: '',
        }), record);
        const cell = element('td', { class: 'unbake-col-preview', 'data-state': 'ok' }, [image]);
        image.addEventListener('error', () => {
            // **黙って壊れた画像を出さない。**
            cell.setAttribute('data-state', 'failed');
            cell.replaceChildren();
            cell.textContent = '×';
            cell.setAttribute('title', t('list.preview.failed'));
        });
        return cell;
    }

    /**
     * タイル1枚。**絵を器いっぱいに敷いて、字は絵の上へ重ねる。**
     *
     * ---
     *
     * 元は「絵・名前・判定・ボタン」を縦に積んでいた。3列にすると1枚 127px しか
     * 無いので、**絵の高さが半分以下**になり、絵で選ぶための器なのに絵が小さい、
     * という形になっていた（実機で「もっと洗練できる」と言われたのがここ）。
     *
     * 上流（LoRA Manager）のカードは絵を全面に敷き、上下の帯を絵へ重ねる。
     * **形は同じ考えを採るが、中身は3つ変えてある**——どれも「この道具は何を
     * 見せるためのものか」から出ている:
     *
     *  1. **名前は照合に使うので、切らずに出す。** ここの名前は出力フォルダの
     *     ファイル名そのもの（`civitai_79689199` ⇔ `civitai_79689199_00001_.png`）で、
     *     途中で切れると突き合わせに使えない。**数字だけを強く出す**
     *     ——`civitai_` は全件に付くので、見分けに効くのは数字の側。
     *  2. **判定を絵の上へ置く。** この道具の主語は「再現できるか」なので、
     *     一覧を絵にしても判定だけは消さない（表と同じ色・同じ短語）。
     *  3. **操作を hover だけで出さない。** 上流は hover で上下の帯を出すが、
     *     それだとキーボードと触る画面から**永久に届かない**。ここは
     *     `:focus-within` でも出し、tab の順序からも外さない。
     */
    /**
     * まとめの名札。表とタイルで**同じ語**を出す（器だけが違う）。
     *
     * 名前はモデルの列と同じ規則で短くし、**元のパスは吹き出しに残す**。
     * 吹き出しには「なぜ続いているのか」も書く——名札だけだと、
     * 見出しが在ることは判っても、設定のどれが効いているのかまでは判らない。
     */
    function groupHead(tag, className, run) {
        const known = Boolean(run.label);
        const name = known ? run.label : t('list.group.unknown');
        const hint = t('list.group.hint');
        return element(tag, {
            class: className,
            text: t('list.group.checkpoint', { name, count: run.records.length }),
            title: known ? `${run.raw} — ${hint}` : hint,
        });
    }

    function tileOf(record) {
        const verdict = record?.verdict || 'blocked';
        const name = displayName(record);
        // **数字だけを強く出す。** `civitai_` は全件に付くので見分けに効かない。
        const parts = /^(civitai_)(\d+)$/.exec(name);
        const nameNode = parts
            ? element('span', { class: 'unbake-tile-name' }, [
                element('span', { class: 'unbake-tile-name-prefix', text: parts[1] }),
                element('b', { class: 'unbake-tile-name-id', text: parts[2] }),
            ])
            : element('span', { class: 'unbake-tile-name', text: shorten(name, 40) });

        const media = (record?.previewUrl
                ? element('div', { class: 'unbake-tile-media', 'data-state': 'ok' }, [
                    makeZoomable(element('img', {
                        class: 'unbake-tile-image', src: record.previewUrl, loading: 'lazy', alt: '',
                    }), record),
                ])
                : element('div', { class: 'unbake-tile-media', 'data-state': 'none', text: '·', title: t('list.preview.none') }));

        // 印。**数えられるものだけ出す**——「たぶん」は出さない。
        const marks = [];
        const loraCount = Number(record?.loraCount) || 0;
        if (loraCount > 0) {
            marks.push(element('span', {
                class: 'unbake-tile-mark', 'data-mark': 'loras',
                text: `❖${loraCount}`, title: t('tile.loras', { n: loraCount }),
            }));
        }
        // **`record.favorite` を直に見ない。** それは**上流が立てた印**で、
        // こちらで外した分を知らない——外したのに★が残る（2026-08-22 利用者の報告）。
        // 印の有無は `isFavorite()` が1箇所で決める（ボタンと同じ答えになる）。
        if (isFavorite(record)) {
            marks.push(element('span', {
                class: 'unbake-tile-mark', 'data-mark': 'favorite', text: '★', title: t('tile.favorite'),
            }));
        }
        // **判定を字で出す。ただし上の段には出さない**（2026-08-22 利用者の選択）。
        //
        // 元は 2.4px の色帯だけで、理由はホバーしないと読めなかった。
        // **全部に出すと一覧が字で埋まる**ので、出すのは「手を打つ必要がある側」だけ
        // ——「再現性 高」は何もしなくてよいので、印が無いことがそのまま印になる。
        if (verdict && verdict !== 'reproducible') {
            // **「落とせば試せる」と「初めから無理」を分ける**（2026-08-23 利用者の
            // 指示）。判定器は既に区別しているのに、一覧では同じ「再現不可」に
            // 見えていた——実データでは前者が29件・後者が27件で、**打つ手が真逆**
            // （前者は落とせばよい／後者は追いかけるだけ無駄）。
            const downloadable = record?.verdictBlocker === 'downloadable';
            marks.push(element('span', {
                class: 'unbake-tile-mark', 'data-mark': 'verdict',
                'data-verdict': verdict,
                'data-blocker': record?.verdictBlocker || null,
                text: downloadable ? t('verdict.downloadable.short') : verdictShort(verdict),
                title: downloadable ? t('verdict.downloadable.help') : verdictTitle(verdict),
            }));
        }
        // **商用可否はタイルにも出す**（2026-08-22 利用者の指摘）。
        // 表の列にしか無く、タイルで見ている間は**一度も出ていなかった**
        // ——実データ 347件のうち 345件が値を持っているのに、である。
        //
        // **判定日の無い値は出さない。** 出典の無い可否は、出さないより悪い
        // （読んだ人が根拠を持ったつもりになる）——表の列と同じ判断。
        //
        // **出すのは「不可」だけ。** 判定と同じ作法で、手を打つ必要がある側にしか
        // 印を出さない——4つ並ぶと幅を使い切り、印の中で字が2行になっていた
        // （実測 2026-08-22: 印4つのタイル30枚すべてが fill 1.000）。
        // 「可」は印が無いことがそのまま印で、値は吹き出しと表の列に在る。
        // **場所を分ける**（2026-08-23 利用者の指示）。判定と同じ列に並べていたので
        // 位置が入れ替わり、どちらがどちらか毎回読ませていた。**判定は左上・
        // 商用可否は右下**と決めれば、位置そのものが見出しになる。
        //
        // **Yes も出す。** 印の列に居たときは幅が足りず「不可」だけ出していたが、
        // 右下に1つだけなら両方置ける——「印が無い」を「可」と読ませるより、
        // 書いてある方が確かである（実データ 347件中 345件が値を持っている）。
        const commercial = (showCommercialOk && record?.commercialOk && record?.licenseCheckedAt)
            ? String(record.commercialOk)
            : null;
        const commercialNode = commercial
            ? element('span', {
                class: 'unbake-tile-commercial',
                'data-commercial': commercial.toUpperCase(),
                text: commercial.toUpperCase() === 'YES' ? t('tile.commercial.yes') : t('tile.commercial.no'),
                title: t('column.commercial.title', {
                    value: commercial, date: record.licenseCheckedAt, license: record?.license || '—',
                }),
            })
            : null;

        return element('article', {
            class: 'unbake-tile', 'data-verdict': verdict,
            'data-selected': selected.has(String(record?.id ?? '')) ? 'true' : 'false',
            // 吹き出しは上流の画面で見た題（探すときの手掛かり）。
            // **色だけに頼らない。** 枠の色が判定で、語はここ（吹き出しと読み上げ）。
            'aria-label': `${name} — ${verdictTitle(verdict)}`,
            // **商用可否はここに書かない。** 右下の札が「Yes / No」を字で出し、
            // 判定日と免許はその札の吹き出しに在る（2026-08-23）。
            title: record?.blockedReason
                ? `${name} — ${verdictLong(verdict)} — ${record.blockedReason}`
                : `${name} — ${verdictTitle(verdict)}`,
        }, [
            media,
            // **判定の色帯はタイルに置かない。** 枠の左端が同じ色を出しているので、
            // 同じことを2度言っていた（実機で「レコードの左で確認できるので要らない」）。
            // 語は枠の吹き出しと読み上げに残る。
            // **触っていない間は系統の札。触ったらチェックボックス**
            // （2026-08-23 利用者の指示）。元はチェックボックスが常時ここに在り、
            // **ホバーするとこの帯ごと消えていた**ので、近づくと的が逃げていた。
            element('div', { class: 'unbake-tile-head' }, [
                (() => {
                    const badge = baseModelBadge(record?.baseModel);
                    // **補った値は、そう言う。** 記録に書いてあった値と見た目は同じでよいが、
                    // 出どころを黙ると「記録に在る」と読まれる（実際に在るのは手元のモデルの隣）。
                    const from = record?.baseModelSource === 'model-index'
                        ? ` — ${t('tile.base.fromIndex')}`
                        : '';
                    return badge
                        ? element('span', {
                            class: 'unbake-tile-base', text: badge,
                            'data-source': record?.baseModelSource || 'record',
                            title: `${record?.baseModel || ''}${from}`,
                        })
                        // **札の無い記録でも並びを崩さない。** 印は右端に置く。
                        : element('span', { class: 'unbake-tile-base', 'data-empty': 'true' });
                })(),
                element('span', { class: 'unbake-tile-marks' }, marks),
            ]),
            // **名前だけ。** チェックポイントの行は出さない（2026-08-23 利用者の
            // 指示）。絵の上に2行あると帯が厚くなるうえ、名前は切らずに出す決めなので
            // 2行目まで足すと絵が隠れる。モデルは詳細と表で見られる。
            element('div', { class: 'unbake-tile-foot' }, [nameNode]),
            // **右下。** 判定（左上）と場所で分ける。
            ...(commercialNode ? [commercialNode] : []),
            // **ホバーで出るのは「この1件にできること」。** 元は Sweep と ◫ だけで、
            // 何のボタンか判らないと言われた——字と吹き出しを付け、並びを揃えた。
            // **選ぶのはここ。** 触っている間だけ出る列で、消えない的になる。
            // 選んだかどうかは触っていなくても分かる（枠の色が変わる）。
            // **走っている間は列ごと見せる**（2026-08-24）。この列は普段 `opacity: 0` で、
            // タイルを hover したときだけ出る——**印を付けても、列が透明なら見えない。**
            // 印は組み立ての最中に付くので `parentElement` から辿れない（まだ親が居ない）。
            // **器を作る側が、器の状態として持つ。**
            element('div', {
                class: 'unbake-tile-actions',
                'data-busy': busyRecords.has(`${record?.id ?? ''}`) ? 'true' : 'false',
            }, [pickBox(record), ...recordActions(record, { icons: true })]),
        ]);
    }

    function render() {
        // **描くたびに測り直す。** 仕掛けが全部空振りしても、利用者が何か
        // 触った時点で追いつく。`applyWidth` は変化したときだけ再描画するので回らない。
        measureWidth();
        const tally = Object.fromEntries(VERDICTS.map(key => [key, 0]));
        for (const record of records) {
            if (record?.verdict in tally) tally[record.verdict] += 1;
        }
        for (const key of CHIP_VERDICTS) {
            const chip = chipOf.get(key);
            chip.textContent = verdictShort(key) + ' ' + tally[key];
            // **消さずに落とす。** フィルタで外した種別も件数は見え続ける。
            chip.setAttribute('data-on', hidden.has(key) ? 'false' : 'true');
        }
        // お気に入りも同じ形——**件数は絞り込んでいても見え続ける**。
        favoritesChip.textContent = '★ ' + records.filter(isFavorite).length;
        favoritesChip.setAttribute('data-on', favoritesOnly ? 'true' : 'false');
        // **範囲が変わったら語も変える。** 未選択なら表示中の全件が対象になる
        // ——同じ語のままだと、範囲が違うことに気づけない。
        if (!armedDownload) downloadButton.textContent = downloadButtonText();

        const shown = sortRecords(records.filter(matches), sortKey, groupByCheckpoint, sortDescending);
        // **向きの印は描くたびに当て直す。** 設定から戻したときに、
        // ボタンの見た目だけが古いまま残らないようにする。
        sortDirection.setAttribute('data-descending', sortDescending ? 'true' : 'false');
        sortDirection.textContent = sortDescending ? '▲' : '▼';
        // **「自然な順」では、日付のどちらが先か読めない**（2026-08-25 実機:
        // 取り込んだばかりの記録が一番上に来ない、の正体はこの旗だった）。
        // 日付のときだけ、**新しい順／古い順**と名前で言う。
        // ほかの鍵は自然な順が鍵ごとに違うので、断定せず「素の順／逆順」のまま。
        const orderText = sortKey === 'modified'
            ? t(sortDescending ? 'sort.order.oldest' : 'sort.order.newest')
            : t(sortDescending ? 'sort.ascending' : 'sort.descending');
        sortDirection.setAttribute('title', orderText);
        // **読み上げにも同じ言葉を渡す**（矢印は読み上げでは何も言わない）。
        sortDirection.setAttribute('aria-label', orderText);
        sortSelect.value = sortKey;
        // **狭くても全部出す。** 元は12行で切って残りを全画面へ送っていたが、
        // 「サイドバーで途中までしか見られない」と実機で報告された（2026-08-20）ので
        // 既定を「切らない」にし、**行数の設定そのものは 2026-08-25 に撤去した**
        // （既定のままなら何も起きない設定で、戻す先は利用者が嫌った挙動だった）。
        // 高さは器の側で固定して中でスクロールさせるので、
        // 「パネルの高さがデータ量に比例しない」という元の狙いは保てている。
        const visible = shown;

        // **選んだ件数と、それが何に効くかを出す。**
        const chosen = chosenRecords();
        selectionBar.setAttribute('data-active', selected.size > 0 ? 'true' : 'false');
        selectionCount.textContent = selected.size > 0
            // **見えていない選択を黙って含めない。** 絞り込みの外に出た分は数から外し、
            // 何件外れているかを言う（言わないと「選んだのに動かない」になる）。
            ? (chosen.hidden
                ? t('select.countHidden', { n: chosen.list.length, hidden: chosen.hidden })
                : t('select.count', { n: chosen.list.length }))
            // **件数は添えない**（2026-08-23 利用者の指示）。すぐ上の絞り込みに
            // 同じ数が出ているし、選んでいないときの文としては「未選択」で足りる。
            : t('select.none');
        clearSelectionButton.disabled = selected.size === 0;

        // **どちらの器へ描くかだけを決める。** 記録も絞り込みも並びも上で済んでいる。
        const asTiles = listView === 'tiles';
        viewToggle.textContent = asTiles ? t('list.view.table') : t('list.view.tiles');
        viewToggle.setAttribute('data-view', listView);
        // 列数はタイルのときだけ意味がある。**意味の無い操作を出しっぱなしにしない。**
        columnsSelect.style.display = asTiles ? '' : 'none';
        tiles.setAttribute('data-size', String(tileSize));

        // **まとめが効いているなら、そう見えるようにする。** 名札は塊の頭にだけ出す
        // （名札そのものは記録ではないので、選択にも件数にも入らない）。
        const runs = groupByCheckpoint
            ? checkpointRuns(visible)
            : [{ name: null, raw: '', records: visible }];

        tiles.replaceChildren();
        if (asTiles) for (const run of runs) {
            if (run.name !== null) tiles.append(groupHead('div', 'unbake-tile-group', run));
            for (const record of run.records) tiles.append(tileOf(record));
        }

        tableBody.replaceChildren();
        for (const run of runs) {
        if (run.name !== null) {
            tableBody.append(element('tr', { class: 'unbake-group-row' }, [
                element('td', {
                    class: 'unbake-group-cell',
                    colspan: String(showCommercialOk ? 7 : 6),
                }, [groupHead('span', 'unbake-group-name', run)]),
            ]));
        }
        for (const record of run.records) {
            const verdict = record?.verdict || 'blocked';
            // **不足の理由を行に持たせる。** 見えないと「なぜか出てこない」になる。
            const rowTitle = record?.blockedReason
                ? `${record?.title ?? ''} — ${record.blockedReason}`
                : String(record?.title ?? '');   // ← 上流の画面で見た題（探すときの手掛かり）
            tableBody.append(element('tr', {
                title: rowTitle,
                'data-selected': selected.has(String(record?.id ?? '')) ? 'true' : 'false',
            }, [
                element('td', { class: 'unbake-col-pick' }, [pickBox(record)]),
                previewCell(record),
                // **出す絵と同じ名前で出す。** 元の題は行の吹き出しに残る。
                element('td', { class: 'unbake-col-title', text: shorten(displayName(record), 34) }),
                element('td', { class: 'unbake-col-verdict' }, [
                    // **長短の両方を描いて、出し分けは CSS に任せる。**
                    // 密度ごとに描き分けると、そこから実装が2つに割れていく。
                    element('span', {
                        class: 'unbake-verdict', 'data-verdict': verdict,
                        title: verdictTitle(verdict), 'aria-label': verdictTitle(verdict),
                    }, [
                        element('b', { class: 'unbake-v-long', text: verdictLong(verdict) }),
                        element('b', { class: 'unbake-v-short', text: verdictShort(verdict) }),
                    ]),
                ]),
                element('td', { class: 'unbake-col-model', text: modelName(record?.checkpoint) }),
                element('td', { class: 'unbake-col-sweep' }, [
                    element('span', { class: 'unbake-row-actions' }, recordActions(record, { compact: true })),
                ]),
                ...(showCommercialOk ? [commercialCell(record)] : []),
            ]));
        }
        }

        const nothing = records.length === 0;
        empty.textContent = nothing
            ? t('list.empty')
            : t('list.noMatch', { total: records.length });
        empty.style.display = shown.length === 0 ? '' : 'none';
        table.style.display = (shown.length === 0 || asTiles) ? 'none' : '';
        tiles.style.display = (shown.length === 0 || !asTiles) ? 'none' : '';
        controls.style.display = nothing ? 'none' : '';

    }

    function applyWidth(next, { remember = true } = {}) {
        const value = Number(next);
        if (!Number.isFinite(value) || value <= 0) return;
        // **実測できた幅だけ覚える。** 覚えた値から復元したときは書き戻さない
        // （書き戻すと、古い値が古いまま生き続ける）。
        if (remember) writeStored(LAST_WIDTH_KEY, Math.round(value));
        const wanted = value < compactWidth ? 'compact' : 'full';
        if (wanted === density) return;
        density = wanted;
        root.setAttribute('data-density', density);
        render();
    }

    // --- ドロップ -----------------------------------------------------
    async function handleDrop(dataTransfer) {
        const routed = routeDrop(dataTransfer);
        if (!routed) {
            appendLog(t('log.unrecognised'));
            return null;
        }
        if (routed.route === DROP_ROUTES.UNSUPPORTED) {
            // **判らなかったのと、判ったうえで扱えないのを分ける**（2026-08-24）。
            // 前は投稿URLも「レコードを特定できませんでした」で終わっており、
            // **打つ手が読み手に渡らなかった**。
            //
            // **鍵を組み立てない。** `log.unsupported.${code}` のように作ると、
            // 訳の足し忘れが画面に `[鍵]` として出るまで気づけない（他の面と同じ作法）。
            appendLog(UNSUPPORTED_LOG[routed.code]
                ? t(UNSUPPORTED_LOG[routed.code], { id: routed.postId })
                : t('log.unrecognised'));
            return routed;
        }
        if (routed.route === DROP_ROUTES.COMFY_OUTPUT) {
            appendLog(t('log.captured', { name: routed.filename }));
        } else if (routed.route === DROP_ROUTES.CIVITAI) {
            appendLog(t('log.civitai', { id: routed.imageId, source: routed.source }));
        } else if (routed.route === DROP_ROUTES.RECIPE_FILE) {
            // **「レシピ」と呼んでよい唯一の経路。** 上流由来のものを名指ししている。
            appendLog(t('log.recipe', { names: routed.files.map(f => f.name).join(', ') }));
        } else {
            appendLog(t('log.localFile', { names: routed.files.map(f => f.name).join(', ') }));
        }

        if (!ingest) return routed;
        await ingestRouted(routed);
        return routed;
    }

    /**
     * 振り分けの済んだものを取り込む。**落とし込みと「あとで読む箱」の共通の尾。**
     *
     * 分けてあるのは、箱から取り込むときに `dataTransfer` が無いからで、
     * **道を増やしたのではなく入口を増やした**——組み立ても、重複の入れ替えも、
     * ログもここ1箇所に残す。
     *
     * @returns {Promise<{ok: boolean, records: object[], errors: string[]}>}
     */
    async function ingestRouted(routed) {
        if (!ingest || !routed) return { ok: false, records: [], errors: [] };
        let result;
        try {
            result = await ingest(routed);
        } catch (error) {
            const detail = error?.message || String(error);
            appendLog(t('log.ingestFailed', { detail }));
            return { ok: false, records: [], errors: [detail] };
        }
        for (const message of result?.errors || []) appendLog(message);
        const added = result?.records || [];
        // **取り込んだものはディスクへ残す**（`I-20260821-03`）。
        // 残さないと、画面を閉じた瞬間に無かったことになる——実際に
        // 「Raindrop から取り込んだ記録が再読み込みで消える」と報告された。
        //
        // **落ちても取り込みは続ける。** 保存できないことと、取り込めないことは別。
        // ただし**黙って落とさない**——1件ずつ理由を出す。
        if (added.length && typeof recordsIo?.save === 'function') {
            let saved = 0;
            const failed = [];
            for (const record of added) {
                let outcome;
                try {
                    outcome = await recordsIo.save(record);
                } catch (error) {
                    failed.push(`${record?.title || record?.id}: ${error?.message || error}`);
                    continue;
                }
                if (outcome?.ok) { saved += 1; record.savedId = outcome.id; }
                // **「もう在る」は失敗ではない。** 取り込み直しでは普通に起きる。
                else if (outcome?.error === 'already saved') record.savedId = outcome.id;
                else failed.push(`${record?.title || record?.id}: ${outcome?.error || ''}`);
            }
            for (const message of failed) appendLog(t('record.saveFailed', { detail: message }));
            if (saved) appendLog(t('record.saved', { count: saved }));

            // **保存できたら書庫から読み直す**（2026-08-22 利用者の報告）。
            //
            // 取り込んだ直後に画面へ並ぶのは**取り込み器が作った控え**で、
            // ディスクの記録とは別物。そのままにすると3つ同時に壊れる:
            //
            //   1. **絵が出ない** — 見本の口は `/unbake/record-preview?id=…` で、
            //      その id は**走査が返す id**（`safe_id` を通った後）でしか引けない
            //   2. **消せない** — 消す口はディスクの記録を指す
            //   3. **名前が変わらない** — 付け直した名前はディスクの記録に在る
            //
            // 読み直せば、控えが**普通の書庫の記録**に入れ替わり、3つとも直る。
            // **落ちても取り込みは成功のまま**——読み直せないことと、
            // 取り込めないことは別（理由だけ出す）。
            //
            // **`settingsIo.rescan` ではない。** あれは走査を促して*要約の行*を
            // 返す口で、面が並べる記録とは形が違う。実機では、渡した瞬間に
            // **一覧の絵が全部消えた**（2026-08-23 利用者の報告）——行が持つのは
            // `preview: true` で、面が読むのは `previewUrl` だから。
            // 再読み込みで直るので「保存できていない」と読めてしまうが、
            // **ディスクの記録も索引も正しかった**。形を変換する責任は呼び手側に
            // あり、それを持っているのは `recordsIo.reload` の方。
            if (saved && typeof recordsIo?.reload === 'function') {
                try {
                    const fresh = await recordsIo.reload();
                    if (Array.isArray(fresh) && fresh.length) {
                        replaceRecords(fresh);
                        return { ok: true, records: added, errors: result?.errors || [] };
                    }
                } catch (error) {
                    appendLog(t('record.rescanFailed', { detail: error?.message || String(error) }));
                }
            }
        }
        if (added.length) {
            // 新しいものが上。**同じ出所は入れ替える**（落とし直しが増殖しない）。
            const keyOf = (r) => r?.origin?.url || r?.origin?.filename || r?.id;
            const incoming = new Set(added.map(keyOf));
            records = [...added, ...records.filter(r => !incoming.has(keyOf(r)))];
            render();
            appendLog(t('log.added', { count: added.length }));
        }
        return { ok: added.length > 0, records: added, errors: result?.errors || [] };
    }

    /**
     * **面のどこへ落としてもよい**（2026-08-23）。
     *
     * 元は上の細い帯だけが受け口で、そこを狙わせるために**常に場所を取って**
     * いた。器の中はほとんど一覧なので、落とす先として自然なのは一覧の側である。
     * 受け口を面全体へ広げ、帯は**普段は1行に畳んで**おく——引きずっている間だけ
     * 開いて「ここへ落ちる」と示す。
     *
     * **出入りは数える。** 子要素をまたぐたびに `dragleave` が飛ぶので、
     * 数えずに閉じると、動かしている最中に案内が点滅する。
     */
    let dragDepth = 0;
    /**
     * **自分の中から始まった引きずりは、落とし込みとして受け取らない**（2026-08-24）。
     *
     * 実機で報告された: **記録をつまむと「画像をここへ落とす」が反応し、
     * 離すと同じ記録がもう1件増えた。**
     *
     * 原因は、記録のタイルに出している `<img>` が**ブラウザの既定で引きずれる**こと。
     * つまむと `dataTransfer` に絵の URL が入るので、面の受け口から見ると
     * **外から URL を落とされたのと区別が付かない**。だから取り込みが走り、複製ができる。
     *
     * **絵を引きずれること自体は残す。** 記録の絵を別のアプリへ持ち出すのは
     * まっとうな操作で、こちらの都合で `draggable="false"` にすると
     * **バグを直すために機能を1つ削る**ことになる。塞ぐのは受け取る側。
     *
     * **面の中に「掴んで運ぶ」機能は1つも無い**（`setData` を呼ぶ箇所が実測で0件）ので、
     * **中から始まった引きずりは全部、落とし込みではない**と言い切れる。
     * 受け取らないときは `preventDefault()` を**しない**——そうするとブラウザが
     * 落とせない印を出して元へ戻すので、「掴んだが受け付けなかった」が目に見える。
     */
    const showDrop = (on) => dropzone.setAttribute('data-active', on ? 'true' : 'false');
    let selfDrag = false;
    const onDragStart = () => { selfDrag = true; };
    const onDragEnd = () => { selfDrag = false; dragDepth = 0; showDrop(false); };
    const onDragEnter = (event) => {
        if (selfDrag) return;
        event.preventDefault?.();
        dragDepth += 1;
        showDrop(true);
    };
    const onDragOver = (event) => {
        if (selfDrag) return;
        event.preventDefault();
        showDrop(true);
    };
    const onDragLeave = () => {
        if (selfDrag) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) showDrop(false);
    };
    const onDropEvent = (event) => {
        // **`dragend` を待たずにここでも見る。** 受け口を素通りさせた場合 `drop` は
        // 飛ばないはずだが、**はずだで取り込みを走らせない**（複製が実害だった）。
        if (selfDrag) return null;
        event.preventDefault();
        dragDepth = 0;
        showDrop(false);
        return handleDrop(event.dataTransfer);
    };

    // **面へ付ける。** 帯は面の中に在るので、帯へ落としても同じ処理が拾う
    // ——両方へ付けると1回の落とし込みが2回走る。
    // **引きずり始めと終わりも見る。** これが無いと、面の中の絵をつまんだだけで
    // 受け口が開き、離すと同じ記録がもう1件増える（実機で報告・2026-08-24）。
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('dragenter', onDragEnter);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDropEvent);

    // **器の高さを宿主から受け取る。** ComfyUI が渡してくる入れ物は高さ auto
    // なので、そのままだと `height: 100%` が伸びきって **root が 10,003px** になる
    // （実測・346件）。すると一覧の器（`.unbake-body`）は中でスクロールせず、
    // ComfyUI 側の外枠が丸ごと縦に流れる——**検索欄も列名も画面の外へ出ていく。**
    //
    // 入れ物はこちらの持ち物なので、ここで高さを渡す。宿主の高さが定まっていない
    // 版では `100%` が auto に落ちるだけで、今までと同じ挙動になる。
    if (el.style) {
        el.style.height = '100%';
        el.style.minHeight = '0';
    }
    // --- 手元の鍵盤 ---------------------------------------------------
    //
    // **面の中にいるときだけ効かせる。** `document` へ張ると、ComfyUI 全体の
    // Ctrl+A（ノード全選択）を奪ってしまう。ここへ張れば、面の中を触っている
    // 人にだけ効き、外側の Ctrl+A は今までどおり動く。
    root.setAttribute('tabindex', '0');
    const onKeyDown = (event) => {
        const key = String(event?.key || '').toLowerCase();
        if (key === 'a' && (event.ctrlKey || event.metaKey)) {
            // **押した先が入力欄なら、字の全選択のほうを優先する。**
            const tag = String(event?.target?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            event.preventDefault?.();
            event.stopPropagation?.();
            selectAllShown();
            return;
        }
        if (key === 'escape' && selected.size > 0) {
            event.preventDefault?.();
            event.stopPropagation?.();
            clearSelection();
        }
    };
    root.addEventListener('keydown', onKeyDown);

    el.append(root);

    // --- 幅の測り方 ---------------------------------------------------
    // **どれか1つの仕掛けに頼らない。** 実機で2つの落とし穴を踏んだ（2026-08-20）:
    //
    //   1. ComfyUI はパネルを**まだ配置されていない要素**へ描かせる。その状態で
    //      `ResizeObserver` を張ると、**後から挿入されても鳴らない**（再現済み）。
    //   2. `requestAnimationFrame` は**隠れたページでは動かない**。検証用の
    //      ブラウザペインが常に hidden で、rAF を使った測り直しが一度も走らなかった。
    //
    // どちらも症状は同じ——狭いサイドバーに広い版が出たまま固まり、横スクロールが出る。
    // だから **タイマー・rAF・監視・描画のたび** の4つで測る。**どれも上限つき**で、
    // 取れないまま回り続ける形（直っていないのに動いて見える）にはしない。
    let observer = null;
    const timers = [];

    measureWidth = () => {
        const rect = typeof root.getBoundingClientRect === 'function' ? root.getBoundingClientRect() : null;
        const value = rect?.width || (typeof el.getBoundingClientRect === 'function'
            ? el.getBoundingClientRect().width
            : 0);
        applyWidth(value);
    };

    if (width !== null) {
        applyWidth(width);
    } else {
        // **前回の幅から始める。** 再起動の直後に測れなくても前と同じ形で開く
        // （測れた瞬間に本物の値へ差し替わる）。
        if (rememberedWidth !== null) applyWidth(rememberedWidth, { remember: false });
        measureWidth();
        // 配置が終わる時刻は宿主しだいなので、決め打ちの数点で測り直す。
        // **1秒で打ち切らない。** サイドバーの幅の復元はこちらの描画より後になりうる。
        for (const delay of [0, 50, 250, 1000, 2500, 5000]) {
            if (typeof globalThis.setTimeout === 'function') {
                timers.push(globalThis.setTimeout(measureWidth, delay));
            }
        }
        // 見えているページでは rAF のほうが早く正しい値になる。
        globalThis.requestAnimationFrame?.(measureWidth);
        if (typeof globalThis.ResizeObserver === 'function') {
            observer = new globalThis.ResizeObserver((entries) => {
                for (const entry of entries) applyWidth(entry.contentRect?.width);
            });
            observer.observe(root);
            // **入れ物の側も見る。** まだ配置されていない要素へ張った監視は
            // 後から挿入されても鳴らないので、既に配置されている親を足す
            // ——サイドバーの幅を動かしたときに鳴るのはこちら。
            if (el?.parentElement) observer.observe(el.parentElement);
        }
    }
    render();

    return {
        root,
        handleDrop,
        // **検査から取り込みの本筋を触れるように。** ドロップの器を通さずに
        // 同じ道を呼べないと、保存の後始末（書庫の読み直し）を固定できない。
        ingestRouted,
        log: appendLog,
        get density() { return density; },
        get selected() { return [...selected]; },
        applyDisplay,
        selectAllShown,
        clearSelection,
        downloadMissing,
        setWidth: applyWidth,
        getRecords: () => [...records],
        setRecords: replaceRecords,
        openSettings,
        openDonate,
        get donateView() { return donateView; },
        openVariants,
        openRaindrop,
        openModels,
        openDetail,
        confirmDeleteRecord,
        runBatch,
        cancelBatch,
        closeSweep,
        closeOverlays,
        get sweepView() { return sweepView; },
        get settingsView() { return settingsView; },
        get variantsView() { return variantsView; },
        get raindropView() { return raindropView; },
        get modelsView() { return modelsView; },
        get detailView() { return detailView; },
        get confirmView() { return confirmView; },
        destroy() {
            closeOverlays();
            observer?.disconnect();
            for (const timer of timers) globalThis.clearTimeout?.(timer);
            root.removeEventListener('dragstart', onDragStart);
            root.removeEventListener('dragend', onDragEnd);
            root.removeEventListener('dragenter', onDragEnter);
            root.removeEventListener('dragover', onDragOver);
            root.removeEventListener('dragleave', onDragLeave);
            root.removeEventListener('drop', onDropEvent);
            root.removeEventListener('keydown', onKeyDown);
            root.remove();
        },
    };
}
