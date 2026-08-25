/**
 * ComfyUI 拡張の登録。**同じパネルを2か所へ差す。**
 *
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * `app.extensionManager.registerSidebarTab()` は公式 API（frontend v1.2.4 以降）で、
 * `render: (el) => {…}` の形で**コンテナ要素を渡してくる**。
 * 全画面はこちらで作った `div` を同じ関数へ渡すだけ——**器が違うだけで中身は1つ**。
 *
 * キャンバスノードは1つも登録しない（パネルがグラフを生成する）。
 * `NODE_CLASS_MAPPINGS` が空でも ComfyUI Manager は配れる。
 *
 * ---
 *
 * **`window.app` を見てはいけない。** 最初の版はこのファイルの末尾で
 * `if (window.app) registerUnbake(window.app)` としていた。実機（ComfyUI v0.28.3 /
 * frontend 1.42.15）で確かめると **`window.app` は存在しない**——frontend は
 * `window.comfyAPI.app.app` に置いており、`/scripts/app.js` がその薄い shim である
 * （実測: 271バイトで `export const app = window.comfyAPI.app.app;` を含む）。
 *
 * **落ち方が最悪だった。** 条件が偽になるだけなので、
 * **例外もログも出ないままサイドバーにタブが出ない。**
 * 「拡張が読み込まれた」（起動ログに出る）「配信されている」（`/api/extensions` に載る）
 * 「モジュールとして読める」は全部通っていて、それでも**画面には何も出ない**。
 * だから下では、宿主が見つからなかったこと自体を**必ず声に出す**。
 */

import { installedNamesFrom, resolveRecipeModels } from './core/modelResolver.js';
import { createUnbakePanel } from './panel/panel.js';
import { installSidebarOverlay } from './panel/sidebarOverlay.js';
import { applySkin } from './panel/skin.js';
import {
    collectAnalysisInputs,
    fetchOutputImage,
    installComfyHost,
    listLibraryRecords,
    listRecordOutputs,
    readLibraryRecord,
    scanOutputs,
    readModelIndex,
    readUnbakeSettings,
    writeUnbakeSettings,
} from './host/comfyHost.js';
import {
    attachBuiltWorkflow,
    buildGenerationRecord,
    buildRecordFromRecipe,
    markUnbuildable,
} from './core/generationRecord.js';
import { buildRecipeWorkflow } from './core/recipeWorkflowBuilder.js';
import { applyResolvedResources } from './core/civitaiResources.js';
import { toRecipeShape } from './core/recordShape.js';
import { applyDarkReaderLock } from './core/darkReaderLock.js';
import { extractParamsFromBytes } from './core/extractedParams.js';
import {
    fetchCivitaiImage, fetchModelVersion, recipeFromCivitaiMeta, recordFromCivitaiImage,
} from './core/civitaiClient.js';
import { applyVerdicts, createVerdictTable } from './core/verdictTable.js';
import { attributeOutputs } from './core/outputAttribution.js';
import { SweepRunner } from './core/sweepRunner.js';
import { buildBuiltinSweepTemplates, installedModelOptions } from './core/sweepAxes.js';
import { DROP_ROUTES } from './panel/dropRouting.js';
import { setLocale, t } from './i18n/index.js';

/** 記録の中に焼き込まない値。**毎回作り直せるもの**は書かない。 */
const VIEW_ONLY_KEYS = new Set([
    'verdict', 'verdictReason', 'blockedReason', 'previewUrl', 'originalUrl',
    'savedId', 'needsBuild', 'sweep', 'attribution', 'loraCount', 'owner',
    // **記録の中へ焼かない。** 絵は隣のファイルとして置く——記録へ入れると
    // 数MBの文字列が JSON に入り、読むたびに丸ごと解かれる。
    'previewData',
]);

/**
 * ディスクへ書く本体を選ぶ。
 *
 * **本体を別に持つならそちら。** 書庫の記録は要約と本体が別で、要約から
 * 復元すると項目が落ちる。
 *
 * **持たない記録が在る。** 取り込みで作った記録（画像を落とした分・
 * Civitai から引いた分）は**記録そのものが本体**で `recipe` を持たない。
 * ここで断ると保存できず、**絵も出ず・消せず・名前も付かない**
 * ——実機で `no-recipe` として報告された（2026-08-22）。
 *
 * @returns {object|null} 書く本体。書くものが無ければ null。
 */
export function recordSaveBody(record) {
    if (record?.recipe && typeof record.recipe === 'object') return { ...record.recipe };
    if (!record || typeof record !== 'object') return null;
    const body = Object.fromEntries(
        Object.entries(record).filter(([key]) => !VIEW_ONLY_KEYS.has(key)),
    );
    return Object.keys(body).length ? body : null;
}

const STYLE_ID = 'unbake-theme';
const FULLSCREEN_ID = 'unbake-fullscreen';
const EXTENSION_NAME = 'Unbake';

function ensureStyle(documentRef) {
    // **器が無ければ何もしない。** 宿主の外（検査や headless）から呼ばれると
    // `document` が無い——ここで落ちると、拡張の登録ごと止まる。
    if (!documentRef?.getElementById || !documentRef.head) return;
    if (documentRef.getElementById(STYLE_ID)) return;
    const link = documentRef.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = new URL('./panel/theme.css', import.meta.url).href;
    documentRef.head.append(link);
}

/**
 * 全画面の器を作って、**サイドバーと同じコンポーネント**を差す。
 * @returns {{ close(): void, panel: object }}
 */
export function openFullscreen(documentRef = globalThis.document, options = {}) {
    ensureStyle(documentRef);
    documentRef.getElementById(FULLSCREEN_ID)?.remove();

    const shell = documentRef.createElement('div');
    shell.id = FULLSCREEN_ID;
    shell.className = 'unbake-fullscreen';
    documentRef.body.append(shell);

    // **閉じ方を目で見えるようにする。** Escape だけだと、
    // **戻り方が画面のどこにも書いていない**——出口の無い画面は「壊れている」
    // のと区別が付かない（実機でそう報告された）。
    const back = documentRef.createElement('button');
    back.className = 'unbake-fullscreen-close';
    back.type = 'button';
    back.textContent = t('app.closeFullscreen');
    back.title = t('app.closeFullscreen.help');
    back.setAttribute('aria-label', t('app.closeFullscreen'));
    back.addEventListener('click', () => close());
    shell.append(back);

    // **ここが決定⑤の全部**——全画面固有の描画コードは1行も無い。
    const panel = createUnbakePanel(shell, { ...options, mode: 'fullscreen', documentRef });

    const onKey = (event) => {
        if (event.key === 'Escape') close();
    };
    function close() {
        documentRef.removeEventListener('keydown', onKey);
        panel.destroy();
        shell.remove();
    }
    documentRef.addEventListener('keydown', onKey);
    return { close, panel };
}

/**
 * ComfyUI へ登録する。
 *
 * @param {object} app ComfyUI の app
 * @returns {{ openFullscreen: () => object }}
 */
export function registerUnbake(app, { documentRef = globalThis.document } = {}) {
    if (!app || typeof app.registerExtension !== 'function') {
        // 形が違うものを黙って受けない。**受けると「登録したのに何も出ない」になる。**
        throw new TypeError('registerUnbake: needs the ComfyUI app (an object with registerExtension)');
    }

    // **言語は宿主から取る。** 既定は英語（母数を切らないため）。
    //
    // 設定で明示的に選ぶこともできる（2026-08-20 の要望）。**既定は空＝宿主に合わせる**
    // なので、選ばなければ以前と同じ——「アプリは日本語なのにこのパネルだけ英語」は
    // 選んだ人にしか起きない。
    const hostLocale = readHostLocale(app);
    setLocale(hostLocale);

    /** 設定の言語を当てる。**空なら宿主へ戻す**（「英語にする」ではない）。 */
    function applyLocale(code) {
        setLocale(code || hostLocale);
    }

    installComfyHost();
    ensureStyle(documentRef);

    // --- 表示の設定を1回だけ読む -----------------------------------------
    //
    // **読めなくても面は開く。** 設定が取れないことと「既定にした」ことは
    // 別なので、取れなければ既定のまま開いて、そのことをログへ出す。
    // 面は既定を自分で持っているので、渡さなければ従来どおりに動く。
    let displaySettings = null;

    /**
     * 保存の形（snake）から、面が読む形（camel）へ。
     *
     * **1箇所に持つ。** 読むときと書いた後で別々に組んでいると、
     * **書いた後の控えだけが古いまま**になる——後から作った面が古い見た目を
     * 持ち込む（2026-08-25 実測: テーマを変えた後に全画面を開くと巻き戻った）。
     */
    function toDisplaySettings(settings) {
        return {
                compactWidth: settings?.compact_width,
                language: typeof settings?.language === 'string' ? settings.language : '',
                favoriteIds: Array.isArray(settings?.favorite_ids) ? settings.favorite_ids : [],
                // **外した印も持ち回る。** 上流の印を打ち消すのはこちら側の名簿。
                unfavoriteIds: Array.isArray(settings?.unfavorite_ids) ? settings.unfavorite_ids : [],
                theme: settings?.theme,
                richUi: settings?.rich_ui !== false,
                // 画面の作り（テーマ1＝classic / テーマ2＝prism）。
                uiSkin: settings?.ui_skin,
                // **重ねて出すか／その幅。** 器は ComfyUI の持ち物なので、
                // ここが切れないと「広げる＝右が切れる」から逃げられない。
                sidebarOverlay: settings?.sidebar_overlay !== false,
                sidebarWidth: settings?.sidebar_width,
                replayMaxMegapixels: settings?.replay_max_megapixels,
                verdictPalette: settings?.verdict_palette,
                listView: settings?.list_view,
                tileSize: settings?.tile_size,
                sortKey: settings?.sort_key,
                sortDescending: settings?.sort_descending === true,
                // 絞り込みも残す（2026-08-24 利用者の指示）。**同じ帯に並んでいる
                // 操作なので、並び替え・見せ方と同じ扱いにする。**
                hiddenVerdicts: Array.isArray(settings?.hidden_verdicts) ? settings.hidden_verdicts : [],
                favoritesOnly: settings?.favorites_only === true,
                disableDarkReader: settings?.disable_dark_reader !== false,
                groupByCheckpoint: settings?.group_by_checkpoint === true,
                showCommercialOk: settings?.show_commercial_ok !== false,
            confirmBeforeDelete: settings?.confirm_before_delete !== false,
        };
    }

    async function readDisplaySettings() {
        try {
            const { settings } = await readUnbakeSettings();
            return toDisplaySettings(settings);
        } catch {
            return null;
        }
    }

    /**
     * 設定を1回だけ読む。**面を作る前に済ませる。**
     *
     * 元は書庫を落とす道の途中で読んでいたが、その道が始まるのは
     * **面を作った後**（`createUnbakePanel(...)` → `fillFromLibrary(panel)`）だった。
     * つまり**最初に開いた面は設定を1つも見ていない**——幅の閾値も行数も並びも
     * 商用可否の列も、既定のまま描かれていた。設定は保存できるのに効かない、
     * という一番読みにくい形。書庫と違って設定は小さいので、**登録の時点で読む**。
     */
    let settingsPromise = null;
    function ensureSettings() {
        if (!settingsPromise) {
            settingsPromise = readDisplaySettings().then((settings) => {
                displaySettings = settings;
                // **言語も面を作る前に当てる。** 見出しと列名は面を作るときに
                // 一度だけ文字を入れるので、後から当てても描き直らない。
                applyLocale(settings?.language);
                // **Dark Reader へ「自前で暗い」と伝える**（2026-08-24）。
                // 実測で色を書き換えられており、半透明の重ねが不透明へ潰れて
                // 「背景が単色」になっていた。**CSS では直せない。**
                //
                // **⚠️ 効く範囲は ComfyUI 全体**（`<meta>` は文書に1つ）。
                // だから既定で有効にしつつ、設定で切れるようにしてある。
                applyDarkReaderLock(settings?.disableDarkReader !== false, documentRef);
                // **面を開く前に、外の印を出す**（2026-08-25 利用者の指摘)。
                // 紙と `data-unbake-skin` は面を作るときに当てているので、
                // **一度も開いていない間、ツール列の印だけテーマ1のまま**だった
                // ——利用者から見れば「アイコンが変わらない」。
                // 設定を読んだ時点で当てれば、読み込み直後から揃う。
                applySkin(documentRef, settings?.uiSkin);
                return settings;
            });
        }
        return settingsPromise;
    }

    // --- 束で回す口（手順13）------------------------------------------
    //
    // **実行器は新しく書かない。** 1件を投げて待つところは `SweepRunner` が
    // 持っているので、ここは材料を渡すだけ。
    const batchIo = {
        makeRunner: makeSweepRunner,
        loadRecord: async (record) => {
            if (!record?.libraryId) return null;
            try { return await loadResolvedRecord(record.libraryId); } catch { return null; }
        },
        // **既定は seed だけの雛形。** 束で回すときに軸まで振ると、
        // 1記録あたりのセルが掛け算で増えて「N分待ってから」が桁で変わる。
        templateFor: (record) => {
            const [seedsOnly] = buildBuiltinSweepTemplates(record.recipe || record);
            return seedsOnly;
        },
        // **「出ている」の判断は刻印だけ。** 推定で回し直しを止めると、
        // 「出したはずの絵が無い」が起きる。
        stampedSignatures: null,
        wantedSignaturesOf: null,
    };

    /**
     * モデルを1つ落とす口。
     *
     * **版IDしか送らない。** URL を画面から渡せる形にすると、画面へ細工をした人が
     * 任意の場所からファイルを落とせる口になる——落とし先を決めるのはサーバ側で、
     * あちらが Civitai の公開 API へ自分で問い合わせ、**返ってきた URL しか使わない**。
     *
     * **「既に在る」を失敗として投げない。** 呼び手が数を分けられるように、
     * 応答をそのまま返す（`{ok:false, error:"already there: …"}`）。
     */
    const downloadIo = {
        async start(versionId) {
            const response = await fetch('/unbake/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ versionId: String(versionId) }),
            });
            return response.json();
        },
        /**
         * 落とす前に大きさを調べる。**1バイトも落とさない。**
         *
         * これが無いと、押した人は総量を知らずに始めることになる——実測で、
         * 19件の待ち行列の10本目が **34 GB** だった（止めるまで気づけなかった）。
         */
        async plan(versionIds) {
            const query = encodeURIComponent([...versionIds].join(','));
            const response = await fetch(`/unbake/download-plan?versionIds=${query}`);
            return response.json();
        },
        async state() {
            const response = await fetch('/unbake/download');
            return response.json();
        },
        async cancel() {
            const response = await fetch('/unbake/download-cancel', { method: 'POST' });
            return response.json();
        },
    };

    /**
     * ComfyUI の画面へワークフローを開く。**投げない。**
     *
     * 出すところで止めるのは、**開いてから直したい**ことがあるため
     * （足りないモデルを差し替える、解像度だけ変える）。投げるのは再現と Sweep の役目。
     *
     * 形は2つある（実測・frontend 1.45.20 で両方在ることを確かめた）:
     *
     *   - **UI グラフ**（作者が保存した画面そのもの）→ `loadGraphData`
     *   - **API グラフ**（こちらが組んだ実行用）→ `loadApiJson`
     *
     * UI グラフを持つ記録は実測で36件しか無いので、**大半はこちらが組んだものを開く**。
     */
    async function openWorkflowInComfy(recipe, name) {
        const uiGraph = recipe?.comfy_workflow || recipe?.ui_workflow || null;
        if (uiGraph && typeof app.loadGraphData === 'function') {
            app.loadGraphData(uiGraph);
            return { ok: true, how: 'ui' };
        }
        // 組んだものを開く。**Sweep と同じ組み立て**を通す（別の道を作らない）。
        let prompt = recipe?.comfy_prompt || null;
        if (!prompt) {
            const inputs = await collectAnalysisInputs();
            const built = buildRecipeWorkflow(recipe, {
                objectInfo: inputs.objectInfo, embeddings: inputs.embeddings,
            });
            prompt = built?.prompt || null;
        }
        if (!prompt) return { ok: false, error: 'no-workflow' };
        if (typeof app.loadApiJson !== 'function') return { ok: false, error: 'no-loadApiJson' };
        app.loadApiJson(prompt, `${name || 'unbake'}.json`);
        return { ok: true, how: 'api' };
    }

    /**
     * 「あとで読む箱」を読む口（裁定⑦・手順19）。**読むだけ。**
     *
     * 鍵はサーバの設定に在り、**画面へは戻ってこない**（`{set, length}` しか来ない）。
     * だから Raindrop への問い合わせはサーバが行い、ここは結果を受け取るだけになる
     * ——鍵をブラウザへ渡す設計にすると、同じページで動く他のカスタムノードからも読める。
     *
     * **取り込みの口はここに作らない。** 取り込みは落とし込みの Civitai 経路と
     * 同じもので、面が `ingest` を通す（`panel.js` の `ingestRouted`）。
     */
    const raindropIo = {
        async list({ page = 0, all = false } = {}) {
            const query = new URLSearchParams({ page: String(Math.max(0, Number(page) || 0)) });
            // **箱ごと読む**（2026-08-23 利用者の指示）。頼まれたときだけ——
            // 既定を全部にすると、開くたびに外への往復が箱の大きさぶん増える。
            if (all) query.set('all', '1');
            const response = await fetch(`/unbake/raindrop?${query.toString()}`);
            // **400 でも本文を読む。** 鍵が無いことは `{ok:false, error:'no-token'}` で
            // 返ってくる——ここで例外にすると「届かなかった」と区別できなくなる。
            return response.json();
        },
    };

    /**
     * 記録をディスクへ残す・消す口（`I-20260821-03`）。
     *
     * **これが無いと、取り込んだ記録は再読み込みで消える。** Civitai からも
     * 「あとで読む箱」からも入るのに、残す口が1つも無かった——
     * 画面の中だけに在る記録は、閉じた瞬間に無かったことになる。
     *
     * **書くのは `.unbake.json`。** `.recipe.json` は1バイトも書かない
     * （書いた瞬間にレシピ編集器になり、稼働中の LoRA Manager と実ファイルを取り合う）。
     */
    const recordsIo = {
        async save(record) {
            const body = recordSaveBody(record);
            if (!body) return { ok: false, error: 'no-recipe' };
            if (!body.id) body.id = record.id || null;
            if (!body.title && record.title) body.title = record.title;
            // 出典を残す。**これが無いと「もう取り込んだか」が二度と判らない。**
            if (!body.source_path && record?.origin?.url) body.source_path = record.origin.url;
            // **見本の在処は別に渡す。** サーバが落として記録の隣へ置く
            // ——ブラウザからバイト列を送る形にすると、任意の画像を書ける口になる。
            const previewUrl = body.preview_url
                || (typeof record?.previewUrl === 'string' && /^https?:/.test(record.previewUrl)
                    ? record.previewUrl : null);
            const response = await fetch('/unbake/record-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // **手元の絵も渡す**（2026-08-23 利用者の指示）。落とし込んだ
                // ファイルはこれしか手が無い——サーバが取りに行けるのは
                // `http(s)` だけで、ブラウザが抱えているバイト列には届かない。
                // 置き場も名前もサーバが決め、**中身を見て**画像か判断する。
                body: JSON.stringify({
                    record: body, previewUrl, previewData: record?.previewData || null,
                }),
            });
            return response.json();
        },
        async remove(recordId) {
            const response = await fetch('/unbake/record-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: String(recordId) }),
            });
            return response.json();
        },
    };

    /**
     * モデルを消す口（2026-08-21 ユーザー決定）。**ゴミ箱へは送らず完全に消す。**
     *
     * **パスを送らない。** 送るのは種別と名前だけで、実ファイルの解決は
     * サーバがやる——画面がパスを組み立てられる形にすると、そこが置き場の外を
     * 消す口になる（改造版 LoRA Manager の削除はパスの検証が無い）。
     */
    const modelsIo = {
        async usage(name) {
            const query = new URLSearchParams({ name: String(name) });
            const response = await fetch(`/unbake/model-usage?${query.toString()}`);
            return response.json();
        },
        async plan(kind, name) {
            const query = new URLSearchParams({ kind: String(kind), name: String(name) });
            const response = await fetch(`/unbake/model-delete-plan?${query.toString()}`);
            return response.json();
        },
        async remove(kind, name) {
            const response = await fetch('/unbake/model-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kind: String(kind), name: String(name) }),
            });
            return response.json();
        },
    };

    /**
     * 記録を読み、**名前で引けないモデルを hash と Civitai の id で引き直す**。
     *
     * **ここ1箇所に挿す。** 判定も Sweep も束の実行も、本体を読むのはこの関数なので、
     * ここで解決しておけば下流はどれも無改造で正しい名前を見る
     * （組み立て側の `getResourceFilename` が `inLibrary ? localPath` を最優先で見る）。
     *
     * **索引が無くても落とさない。** LoRA Manager を入れていない環境では空で返るので、
     * 今までどおり名前だけで解決する（悪くならない）。
     */
    async function loadResolvedRecord(recordId) {
        // **境界で1度だけ形を揃える**（2026-08-24）。こちらが画像から作った記録は
        // 条件を直下に持ち、`checkpoint` は文字列——下流は全部レシピの形を読むので、
        // そのまま流すと**値が在るのに画面が空になる**（`ComfyUI_00444_` で起きた）。
        const recipe = toRecipeShape(await readLibraryRecord(recordId));
        let index = null;
        let installed = {};
        try {
            index = await readModelIndex();
            const inputs = await collectAnalysisInputs();
            installed = installedNamesFrom(inputs?.objectInfo);
        } catch {
            // 索引も `/object_info` も無ければ、名前だけで解決する。
            return recipe;
        }
        const { recipe: resolved, resolved: applied } = resolveRecipeModels(recipe, index, installed);
        if (!applied.length) return resolved;
        // **当てたことを黙らせない。** 記録に書かれた名前と実際に使う名前が違うので、
        // **どの根拠で当てたか**が辿れないと、間違った解決を後から見つけられない。
        // 記録へ載せて持ち回り、判定の注記として画面まで出す。
        return { ...resolved, unbake_resolved: applied };
    }

    const shared = {
        documentRef,
        downloadIo,
        openInComfy: openWorkflowInComfy,
        // **お気に入りはこちら側に持つ。** 記録は上流が書いた `.recipe.json` で、
        // こちらは読むだけと決めてある（上流の印は尊重して、消す道は作らない）。
        favoritesIo: { write: (patch) => writeUnbakeSettings(patch) },
        ingest,
        makeSweepRunner,
        /** 出た絵を1枚消す（2026-08-25 利用者の指示）。**猶予は面が持つ。** */
        async deleteOutputIo({ filename, subfolder }) {
            const response = await fetch('/unbake/output-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, subfolder }),
            });
            return response.json();
        },
        /**
         * 宿主のキューの混み具合。**順番待ちが「空くまで待つ」ために要る。**
         *
         * 自分の行列だけを直列にしても、**Unbake の外で始まった生成**（ComfyUI の
         * Run など）には気づけない。気づけないと、押した1件目がその場で断られて
         * 止まった印のまま終わり、**後から押した分だけが待ちに見える**
         * ——2026-08-24 の「一件目が開始されない」はこの形だった。
         */
        async hostQueue() {
            // **掴んだままにしない。** 面の側にも締め切りは在るが、
            // 繋ぎっぱなしの要求を残すと、再起動をまたいで積み上がる。
            const abort = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = abort && typeof setTimeout === 'function'
                ? setTimeout(() => abort.abort(), 5000)
                : null;
            let response;
            try {
                response = await fetch('/queue', abort ? { signal: abort.signal } : undefined);
            } finally {
                if (timer) clearTimeout(timer);
            }
            if (!response.ok) throw new Error(`Queue check failed: ${response.status}`);
            const queue = await response.json();
            return {
                running: (queue?.queue_running || []).length,
                pending: (queue?.queue_pending || []).length,
            };
        },
        /**
         * **その記録は、そもそも組めるか。**
         *
         * 代理の印で判断しない（2026-08-23）。実データ350件で測ると、
         * 判定の `norecord` は**組めない8件を全部含む**が、**組める20件も
         * 巻き込む**——それで押せなくすると、出せる記録が出せなくなる。
         * 組めるかどうかは組んでみれば判るので、そのまま組む（1件 20ms 前後）。
         *
         * **投入はしない。** 組み立てだけで、絵は1枚も出ない。
         */
        async canBuild(recipe) {
            if (!recipe) return { ok: false, error: null };
            try {
                const inputs = await collectAnalysisInputs();
                buildRecipeWorkflow(recipe, {
                    objectInfo: inputs.objectInfo, embeddings: inputs.embeddings,
                });
                return { ok: true, error: null };
            } catch (error) {
                return { ok: false, error: error?.message || String(error) };
            }
        },
        onCaptureSweepCell,
        onExtractParams: onExtractOutputParams,
        loadRecord: loadResolvedRecord,
        loadVariants,
        batchIo,
        raindropIo,
        recordsIo: {
            ...recordsIo,
            /**
             * 書庫を読み直して、**面がそのまま並べられる形**で返す。
             *
             * **生の行を面へ渡さない。** `/unbake/records` が返すのは要約の行で、
             * 面が読むのは `libraryRowToRecord` を通した記録——別物である。
             * 混ぜた結果を実機で見た（2026-08-23 利用者の報告）: 取り込んだ直後に
             * **一覧の絵が全部消える**（行は `preview: true` を持つが、面が読むのは
             * `previewUrl` で、行には無い）。再読み込みで直るので「保存できていない」
             * ようにも見えるが、**ディスクの記録も索引も正しかった**。
             *
             * 読み直したら**判定も掛け直す**——行から起こした記録は全部 `pending`
             * から始まるので、掛け直さないと判定の欄が一斉に「未確認」へ戻る。
             */
            async reload() {
                const { records, messages } = await loadLibrary({ rescan: true });
                for (const message of messages) logAll(message);
                if (!records.length) return [];
                sharedRecords = records;
                // **次に開く面も新しい方を見る。** 控えを残すと、全画面を開いた
                // ときだけ取り込む前の一覧が出る。
                libraryPromise = Promise.resolve({ records, messages: [] });
                verdictPassStarted = false;
                startVerdictPass();
                return records;
            },
        },
        modelsIo,
        loadInstalledModels: listInstalledModels,
        settingsIo: {
            read: readUnbakeSettings,
            /**
             * 保存したら、**控えを新しくして、開いている面すべてへ流す。**
             *
             * 面は作られるたびにこの控えを読む。古いままだと**後から作った面が
             * 古い見た目を持ち込む**——実測（2026-08-25）: テーマを kitchen へ
             * 変えた後に全画面を開くと、紙も外の印も vinyl（読み込み時の値）へ
             * 巻き戻り、**保存値と画面が食い違った**。
             *
             * 面が2つ開いているときも同じ。紙は文書に1枚しか無いので、
             * **片方だけ新しい**状態を作らない。
             */
            write: async (patch) => {
                const payload = await writeUnbakeSettings(patch);
                const next = payload?.settings;
                if (next && typeof next === 'object') {
                    const fresh = toDisplaySettings(next);
                    if (displaySettings) Object.assign(displaySettings, fresh);
                    else displaySettings = fresh;
                }
                // **文書に効く錠も、その場で当て直す。** 面ではなく `<meta>` に
                // 効くので `applyDisplay` では届かない——読み込み時に1回しか
                // 当てていなかったので、切っても**読み直すまで効かなかった**
                // （まとめを切っても並びが戻らなかったのと同じ形）。
                if (patch && (patch.disable_dark_reader !== undefined || patch.disableDarkReader !== undefined)) {
                    applyDarkReaderLock(
                        (patch.disable_dark_reader ?? patch.disableDarkReader) !== false, documentRef);
                }
                for (const panel of openPanels) panel.applyDisplay?.(patch);
                return payload;
            },
            rescan: () => listLibraryRecords({ rescan: true }),
            // **言語を変えたら面を組み直す。** 保存しただけでは、
            // 既に文字が入っている見出し・列名・ボタンが古い言語のまま残る。
            onLanguageChange: async (code) => {
                applyLocale(code);
                // **組み直す前に、保存した値を読み直す。** 古い控えのまま組み直すと、
                // 同じ保存で変えたはずのテーマや配色が元へ戻る
                // ——実機で「テーマを変えても変化が無い」と言われた形。
                settingsPromise = null;
                await ensureSettings().catch(() => null);
                if (displaySettings) displaySettings.language = code;
                rebuildSidebar?.();
            },
        },
    };

    // --- 書庫は1回だけ落として、器の数だけ取らない -----------------------
    //
    // **元は `render()` の中で落としていた。** つまり書庫を読む呼び手は
    // サイドバー1箇所だけで、全画面はコマンドから開くと**常に0件**だった
    // （器が違うだけで中身は1つ、という決定⑤が、データの側では守られていなかった）。
    //
    // 落とす場所をここへ上げ、**応答を使い回す**。実測で `/unbake/records` の
    // 応答は 226.3 KiB あり、器ごとに取ると開くたびにそれを繰り返す。

    /** 最後に読めた記録。**両方の器がこれを見る。** */
    let sharedRecords = [];
    /** 進行中／完了済みの取得。**同じものを2回投げない。** */
    let libraryPromise = null;

    // --- 判定は1回だけ回して、表を共有する ------------------------------
    //
    // 一覧の判定は長いあいだ `pending` 固定だった。理由は「346件ぶん組むと
    // 画面が固まる」で、それ自体は正しい観察だったが、**固定した結果として
    // チップは実データで `not built 346` になり、1件も絞れなかった**
    // ——絞り込みが仕事の道具で、絞れないのは機能が無いのと同じである。
    //
    // 答えは「出さない」ではなく「**1回だけ背景で回して、4人の消費者が
    // 同じ表を読む**」。条件の固定は `verdictTable.js` が持つ。

    const verdicts = createVerdictTable({
        loadRecord: loadResolvedRecord,
        collectInputs: () => collectAnalysisInputs(),
    });

    // --- 出た絵を記録へ帰属させる（工程2・裁定③）---------------------------
    //
    // **押されたときに初めて取る。** 出力は実測で4,275枚、生の値で 18.2 MiB。
    // 開いた瞬間に全部取ると画面が固まるので、`loadVariants` が呼ばれるまで
    // 1バイトも取りに行かない。取ったら使い回す。

    /** 帰属の結果（記録id → 絵の配列）。**1回だけ組む。** */
    let variantIndex = null;
    let variantPromise = null;

    async function ensureVariantIndex() {
        if (variantIndex) return variantIndex;
        if (variantPromise) return variantPromise;
        variantPromise = (async () => {
            const outputs = [];
            let offset = 0;
            for (let page = 0; page < 60; page += 1) {
                const result = await scanOutputs({ offset, limit: 200 });
                if (!result.reachable) break;
                const batch = result.outputs || [];
                outputs.push(...batch);
                offset += batch.length;
                if (batch.length === 0 || offset >= (result.total || 0)) break;
            }
            const { byRecord, tally } = attributeOutputs(outputs, sharedRecords);
            // **内訳を必ず出す。** 「N枚を紐付けた」だけだと、
            // そのうち何枚が推定なのかが読めない。
            logAll(t('variants.tally', {
                attributed: tally.stamped + tally.inferred,
                total: tally.total,
                stamped: tally.stamped,
                inferred: tally.inferred,
            }));
            variantIndex = byRecord;
            return byRecord;
        })();
        return variantPromise;
    }

    /**
     * 索引を**押される前に**組んでおく（2026-08-24 利用者の指摘
     * 「レコードをクリックしたときラグが発生することがある」）。
     *
     * **実測**: 記録を初めて開くと `/unbake/outputs` を200件ずつ**24回、直列に**
     * 取っており、**1,334ms** かかっていた（2回目以降は 21〜34ms）。
     * 「ことがある」＝**初回だけ**、が実測と合う。
     *
     * 元の設計は「押されたときに初めて取る」で、**開いた瞬間に固まらないため**の
     * 判断だった。それは正しいが、**押した瞬間に固まるほうへ移しただけ**でもある。
     * 一覧が出た後の空き時間に回せば、**どちらの瞬間も固まらない。**
     *
     * **待たない・失敗を数えない。** ここは前倒しでしかなく、間に合わなければ
     * 従来どおり `loadVariants` の中で組まれる。**組み立ては約束で1本化されている**
     * ので、前倒しと本番が二重に走ることはない。
     */
    function warmVariantIndex() {
        if (variantIndex || variantPromise) return;
        if (typeof setTimeout !== 'function') { ensureVariantIndex().catch(() => {}); return; }
        // **一覧を描き終えてから。** 同じ tick で始めると、前倒しのつもりが
        // 最初の描画を遅らせる（避けたかったものをそのまま作る）。
        setTimeout(() => { ensureVariantIndex().catch(() => {}); }, 1200);
    }

    /** 記録1件ぶんの絵と、基準にする本体を揃える。 */
    async function loadVariants(record) {
        const index = await ensureVariantIndex();
        const id = String(record?.libraryId ?? record?.id ?? '');
        let recipe = record?.recipe || null;
        if (!recipe && record?.libraryId) {
            try { recipe = await readLibraryRecord(record.libraryId); } catch { recipe = null; }
        }
        return { outputs: index.get(id) || [], recipe };
    }

    /** 開いている面。**判定が進むたびに全部へ流す**（器ごとに数が違うと困る）。 */
    const openPanels = new Set();
    let verdictPassStarted = false;

    const trackPanel = (panel) => {
        openPanels.add(panel);
        const destroy = panel.destroy;
        panel.destroy = () => { openPanels.delete(panel); destroy.call(panel); };
        return panel;
    };

    /** 表の内容を、開いている面すべてへ写す。 */
    function pushVerdicts() {
        for (const panel of openPanels) {
            panel.setRecords(applyVerdicts(panel.getRecords(), verdicts));
        }
    }

    const logAll = (message) => { for (const panel of openPanels) panel.log(message); };

    /**
     * 背景で判定を回す。**1セッションに1回だけ。**
     *
     * 進捗は一定間隔でしか描かない——346回描き直すと、判定より描画のほうが高くつく。
     */
    function startVerdictPass() {
        if (verdictPassStarted || !sharedRecords.length) return;
        verdictPassStarted = true;
        logAll(t('list.verdictRunning', { total: sharedRecords.length }));
        verdicts.run(sharedRecords, (done, total) => {
            if (done % 25 === 0 || done === total) pushVerdicts();
        }).then(({ done, failed, ms }) => {
            pushVerdicts();
            logAll(t('list.verdictDone', { total: done, ms }));
            if (failed > 0) logAll(t('list.verdictFailed', { failed }));
            // **測っていないことを必ず併記する。** 判定は入力条件で答えが変わり、
            // 台帳の有無だけで unavailable が 51↔59 と動く（実測）。
            // 条件を書かない件数は、読んだ人に「確かめた」と読まれる。
            const notMeasured = verdicts.describeConditions();
            if (notMeasured.length) {
                logAll(t('list.verdictConditions', { list: notMeasured.join(' / ') }));
            }
        }).catch(error => {
            verdictPassStarted = false;
            logAll(t('list.loadFailed', { detail: error?.message || error }));
        });
    }

    const ensureLibrary = () => {
        if (!libraryPromise) {
            // **設定が先。** 後から来ると、既定の閾値で一度描いてから
            // 設定の閾値で描き直すことになり、幅が一瞬で切り替わる。
            // **設定が先。** 後から来ると、既定の閾値で一度描いてから
            // 設定の閾値で描き直すことになり、幅が一瞬で切り替わる。
            // **`.then(loadLibrary)` にしない。** 解決した設定がそのまま
            // 第1引数として渡る——引数を取らない間は無害だったが、受ける形を
            // 足した途端に「設定を読み込み指定として読む」経路になる。
            libraryPromise = ensureSettings().then(() => loadLibrary());
        }
        return libraryPromise;
    };

    /** 書庫を面へ流し込む。**届かなかったことは必ず言葉で出す。** */
    function fillFromLibrary(panel) {
        return ensureLibrary().then(({ records, messages }) => {
            for (const message of messages) panel.log(message);
            if (records.length) {
                sharedRecords = records;
                panel.setRecords(records);
                startVerdictPass();
                warmVariantIndex();
            }
            return records;
        }).catch(error => {
            panel.log(t('list.loadFailed', { detail: error?.message || error }));
            return [];
        });
    }

    /**
     * 全画面を開く。
     *
     * @param {object[]|null} seed 呼び手が既に持っている記録。**渡されたら取り直さない。**
     *   サイドバーの「残り N 件」から来たときがこれで、そこには落とし込みで
     *   足された分（書庫に無い記録）も入っている——取り直すと**それが消える**。
     */
    /**
     * サイドバーの面を作り直す。**言語を変えたときだけ使う。**
     *
     * 見出し・列名・ボタンの文字は面を作るときに一度だけ入れているので、
     * 言語を差し替えても描き直らない（`render()` は行だけを描く）。
     * 器ごと作り直すのが一番短い——`localStorage` に持っている幅も、
     * 記録も、作り直した面が自分で取り直す。
     */
    let rebuildSidebar = null;

    const openFullscreenWith = (seed) => {
        const view = openFullscreen(documentRef, { ...shared, display: displaySettings });
        trackPanel(view.panel);
        // 既に判定が済んでいる分は、開いた瞬間に反映する。
        if (Array.isArray(seed) && seed.length) view.panel.setRecords(applyVerdicts(seed, verdicts));
        else if (sharedRecords.length) view.panel.setRecords(applyVerdicts(sharedRecords, verdicts));
        else fillFromLibrary(view.panel);
        return view;
    };

    // コマンドからも呼ばれる。**引数は受けない**——コマンドは実行時の
    // 引数を渡してくることがあり、それを seed と読むと壊れる。
    const open = () => openFullscreenWith(null);

    app.registerExtension({
        name: EXTENSION_NAME,
        commands: [{
            id: 'Unbake.OpenFullscreen',
            label: t('app.openFullscreen'),
            function: open,
        }],
        // **`setup()` の中で登録する。** モジュールの評価時点では
        // `extensionManager` がまだ組み上がっていないことがある。
        async setup() {
            // **面を登録する前に設定を読む。** `render(el)` はこの後いつでも
            // 呼ばれうるので、ここで待たないと最初の面が既定で描かれる。
            // 読めなくても進む——設定が取れないことと「既定にした」ことは別だが、
            // ここで止めると拡張ごと出なくなる。
            await ensureSettings().catch(() => null);
            // **面より先に style を入れる。** 宿主はタブのボタンを登録した
            // 時点で描くので、`render(el)` を待つとアイコンの規則が
            // 間に合わず、最初の一瞬だけ**四角い空白**が出る。
            ensureStyle(globalThis.document);
            app.extensionManager?.registerSidebarTab?.({
                id: 'unbake',
                // **専用の印。** 元は `pi pi-images` で、並びの他の面と同じ絵だった
                // ——アイコンからはどれが Unbake か判らない（2026-08-22 利用者の指示）。
                icon: 'unbake-icon',
                title: 'Unbake',
                // **ツールチップに名前を入れる。** frontend はこれを
                // ボタンの `aria-label` にする（実測 v1.42.15）ので、名前を外すと
                // **画面のどこにも "Unbake" という文字が出ない**。
                // 実際にそうなっていて、探した人に「見つからない」と言わせた。
                tooltip: t('app.tooltip'),
                type: 'custom',
                render: (el) => {
                    const build = () => {
                        const panel = trackPanel(createUnbakePanel(el, {
                            ...shared,
                            mode: 'sidebar',
                            display: displaySettings,
                            // 狭い器で溢れた分の行き先。**件数だけ出して行き止まりにしない。**
                            // **手持ちをそのまま渡す**（再取得しない）。
                            onRequestFullscreen: () => openFullscreenWith(panel.getRecords()),
                        }));
                        // **自分のレシピを最初から出す。** 落とすまで空、では
                        // 346件を毎回落とすことになり、実際には使えない。
                        if (sharedRecords.length) panel.setRecords(applyVerdicts(sharedRecords, verdicts));
                        else fillFromLibrary(panel);
                        return panel;
                    };
                    let current = null;
                    // **押し広げず、重ねて出す**（2026-08-25 利用者の指示）。
                    // 器を横の並びから外すので、ComfyUI の右端は動かない。
                    let overlay = null;
                    const reoverlay = () => {
                        overlay?.dispose?.();
                        overlay = installSidebarOverlay(el, {
                            enabled: displaySettings?.sidebarOverlay !== false,
                            width: displaySettings?.sidebarWidth,
                            gripTitle: t('app.sidebarGrip'),
                            // **掴んで決めた幅を残す。** 重ねた時点で ComfyUI の
                            // 仕切りは効かなくなるので、こちらが持ち主になる。
                            onWidth: (px) => {
                                if (displaySettings) displaySettings.sidebarWidth = px;
                                writeUnbakeSettings({ sidebar_width: px }).catch(() => null);
                            },
                        });
                    };
                    rebuildSidebar = () => {
                        // **古い面を先に畳む。** 畳まないと、画面から外れた面が
                        // `openPanels` に残って判定の書き込み先であり続ける
                        // （見えない面へ描き続けるので、遅くなるだけで症状が出ない）。
                        current?.destroy?.();
                        // **入れ物は使い回す。** ComfyUI は `render(el)` を1回しか
                        // 呼ばないので、新しい器を作っても画面には出ない。
                        el.replaceChildren?.();
                        current = build();
                        // 幅や入切は設定から来るので、組み直しのたびに入れ直す。
                        reoverlay();
                    };
                    current = build();
                    reoverlay();
                    return current;
                },
            });
        },
    });

    // `whenLibraryReady` は検査用の口。**「開いた」と「記録が届いた」は別の時刻**で、
    // これが無いと検査は待ち方を持たず、空のまま比べて通ってしまう。
    return {
        openFullscreen: open,
        whenLibraryReady: () => ensureLibrary(),
        // 検査と実測用。**判定の表は1つしか無いことを外から確かめられるようにする。**
        verdicts,
    };
}

/**
 * 書庫の要約を、一覧が扱える記録の形へ落とす。
 *
 * **判定を付けない（`pending` にする）。** 346件ぶんの判定は、1件ずつグラフを
 * 組んで初めて出る（実測で全件 8秒前後）。開いた瞬間にそれをやると画面が固まるし、
 * **`pending` は「まだ組んでいない」という正しい意味**なので、嘘にもならない。
 * 組むのは Sweep を開いたときで、そこでは1件だけ組めば足りる。
 */
export function libraryRowToRecord(row) {
    return {
        id: row.id,
        // **本体を取りに行くための鍵。** これが在る記録は Sweep を押せる。
        libraryId: row.id,
        title: row.title || row.id,
        verdict: 'pending',
        checkpoint: row.checkpoint || null,
        positive: row.prompt || '',
        seed: row.seed ?? null,
        // **要約が持っている分だけの LoRA。** 本体（`.recipe.json`）とは違い
        // 名前と効き目しか無いが、帰属の照合にはこれで足りる。
        loras: Array.isArray(row.loras) ? row.loras : [],
        // **レシピと同じ形へ寄せる。** 抽出器（`outputFingerprint.js`）は
        // `gen_params` を読むので、ここで形を揃えないと**比べられる項目が
        // 1本しか無くなり、帰属が全件0になる**（実際にそうなった）。
        gen_params: {
            prompt: row.prompt || '',
            negative_prompt: row.negative_prompt || '',
            seed: row.seed ?? null,
            steps: row.steps ?? null,
            cfg_scale: row.cfg_scale ?? null,
            sampler: row.sampler ?? null,
            size: row.size ?? null,
        },
        source: row.source || 'folder',
        // **誰が書いたか。** 消すときに文言が変わる——LoRA Manager が書いた記録は、
        // ファイルを消しても**向こうの一覧には再スキャンまで残って見える**。
        owner: row.owner || 'lora-manager',
        origin: { kind: 'library', url: null, filename: null, subfolder: null },
        // 参照画像は id でしか引けない（パスを画面へ渡さない）。
        previewUrl: row.preview ? `/unbake/record-preview?id=${encodeURIComponent(row.id)}` : null,
        hasGraph: Boolean(row.has_graph),
        // **API グラフと UI グラフは別の列。** 両方持つ記録が36件あり、
        // OR で潰すと「画面へそのまま開ける36件」が見分けられないまま残る。
        hasUiGraph: Boolean(row.has_ui_graph),

        // --- 要約が既に持っていたのに、ここで落としていた3つ ----------------
        baseModel: row.base_model || null,
        // **記録が持っていた値か、こちらが手元のモデルから補った値か。**
        // 補った分は札の吹き出しでそう言う——同じ見た目で出しておいて、
        // 出どころを黙っていると「記録に書いてある」と読まれる。
        baseModelSource: row.base_model_source || null,
        loraCount: Number(row.lora_count) || 0,
        modified: row.modified ?? null,

        // --- 利用者が既に払った手作業（決定: 出すだけ・判定しない）-----------
        favorite: Boolean(row.favorite),
        license: row.license || null,
        commercialOk: row.commercial_ok || null,
        licenseSourceUrl: row.license_source_url || null,
        // **判定日は必ず連れて歩く。** 商用可否だけを出すと、読んだ人は
        // 「今の分類」だと思う。実データは345件すべて 2026-08-14 の一度きり。
        licenseCheckedAt: row.license_checked_at || null,
        // **未格付けは null のまま。** 0（安全と判定された）へ丸めない。
        nsfwLevel: row.preview_nsfw_level ?? null,
    };
}

/**
 * 起動時に書庫を読む。**届かなかったことを「0件」と混ぜない。**
 *
 * @param {object} [options]
 * @param {boolean} [options.rescan] ディスクを見直してから読むか。
 *   保存した直後がこれ——**書いたばかりの記録は、走査し直さないと索引に無い。**
 * @returns {Promise<{records: object[], messages: string[]}>}
 */
export async function loadLibrary(options = {}) {
    // **`= {}` は `undefined` しか埋めない。** `null` を渡されると分解で落ちる。
    const rescan = Boolean(options?.rescan);
    const messages = [];
    const rows = [];
    let total = 0;
    let sourceDirs = [];

    // **`total` と手元の件数を突き合わせる。** 元は1回だけ取って、
    // 返ってきた分をそのまま全件として扱っていた。口の上限は1回 1,000件なので、
    // **1,001件目からは無言で消える**——利用者から見ると「入れたのに出てこない」で、
    // 壊れているようには見えないので原因を探しようがない。
    //
    // 手元の実データは346件なので、この経路は今の環境では1周で終わる。
    // **「今は当たらない」は「壊れていない」ではない。**
    const PAGE = 500;
    const MAX_PAGES = 40; // 20,000件（走査側の上限 MAX_FILES と同じ）
    for (let page = 0; page < MAX_PAGES; page += 1) {
        // **走査し直すのは1周目だけ。** 2周目以降も頼むと、ページを繰るたびに
        // 索引が作り直されて**並びがずれ、同じ記録を2度読む/1度も読まない**。
        const result = await listLibraryRecords({
            offset: rows.length, limit: PAGE, rescan: rescan && page === 0,
        });
        if (!result.reachable) {
            // Python 側の口が登録できていない。**黙って空の一覧を出さない。**
            messages.push(t('list.routesUnreachable'));
            return { records: [], messages };
        }
        if (page === 0) {
            sourceDirs = result.sourceDirs || [];
            for (const error of result.errors || []) {
                messages.push(t('list.scanError', { detail: error }));
            }
        }
        total = result.total || 0;
        const batch = result.records || [];
        rows.push(...batch);
        // 1件も返らないのに足りていない＝口の側が進まない。**回り続けない。**
        if (batch.length === 0 || rows.length >= total) break;
    }

    if (rows.length < total) {
        // **足りないことを言う。** 黙って切ると、件数だけが静かに縮む。
        messages.push(t('list.partial', { shown: rows.length, total }));
    }
    if (total === 0 && sourceDirs.length === 0) {
        // 設定していないだけ。**「壊れている」と読ませない。**
        messages.push(t('list.noSourceDir'));
    }
    return { records: rows.map(libraryRowToRecord), messages };
}

/**
 * 記録1件ぶんの `SweepRunner` を作る。
 *
 * **判定材料を持っているのはホストだけ。** `/object_info` と埋め込み一覧は
 * `web/host/` が取るので、面はこれを呼ぶだけで材料の出どころを知らない。
 *
 * **同期で作る。** 面はボタンを押した瞬間に器を差し替える必要があり、
 * ここで待つと「押したのに何も起きない」時間ができる。材料は `preflight()` の
 * 時点で要るので、**取得は runner の中で待たせずに済むよう先に暖めておく**。
 */
/** 種別ごとの出どころ。**`/object_info` のどこを見るか。** */
const INSTALLED_SOURCES = {
    checkpoints: ['CheckpointLoaderSimple', 'ckpt_name'],
    loras: ['LoraLoader', 'lora_name'],
};

/** 一度取った `/object_info` を使い回す（行ごとに呼ばれるので毎回は取らない）。 */
let installedInputs = null;

/**
 * 手元に在るモデルの名前を種別で返す。
 *
 * **`/object_info` が唯一の真実源。** ここが配る名前は
 * `Illustrious\anime\x.safetensors` のような**完全な相対名**で、投入も
 * この形でしか通らない——ディスクを自分で歩いて素の名前を並べると、
 * 選んだ瞬間に「そんなモデルは無い」で落ちる。
 *
 * **取れなければ空を返す。** 差し替えの口が出ないだけで済ませる
 * ——推測で名前を並べると、選ばせてから落とすことになる。
 */
export async function listInstalledModels(kind) {
    const source = INSTALLED_SOURCES[kind];
    if (!source) return [];
    try {
        installedInputs = installedInputs || collectAnalysisInputs();
        const { objectInfo } = await installedInputs;
        return installedModelOptions(objectInfo, source[0], source[1]);
    } catch {
        // **失敗を次回へ持ち越さない。** 起動直後の1回が落ちたときに
        // 掴んだままにすると、拒否済みの約束をずっと返し続ける。
        installedInputs = null;
        return [];
    }
}

export function makeSweepRunner(record, options = {}) {
    const runner = new SweepRunner({
        // **上限は画素で持つ。** 設定はメガピクセルで受けるので、ここで直す
        // ——2箇所で単位を変えると、どちらが正か毎回考えることになる。
        maxReplayPixels: Math.max(0, Number(options.maxReplayMegapixels) || 0) * 1_000_000,
        // 差した時点では未取得。**下で入れ替える。**
        objectInfo: null,
        embeddings: null,
        // **再利用索引はディスクを真実源にする。** 手元の入れ物には
        // 「このブラウザでこの Unbake が回した分」しか入らず、実測で3枚しか無かった。
        loadRecordOutputs: listRecordOutputs,
    });
    // 面が開くのと同時に取りに行く。人が軸を確かめている間に揃う。
    //
    // **届いた時刻を面へ知らせる。** 導入済みモデルから選ぶ軸
    // （checkpoint 差し替え・LoRA 差し替え）は `/object_info` が要るので、
    // 知らせないと**面は永久にその軸を出せない**——待って開けば
    // 「押したのに何も起きない」時間ができ、待たずに諦めれば軸が消える。
    runner.inputsReady = collectAnalysisInputs()
        .then(({ objectInfo, embeddings }) => {
            runner.objectInfo = objectInfo;
            runner.embeddings = embeddings;
            return { objectInfo, embeddings };
        })
        .catch((error) => {
            // 取れなければ `preflight()` が `objectInfo` 未設定として投げる。
            // **空で続けない**——全モデルが未導入に見えて誤った判定が静かに出る。
            throw error;
        });
    // 誰も待たなかったときに未処理の拒否を出さない（面は `.catch` を付けて待つ）。
    runner.inputsReady.catch(() => {});
    return runner;
}

/**
 * Sweep で出たセルを、記録として取り込み直す。
 *
 * **これが「捕捉 → Sweep → また捕捉」の輪を閉じる。** 落とし直すのと同じ経路
 * （`/api/view` を取って PNG のメタを読む）で戻せる。
 *
 * **焼かれ方は2つに分かれている。** 実行したグラフを書くのは **ComfyUI 自身**で、
 * PNG の `prompt` チャンクへ入る。`extra_pnginfo` へ Unbake が入れているのは
 * **Sweep の印だけ**（`sweepRunner.js` の `extra_pnginfo: { unbake_sweep: stamp }`）。
 * ここを「グラフも extra_pnginfo に焼かれる」と書いていたが**誤り**で、
 * そう信じると `extra_pnginfo` だけ読む実装を書いてグラフを取り落とす。
 */
export async function onCaptureSweepCell(cell) {
    const url = cell?.output?.url;
    if (!url) return { records: [], errors: [] };
    return ingest({
        route: DROP_ROUTES.COMFY_OUTPUT,
        url,
        filename: cell.output.filename || null,
        subfolder: cell.output.subfolder ?? null,
    });
}

/**
 * 出た絵から、**欄へ流し込める設定**を読み取る（`onCaptureSweepCell` の逆向き）。
 *
 * **記録は作らない。** ここで `ingest` を呼ぶと**書庫に1件増える**——
 * 「設定だけ戻したい」のに記録が増えるのは、押した人の意図と違う。
 * 取るのはバイト列だけで、読み方は `core/extractedParams.js` が1本で持つ。
 *
 * `url` しか持たない項目が来る（詳細の並びは `{url, label, kind}`）ので、
 * **`/api/view` を組み立て直さない**——並びを作った側が既に正しい URL を持っている。
 */
export async function onExtractOutputParams(item) {
    const url = item?.url || item?.output?.url;
    if (!url) return { ok: false, params: {}, reason: t('reason.noImage') };
    try {
        const bytes = await fetchOutputImage(url);
        return extractParamsFromBytes(bytes, { kind: 'comfy_output', url });
    } catch (error) {
        return {
            ok: false, params: {},
            reason: t('reason.fetchFailed', { detail: error?.message || String(error) }),
        };
    }
}

/**
 * 落とされたものを **Generation Record** へ変える。
 *
 * **3経路のうち2つはここで完結する。** ComfyUI の出力もローカルの画像も、
 * 実体は PNG のバイト列で、実行したグラフがそこに埋まっている——**捕捉**であって
 * 再現ではないので、取り直しも組み直しも要らない。
 *
 * **Civitai だけは別物。** 来るのは URL だけでバイト列は来ないので、
 * ID から API で取り直して**再構成**する必要がある。その変換器は別リポジトリ
 * （`civitai-recipe-sync`・MIT）に1枚単位で在り、**まだ配線していない。**
 * ここで黙って空を返さず、何が要るかを言葉で返す。
 *
 * @param {object} routed `routeDrop()` の結果
 * @returns {Promise<{records: object[], errors: string[]}>}
 */
/** 記録に添える絵の上限。**サーバ側と同じ値**（32MiB）。 */
export const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

/**
 * バイト列を `data:` へ。**大きすぎるものは添えない**（`null` を返す）。
 *
 * **一気に文字へ直さない。** `String.fromCharCode(...bytes)` は引数を
 * 全部積むので、数MBで呼び出しの上限を越えて落ちる。塊で回す。
 */
export function toDataUrl(bytes, type = 'image/png') {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!view.length || view.length > MAX_PREVIEW_BYTES) return null;
    let binary = '';
    const CHUNK = 0x8000;
    for (let at = 0; at < view.length; at += CHUNK) {
        binary += String.fromCharCode(...view.subarray(at, at + CHUNK));
    }
    const encode = globalThis.btoa;
    if (typeof encode !== 'function') return null;
    return `data:${type};base64,${encode(binary)}`;
}

/** 拡張子から名乗る型。**サーバは名乗りを見ない**（中身で決める）。 */
function mimeOf(filename) {
    const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    return 'image/png';
}

/** 外部への問い合わせを、一度に流す本数。**相手の上限はこちらでは決められない。** */
const CIVITAI_CONCURRENCY = 3;

/**
 * 本数を絞って回す。**並びは入力どおりに返す。**
 *
 * `Promise.all` は数だけ同時に投げる。手元の実測では版IDが最大12あり、
 * 1枚取り込むたびに12本が同時に飛んでいた。
 */
export async function mapWithLimit(items, limit, run) {
    const list = [...items];
    const out = new Array(list.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const index = next;
            next += 1;
            if (index >= list.length) return;
            out[index] = await run(list[index], index);
        }
    };
    const width = Math.max(1, Math.min(limit, list.length));
    await Promise.all(Array.from({ length: width }, worker));
    return out;
}

export async function ingest(routed) {
    const records = [];
    const errors = [];
    /** 判定材料は1回だけ取る（`routed` 1件のうちで使い回す）。 */
    let civitaiInputs = null;
    /** 組み立ての材料も1回だけ（`/object_info` は実測 200KB 超）。 */
    let buildInputs = null;

    /**
     * 版 ID を**本当のファイル名と SHA256** へ解決する。
     *
     * **プロンプトの表記は手元のファイル名ではない**（実測: `<lora:ZodaPlus:1>`
     * の実体は `zodaplus_v1_anima.safetensors`）。名前で探すと在るのに
     * 見つからないので、版 ID で引き直してから組む。
     *
     * **引けなくても止まらない。** 外への問い合わせなので、鍵が無い・
     * 版が消えた・繋がらないが普通に起こる——そのときは名前だけの記録として
     * 今までどおり進み、**引けなかった件数だけを言葉で出す**。
     */
    async function resolveCivitaiResources(record, label) {
        const resources = record?.recipe?.civitai_resources;
        if (!Array.isArray(resources) || !resources.length) return record;
        const ids = [...new Set(resources
            .map(item => Number(item?.modelVersionId))
            .filter(id => Number.isFinite(id) && id > 0))];
        if (!ids.length) return record;

        // **一度に流す本数を絞る**（2026-08-24 利用者の指示）。
        // 版IDの数だけ同時に投げていた——実測で中央値5・最大12。
        // 外への問い合わせなので、**相手の上限へ近づく速さ**をこちらで決める。
        const resolved = await mapWithLimit(ids, CIVITAI_CONCURRENCY, async (id) => {
            try {
                const response = await fetch(`/unbake/civitai-version?id=${encodeURIComponent(id)}`);
                if (!response.ok) return null;
                const body = await response.json();
                if (body?.code === 'rate_limited') {
                    // **上限に当たったことは言う。** 黙ると「版が消えた」と読まれる。
                    errors.push(`${label}: ${body.error}`);
                    return null;
                }
                return body?.ok ? { ...body, versionId: id } : null;
            } catch {
                // **1件の失敗で全部を止めない。** 引けた分だけでも記録は良くなる。
                return null;
            }
        });

        const applied = applyResolvedResources(record.recipe, resolved.filter(Boolean));
        if (applied.unresolved) {
            // **黙って落とさない。** 出さないと「全部そろった」と読まれる。
            errors.push(`${label}: ${t('reason.civitaiUnresolved', { count: applied.unresolved })}`);
        }
        if (!applied.replaced && !applied.added) return record;
        return { ...record, recipe: applied.recipe };
    }

    /**
     * グラフの無い記録を組む。**落ちても記録は残す**——組めないことと、
     * 読めないことは別で、項目が埋まっている記録は読む価値がある。
     *
     * A1111 の画像とレシピの書き出しで**同じ関数を通す**。分けると、片方だけ直った
     * 状態が生まれる（実際に画像側だけ組み立てを持っていなかった）。
     */
    async function buildIfNeeded(inputRecord, label) {
        if (!inputRecord?.needsBuild || !inputRecord.recipe) return inputRecord;
        // **組む前に名前を確かめる。** 組んでから直すと、組み立ての判断
        // （その名前が手元に在るか）が古い名前のまま行われる。
        const record = await resolveCivitaiResources(inputRecord, label);
        try {
            if (!buildInputs) buildInputs = await collectAnalysisInputs();
            return attachBuiltWorkflow(record, buildRecipeWorkflow(record.recipe, {
                objectInfo: buildInputs.objectInfo,
                embeddings: buildInputs.embeddings,
            }));
        } catch (error) {
            // **握り潰さない。** 中核が返すのは判断であって障害ではない。
            const marked = markUnbuildable(record, error);
            errors.push(`${label}: ${marked.blockedReason}`);
            return marked;
        }
    }

    if (routed?.route === DROP_ROUTES.COMFY_OUTPUT) {
        try {
            const bytes = await fetchOutputImage(routed.url);
            const built = buildGenerationRecord(bytes, {
                kind: 'comfy_output',
                url: routed.url,
                filename: routed.filename,
                subfolder: routed.subfolder,
            });
            if (built.ok) {
                // 出力も同じ。**URL は ComfyUI の中でしか通らない**ので、
                // サーバへ渡しても取りに行けない（バイト列で渡す）。
                const data = toDataUrl(new Uint8Array(bytes), mimeOf(routed.filename));
                const record = data
                    ? { ...built.record, previewData: data, previewUrl: data }
                    : built.record;
                if (!data) errors.push(`${routed.filename}: ${t('reason.previewTooLarge')}`);
                records.push(await buildIfNeeded(record, routed.filename));
            }
            else errors.push(`${routed.filename}: ${reasonText(built.reason)}`);
        } catch (error) {
            errors.push(`${routed.filename}: ${t('reason.fetchFailed', { detail: error?.message || error })}`);
        }
        return { records, errors };
    }

    if (routed?.route === DROP_ROUTES.LOCAL_FILE) {
        for (const file of routed.files || []) {
            try {
                const bytes = await file.arrayBuffer();
                const built = buildGenerationRecord(bytes, {
                    kind: 'local_file',
                    filename: file.name,
                });
                if (built.ok) {
                    // **絵を添える。** 落とし込んだファイルはここでしか残せない
                    // ——保存の時点では `File` はもう手元に無い（2026-08-23）。
                    const data = toDataUrl(new Uint8Array(bytes), mimeOf(file.name));
                    const record = data
                        // 保存する前から一覧に出す（読み直しで本物の口に入れ替わる）。
                        ? { ...built.record, previewData: data, previewUrl: data }
                        : built.record;
                    if (!data) errors.push(`${file.name}: ${t('reason.previewTooLarge')}`);
                    records.push(await buildIfNeeded(record, file.name));
                }
                else errors.push(`${file.name}: ${reasonText(built.reason)}`);
            } catch (error) {
                errors.push(`${file.name}: ${t('reason.readFailed', { detail: error?.message || error })}`);
            }
        }
        return { records, errors };
    }

    if (routed?.route === DROP_ROUTES.RECIPE_FILE) {
        // 実測で、レシピ346件のうちグラフを持っているのは48件（14%）だけ
        // ——残りは組む必要がある。**画像の側も同じ関数を通す**（2026-08-23）:
        // A1111 の書式で書かれた画像は、レシピと同じだけの材料を持っている。
        for (const file of routed.files || []) {
            let recipe;
            try {
                recipe = JSON.parse(await file.text());
            } catch (error) {
                errors.push(`${file.name}: ${t('reason.unreadableRecipe', { detail: error?.message || error })}`);
                continue;
            }
            const built = buildRecordFromRecipe(recipe, { kind: 'recipe_file', filename: file.name });
            if (!built.ok) { errors.push(`${file.name}: ${reasonText(built.reason)}`); continue; }
            records.push(await buildIfNeeded(built.record, file.name));
        }
        return { records, errors };
    }

    if (routed?.route === DROP_ROUTES.CIVITAI) {
        // **ここだけバイト列が来ない。** ID から取り直して組み直す。
        //
        // 鍵は無くても引ける（実測で30件中29件）。設定に在れば載せるだけ。
        let apiKey = '';
        try {
            const { settings } = await readUnbakeSettings();
            // **秘密の値は画面へ返らない**（`{set, length}` になる）ので、
            // ここで取れるのは「在るかどうか」だけ。実際の付与はサーバを通す
            // 経路が要る——今は鍵なしで引ける範囲だけを配線してある。
            if (settings?.civitai_api_key?.set) apiKey = '';
        } catch {
            // 設定が読めなくても引けるので続ける。
        }

        const fetched = await fetchCivitaiImage(routed.imageId, {
            domain: routed.domain, apiKey,
        });
        if (!fetched.ok) {
            errors.push(t('reason.civitaiFetchFailed', {
                id: routed.imageId, detail: fetched.reason,
            }));
            return { records, errors };
        }
        // **グラフが在れば、捕捉と同じ経路で読む。** ComfyUI で作られた絵だけ。
        const captured = recordFromCivitaiImage(fetched.item, fetched.meta, {
            url: routed.url, domain: routed.domain,
        });
        if (captured.ok) { records.push(captured.record); return { records, errors }; }

        // **大半はグラフを持っていない。** 実測（画像30件）で `comfy` を持つのは
        // **2件（6.9%）**だけで、残りは A1111 形式の平たい値だった。
        // グラフがある前提で書くと**93%が組めない**（最初の版が実際に0件だった）。
        // こちらは書庫の記録と同じ形へ落として、既存の組み立てへ渡す。
        const versionIds = [
            ...new Set((fetched.meta?.civitaiResources || [])
                .map(resource => resource?.modelVersionId)
                .filter(value => value !== null && value !== undefined)),
        ];
        const versions = new Map();
        for (const versionId of versionIds) {
            const found = await fetchModelVersion(versionId, { domain: routed.domain, apiKey });
            if (found.ok) versions.set(String(versionId), found.version);
        }
        const recipe = recipeFromCivitaiMeta(fetched.item, fetched.meta, versions);
        const fromRecipe = buildRecordFromRecipe(recipe, {
            kind: 'civitai',
            url: routed.url || `https://civitai.com/images/${routed.imageId}`,
        });
        if (!fromRecipe.ok) { errors.push(reasonText(fromRecipe.reason)); return { records, errors }; }

        let record = fromRecipe.record;
        if (record.needsBuild) {
            if (!civitaiInputs) civitaiInputs = await collectAnalysisInputs();
            try {
                record = attachBuiltWorkflow(record, buildRecipeWorkflow(recipe, {
                    objectInfo: civitaiInputs.objectInfo,
                    embeddings: civitaiInputs.embeddings,
                }));
            } catch (error) {
                // **握り潰さない。** 組めないことも答えである。
                record = markUnbuildable(record, error);
                errors.push(record.blockedReason);
            }
        }
        records.push(record);
        return { records, errors };
    }

    return { records, errors };
}

/**
 * 失敗の理由を、読んだ人が次に何をすればよいか分かる言葉にする。
 * **文言は持たず鍵へ写す**——言語を足すたびにここを触らないため。
 */
function reasonText(reason) {
    const CODES = {
        'not-png': 'reason.notPng',
        'no-metadata': 'reason.noMetadata',
        'compressed-metadata': 'reason.compressedMetadata',
        truncated: 'reason.truncated',
        'not-a-recipe': 'reason.notARecipe',
    };
    const code = CODES[reason];
    return code ? t(code) : t('reason.unknown', { reason: String(reason ?? '') });
}

/**
 * 宿主が使っている言語。ComfyUI の設定 `Comfy.Locale` を読む
 * （実測 2026-08-20: 手元の2インスタンスで別々の値が入っていた）。
 *
 * **読めなければ既定（英語）へ落とす。** ブラウザの言語は見ない——
 * ComfyUI を英語で使っている日本語話者は珍しくなく、そこで食い違うと
 * 「アプリは英語なのにこのパネルだけ日本語」になる。**宿主に合わせるのが筋。**
 *
 * @returns {string|null}
 */
export function readHostLocale(app) {
    try {
        return app?.ui?.settings?.getSettingValue?.('Comfy.Locale') ?? null;
    } catch {
        return null;
    }
}

/**
 * 宿主の `app` を探す。**見つからなければ理由つきで null を返す。**
 *
 * 1. `/scripts/app.js` — ComfyUI が拡張向けに公開している shim。**これが正規の経路。**
 * 2. `window.comfyAPI.app.app` — 上の shim が読んでいる実体。shim が消えたときの受け皿。
 *
 * @returns {Promise<object|null>}
 */
export async function resolveComfyApp() {
    try {
        const module = await import('../../scripts/app.js');
        if (module?.app) return module.app;
    } catch {
        // shim が無い環境（Node のテストなど）。下の実体を見る。
    }
    return globalThis.comfyAPI?.app?.app ?? null;
}

/**
 * 自動起動が返したもの。ブラウザ以外では `null` のまま。
 * **検査だけが読む口**——画面の挙動はここに依存しない。
 * @type {{openFullscreen: () => object, whenLibraryReady: () => Promise<object>}|null}
 */
export let autostarted = null;

// --- 実機での起動 ---------------------------------------------------------
// ブラウザで読まれたときだけ走る。**見つからなければ黙らない。**
if (typeof globalThis.document !== 'undefined' && !globalThis.__UNBAKE_NO_AUTOSTART__) {
    const app = await resolveComfyApp();
    if (app) {
        // **返り値を捨てない。** 捨てると、検査は「記録が届いた」時刻を知る手段を
        // 失い、空のまま比べて通る（それが実際に起きていた）。
        autostarted = registerUnbake(app);
    } else {
        // 静かに何も出ないのが最悪の落ち方なので、必ず理由を残す。
        console.error(t('host.notFound'));
    }
}
