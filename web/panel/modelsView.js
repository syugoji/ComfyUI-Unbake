/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * この記録が使っているモデルを並べ、1つずつ消せるようにする面。
 *
 * ---
 *
 * **入口を記録の側に置く理由。** 「もう使わない記録」を消したあと、その記録のために
 * 落としたモデルが置き場に残り続ける。モデル一覧から探し直すには**どれがその記録の
 * ものだったか**を覚えていないといけない——記録の側から辿れれば覚えなくてよい。
 *
 * **消してよいかは件数で決まる。** 実測で1つの checkpoint を **39件**の記録が
 * 共有している（`hassakuXLIllustrious_v13StyleA`）。だからこの面は、
 * **消す前に必ず「他に何件が使っているか」を出す**。
 *
 * **数えていない範囲を隠さない。** 数えているのは書庫の記録だけで、手組みの
 * ワークフローも他の UI も見ていない。件数 0 は「安全」ではなく
 * 「**この数え方では 0**」でしかない。
 *
 * **名前が2つに当たったら消さない。** 実データに1件ある
 * （`DetailedEyes_V3` が置き場の直下とサブフォルダの両方に在る）。
 * 片方を選ぶ実装にすると、1件だけ静かに違うファイルが消える。
 *
 * ---
 *
 * **2026-08-22: 見るだけの面から、その場でいじれる面にした**（利用者の指示）。
 *
 * 元は「振る」の面で**軸**を宣言してから回す形だったが、やりたいことは
 * たいてい**1つの値を動かすこと**で、「軸」という言い方が間に挟まっていた。
 *
 * ---
 *
 * **2026-08-22: 見るだけの面から、その場でいじれる面にした**（利用者の指示）。
 *
 * 元は「振る」の面で*軸*を宣言してから回す形だったが、やりたいことは
 * たいてい**1つの値を動かすこと**で、「軸」という言い方が間に挟まっていた。
 * **LoRA の強度は、そのモデルの行で動かす。**
 *
 * **値はここで持たない。** 記録ごとの上書きレイヤ（`recipeLoraOverrides`）が
 * 持っていて、そちらは版 ID で鍵を作り、`user_override` を立てて
 * `capUnrecordedLoraStrengths` の自動抑制から外す——手で指した値は
 * 「既定で埋めた値」ではないので、勝手に縮めない。
 *
 * **記録そのものは書き換えない。** 記録の `strength` は元画像に付いていた値で、
 * ここが基準点になる。書き換えると、見比べる基準が回を追うごとに動く。
 */

import { t } from '../i18n/index.js';
import { sizeText } from './confirmView.js';
import { loraTargetIdentity } from '../core/sweepAxes.js';

/**
 * 役割の名札。**鍵を組み立てない**——`t(`models.role.${role}`)` の形で書くと、
 * 鍵の走査に1つも映らず、訳の足し忘れが「画面に `[models.role.lora]` が出る」まで
 * 気づけない（同じ形で12個まとめて足し忘れた実績がある）。
 */
function roleText(role) {
    if (role === 'checkpoint') return t('models.role.checkpoint');
    if (role === 'lora') return t('models.role.lora');
    return t('models.role.other');
}

function makeElement(documentRef, tag, attributes = {}, children = []) {
    const node = documentRef.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
}

/** 本体の拡張子。**これ以外は落とさない**（下の `stemOf` を見よ）。 */
const MODEL_SUFFIXES = ['.safetensors', '.sft', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'];

/**
 * 名前を比べるための形。**フォルダと本体の拡張子だけ落とす。**
 *
 * **最後の `.` から後ろを落とさない。** 拡張子の付いていない名前が版番号の
 * ところで切れる（実データの `ink-style_A3.1_XL` → `ink-style_a3`）。
 * サーバ側（`unbake/models.py` の `_stem`）と同じ判断で揃えてある。
 */
export function stemOf(name) {
    const tail = String(name || '').replaceAll('\\', '/').split('/').pop().trim().toLowerCase();
    for (const suffix of MODEL_SUFFIXES) {
        if (tail.endsWith(suffix)) return tail.slice(0, -suffix.length).trim();
    }
    return tail;
}

/**
 * プロンプトに直接書かれた `<lora:名前:効き目>`。
 *
 * **一覧に無い LoRA が在る。** 実データ 347件のうち **20件**で、プロンプトが
 * 名指ししている LoRA が `loras` に入っていなかった（`Civitai_Recipe_91163810`
 * は5本すべて欠落し、件数は 0 と出ていた）。構造化された一覧は Civitai が
 * 版として解決できたものだけで、**手で書いた分はそこに入らない**。
 *
 * 名前しか判らないので版 ID も hash も無い。**それでも出す**——
 * 「使っていない」と読まれるより、「名前だけ判っている」の方が正しい。
 */
export function lorasInPrompt(text) {
    const out = [];
    const seen = new Set();
    for (const match of String(text ?? '').matchAll(/<lora:([^:>]+)(?::([^:>]*))?[^>]*>/gi)) {
        const name = String(match[1] || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const weight = Number(match[2]);
        out.push({ name, strength: Number.isFinite(weight) ? weight : 1 });
    }
    return out;
}

/**
 * 記録が持っている強度。**無ければ 1**——0 に丸めると LoRA が効かなくなる
 * （「書いていない」と「0 と書いてある」は別物）。
 */
export function strengthOf(source) {
    for (const key of ['strength_model', 'strength', 'weight']) {
        const value = Number(source?.[key]);
        if (Number.isFinite(value)) return value;
    }
    return 1;
}

/**
 * 記録が使っているモデルを拾う。**種別を落とさない**——消す口は種別を要る。
 *
 * 拾い先は要約でも本体でも同じ形になるようにしてある
 * （`checkpoint` は文字列、`loras[].file_name` は名前）。
 *
 * @returns {{kind: string, name: string, role: string}[]}
 */
export function modelsOf(record, recipe = null) {
    const out = [];
    const seen = new Set();
    const push = (kind, name, role, raw = null, altKinds = []) => {
        const text = String(name || '').trim();
        if (!text) return;
        const key = `${kind}:${text.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        // **元の資源も持つ。** 強度は記録の側に在るので、名前だけだと読めない。
        out.push({
            kind, name: text, role, index: out.length, source: raw,
            // **当たらなかったときに引き直す置き場**（空なら引き直さない）。
            altKinds,
            // **LoRA だけの通し番号。** 上書きレイヤは版 ID が無いとき順番で鍵を作るので、
            // checkpoint を混ぜて数えると鍵がずれる。
            loraIndex: out.filter(item => item.role === 'lora').length,
        });
    };
    const source = recipe || record || {};
    const checkpoint = source.checkpoint ?? record?.checkpoint;
    /*
     * **チェックポイントは `checkpoints` に在るとは限らない**（2026-08-26 実機）。
     *
     * Anima / Krea 2 / Z-Image のように**UNet 単体で配られる**モデルは
     * `models/diffusion_models` に入る。ここを `checkpoints` 決め打ちにして
     * いたので、実在する 13.1 GB の `krea2Turbo_v10.safetensors` に対して
     * **「この環境には入っていません」**と出ていた——在る物を無いと言い、
     * 消す口も押せないままになる。
     *
     * 置き場は**引いてみるまで判らない**ので、候補を持たせて外れたら次を引く
     *（`altKinds`）。系統の表を持ち込むより、実際に当たった方を採る方が確か。
     */
    push('checkpoints', typeof checkpoint === 'string'
        ? checkpoint
        : (checkpoint?.file_name || checkpoint?.name), 'checkpoint', checkpoint,
        ['diffusion_models', 'unet']);
    const loras = Array.isArray(source.loras) ? source.loras : (record?.loras || []);
    for (const lora of loras) {
        if (!lora) continue;
        push('loras', lora.file_name || lora.name, 'lora', lora);
    }

    // **プロンプトが名指ししている分も足す**（2026-08-22 利用者の指摘）。
    // `push` が茎で重複を弾くので、一覧に在るものは二重に出ない。
    const prompt = source.gen_params?.prompt
        ?? record?.gen_params?.prompt
        ?? record?.positive
        ?? record?.prompt
        ?? '';
    for (const found of lorasInPrompt(prompt)) {
        push('loras', found.name, 'lora', {
            file_name: found.name,
            strength_model: found.strength,
            // **どこから来たかを消さない。** 版 ID も hash も無いので、
            // 一覧に在るものと同じ強さの手掛かりだと読ませない。
            fromPrompt: true,
        });
    }
    return out;
}

/**
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {object} options.record
 * @param {object|null} [options.recipe] 本体（在れば LoRA の並びが正確になる）
 * @param {{plan: Function, remove: Function}} options.io
 * @param {(entry: object, plan: object) => void} options.onDelete 確認の面を開く
 * @param {() => void} [options.onClose]
 */
export function createModelsView({
    documentRef, record, recipe = null, io, onDelete, onClose = null,
    loraStrengthOf = null, onLoraStrength = null, onStrengthCount = null,
    modelNameOf = null, onModelName = null, loadInstalled = null,
    /** 絵で選ぶ面を出す口。`({kind, current, names, onPick}) => void`。 */
    onOpenPicker = null,
    /**
     * 差し替え先が増えたことを知らせる口。`(target, names, label) => void`。
     *
     * **軸を宣言する面をやめた**（2026-08-22 利用者の指示）ので、比べたい
     * LoRA はここで足す。`names` の**1つ目が基準**——元の1本が先頭に来る。
     */
    onAlternates = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    /** 記録どおりでない行。**値は持たない**——上書きレイヤが持っている。 */
    const changed = new Set();
    /** 差し替え先を呼び手へ知らせ直す口（選択が変わったら基準も変わる）。 */
    const alternateReporters = [];

    const root = element('div', { class: 'unbake-models' });
    // **戻る先が無いなら、戻る口も出さない**（2026-08-22 利用者の指摘）。
    //
    // 元は単体の面で、`onClose` が一覧へ戻していた。詳細の中へ差してからは
    // `onClose: null` で呼ばれているので、**押しても何も起きないボタン**が
    // 出たままになっていた。題も同じ——詳細の見出しが既に記録の名前を出している。
    if (onClose) {
        const back = element('button', {
            class: 'unbake-sweep-back', type: 'button', text: t('sweep.back'),
        });
        back.addEventListener('click', () => onClose());
        root.append(element('div', { class: 'unbake-sweep-head' }, [
            back,
            element('span', {
                class: 'unbake-sweep-title',
                text: t('models.title', { title: record?.title || record?.id || '' }),
            }),
        ]));
    }

    const entries = modelsOf(record, recipe);
    root.append(element('p', {
        class: 'unbake-sweep-help', text: t('models.counts', { count: entries.length }),
    }));
    // **数えた範囲を必ず出す。** 0件を「安全」と読ませない。
    root.append(element('p', { class: 'unbake-sweep-help', text: t('models.scope') }));

    const listNode = element('div', { class: 'unbake-models-list' });
    root.append(listNode);

    const rows = new Map();
    /** 選択肢を差し終えるまでの約束。**検査が「まだ空」を見ないように待てる。** */
    const pending = [];
    for (const entry of entries) {
        const state = element('span', { class: 'unbake-models-state', text: t('models.checking') });
        const button = element('button', {
            class: 'unbake-models-delete', type: 'button',
            text: t('models.delete'), disabled: 'true',
        });
        // **絵を出す。** 名前だけでは「どちらが欲しいモデルか」が判らない
        // ——差し替えの軸で先に踏んだのと同じ問題（2026-08-22 利用者の指摘）。
        // **見本が動画しか無いモデルでも出る**（サーバが1コマ抜いて画像にする）。
        const thumb = element('img', {
            class: 'unbake-models-thumb', loading: 'lazy', alt: '',
            src: `/unbake/model-preview?kind=${encodeURIComponent(entry.kind)}`
                + `&name=${encodeURIComponent(entry.name)}`,
        });
        // **無い見本を「壊れた画像」として出さない。** 404 は普通に起きる
        // （手元に無いモデル・見本を置いていないモデル）ので、静かに畳む。
        thumb.addEventListener('error', () => { thumb.style.display = 'none'; });

        const key = `${entry.kind}:${entry.name}`;
        const row = element('div', {
            class: 'unbake-models-row', 'data-role': entry.role, 'data-changed': 'false',
        }, [thumb]);
        const body = element('div', { class: 'unbake-models-body' });
        row.append(body);

        // --- 名前と差し替え -------------------------------------------------
        //
        // **押してから選ぶ形をやめ、その場で選ばせる**（利用者の指示・2026-08-22）。
        // 「変える」を押して別の面へ飛ぶと、戻ってきたときに何を見ていたか消える。
        // **後で手元のファイル名へ寄せ直すことがある**（下の `fill` を見よ）ので let。
        let recordedName = entry.name;
        const storedName = modelNameOf ? modelNameOf(entry.source, entry.loraIndex, entry.role) : null;
        let currentName = (typeof storedName === 'string' && storedName) ? storedName : recordedName;

        const nameLine = element('div', { class: 'unbake-models-line' });
        const label = element('span', { class: 'unbake-models-role', text: roleText(entry.role) });
        nameLine.append(label);
        // **出どころを消さない。** 版 ID も hash も無いので、一覧に在るものと
        // 同じ強さの手掛かりだと読ませない（引き直しも名前でしかできない）。
        if (entry.source?.fromPrompt) {
            nameLine.append(element('span', {
                class: 'unbake-models-role', 'data-source': 'prompt',
                text: t('models.fromPrompt'), title: t('models.fromPrompt.help'),
            }));
        }

        /** 記録どおりへ戻す口。**行ごとに置く**——全部戻すのは別の話。 */
        const reset = element('button', {
            class: 'unbake-models-reset', type: 'button',
            text: '↺', title: t('models.reset'), 'aria-label': t('models.reset'),
            disabled: 'true',
        });

        // **素の `<select>` をやめた**（2026-08-22 利用者の指摘）。開いた一覧は
        // OS 側が描くので面の色が届かず**白飛び**し、しかも**絵を出せない**。
        // 押したら `onOpenPicker` が絵つきの面を出し、選んだ名前が戻ってくる。
        let picker = null;
        let installed = [];
        if (onModelName && loadInstalled) {
            picker = element('button', {
                class: 'unbake-models-pick', type: 'button',
                text: currentName, title: t('models.change'), 'aria-label': t('models.change'),
            });
            // **`value` で読み書きできるようにしておく。** 呼び出し側（と検査）は
            // 素の `<select>` と同じ言い方のままでよい。
            Object.defineProperty(picker, 'value', {
                get: () => currentName,
                set: (next) => { currentName = String(next); picker.textContent = currentName; },
                configurable: true,
            });
            picker.addEventListener('click', () => {
                onOpenPicker?.({
                    kind: entry.kind, current: currentName, names: installed,
                    onPick: (name) => {
                        if (!name || name === currentName) return;
                        picker.value = name;
                        applyPick();
                    },
                });
            });
            nameLine.append(picker);
        } else {
            nameLine.append(element('span', { class: 'unbake-models-name', text: currentName }));
        }
        nameLine.append(reset);
        body.append(nameLine);

        // --- 強度 -----------------------------------------------------------
        //
        // **記録の値が基準。** 書いていなければ 1——0 に丸めると効かなくなる。
        const recorded = strengthOf(entry.source);
        let slider = null;
        let readout = null;
        let currentStrength = recorded;
        if (entry.role === 'lora' && onLoraStrength) {
            const stored = loraStrengthOf ? loraStrengthOf(entry.source, entry.loraIndex) : null;
            // **生の値をまず見る。** `Number(null)` は 0 で `Number.isFinite` を通るので、
            // 数へ直してから判定すると**上書きの無い LoRA が全部 0 で開く**
            // ——押した瞬間に、その LoRA が黙って効かなくなる。
            currentStrength = (stored === null || stored === undefined || stored === '')
                ? recorded
                : (Number.isFinite(Number(stored)) ? Number(stored) : recorded);
            readout = element('span', {
                class: 'unbake-models-strength-value', text: currentStrength.toFixed(2),
            });
            slider = element('input', {
                class: 'unbake-models-strength', type: 'range',
                min: '0', max: '2', step: '0.05', 'aria-label': t('models.strength'),
            });
            slider.value = String(currentStrength);
            // **記録の値を字でも出す。** つまみの位置だけでは「元がいくつか」が判らず、
            // 戻したいときに戻せない。
            body.append(element('div', { class: 'unbake-models-strength-row' }, [
                slider, readout,
                element('span', {
                    class: 'unbake-models-recorded', text: t('models.recorded', { value: recorded.toFixed(2) }),
                }),
            ]));
        }

        /**
         * 記録どおりか。**印と ↺ の生死は、ここ1箇所で決める。**
         *
         * `notify` を false にすると呼び手へ数を送らない——**組み立て中は送らない**。
         * 行ごとに送ると、まだ全部の行を作っていない途中の数が何度も届く。
         */
        function syncChanged(notify = true) {
            const same = currentStrength === recorded && currentName === recordedName;
            row.setAttribute('data-changed', same ? 'false' : 'true');
            if (same) changed.delete(entry.name);
            else changed.add(entry.name);
            if (same) reset.setAttribute('disabled', 'true');
            else reset.removeAttribute('disabled');
            if (notify) onStrengthCount?.(changed.size);
        }

        if (slider) {
            const applyStrength = () => {
                const value = Number(slider.value);
                if (!Number.isFinite(value)) return;
                currentStrength = value;
                readout.textContent = value.toFixed(2);
                // null を渡すとその1本だけ上書きが消える（＝記録どおりへ戻る）。
                onLoraStrength(entry.source, entry.loraIndex, value === recorded ? null : value);
                syncChanged();
            };
            slider.addEventListener('input', applyStrength);
            slider.addEventListener('change', applyStrength);
        }

        /** 選んでいるモデルの見本へ差し替える。**名前と絵がずれない。** */
        function showPreview(name) {
            thumb.style.display = '';
            thumb.setAttribute('src', `/unbake/model-preview?kind=${encodeURIComponent(entry.kind)}`
                + `&name=${encodeURIComponent(name)}`);
        }

        /** 選び直した後の後始末。**絵・状態・印・比べる相手を一度に揃える。** */
        function applyPick() {
            showPreview(currentName);
            // null を渡すとその1つだけ差し替えが消える（＝記録どおりへ戻る）。
            onModelName(entry.source, entry.loraIndex, entry.role,
                currentName === recordedName ? null : currentName);
            syncChanged();
            refreshOne(key, currentName);
            // **基準が変わった。** 知らせ直さないと、軸の1つ目が古いままになる。
            for (const report of alternateReporters) report();
        }
        if (picker) {
            // 検査と外からの操作のために、`change` も今までどおり効かせる。
            picker.addEventListener('change', applyPick);
        }

        reset.addEventListener('click', () => {
            if (slider) {
                slider.value = String(recorded);
                currentStrength = recorded;
                readout.textContent = recorded.toFixed(2);
                onLoraStrength(entry.source, entry.loraIndex, null);
            }
            if (picker && currentName !== recordedName) {
                picker.value = recordedName;
                showPreview(recordedName);
                onModelName(entry.source, entry.loraIndex, entry.role, null);
                refreshOne(key, recordedName);
            }
            syncChanged();
        });

        // **比べたい相手をその場で足す。**「振る」で*軸*を宣言してから回す形は、
        // 「この LoRA と、あの LoRA を見比べたい」だけのことが2手先になっていた。
        // **checkpoint にも出す**（2026-08-22 利用者の指示で「振る」から移した）。
        // 土台を変えると絵は大きく動くので、**比べたい相手が複数ある**のが普通。
        if (onAlternates && picker) {
            const target = entry.role === 'checkpoint'
                ? 'checkpoint'
                : loraTargetIdentity(entry.source, entry.loraIndex);
            const alternates = [];
            const chips = element('div', { class: 'unbake-models-alts' });

            const report = () => {
                // **1つ目は今選んでいるもの。** 基準が無いと、出た絵の側から
                // 「どれが元だったか」を言えなくなる。
                onAlternates(target, [currentName, ...alternates], entry.name, entry.role);
            };
            const draw = () => {
                chips.replaceChildren();
                for (const name of alternates) {
                    const drop = element('button', {
                        class: 'unbake-models-alt-drop', type: 'button',
                        text: '×', title: t('models.alt.remove'), 'aria-label': t('models.alt.remove'),
                    });
                    drop.addEventListener('click', () => {
                        alternates.splice(alternates.indexOf(name), 1);
                        draw();
                        report();
                    });
                    chips.append(element('span', { class: 'unbake-models-alt' }, [
                        element('span', { class: 'unbake-models-alt-name', text: name }), drop,
                    ]));
                }
            };
            const add = element('button', {
                class: 'unbake-models-alt-add', type: 'button', text: '＋',
                title: t('models.alt.add'), 'aria-label': t('models.alt.add'),
            });
            /** 比べる相手を1つ足す。**同じものは足さない**（展開器は重複で投げる）。 */
            const addAlternate = (name) => {
                if (!name || name === currentName || alternates.includes(name)) return false;
                alternates.push(name);
                draw();
                report();
                return true;
            };
            // **押したら選ぶ面を出す。** 素の `<select>` だったころは「今選んで
            // いる値」を溜める場所があったが、絵で選ぶ面には**溜める場所が無い**
            // ——押した先で選んだものが、そのまま比べる相手になる。
            add.addEventListener('click', () => {
                onOpenPicker?.({
                    kind: entry.kind, current: currentName, names: installed,
                    onPick: (name) => addAlternate(name),
                });
            });
            row.addAlternate = addAlternate;
            nameLine.append(add);
            body.append(chips);
            alternateReporters.push(report);
        }

        body.append(element('div', { class: 'unbake-models-line' }, [state, button]));
        listNode.append(row);
        rows.set(key, { entry, state, button, current: currentName });

        // **選択肢は後から差す。** `/object_info` は起動直後には届いていない。
        // **必ず先に選択肢を入れてから `value` を入れる**——空の `<select>` へ
        // 代入しても何も起きず、選ばれていない状態のまま「記録どおり」に見える。
        if (picker) {
            const fill = (names) => {
                installed = names || [];
                // **記録の名前と手元のファイル名を、同じ1つとして扱う。**
                // 記録が持つのは `wasabi_natsume_style_r1` のような素の名前で、
                // `/object_info` が配るのは `Illustrious\\realistic\\....safetensors`。
                // そのまま並べると**同じモデルが2つ出て**、片方を選ぶだけで
                // 「記録と違う」印が付く。1つに決まるときだけ寄せる
                // ——2つに当たるときは決めない（どちらか判らない）。
                const wanted = stemOf(recordedName);
                const same = installed.filter(item => stemOf(item) === wanted);
                if (same.length === 1) {
                    if (currentName === recordedName) currentName = same[0];
                    recordedName = same[0];
                }
                // **記録のモデルは必ず並べる。** 手元に無くても、戻す先が消えると戻せない。
                installed = [...new Set([recordedName, ...installed])];
                picker.value = installed.includes(currentName) ? currentName : recordedName;
                // **絵と状態も、寄せ直した名前で引き直す。** ここを忘れると、
                // 選択だけがフルパスになり、見本と使用件数は素の名前のまま
                // ——素の名前は 404 になることがあるので、絵が出ない（実機で踏んだ）。
                showPreview(currentName);
                refreshOne(key, currentName);
                syncChanged(false);
            };
            const ready = Promise.resolve(loadInstalled(entry.kind)).then(fill, () => fill([]));
            pending.push(ready);
        }
        syncChanged(false);
        showPreview(currentName);
    }
    // **組み立てが済んでから、いま何本違うのかを1回だけ送る。**
    onStrengthCount?.(changed.size);

    if (entries.length === 0) {
        listNode.append(element('p', { class: 'unbake-sweep-help', text: t('models.none') }));
    }

    /**
     * 1件ぶんの状態を引き直す。**押せるのは「1つに決まった」ものだけ。**
     *
     * `name` を渡すと、その名前で引き直す——**差し替えた後に元の名前で引くと、
     * 画面に出ているのと違うモデルの大きさ・使用件数・削除口が出る**。
     */
    async function refreshOne(key, name = null) {
        const row = rows.get(key);
        if (!row) return null;
        const { entry, state, button } = row;
        if (name) row.current = name;
        const target = row.current || entry.name;
        state.textContent = t('models.checking');
        let plan;
        try {
            plan = await io.plan(entry.kind, target);
            /*
             * **外れたら別の置き場で引き直す**（2026-08-26 実機）。
             *
             * UNet 単体で配られるモデルは `diffusion_models` に入るので、
             * `checkpoints` だけを見ると在る物を「入っていません」と言う。
             * **当たった置き場を採る**——以降の削除もそちらへ向く。
             */
            for (const alt of entry.altKinds || []) {
                if (plan?.ok) break;
                let retry = null;
                try { retry = await io.plan(alt, target); } catch { retry = null; }
                if (retry?.ok) { plan = retry; entry.kind = alt; }
            }
        } catch (error) {
            state.textContent = t('models.failed', { detail: error?.message || String(error) });
            return null;
        }
        row.plan = plan;
        const used = plan?.usage?.count ?? null;
        if (!plan?.ok && plan?.state === 'many') {
            // **曖昧。** 候補を見せて、押せないままにする。
            state.textContent = t('models.ambiguous', { list: (plan.matches || []).join(' / ') });
            button.disabled = true;
        } else if (!plan?.ok) {
            state.textContent = t('models.notInstalled');
            button.disabled = true;
        } else {
            state.textContent = t('models.installed', {
                size: sizeText(plan.bytes),
                files: (plan.files || []).length,
                used: used === null ? '—' : used,
            });
            button.disabled = false;
        }
        return plan;
    }

    for (const [key, row] of rows) {
        row.button.addEventListener('click', () => {
            if (!row.plan?.ok) return;
            onDelete?.(row.entry, row.plan, () => refreshOne(key));
        });
    }

    // 開いた時点で全部引く。**押してから調べると、押せるかどうかが押すまで判らない。**
    //
    // **`.map(refreshOne)` と書かない。** `map` は第2引数に添字を渡すので、
    // 2件目以降が「名前 = 1」で引き直される（引数を1つ増やした瞬間に生える事故）。
    const ready = Promise.all([
        ...pending,
        ...[...rows.keys()].map(key => refreshOne(key)),
    ]);

    return {
        root,
        ready,
        refreshOne,
        get entries() { return entries; },
        destroy() { root.remove(); },
    };
}
