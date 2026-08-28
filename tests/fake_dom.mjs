/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * 面の検査で使う最小の DOM。
 *
 * **jsdom を持ち込まない。** 面は `documentRef` を受け取る形にしてあり、
 * 使うのは `createElement` / `append` / `replaceChildren` / イベントだけなので、
 * その面だけを満たす偽物で足りる——依存を1つ足すと、配布物の依存0という
 * 主張を検査するときに毎回この例外を説明することになる。
 */
// --- 最小 DOM ------------------------------------------------------------

export class FakeClassList {
    constructor(node) { this.node = node; }
    add(...names) {
        const set = new Set(String(this.node.className || '').split(/\s+/).filter(Boolean));
        for (const name of names) set.add(name);
        this.node.className = [...set].join(' ');
    }
}

export class FakeNode {
    constructor(tag, doc) {
        this.tagName = String(tag).toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.style = {};
        this.textContent = '';
        this.rawValue = '';
        this.disabled = false;
        this.classList = new FakeClassList(this);
    }

    get className() { return this.attributes.get('class') || ''; }
    set className(value) { this.attributes.set('class', String(value)); }

    setAttribute(name, value) {
        if (name === 'class') { this.className = value; return; }
        this.attributes.set(name, String(value));
        if (name === 'value') this.rawValue = String(value);
    }

    /**
     * `<select>` は**選択肢に無い値を受け付けない。**
     *
     * ここを素通しにしていたせいで、中核へ回し方を1つ足したのに面の選択肢へ
     * 足し忘れた事故を、検査が緑のまま通した（実機で初めて
     * 「Unsupported sweep mode」として出た・2026-08-20）。
     * **ダブルがブラウザより寛容だと、その差の分だけ検査が嘘になる。**
     */
    get value() {
        return this.rawValue ?? '';
    }

    set value(next) {
        if (this.tagName === 'SELECT') {
            const options = this.children
                .filter(child => child.tagName === 'OPTION')
                .map(child => child.getAttribute('value'));
            // 選択肢が1つも無いうちは素通し（構築中に値を入れる形を壊さない）。
            if (options.length > 0 && !options.includes(String(next))) {
                this.rawValue = '';
                return;
            }
        }
        this.rawValue = String(next);
    }

    removeAttribute(name) {
        if (name === 'class') { this.className = ''; return; }
        this.attributes.delete(name);
    }

    getAttribute(name) {
        if (name === 'class') return this.className;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    append(...nodes) {
        for (const node of nodes) {
            if (!node) continue;
            node.parentNode = this;
            this.children.push(node);
        }
    }

    replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
    }

    /**
     * 自分の下に居るか（`Node.contains` と同じ。**自分自身も含む**）。
     *
     * **無いと「焦点が面の中に在るか」を測れない**（2026-08-27）。
     * 実装側が `root.contains(activeElement)` で分岐しているのに、偽の DOM に
     * これが無いと**その分岐が検査から見えない**——通ったのか飛ばされたのか
     * 区別できないまま緑になる。
     */
    contains(other) {
        for (const node of this.walk()) {
            if (node === other) return true;
        }
        return false;
    }

    /** 焦点を取る。**書き込む先は書類の `activeElement`**（本物と同じ場所）。 */
    focus() {
        if (this.ownerDocument) this.ownerDocument.activeElement = this;
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }

    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }

    removeEventListener(type, handler) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler));
    }

    dispatch(type, event = {}) {
        // **disabled な相手は押せない。** 本物のブラウザは disabled 要素へ click を配らない。
        // ここで配ってしまうと、**押せない口を「押せる」と証言するテスト**ができる
        // （2026-08-24 実機：待機中の ⏸ が押せないのにテストは通っていた）。
        const pointerish = type === 'click' || type === 'dblclick' || type.startsWith('pointer')
            || type.startsWith('mouse');
        if (pointerish && this.disabled) return Promise.resolve([]);
        if (!pointerish) {
            return Promise.all((this.listeners.get(type) || []).map(handler => handler(event)));
        }
        /*
         * **押した先から親へ上っていく**（2026-08-28 実機で判明）。
         *
         * 元はその要素の聞き手だけを呼んでいた。ところが面の一番外側には
         * 「どこかを押したら品書きを閉じる」が付いており、**本物では品書きを
         * 開く押しがそのまま外側まで届いて、開いた直後に閉じていた**
         * ——利用者からは「押しても何も出ない」に見える。
         * 偽物が上へ配らないので、検査はそれを緑のまま通した。
         *
         * **ダブルがブラウザより寛容だと、その差の分だけ検査が嘘になる**
         *（この面が上の `<select>` で既に払った授業料と同じ）。
         */
        let stopped = false;
        const before = typeof event.stopPropagation === 'function'
            ? event.stopPropagation.bind(event) : null;
        event.stopPropagation = () => { stopped = true; before?.(); };
        const running = [];
        for (let node = this; node; node = node.parentNode) {
            // 聞き手の中で付け外しされても崩れないように写しで回す。
            for (const handler of [...(node.listeners.get(type) || [])]) running.push(handler(event));
            // **止めろと言われたら、そこから上には配らない。**
            if (stopped) break;
        }
        // **最後は書類まで届く**（本物と同じ）。面は宿主の書類の中に在るので、
        // 「面の外を押したら閉じる」を書類へ付けた側から見ると、
        // **面の中の押しも同じ聞き手に当たる**——止めていなければ。
        if (!stopped && typeof this.ownerDocument?.listeners?.get === 'function') {
            for (const handler of [...(this.ownerDocument.listeners.get(type) || [])]) {
                running.push(handler(event));
            }
        }
        return Promise.all(running);
    }

    getBoundingClientRect() { return { width: 900, height: 600 }; }

    /** 深さ優先で全部。 */
    *walk() {
        yield this;
        for (const child of this.children) yield* child.walk();
    }

    find(predicate) {
        for (const node of this.walk()) if (node !== this && predicate(node)) return node;
        return null;
    }

    findAll(predicate) {
        return [...this.walk()].filter(node => node !== this && predicate(node));
    }

    byClass(name) {
        return this.find(node => String(node.className).split(/\s+/).includes(name));
    }

    allByClass(name) {
        return this.findAll(node => String(node.className).split(/\s+/).includes(name));
    }

    get text() {
        return [this.textContent, ...this.children.map(child => child.text)].filter(Boolean).join(' ');
    }
}

/**
 * `querySelector` の**ごく狭い**実装。当たるのは3つの形だけ:
 * `tag[attr="value"]` / `.class` / `#id`。
 *
 * **無いことを「無い」と読ませないため**に足した（2026-08-25）。
 * ここが未実装だった間、`querySelector` を使う製品側の道は
 * `if (!doc?.querySelector) return 'unavailable'` で**必ず早退**していて、
 * 検査からは一度も踏めていなかった（Dark Reader の錠を外す道がそれ）。
 * **踏めない道は、壊れても赤くならない。**
 *
 * 対応していない形（子孫・複合セレクタ等）は `null` ではなく**投げる**
 * ——静かに `null` を返すと、また「無い」と読める嘘に戻る。
 */
function matchOne(root, selector) {
    const text = String(selector || '').trim();
    let test = null;
    const attr = text.match(/^([a-zA-Z][\w-]*)\[([\w-]+)="([^"]*)"\]$/);
    if (attr) {
        const [, tag, name, value] = attr;
        const wanted = tag.toUpperCase();
        test = (node) => node.tagName === wanted && node.getAttribute(name) === value;
    } else if (/^\.[\w-]+$/.test(text)) {
        const name = text.slice(1);
        test = (node) => String(node.className).split(/\s+/).includes(name);
    } else if (/^#[\w-]+$/.test(text)) {
        const id = text.slice(1);
        test = (node) => node.getAttribute('id') === id;
    } else {
        throw new Error(`fake_dom: この形の querySelector は未対応です: ${text}`);
    }
    for (const start of root) {
        const hit = start.find(test);
        if (hit) return hit;
    }
    return null;
}

/** 木を降りて `id` の一致する節を探す。**最初の1つ**（本物と同じ）。 */
function findById(roots, id) {
    for (const node of roots) {
        if (!node) continue;
        if (node.id === id) return node;
        const hit = findById(node.children || [], id);
        if (hit) return hit;
    }
    return null;
}

export function fakeDocument() {
    const doc = {
        createElement: (tag) => new FakeNode(tag, doc),
        // **本当に探す。** `() => null` の偽物にしていたので、`id` で器を
        // 探す実装（全画面の差し替え・作り直し）が**検査からは常に「無い」**
        // と見え、**付けても外しても同じ結果**になっていた。
        // 人形の穴は、原因が実装側に在るように見えるので一番たちが悪い。
        getElementById: (id) => findById([doc.head, doc.body].filter(Boolean), String(id)),
        querySelector: (selector) => matchOne([doc.head, doc.body].filter(Boolean), selector),
        head: null,
        body: null,
        // **焦点は書類が持つ**（本物と同じ）。初期値は本文——面の外を指す。
        activeElement: null,
        /*
         * **書類の聞き手も本当に覚える**（2026-08-28）。
         *
         * 何もしない偽物にしていたので、「面の外を押したら閉じる」を
         * 付けても外しても**検査からは同じに見えた**——付け忘れも
         * 外し忘れも緑のまま通る。覚えて配る。
         */
        listeners: new Map(),
        addEventListener(type, handler) {
            const list = doc.listeners.get(type) || [];
            list.push(handler);
            doc.listeners.set(type, list);
        },
        removeEventListener(type, handler) {
            const list = (doc.listeners.get(type) || []).filter(item => item !== handler);
            doc.listeners.set(type, list);
        },
        /** 面の外で起きた出来事（宿主の背景を押す・鍵盤を叩く）。 */
        dispatch(type, event = {}) {
            return Promise.all([...(doc.listeners.get(type) || [])].map(handler => handler(event)));
        },
        countListeners(type) { return (doc.listeners.get(type) || []).length; },
    };
    doc.head = new FakeNode('head', doc);
    doc.body = new FakeNode('body', doc);
    doc.activeElement = doc.body;
    return doc;
}

