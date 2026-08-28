/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
/**
 * ビルダーの警告を「危うさ」で3段階に分ける。
 *
 * **なぜ件数では採点にならないか。**
 * 実測（2026-08-10 / 全316レシピをビルド）: 何らかの警告を持つのは
 * **312件（98.7%）**、1レシピあたりの種類数の中央値は2。ほぼ全件が該当するので、
 * 警告の有無や件数では差がつかない。
 *
 * 種類別に見ると、性質がまるで違うものが同じ「警告」に入っていた:
 *
 *   291件 プロンプトの強調記法をA1111互換パーサで解釈    ← **忠実度を上げている**
 *    89件 必須LoRAを保存レシピの素材へ対応付けできない    ← 危険
 *    52件 入力画像が手元に無い                          ← 危険
 *    39件 ADetailerの再描画段を復元                     ← 忠実度を上げている
 *
 * つまり**警告は「やったこと」であって「危うさ」ではない**。混ぜたまま数えると、
 * 忠実度を上げた処理まで減点することになる。
 *
 * **未知の警告は risk 側に置く。**
 * 分類表に無い文を neutral にすると、新しく増えた警告が黙って合格する。
 * 検査器の沈黙は合格に見えるので、`unknown` として別に数え、点数上は危険と同じ扱いにする。
 *
 * **上の内訳は再現できる。** `npm run audit:replay` が同じ判定器を呼んで
 * 種類別に数える（`scripts/replay_audit.mjs`）。この文書の数字は 316レシピ時点の
 * 手作業の実測で、母数が変わると当然ずれる ——ずれていたら台帳ではなく実測を正とする。
 * 実際、2026-08-10 の再実測（346レシピ）では上の「89件 必須LoRA」は **0件**だった
 * （ライブラリの全件が `replay_manifest` を持たず、監査が素通りしていたため）。
 */

import { CATALOGS } from '../i18n/index.js';

export const SEVERITY = Object.freeze({
    IMPROVEMENT: 'improvement',
    NEUTRAL: 'neutral',
    RISK: 'risk',
    UNKNOWN: 'unknown',
});

/**
 * 上から順に当てる。**危険を先に置く**のは、改善の言い回しを含みつつ実際には
 * 何かを落としている文（例: 再描画段を復元したが検出モデルが無い分は省略）を
 * 取りこぼさないため。
 */
const RULES = [
    // --- 危険: 記録が欠けている / 置換した / 推定した -----------------------
    [SEVERITY.RISK, /検出モデル[^。]*(無い|ありません|手元に)/],
    [SEVERITY.RISK, /A1111固有情報/],
    [SEVERITY.RISK, /必須LoRA|再現manifestを確定できない|マニフェストに必須LoRAの記載がありません/],
    [SEVERITY.RISK, /入力画像[^。]*(残っていない|手元に無い|URLのみ)/],
    [SEVERITY.RISK, /拡大して描き直した記録|描き直した記録/],
    [SEVERITY.RISK, /記録がないため[^。]*推定|比率[^。]*推定しました/],
    [SEVERITY.RISK, /解決できませんでした/],
    [SEVERITY.RISK, /既定で埋めたもの|そのまま重ねると絵が破綻/],
    [SEVERITY.RISK, /不足ノード/],
    [SEVERITY.RISK, /完全なワークフローがないため|標準構成へ再構築|標準のtxt2img構成から再構築/],
    [SEVERITY.RISK, /スケジューラの記録がないため/],
    [SEVERITY.RISK, /LoRAを適用するノードがありません/],

    // `省略しました` の行は置かない。実測58種のうち該当する文は
    // 「検出モデルが無い…省略しました」だけで、上の検出モデル規則が必ず先に当たる。
    // 変異検査でも生き残った（＝どのテストも通らない死んだ行）ので消してある。
    // 未知の文は unknown として risk 側に数えるので、取りこぼしにはならない。

    // --- 危険: 2026-08-10 の `npm run audit:replay` で unknown だった18種 -----
    // 表に無いだけで危険ではあったので、点数は変わらない。分類表へ入れる意味は
    // **これ以降に増えた警告が unknown として目立つようにする**こと。
    // 18種176件が unknown のまま埋もれていると、新種が1件混ざっても気づけない。
    [SEVERITY.RISK, /生成サイズの記録/],
    [SEVERITY.RISK, /描画内容の記述がありません|単色の画像になる/],
    [SEVERITY.RISK, /未導入モデル[:：]/],
    [SEVERITY.RISK, /埋め込み（効果は反映されません）/],
    [SEVERITY.RISK, /未導入のLoRA[^。]*外して再現/],
    [SEVERITY.RISK, /再現に必要なチェックポイント情報がありません/],
    [SEVERITY.RISK, /未導入または破損した/],
    [SEVERITY.RISK, /配布終了または取得不能/],
    [SEVERITY.RISK, /プロンプト／生成パラメータがなく/],
    [SEVERITY.RISK, /チェックポイントSHAと導入済みモデルが一致しません/],
    [SEVERITY.RISK, /がレシピに保存されていません/],
    // 壊れた構成を直してはいるが、元グラフを捨てて標準構成へ組み直している。
    // 他の「標準…へ再構築」と同じ危うさなので同じ側へ置く。
    [SEVERITY.RISK, /標準Flux構成へ再構築/],
    // 記録された強調解釈（Emphasis: Original）を**当てられずに現行方式で代替**している。
    // smZNodes の旧実装がこの版で必ず実行時に落ちるためだが、記録どおりでない以上
    // 危険側。上の「CLIP Skip を当てない」判断（改善）とは別物で、あちらは
    // 「対応する構造が無いものを当てない」＝当てる方が壊れる。こちらは
    // 「当てたいが実装が壊れていて当てられない」＝落ちている情報がある。
    [SEVERITY.RISK, /旧方式の強調解釈/],
    // ADetailer の段専用プロンプトに書かれた LoRA を**当てられずに落としている**。
    // 記録には在るのに再現へ乗らないので、上の「旧方式の強調解釈」と同じ形の危険側。
    // **分類表に無いと `UNKNOWN` として risk に数えられる**ので件数は変わらないが、
    // 「未分類」に溜まったままだと**新しく生えた警告に気づけなくなる**（2026-08-11 に
    // 未分類が57件溜まっていたのを `d9b21e63` で解消した直後、`98e274b0` が足した
    // この文言がまた未分類へ入っていた。実測8件・2026-08-12）。
    // **分類は生の文言に当てる。** 集計側が括弧書きを畳んだ後の文字列に合わせると
    // 当たらない（実測: `LoRA指定があります` で書いたら、実物は
    // `LoRA指定（kaelakovalskia20IllustriousXL / …）がありますが` で1件も当たらなかった）。
    [SEVERITY.RISK, /段専用プロンプトにLoRA指定/],

    // --- 改善: 失われた情報を戻した / 元と同じ適用式にした -------------------
    // **UNet単体で配られる系統の構成復元は改善である。** ここが表に無かったため、
    // 2026-08-10 に追加した8系統（Flux.1/Flux.2/Qwen-Image/HiDream/Chroma/
    // Z-Image/Krea 2/Anima）の説明文が unknown → risk に化けており、
    // **忠実度を上げた処理が自分のスコアを下げていた**（実測14件）。
    // この構成を組まなければレシピは読み込みすら通らない。
    // **タイル分割の復号は、再現の質を落としていない。**
    // グラフは記録どおりで、これは「この形は環境によって止まる」という
    // 運用上の注意にすぎない。分類表へ入れないと `unknown` として
    // 危険と同じ点数で数えられ、**再現性の判定が理由もなく下がる**
    // （2026-08-25 実機: `civitai_137676446` が高から落ちていた）。
    [SEVERITY.NEUTRAL, /タイル分割へ切り替え|switched to tiles|元からタイル分割|already decodes in tiles|素通し|passed straight through/],
    // **縮めたのは事実だが、記録が欠けているわけではない。** 危険側へ入れると
    // 「出せるようにした」ことで判定が下がる、という逆さまな形になる。
    [SEVERITY.NEUTRAL, /比率を保って[^。]*まで縮めました|reduced to .* keeping the aspect ratio/],
    // **運搬ノードを開くのは、絵を変えない置き換え。** 順番も強さも同じで、
    // 節の形が違うだけ。ここが表に無かったので `unknown`＝危険と同じ点数になり、
    // **開いた記録の判定だけが理由もなく下がっていた**（2026-08-25 実測）。
    [SEVERITY.NEUTRAL, /標準のノードの連なりへ開きました|rebuilt as a chain of standard loaders/],
    /*
     * **埋め込みグラフの寸法を残した件は改善**（2026-08-28 実機 `civitai_140604778`）。
     *
     * 記録の `size` は出力についての申告で、埋め込みグラフは**実際に走った設定**。
     * 食い違ったときにグラフを残すのは、落ちている情報を戻す側である。
     * 実測: 参照画像の実寸 832x1216 ＝ グラフ 832x1216 ≠ 記録 1024x1024。
     *
     * **分類表へ入れ忘れると、直した本人の判定が下がる。** この1件がまさに
     * それで、利用者から「**全く同じ絵が出たのに再現性・中**」と報告された
     *（`unknown` は risk と同じ点数で数えられる）。
     */
    // **数字に依存させない。** 寸法を含む形にすると、差し込み口が数字でない
    // 呼ばれ方（検査・別経路）で当たらなくなる。語で当てる。
    [SEVERITY.IMPROVEMENT, /グラフの方を使いました|The graph was used/],
    [SEVERITY.IMPROVEMENT, /UNet単体で配られるモデル/],
    // 記録された CLIP Skip を**適用しない**判断は、忠実度を上げる側。
    // 掛けると Qwen3・T5 系のエンコーダで条件付けが壊れ、絵が別物になるか単色に潰れる
    // （実測3件・3件ともユーザーが劣化を報告）。記録の取りこぼしではなく、
    // 対応する構造が無いものを当てないという判断。
    [SEVERITY.IMPROVEMENT, /CLIP Skip [0-9]+ は、この系統のテキストエンコーダ/],
    // **対象ごとの上書き（`replay_overrides`）で再現した件は改善である。**
    // 一律規則は立たなかった（smZなし: 改善10/退行17・正規化なし: 改善7/6）ので、
    // 人間が目視した件だけをレシピへ保存して当てている（改善12 / 差なし3 / 退行0）。
    // **3度目の同じ失敗**——`UNet単体で配られるモデル`（2026-08-10・14件）、
    // `乱数源`ほか4種（2026-08-11・57件）に続き、この文言が 2026-08-14 の
    // `npm run audit:replay` で「未分類 6件」として溜まっていた。`riskCount` は
    // unknown を risk として数えるので、**忠実度を上げた処理が自分のスコアを下げる**。
    //
    // **この規則は下の `A1111互換パーサ` より前に置く。** `nosmz` 側の文言は
    // 「A1111互換パーサ（smZ）を**使わずに**再現します」で、当てている件と当てていない件が
    // 同じ規則に当たっていた。結果の段階は同じ improvement だが、**逆の処理が同じ理由で
    // 分類される**状態なので、片方の規則を直すともう片方が黙って動く。
    [SEVERITY.IMPROVEMENT, /実測にもとづき[^。]*再現します/],
    [SEVERITY.IMPROVEMENT, /A1111互換パーサ|元画像と同じ適用式/],
    // **記録された（または由来から読んだ）乱数源で再現するのは改善である。**
    // ComfyUI は初期潜在ノイズを CPU 固定で引くが、A1111/Forge の既定は GPU で、
    // 既定と違うときだけ記録へ書く。当てないと同じ seed でも初期ノイズが別物になる。
    // 2026-08-11 の目視（触る72件）で 改善32 / 差なし25 / 退行1。
    //
    // **同じ失敗を同じファイルで2度やっている。** 上の「UNet単体で配られるモデル」も
    // 表に無くて unknown → risk に化けていた。`riskCount` は unknown を risk として
    // 数えるので、**忠実度を上げた処理が自分のスコアを下げる**。
    // 実測 2026-08-11: `npm run audit:replay` の「未分類の警告」に4種（57件）が溜まった。
    [SEVERITY.IMPROVEMENT, /乱数源/],
    [SEVERITY.IMPROVEMENT, /ComfyUIが読み込める形へ直しました/],
    [SEVERITY.IMPROVEMENT, /再描画段[^。]*復元しました/],
    [SEVERITY.IMPROVEMENT, /CLIP側強度を復元しました/],
    [SEVERITY.IMPROVEMENT, /縦横逆だったため/],
    [SEVERITY.IMPROVEMENT, /曖昧なVAE指定を検出/],

    // --- 中立: 忠実度に影響しない ------------------------------------------
    [SEVERITY.NEUTRAL, /1段目のlatentへは適用しませんでした|元の段組みを保ちます/],
    [SEVERITY.NEUTRAL, /SaveImage へ替えました|ディスクに残らない/],
    [SEVERITY.NEUTRAL, /旧式の定数ノード/],
    [SEVERITY.NEUTRAL, /単一バッチへ最適化/],
];

/**
 * **鍵で決める分類**（2026-08-28・利用者の指示で言語差を塞いだ）。
 *
 * 分類表（`RULES`）は日本語の言い回しへ当てていた。実測すると:
 *
 *     ja  未分類 21 / 56 種
 *     en  未分類 54 / 56 種
 *
 * 未分類は `riskCount` で危険として数えられるので、**英語で動かすとほぼ全ての
 * 警告が減点になる**——同じライブラリでも**画面の言語で判定が変わっていた**。
 * 既定は英語なので、公開版の利用者はこちらを踏む。
 *
 * 鍵は翻訳しても変わらないので、**鍵で決めれば言語に依らない**。
 * `RULES` は残す——鍵の判らない文（古い記録・別経路で作られた文）が来たときの
 * 受け皿で、そこでも当たらなければ従来どおり `unknown`（＝危険側）になる。
 *
 * **迷ったら危険側**（利用者の方針・2026-08-28）。改善に入れるのは
 * 「落ちた情報を戻した」「元と同じ適用式にした」と根拠が書けるものだけ。
 */
export const KEY_SEVERITY = Object.freeze({
    // --- 改善: 落ちた情報を戻した / 元と同じ適用式にした ---------------------
    'core.recipeWorkflowBuilder.12': SEVERITY.IMPROVEMENT,   // 縦横逆の記録を直した
    'core.recipeWorkflowBuilder.13': SEVERITY.IMPROVEMENT,   // 埋め込みを読める形へ
    'core.recipeWorkflowBuilder.20': SEVERITY.IMPROVEMENT,   // UNet単体系の構成復元
    'core.recipeWorkflowBuilder.25': SEVERITY.IMPROVEMENT,   // 実測にもとづく倍率
    'core.recipeWorkflowBuilder.31': SEVERITY.IMPROVEMENT,   // 当てると壊れる CLIP Skip を当てない
    'core.recipeWorkflowBuilder.39': SEVERITY.IMPROVEMENT,   // 曖昧なVAE指定を内蔵へ
    'core.recipeWorkflowBuilder.52': SEVERITY.IMPROVEMENT,   // 実測で smZ を使わない方が近い
    'core.recipeWorkflowBuilder.54': SEVERITY.IMPROVEMENT,   // 実測で平均正規化を外す
    'core.recipeWorkflowBuilder.56': SEVERITY.IMPROVEMENT,   // 元画像と同じ適用式（smZ）
    'core.recipeWorkflowBuilder.64': SEVERITY.IMPROVEMENT,   // ADetailer の段を復元
    'core.recipeWorkflowBuilder.71': SEVERITY.IMPROVEMENT,   // CLIP側強度を復元
    // **グラフと一覧が食い違ったらグラフ**。実際にその絵を出したのはグラフの側で、
    // `sizeFromGraph` と同じ形（強い証拠を弱い申告で上書きしない）。
    'core.recipeWorkflowBuilder.87': SEVERITY.IMPROVEMENT,
    'core.recipeWorkflowBuilder.sizeFromGraph': SEVERITY.IMPROVEMENT,

    // --- 中立: 絵が変わらない置き換え / 運用上の注意 -------------------------
    'core.recipeWorkflowBuilder.22': SEVERITY.NEUTRAL,       // 旧式の定数ノードを標準入力へ
    'core.recipeWorkflowBuilder.36': SEVERITY.NEUTRAL,       // 多段の1段目に最終寸法を当てない
    'core.recipeWorkflowBuilder.40': SEVERITY.NEUTRAL,       // Preview だけ → SaveImage
    'core.recipeWorkflowBuilder.69': SEVERITY.NEUTRAL,       // 単一バッチへ最適化（同じ系列）
    'core.recipeWorkflowBuilder.cappedSize': SEVERITY.NEUTRAL,  // 比率を保って縮めた
    // **出力の口を足しただけ**で、条件付けも潜在も触っていない（絵は変わらない）。
    'core.recipeWorkflowBuilder.50': SEVERITY.NEUTRAL,
    // **形が違うだけの置き換え。** 中身も効き方も同じだと本文が言っている。
    'core.recipeWorkflowBuilder.joinString': SEVERITY.NEUTRAL,
    'core.recipeWorkflowBuilder.powerLora': SEVERITY.NEUTRAL,
    // 入れる物の案内。**落ちている分は肩代わりの側（`.44`）が危険として数える**ので、
    // ここで二重に減点しない。
    'core.recipeWorkflowBuilder.packs': SEVERITY.NEUTRAL,

    // --- 危険: 記録が欠けている / 置換した / 推定した ------------------------
    'core.recipeWorkflowBuilder.3': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.16': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.32': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.37': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.49': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.55': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.63': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.68': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.70': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.72': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.73': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.74': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.75': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.76': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.77': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.78': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.79': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.80': SEVERITY.RISK,
    // ここから下は 2026-08-28 に新しく決めた分（それまで全部 `unknown`）。
    // **名前で同定できず台帳をそのまま使った**＝推定で当てている。
    'core.recipeWorkflowBuilder.11': SEVERITY.RISK,
    // **manifest に無い強度を台帳で補った**＝根拠の弱い値を使っている。
    'core.recipeWorkflowBuilder.6': SEVERITY.RISK,
    // 外部VAEが手元に無く内蔵で代用（本文が「彩度や色味が変わる」と言っている）。
    'core.recipeWorkflowBuilder.17': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.19': SEVERITY.RISK,
    // **同名とは限らない別のVAEを当てている。** 当たっていれば改善だが、
    // 同一である保証がここには無いので危険側へ置く（迷ったら危険側）。
    'core.recipeWorkflowBuilder.18': SEVERITY.RISK,
    // 拡大器を特定できず単純拡大（本文が「質感が変わる」と言っている）。
    'core.recipeWorkflowBuilder.21': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.upscalerMissing': SEVERITY.RISK,
    // 倍率・段構成を**推定**して組み替えている。
    'core.recipeWorkflowBuilder.26': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.28': SEVERITY.RISK,
    // **LoRA が1本も効かない構成**になっている。
    'core.recipeWorkflowBuilder.38': SEVERITY.RISK,
    // 未導入ノードの役割を核ノードで肩代わり＝**同じ効果の保証が無い**。
    'core.recipeWorkflowBuilder.44': SEVERITY.RISK,
    // BREAK を落とした／強調記法が標準解釈になった＝**元の解釈で出ていない**。
    'core.recipeWorkflowBuilder.51': SEVERITY.RISK,
    'core.recipeWorkflowBuilder.53': SEVERITY.RISK,
    // ADetailer の段を丸ごと省略した。
    'core.recipeWorkflowBuilder.62': SEVERITY.RISK,
    // 寸法の手がかりが無く既定で描く（本文が「縦横比が変わる」と言っている）。
    'core.recipeWorkflowBuilder.81': SEVERITY.RISK,
    // タグに出ない LoRA を外した（本文が「絵は元と変わります」と言っている）。
    'core.recipeWorkflowBuilder.86': SEVERITY.RISK,
});

/** `{p1}` のような差し込み口を「何でも」に替えた形。**鍵を引き当てるためだけ**に使う。 */
function templateToPattern(template) {
    const escaped = String(template).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped.replace(/\\\{[A-Za-z0-9_]+\\\}/g, '[\\s\\S]*?')}$`);
}

/**
 * 全言語ぶんの「この文はどの鍵から出たか」。**1度だけ組む。**
 *
 * 画面の言語に依らないよう、**12言語すべて**の型を持つ。鍵が判れば
 * `KEY_SEVERITY` を引くだけなので、訳文の言い回しに judgement を持たせない。
 */
let keyPatterns = null;

function keyOf(text) {
    if (keyPatterns === null) {
        keyPatterns = [];
        for (const catalog of Object.values(CATALOGS || {})) {
            for (const [key, template] of Object.entries(catalog || {})) {
                if (!(key in KEY_SEVERITY)) continue;
                if (typeof template !== 'string' || !template) continue;
                keyPatterns.push([templateToPattern(template), key]);
            }
        }
    }
    for (const [pattern, key] of keyPatterns) {
        if (pattern.test(text)) return key;
    }
    return null;
}

export function classifyWarning(message) {
    const text = String(message ?? '');
    if (!text.trim()) return SEVERITY.UNKNOWN;
    // **まず鍵で決める。** 訳文の言い回しに判断を持たせない。
    const key = keyOf(text);
    if (key) return KEY_SEVERITY[key];
    // 鍵が判らない文（古い記録・別経路で作られた文）は、従来の表で当てる。
    for (const [severity, pattern] of RULES) {
        if (pattern.test(text)) return severity;
    }
    return SEVERITY.UNKNOWN;
}

/**
 * 警告の集まりを、行動に使える形へ畳む。
 *
 * `riskCount` には **unknown も足す**。分類できていない警告を安全側に倒さないと、
 * 分類表を更新し忘れた分がそのまま「危険なし」として通る。
 */
export function summarizeWarnings(warnings) {
    const groups = {
        [SEVERITY.IMPROVEMENT]: [],
        [SEVERITY.NEUTRAL]: [],
        [SEVERITY.RISK]: [],
        [SEVERITY.UNKNOWN]: [],
    };
    for (const warning of Array.isArray(warnings) ? warnings : []) {
        groups[classifyWarning(warning)].push(String(warning));
    }
    return {
        improvement: groups[SEVERITY.IMPROVEMENT],
        neutral: groups[SEVERITY.NEUTRAL],
        risk: groups[SEVERITY.RISK],
        unknown: groups[SEVERITY.UNKNOWN],
        riskCount: groups[SEVERITY.RISK].length + groups[SEVERITY.UNKNOWN].length,
    };
}
