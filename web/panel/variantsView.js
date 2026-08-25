/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * ある記録から出た絵を並べ、**基準との差だけ**をラベルにする（裁定③）。
 *
 * ---
 *
 * **刻印には頼らない。** 条件ラベルを焼いた画像は実測で 4,256枚中**12枚**しか無く、
 * 刻印方式は将来分しか救わない。差分なら**過去の絵にも当たる**。
 *
 * **証拠の強さを見た目で分ける。** 刻印から来た帰属（確実）と、指紋から来た帰属
 * （推定）を同じ顔で出すと、**一番強い主張が一番弱い根拠で通る**。
 *
 * **「差が無い」は強い主張。** 何を見た上での「無い」なのかが判らないと読んだ人を
 * 誤らせるので、**指紋が見ている項目と見ていないものを画面に必ず出す**。
 */

import { describeDifference, FINGERPRINT_BLIND_SPOTS, FINGERPRINT_FIELDS } from '../core/outputFingerprint.js';
import { conditionsFromPrompt, conditionsFromRecord } from '../core/outputFingerprint.js';
import { t } from '../i18n/index.js';

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

/** 画像を ComfyUI の口で引く URL（**パスは組み立てない**）。 */
export function outputViewUrl(entry) {
    const query = new URLSearchParams({
        filename: String(entry?.filename || ''),
        subfolder: String(entry?.subfolder || ''),
        type: 'output',
    });
    return `/api/view?${query.toString()}`;
}

/**
 * 差分を1行の言葉にする。**基準と同じなら空**（「差が無い」は別に出す）。
 */
export function labelOf(differences) {
    return (differences || [])
        .map(item => t('variants.diff', { field: t(item.label), from: item.from || '—', to: item.to || '—' }))
        .join(' / ');
}

/**
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {object} options.record 一覧が持っている記録
 * @param {object[]} options.outputs `attributeOutputs()` が返した、この記録の分
 * @param {object|null} [options.recipe] 本体（在れば基準の条件をここから採る）
 * @param {() => void} [options.onClose]
 */
export function createVariantsView({
    documentRef, record, outputs = [], recipe = null, onClose = null, onCompare = null,
    /**
     * この1枚を**新しい記録にする**。`(output) => Promise<{ok, reason}>`。
     *
     * 口は升目の側にだけ在って、**この面には無かった**（2026-08-24 利用者の指摘）。
     * 出た絵を見ているのはここなので、ここに置く。
     */
    onCapture = null,
    /**
     * この1枚の設定を**編集中の欄へ流し込む**。`(output) => Promise<…>`。
     *
     * **記録は書き換えない**ので、閉じれば元へ戻る（一時的な上書き）。
     */
    onExtract = null,
    /**
     * 出た絵を1枚消す口（2026-08-25 利用者の指示）。`(output) => Promise<{ok}>`。
     *
     * **押した瞬間には消さない。** 猶予のあいだ画面から外すだけで、
     * 実際に消すのは呼び手（`onDelete`）が猶予を過ぎてから行う。
     */
    onDelete = null,
}) {
    const doc = documentRef;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    const root = element('div', { class: 'unbake-variants' });
    // **戻る先が無いなら、戻る口も出さない**（2026-08-22 利用者の指摘）。
    //
    // 元は単体の面で、`onClose` が一覧へ戻していた。詳細のタブへ差してからは
    // `onClose: null` で呼ばれているので、**押しても何も起きないボタン**が
    // 出たままになっていた。題も同じ——詳細の見出しが既に記録の名前を出している。
    if (onClose) {
        const back = element('button', {
            class: 'unbake-sweep-back', type: 'button', text: t('sweep.back'),
        });
        back.addEventListener('click', () => onClose());
        root.append(element('div', { class: 'unbake-sweep-head' }, [
            back,
            element('span', { class: 'unbake-sweep-title', text: t('variants.title', { title: record?.title || record?.id || '' }) }),
        ]));
    }

    // **基準は記録そのもの。** 出た絵のどれかを基準にすると、
    // 「良く見えた1枚」が基準になって比較の土台が動く。
    const baseline = conditionsFromRecord(recipe || record) || null;

    root.append(element('p', {
        class: 'unbake-sweep-help',
        text: t('variants.counts', {
            total: outputs.length,
            stamped: outputs.filter(item => item.attribution?.evidence === 'stamped').length,
            inferred: outputs.filter(item => item.attribution?.evidence === 'inferred').length,
        }),
    }));

    const grid = element('div', { class: 'unbake-variants-grid' });
    for (const [index, output] of outputs.entries()) {
        const conditions = conditionsFromPrompt(output?.raw?.prompt);
        const differences = baseline && conditions ? describeDifference(baseline, conditions) : [];
        const evidence = output.attribution?.evidence || 'none';
        const card = element('article', {
            class: 'unbake-variant',
            'data-evidence': evidence,
        }, [
            // **押したら大きく見比べる。** ここは「何が違うか」を一覧で読む面で、
            // 違いそのものは小さく並べたままでは見えない。
            (() => {
                const image = element('img', {
                    class: 'unbake-variant-image', loading: 'lazy',
                    src: outputViewUrl(output), alt: output.filename || '',
                    ...(onCompare ? { 'data-zoom': 'true', title: t('image.enlarge') } : {}),
                });
                if (onCompare) {
                    image.addEventListener('click', (event) => {
                        event?.stopPropagation?.();
                        onCompare(index);
                    });
                }
                return image;
            })(),
            // **普段は畳む**（2026-08-24 利用者の指示）。
            // 違いはプロンプトの差を含むので長くなりがちで、**並べて見たいのは絵**。
            // 開けば全部読める形にしてあり、**畳んだのは情報であって捨てていない。**
            element('details', { class: 'unbake-variant-info' }, [
                element('summary', {
                    class: 'unbake-variant-summary',
                    // **畳んだままでも「差が無い」ことは読める。**
                    // 差が無い記録まで開かせると、開く操作だけが増える。
                    text: !conditions
                        ? t('variants.unreadable')
                        : (differences.length ? t('variants.differences') : t('variants.same')),
                }),
                element('div', {
                    class: 'unbake-variant-label',
                    // **差が無いことと、比べられなかったことを分ける。**
                    text: !conditions
                        ? t('variants.unreadable')
                        : (differences.length ? labelOf(differences) : t('variants.same')),
                }),
                element('div', {
                    class: 'unbake-variant-evidence',
                    'data-evidence': evidence,
                    text: evidence === 'stamped'
                        ? t('variants.evidence.stamped')
                        : t('variants.evidence.inferred', {
                            percent: Math.round((output.attribution?.agreement || 0) * 100),
                            compared: output.attribution?.compared ?? 0,
                        }),
                }),
            ]),
        ]);
        // **見ている場所に口を置く**（2026-08-24 利用者の指示）。
        // どちらも機能としては前から在ったが、**升目の側と詳細の欄の側にしか無く、
        // 出た絵を並べて見ているこの面からは届かなかった**。
        // **見つけられない機能は、無いのと同じこと。**
        if (onCapture || onExtract || onDelete) {
            const status = element('span', { class: 'unbake-variant-status', role: 'status' });
            const actions = element('div', { class: 'unbake-variant-actions' });
            const act = (className, label, title, run, done) => {
                const button = element('button', {
                    class: `unbake-variant-act ${className}`, type: 'button',
                    text: label, title, 'aria-label': title,
                });
                button.addEventListener('click', async (event) => {
                    event?.stopPropagation?.();
                    // **押した瞬間に見た目を変える**（一覧の ▶ と同じ作法）。
                    // **二度押しも塞ぐ**——記録にする口を2回叩くと2件増える。
                    if (button.disabled) return;
                    button.disabled = true;
                    status.textContent = t('detail.extracting');
                    try {
                        const result = await run(output);
                        status.textContent = done(result);
                    } catch (error) {
                        status.textContent = t('detail.saveFailed', {
                            detail: error?.message || String(error),
                        });
                    } finally {
                        button.disabled = false;
                    }
                });
                actions.append(button);
            };
            if (onCapture) {
                act('unbake-variant-save', t('detail.save'), t('detail.save'), onCapture,
                    (r) => (r?.ok === false
                        ? t('detail.saveFailed', { detail: String(r?.reason || '') })
                        : t('detail.cell.saved')));
            }
            if (onExtract) {
                act('unbake-variant-extract', t('detail.extract'), t('detail.extract.help'), onExtract,
                    (r) => (r?.ok === false
                        ? t('detail.extractFailed', { detail: String(r?.reason || '') })
                        : t('detail.extracted', { count: r?.matched ?? 0, changed: r?.changed ?? 0 })));
            }
            if (onDelete) {
                // **消すのは他と並べない。** 隣に置くと、写すつもりで消す。
                const remove = element('button', {
                    class: 'unbake-variant-act unbake-variant-delete', type: 'button',
                    // **印だけにする**（2026-08-25 利用者の指示）。語を並べると
                    // 操作の列が伸び、狭い器で折り返して見つけにくくなる。
                    text: '🗑', title: t('detail.delete.help'),
                    'aria-label': t('detail.delete.help'),
                });
                remove.addEventListener('click', async (event) => {
                    event?.stopPropagation?.();
                    if (remove.disabled) return;
                    remove.disabled = true;
                    try {
                        // **その場で画面から外す。** 戻せる猶予は呼び手が持つ。
                        const result = await onDelete(output);
                        if (result?.ok === false) {
                            status.textContent = t('detail.deleteFailed', {
                                detail: String(result?.reason || ''),
                            });
                            remove.disabled = false;
                            return;
                        }
                        // **戻す口を、押した場所へ置く**（2026-08-25 利用者の指摘）。
                        // 元は消したことも戻す口も**パネルの記録欄**にだけ出していた
                        // ——詳細は画面いっぱいに被さるので、見ている人からは
                        // **どちらも一度も見えない**。消えた升目をその場で
                        // 「消しました／元に戻す」に差し替える。
                        const undo = typeof result?.undo === 'function' ? result.undo : null;
                        const kept = [...card.children];
                        const gone = element('div', { class: 'unbake-variant-gone' }, [
                            element('p', {
                                class: 'unbake-variant-gone-note',
                                text: t('detail.deletePending', {
                                    name: String(output?.filename || ''),
                                    seconds: Number(result?.seconds || 0),
                                }),
                            }),
                        ]);
                        if (undo) {
                            const back = element('button', {
                                class: 'unbake-variant-act unbake-variant-undo', type: 'button',
                                text: t('detail.undo'), title: t('detail.undo'),
                                'aria-label': t('detail.undo'),
                            });
                            back.addEventListener('click', (undoEvent) => {
                                undoEvent?.stopPropagation?.();
                                if (back.disabled) return;
                                back.disabled = true;
                                undo();
                                // 元の升目をそのまま戻す（作り直さないので状態も残る）。
                                card.replaceChildren(...kept);
                                card.removeAttribute('data-deleted');
                                remove.disabled = false;
                                status.textContent = t('detail.undone', {
                                    name: String(output?.filename || ''),
                                });
                            });
                            gone.append(back);
                        }
                        card.setAttribute('data-deleted', 'true');
                        card.replaceChildren(gone);
                    } catch (error) {
                        status.textContent = t('detail.deleteFailed', {
                            detail: error?.message || String(error),
                        });
                        remove.disabled = false;
                    }
                });
                actions.append(remove);
            }
            card.append(actions, status);
        }
        grid.append(card);
    }
    root.append(grid);

    // **検出可能範囲をセットで出す。** ここが無いと「差が無い＝同一」と読まれる。
    root.append(element('details', { class: 'unbake-variants-scope' }, [
        element('summary', { text: t('variants.scope') }),
        element('p', {
            class: 'unbake-sweep-help',
            text: t('variants.scope.looksAt', {
                list: FINGERPRINT_FIELDS.map(field => t(field.label)).join(' / '),
            }),
        }),
        element('p', {
            class: 'unbake-sweep-help',
            text: t('variants.scope.blind', {
                list: FINGERPRINT_BLIND_SPOTS.map(code => t(code)).join(' / '),
            }),
        }),
    ]));

    return {
        root,
        baseline,
        destroy() { root.remove(); },
    };
}
