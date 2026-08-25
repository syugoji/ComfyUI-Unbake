/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 「あとで読む箱」の面（裁定⑦・手順19）。
 *
 * ---
 *
 * **用途は取得ではなく先送りである。** Civitai で気に入った絵を見つけた時点では
 * ComfyUI を起動していないので、その場でブックマークだけしておき、あとで
 * ここが回収する。だから面がやることは2つしか無い——**並べる**ことと、
 * **まだ取り込んでいない分を取り込む**こと。
 *
 * **取り込み器を新しく書かない。** 取り込みは落とし込み（ドロップ）の Civitai 経路
 * そのもので、ここは同じ `routed` を作って渡すだけである。ID の取り出しも
 * `civitaiImageId.js` の同じ抽出器を通す——2本目を書くと、`.red` の扱いのような
 * 決めごとが片方にだけ残って静かに食い違う（実測で出典の 326/340 は `.red`）。
 *
 * **「取り込み済み」はここで決める。** サーバは書庫に在る画像 ID を一緒に返すだけで、
 * 判断しない（判定を2箇所に置くと必ず食い違う）。こちらは**その一覧に加えて、
 * 今この画面に出ている記録**も見る——同じ回に取り込んだ分をもう一度取りに行かないため。
 *
 * **鍵が無いことと0件を混ぜない。** ブックマークが空なのか、鍵を入れていないのか、
 * Raindrop へ届かなかったのかで打つ手が違う。3つを別の文言で出す。
 *
 * **見えている範囲を書く。** 口が返すのは1ページ50件までなので、
 * 「未取り込み0件」は**このページに限った話**である。範囲を書かずに0を出すと、
 * 箱が空になったと読まれる。
 */

import { extractCivitaiImageIdFromCandidates } from './civitaiImageId.js';
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

/**
 * ブックマーク1件から Civitai の画像 ID を取る。
 *
 * **サーバの `civitaiImageId` を鵜呑みにしない**——`link` から取り直して
 * ドメイン（`.com` / `.red`）も一緒に得る。取り込みは**同じドメインへ**問い合わせる。
 *
 * @returns {{id: string, domain: string|null, source: string}|null}
 */
export function civitaiTargetOf(item) {
    const found = extractCivitaiImageIdFromCandidates([item?.link]);
    if (found) return { id: found.id, domain: found.domain || null, source: found.source };
    // 口が ID を見つけていて、こちらの抽出器が見つけられない形は今のところ無い。
    // それでも ID だけは拾えているなら、ドメインは分からないまま返す（既定へ落ちる）。
    const fallback = String(item?.civitaiImageId ?? '');
    return /^\d+$/.test(fallback) ? { id: fallback, domain: null, source: 'server' } : null;
}

/** 記録が指している Civitai の画像 ID。**出典の URL からしか取らない。** */
export function imageIdOfRecord(record) {
    const found = extractCivitaiImageIdFromCandidates([record?.origin?.url]);
    return found ? found.id : null;
}

/**
 * ブックマークを3つに分ける。**「Civitai ではない」を「取り込み済み」に混ぜない。**
 *
 * 箱には Civitai 以外のブックマークも入る（実データのこのコレクションは全件
 * Civitai だったが、それはこの人の使い方であって仕様ではない）。
 *
 * @param {object[]} items 口が返した並び
 * @param {Set<string>|string[]} known 既に手元に在る画像 ID
 */
export function splitBookmarks(items, known) {
    const seen = known instanceof Set ? known : new Set([...(known || [])].map(String));
    const fresh = [];
    const imported = [];
    const other = [];
    for (const item of items || []) {
        const target = civitaiTargetOf(item);
        if (!target) { other.push({ item, target: null }); continue; }
        if (seen.has(String(target.id))) imported.push({ item, target });
        else fresh.push({ item, target });
    }
    return { fresh, imported, other };
}

/**
 * @param {object} options
 * @param {Document} options.documentRef
 * @param {(options: {page: number}) => Promise<object>} options.list `/unbake/raindrop` を読む
 * @param {(target: {id: string, domain: string|null, url: string}) => Promise<object>} options.importOne
 *   1件を取り込む。**落とし込みと同じ経路**を呼ぶこと。
 * @param {() => Iterable<string>} [options.knownIdsOf] いま手元に在る記録の画像 ID
 * @param {() => void} [options.onClose]
 */
export function createRaindropView({
    documentRef, list, importOne, knownIdsOf = null, onClose = null,
}) {
    const doc = documentRef || globalThis.document;
    const element = (tag, attributes, children) => makeElement(doc, tag, attributes, children);

    const root = element('div', { class: 'unbake-raindrop' });
    const back = element('button', {
        class: 'unbake-sweep-back', type: 'button', text: t('sweep.back'),
    });
    back.addEventListener('click', () => onClose?.());
    root.append(element('div', { class: 'unbake-sweep-head' }, [
        back,
        element('span', { class: 'unbake-sweep-title', text: t('raindrop.title') }),
    ]));

    const status = element('p', { class: 'unbake-sweep-help', role: 'status', text: t('raindrop.loading') });
    // **同期ボタンは1つ**（手順19）。押すまで何も取り込まない。
    const importButton = element('button', {
        class: 'unbake-raindrop-import', type: 'button', text: t('raindrop.import.idle'), disabled: 'true',
    });
    // **ページ送りは持たない**（2026-08-23 利用者の指示）。箱ごと読むので
    // 「次のページ」に意味が無い——実測で手元の箱は349件＝7周で全部読める。
    root.append(element('div', { class: 'unbake-raindrop-actions' }, [importButton]));
    root.append(status);
    // **範囲を必ず書く。** 何件のうち何件を見ているのかを、数で出す。
    const scope = element('p', { class: 'unbake-sweep-help' });
    root.append(scope);

    const listNode = element('div', { class: 'unbake-raindrop-list' });
    root.append(listNode);

    const log = element('div', { class: 'unbake-raindrop-log', role: 'log' });
    root.append(log);

    /** この面で取り込んだ分。**もう一度取りに行かない。** */
    const importedHere = new Set();
    let page = 0;
    let last = null;
    let busy = false;

    // **一覧と同じ向きに積む**（古いものが上・新しいものが下へ足す）。
    // 面ごとに向きが違うと、どちらが最新なのか読むたびに考えることになる。
    function appendLog(message) {
        log.append(element('div', { class: 'unbake-raindrop-log-line', text: String(message) }));
        log.scrollTop = log.scrollHeight;
    }

    function knownIds() {
        const out = new Set(importedHere);
        for (const id of last?.knownImageIds || []) out.add(String(id));
        for (const id of knownIdsOf?.() || []) if (id) out.add(String(id));
        return out;
    }

    function render() {
        listNode.replaceChildren();
        if (!last?.ok) return;
        const { fresh, imported, other } = splitBookmarks(last.items, knownIds());
        status.textContent = t('raindrop.counts', {
            total: (last.items || []).length,
            fresh: fresh.length,
            imported: imported.length,
            other: other.length,
        });
        // **途中で止めたなら、そう言う。** 黙って切ると「これで全部」と読まれ、
        // 箱に残っている分を「もう取り込んだ」と勘違いする。
        scope.textContent = last.truncated
            ? t('raindrop.scope.partial', {
                shown: (last.items || []).length, total: last.count ?? '—',
            })
            : t('raindrop.scope.all', { total: (last.items || []).length });
        importButton.disabled = busy || fresh.length === 0;
        importButton.textContent = fresh.length
            ? t('raindrop.import', { count: fresh.length })
            : t('raindrop.import.idle');

        if ((last.items || []).length === 0) {
            listNode.append(element('p', { class: 'unbake-sweep-help', text: t('raindrop.empty') }));
            return;
        }
        // **未取り込みが一番上**（2026-08-25 利用者の指示）。並び自体は前からこの順
        // だったが、**349件が同じ見た目で続くので群の切れ目が読めなかった**
        // ——見出しを1行入れて、どこまでが未取り込みかを目で追えるようにする。
        for (const [state, group] of [['fresh', fresh], ['imported', imported], ['other', other]]) {
            if (group.length === 0) continue;
            listNode.append(element('div', {
                class: 'unbake-raindrop-group', 'data-state': state,
                text: t(`raindrop.group.${state}`, { count: group.length }),
            }));
            for (const { item } of group) {
                // **絵を出すのは未取り込みだけ**（2026-08-25 利用者の指示）。
                // 取り込み済みは「どれか」を決める必要がもう無く、絵はその分の
                // 高さを取るだけになる。表紙が無いブックマークもあるので、
                // **無いときは枠ごと出さない**（壊れた画像を並べない）。
                const showCover = state === 'fresh' && Boolean(item.cover);
                listNode.append(element('div', {
                    class: 'unbake-raindrop-row', 'data-state': state,
                }, [
                    ...(showCover ? [element('img', {
                        class: 'unbake-raindrop-thumb', loading: 'lazy', alt: '',
                        referrerpolicy: 'no-referrer', src: item.cover,
                    })] : []),
                    element('span', {
                        class: 'unbake-raindrop-state',
                        text: state === 'fresh'
                            ? t('raindrop.state.fresh')
                            : (state === 'imported' ? t('raindrop.state.imported') : t('raindrop.state.other')),
                    }),
                    element('span', { class: 'unbake-raindrop-title', text: item.title || item.link || '' }),
                    element('span', { class: 'unbake-raindrop-created', text: String(item.created || '') }),
                ]));
            }
        }
    }

    /** 口を読む。**届かなかったことと0件を混ぜない。** */
    async function refresh() {
        busy = true;
        status.textContent = t('raindrop.loading');
        importButton.disabled = true;
        let result;
        try {
            // **箱ごと読む。** 50件ずつでは、取り込み済みかどうかを箱全体で
            // 見渡せない——「未取り込み0件」がこのページの話になってしまう。
            result = await list({ page, all: true });
        } catch (error) {
            busy = false;
            last = null;
            status.textContent = t('raindrop.failed', { detail: error?.message || String(error) });
            return null;
        }
        busy = false;
        last = result;
        if (!result?.ok) {
            listNode.replaceChildren();
            scope.textContent = '';
            // **鍵が無いことは失敗ではない。** 何をすればよいかを書く。
            status.textContent = result?.error === 'no-token'
                ? t('raindrop.noToken')
                : t('raindrop.failed', { detail: String(result?.error || '') });
            return result;
        }
        render();
        return result;
    }

    /**
     * 未取り込みを取り込む。**1件ずつ・落ちた理由を1件ずつ出す。**
     *
     * 件数だけでは次の一手が決まらない（実機で束の実行にも同じ直しを入れた）。
     */
    async function importFresh() {
        if (busy || !last?.ok) return null;
        const { fresh } = splitBookmarks(last.items, knownIds());
        if (fresh.length === 0) { appendLog(t('raindrop.nothingFresh')); return null; }
        busy = true;
        render();
        let added = 0;
        const failed = [];
        for (const [index, entry] of fresh.entries()) {
            status.textContent = t('raindrop.importing', {
                index: index + 1, count: fresh.length, id: entry.target.id,
            });
            let result;
            try {
                result = await importOne({
                    id: entry.target.id,
                    domain: entry.target.domain,
                    url: entry.item.link,
                });
            } catch (error) {
                failed.push({ id: entry.target.id, detail: error?.message || String(error) });
                continue;
            }
            if (result?.ok === false || (result?.errors?.length && !result?.records?.length)) {
                failed.push({
                    id: entry.target.id,
                    detail: String(result?.error || result?.errors?.[0] || ''),
                });
                continue;
            }
            importedHere.add(String(entry.target.id));
            added += 1;
        }
        busy = false;
        for (const item of failed) {
            appendLog(t('raindrop.importFailed', { id: item.id, detail: item.detail }));
        }
        appendLog(t('raindrop.imported', { added, failed: failed.length }));
        render();
        return { added, failed: failed.length };
    }

    importButton.addEventListener('click', () => importFresh());

    const ready = refresh();

    return {
        root,
        ready,
        refresh,
        importFresh,
        get page() { return page; },
        get last() { return last; },
        destroy() { root.remove(); },
    };
}
