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

/**
 * `tabindex` が無くても焦点を取れる札（本物の既定に合わせる）。
 * これ以外は `tabindex` を持っているときだけ焦点を取れる。
 */
const FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A']);

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

    /**
     * `id` は**属性の写し**（本物と同じ・`I-20260831-53`）。
     *
     * ここが素のプロパティだった間、`document.getElementById` は `node.id` を、
     * `querySelector('#…')` は `getAttribute('id')` を見ていて、
     * **同じ要素を別々の経路で探していた**。`.id =` で付けた器は
     * `querySelector` から見えず、`setAttribute('id', …)` で付けた器は
     * `getElementById` から見えない。**片方の書き方に変えた瞬間に検査が嘘になる。**
     */
    get id() { return this.attributes.get('id') || ''; }
    set id(value) { this.attributes.set('id', String(value)); }

    setAttribute(name, value) {
        if (name === 'class') { this.className = value; return; }
        this.attributes.set(name, String(value));
        // **`value` を素通しにしない**（`I-20260831-52`）。
        //
        // 直に `rawValue` を書くと、下の setter が持っている
        // **SELECT の選択肢検査と range の丸めを迂回できる**——
        // 人形の穴は今回2件とも実害だったので、入口を1つにする。
        if (name === 'value') this.value = value;
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
        // **range は範囲で丸める**（2026-08-31・監査 I-20260831-07）。
        // 本物の `<input type="range">` は `min`/`max` の外の値を丸めるので、
        // 素通しにすると「画面から入れられない値」を検査だけが入れられてしまう
        // ——下限 0 のスライダーへ負の強度を入れる検査が偽DOM上だけ通り、
        // 実機では 0 へ潰れる差を一度も捕まえられない。
        // **範囲の宣言が無いものは丸めない**（宣言していない物を勝手に狭めない）。
        if (this.tagName === 'INPUT' && this.getAttribute('type') === 'range') {
            const value = Number(next);
            // **属性の有無で見る。** `Number(null)` は `0` になるので、
            // `getAttribute` の結果をそのまま数にすると**宣言していない下限が
            // 0 として効いてしまう**（この直し自体で1度踏んだ）。
            const min = this.attributes.has('min') ? Number(this.getAttribute('min')) : NaN;
            const max = this.attributes.has('max') ? Number(this.getAttribute('max')) : NaN;
            if (Number.isFinite(value)) {
                let clamped = value;
                if (Number.isFinite(min)) clamped = Math.max(min, clamped);
                if (Number.isFinite(max)) clamped = Math.min(max, clamped);
                this.rawValue = String(clamped);
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

    /**
     * **外した子の親も切る**（2026-09-01・走査16周目）。
     *
     * 元は `this.children = []` だけで、**外された子の `parentNode` が残って**いた。
     * `isConnected` は親を辿って本文に着くかを見るので、
     * **一覧を描き直しても、前の描画の要素が「画面に居る」と答え続ける。**
     *
     * 実測（記録20件・31回描き直し）:
     *
     *   人形が寛容なとき: total 620 / live 620 / dead   0   ← 抜けが見えない
     *   本物と同じとき:   total 620 / live  20 / dead 600   ← 600個が浮いている
     *
     * `remove()` は前から親を切っていたので、**片方だけ本物と違っていた**。
     * この差の分だけ「外れた要素を捨てているか」を測る検査が嘘になる。
     */
    replaceChildren(...nodes) {
        for (const child of this.children) child.parentNode = null;
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

    /**
     * **文書へ付いているか**（本物と同じ意味）。
     *
     * 持たせていなかったので、**外れた箱への `focus()` が成功しているように
     * 見えていた**——実機では焦点が litegraph のキャンバスに残っていたのに、
     * 検査は緑だった（2026-08-30 実測）。
     */
    /**
     * **親を指す名前は2つある**（`I-20260830-28`）。
     *
     * 本物は `parentNode`（節）と `parentElement`（要素）の両方を持つ。
     * 人形は `parentNode` しか持っていなかったので、祖先を
     * `parentElement` で辿る実装（重ねる出し方が宿主の器を探す所）は
     * **必ず「見つからない」で終わり**、検査からは「何もしないのが正しい」
     * ように見えていた。
     */
    get parentElement() {
        const parent = this.parentNode;
        return parent && parent.tagName ? parent : null;
    }

    get isConnected() {
        const doc = this.ownerDocument;
        for (let node = this; node; node = node.parentNode) {
            if (doc && (node === doc.body || node === doc.head)) return true;
        }
        return false;
    }

    /**
     * 焦点を取る。**書き込む先は書類の `activeElement`**（本物と同じ場所）。
     *
     * **外れた箱は焦点を取れない**（本物のブラウザと同じ）。ここを無条件に
     * 通していたので、付く前に呼ぶ実装が検査を素通りしていた。
     */
    focus() {
        if (!this.isConnected) return;
        // **焦点を取れる要素でなければ何も起きない**（2026-08-31・監査 I-20260831-17）。
        //
        // ここを `isConnected` だけで通していたので、**面の根から `tabindex` を
        // 消しても1,534件が緑のまま**だった（変異で確認）。焦点の移動を測る検査が
        // 全部、実装ではなく人形の寛容さを測っていたことになる。
        // SELECT の選択肢検証と同じ理由——**ダブルがブラウザより寛容だと、
        // その差の分だけ検査が嘘になる。**
        if (!this.isFocusable()) return;
        if (this.ownerDocument) this.ownerDocument.activeElement = this;
    }

    /** 本物が焦点を当てる相手か。`tabindex` を持つか、本来 focusable な札。 */
    isFocusable() {
        if (this.attributes.has('tabindex')) return true;
        return FOCUSABLE_TAGS.has(this.tagName);
    }

    remove() {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }

    /**
     * **第3引数を捨てない**（`I-20260830-26`）。
     *
     * 引数リストに `options` が無かったので、`addEventListener(t, h, true)` の
     * `true` が**黙って消えていた**。捕まえる段（capture）で受ける聞き手が
     * 上る段（bubble）の最後に回るので、**順序が逆になる**。
     *
     * 実物では面の根に `contextmenu` を capture で1本張ってあり、
     * 「開く前に、開いている品書きを畳む」を担っている。順序が逆だと
     * **開いた直後に自分で畳んで、右クリックの品書きが1枚も出ない**。
     */
    addEventListener(type, handler, options) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        const capture = options === true || options?.capture === true;
        this.listeners.get(type).push({ handler, capture });
    }

    removeEventListener(type, handler, options) {
        const capture = options === true || options?.capture === true;
        this.listeners.set(type, (this.listeners.get(type) || [])
            .filter(item => !(item.handler === handler && item.capture === capture)));
    }

    dispatch(type, event = {}) {
        // **disabled な相手は押せない。** 本物のブラウザは disabled 要素へ click を配らない。
        // ここで配ってしまうと、**押せない口を「押せる」と証言するテスト**ができる
        // （2026-08-24 実機：待機中の ⏸ が押せないのにテストは通っていた）。
        const pointerish = type === 'click' || type === 'dblclick' || type.startsWith('pointer')
            || type.startsWith('mouse')
            // **右クリックも上っていく**（`I-20260830-26`）。
            //
            // `contextmenu` だけが伝播の輪から外れていた。面の根に張った
            // 「開いている品書きを畳む」が一度も走らないので、**開いた直後に
            // 自分で畳んで1枚も出ない**という形を、検査は緑のまま通していた。
            // 2026-08-28 に `click` で同じ授業料を払った跡が下のコメントに在る。
            || type === 'contextmenu';
        if (pointerish && this.disabled) return Promise.resolve([]);
        if (!pointerish) {
            return Promise.all((this.listeners.get(type) || [])
                .map(item => item.handler(event)));
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

        // 押した先から根までの道。**捕まえる段は逆から、上る段は順に。**
        const path = [];
        for (let node = this; node; node = node.parentNode) path.push(node);

        /*
         * **捕まえる段（capture）**——外側から内側へ。
         *
         * ここを持たないと、`addEventListener(t, h, true)` で張った聞き手が
         * **上る段の最後**に回る。実物の面は根に `contextmenu` を capture で
         * 張って「開く前に畳む」を担っているので、順序が逆になると
         * **開いてから畳む**＝品書きが1枚も出ない、に反転する。
         */
        for (const node of [...path].reverse()) {
            for (const item of [...(node.listeners.get(type) || [])]) {
                if (item.capture) running.push(item.handler(event));
            }
            if (stopped) break;
        }

        // **上る段（bubble）**——押した先から根へ。
        if (!stopped) {
            for (const node of path) {
                // 聞き手の中で付け外しされても崩れないように写しで回す。
                for (const item of [...(node.listeners.get(type) || [])]) {
                    if (!item.capture) running.push(item.handler(event));
                }
                // **止めろと言われたら、そこから上には配らない。**
                if (stopped) break;
            }
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

