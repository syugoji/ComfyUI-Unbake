/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/**
 * サイドバーを**押し広げず、重ねて出す**（2026-08-25 利用者の指示）。
 *
 * **幅はこちらの持ち物ではなかった。** ComfyUI は自分の
 * `.p-splitterpanel.side-bar-panel`（実測 v1.42.15: `min-width: 312px` /
 * `width: 370px`・`Comfy.Sidebar.UnifiedWidth` は全タブ共通）に面を差し込む。
 * タブ登録の口に幅の引数は無く、こちらの中身をいくら細くしても
 * **器は縮まない**——だから「広げると Job Queue が切れる」は、
 * 中身ではなく**器が横の並びで場所を取っている**ことが原因。
 *
 * ここでやるのは1つだけ: **その器を横の並びから外す**
 * （`position: absolute`）。実測（2026-08-25・窓 1134px）で、外すと
 * 右側の入れ子は **760px → 1072px** になり、**キャンバスも右端も動かない**。
 *
 * **左端そのものは覆わない。** 覆うと Unbake を**閉じる釦ごと隠れて**
 * 開けっぱなしになる。器の今の位置（`offsetLeft`＝ツール群の右）から始める。
 *
 * **他のタブへ持ち込まない。** 器はタブ間で使い回されるので、
 * 手を入れたままにすると Queue や Node Library まで重なって出る
 * ——こちらの面が外れた瞬間に、触る前の指定へ戻す。
 *
 * **すぐには繋がっていない。** 器を渡してくる時点では、その器はまだ
 * どこにも付いていない（実測: 祖先に `.side-bar-panel` が無い）。
 * 1回試して諦めると**何も起きないまま静かに終わる**ので、
 * 付くまで数回やり直す。
 *
 * **掴んで変える口を、こちらで持つ。** 並びから外した瞬間、ComfyUI の
 * 仕切り（splitter）は効かなくなる——向こうが動かすのは `flex-basis` で、
 * 絶対位置にした器はそれを見ない。**取り上げたなら、代わりを出す**
 * ——右端に掴み手を置き、離した時点の幅を設定へ書く
 * （2026-08-25 利用者の指摘: 重なったが幅を変えられなくなった）。
 */

/** 触る指定。**戻すために、触る物を先に数え上げる。** */
const TOUCHED = ['position', 'left', 'top', 'bottom', 'width', 'maxWidth', 'zIndex'];

/** 既定の幅。`clamp` なので、狭い窓では窓に従う。 */
const DEFAULT_WIDTH = 'clamp(320px, 42vw, 720px)';

/** やり直す間隔(ms)。**尽きたら諦める**（全画面にはこの器が無い）。 */
const RETRY_MS = [60, 200, 500, 1200, 2500];

/**
 * 重ねたときの重なり順（2026-08-25 利用者の指摘「実行ボタンが上に重なる」）。
 *
 * **実測**（ComfyUI v0.28.3 / frontend 1.42.15）:
 *
 *   `.actionbar`（Run・停止・行列）を包む `.p-panel`  … **z-index 1300**
 *   サイドバーの器 `.side-bar-panel`               … 20（こちらが入れていた値）
 *   両者を包む `div.z-999`                          … 999（＝ここが積み木の底）
 *
 * 器を並びから外して広げると**実行バーの下へ潜り込む**——同じ入れ物の中では、
 * 大きい方が上に来るため。だから 1300 より上へ出す。
 *
 * **これで ComfyUI の対話窓まで覆うことはない。** 対話窓の覆い（`.p-dialog-mask`）は
 * **body 直下の z-index 1101** で、こちらは z-999 の入れ物の中に居る
 * ——入れ物ごと 999 として比べられるので、中で何番を付けても 1101 は超えない。
 */
const OVER_HOST_TOOLBAR = 1400;

/** 中身が要る最小の幅。これを割ると器だけ細くなって、中で横に溢れる。 */
const MIN_WIDTH = 285;

/** 祖先から ComfyUI のサイドバーの器を探す。 */
export function findSidebarPanel(node, limit = 12) {
    let current = node;
    for (let depth = 0; current && depth < limit; depth += 1) {
        const className = String(current.className || '');
        if (className.split(/\s+/).includes('side-bar-panel')) return current;
        current = current.parentElement || null;
    }
    return null;
}

/**
 * 重ねる指定を入れる／外す。
 *
 * @param {object} root こちらの面（タブ登録で渡ってきた器）
 * @param {object} [options]
 * @param {boolean} [options.enabled] 切れるようにしておく（既定は入り）
 * @param {number} [options.width] 幅(px)。0 や未指定なら `clamp` の既定
 * @param {Function} [options.scheduler] 検査用（`setTimeout` の差し替え）
 * @param {Function} [options.observerFactory] 検査用（`MutationObserver` の差し替え）
 * @returns {{ok: boolean, reason?: string, applied: () => boolean, refresh: () => void, dispose: () => void}}
 */
export function installSidebarOverlay(root, options = {}) {
    const idle = { ok: false, applied: () => false, refresh() {}, dispose() {} };
    if (!root) return { ...idle, reason: 'no root' };
    if (options.enabled === false) return { ...idle, reason: 'disabled' };

    let panel = null;
    let before = null;
    let on = false;
    let observer = null;
    let dead = false;
    const timers = [];

    // 掴んで決めた幅（設定より優先する。**離すまでは保存しない**）。
    let manualWidth = 0;
    // 設定から来た幅。**戻す時はこちらも 0 にする**——見た目だけ既定へ戻して
    // 設定を持ったままだと、次にタブを開いた瞬間に元の幅へ跳ね返る。
    let settingWidth = Number(options.width);
    let grip = null;

    const widthValue = () => {
        if (manualWidth >= MIN_WIDTH) return `${Math.round(manualWidth)}px`;
        return Number.isFinite(settingWidth) && settingWidth >= MIN_WIDTH
            ? `${Math.round(settingWidth)}px`
            : DEFAULT_WIDTH;
    };

    /** 窓の幅。**取れないときは上限を掛けない**（掛けると 0 に潰れる）。 */
    const viewport = () => Number(options.viewportWidth)
        || (typeof window !== 'undefined' ? Number(window.innerWidth) : 0)
        || 0;

    /** 掴んで動かせる範囲へ収める。 */
    const clampWidth = (px, left) => {
        const room = viewport();
        // **右端を割らない。** ここを外すと、広げるほど窓からはみ出す。
        const most = room ? Math.max(MIN_WIDTH, room - left) : Infinity;
        return Math.min(Math.max(Math.round(px), MIN_WIDTH), most);
    };

    /** 右端の掴み手。**取り上げた口の代わり**なので、必ず出す。 */
    const addGrip = () => {
        if (grip) return;
        const doc = panel.ownerDocument || root.ownerDocument
            || (typeof document !== 'undefined' ? document : null);
        if (!doc?.createElement) return;
        grip = doc.createElement('div');
        grip.className = 'unbake-sidebar-grip';
        grip.title = options.gripTitle || '';
        // **見た目はここで持つ。** こちらの器の外に置くので、
        // パネルの中だけに効く指定は届かない。
        Object.assign(grip.style, {
            position: 'absolute',
            top: '0',
            bottom: '0',
            right: '0',
            width: '8px',
            cursor: 'col-resize',
            zIndex: '21',
            touchAction: 'none',
        });

        let from = 0;
        let started = 0;
        const move = (event) => {
            const left = Number(panel.offsetLeft) || 0;
            const next = clampWidth(started + (Number(event?.clientX) || 0) - from, left);
            manualWidth = next;
            panel.style.width = `${next}px`;
        };
        const end = (event) => {
            if (!from && !started) return;
            move(event);
            from = 0;
            started = 0;
            doc.removeEventListener?.('pointermove', move);
            doc.removeEventListener?.('pointerup', end);
            // **離した時にだけ書く。** 動かすたびに書くと、
            // 1回の掴みで何十回も保存へ行く。
            options.onWidth?.(manualWidth);
        };
        grip.addEventListener('pointerdown', (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            from = Number(event?.clientX) || 0;
            started = Number(panel.getBoundingClientRect?.().width) || manualWidth || MIN_WIDTH;
            grip.setPointerCapture?.(event?.pointerId);
            doc.addEventListener?.('pointermove', move);
            doc.addEventListener?.('pointerup', end);
        });
        // **戻す口も要る。** 掴んで狭めた後、既定へ戻す道が無いと詰む。
        grip.addEventListener('dblclick', (event) => {
            event?.preventDefault?.();
            manualWidth = 0;
            settingWidth = 0;
            panel.style.width = widthValue();
            options.onWidth?.(0);
        });
        panel.append?.(grip);
    };

    const removeGrip = () => {
        grip?.remove?.();
        grip = null;
    };

    const apply = () => {
        // **今の位置から始める。** 左端から出すとツール群ごと覆い、
        // Unbake を閉じる釦が消える。
        const left = Number(panel.offsetLeft) || 0;
        panel.style.position = 'absolute';
        panel.style.left = `${left}px`;
        panel.style.top = '0';
        panel.style.bottom = '0';
        panel.style.width = widthValue();
        panel.style.maxWidth = `calc(100vw - ${left}px)`;
        panel.style.zIndex = String(OVER_HOST_TOOLBAR);
        panel.setAttribute?.('data-unbake-overlay', 'true');
        addGrip();
        on = true;
    };

    const restore = () => {
        if (!panel || !before) return;
        removeGrip();
        for (const name of TOUCHED) panel.style[name] = before[name];
        panel.removeAttribute?.('data-unbake-overlay');
        on = false;
    };

    // **こちらの面が付いている間だけ。** `isConnected` を持たない人形では
    // 「付いている」とみなす（検査で外れた扱いになると、何も測れない）。
    const mine = () => root.isConnected !== false;

    const refresh = () => {
        if (dead || !panel) return;
        if (mine()) apply();
        else if (on) restore();
    };

    /** 器が見つかったら、そこへ手を入れて見張りを始める。 */
    const attach = () => {
        if (dead || panel) return Boolean(panel);
        const found = findSidebarPanel(root.parentElement || root);
        if (!found || !found.style) return false;
        panel = found;
        before = Object.fromEntries(TOUCHED.map(name => [name, panel.style[name] ?? '']));
        refresh();
        // タブの切り替えは、器の中身の差し替えとして現れる。
        const Observer = options.observerFactory
            || (typeof MutationObserver === 'function' ? MutationObserver : null);
        if (Observer) {
            observer = new Observer(() => refresh());
            observer.observe?.(panel, { childList: true, subtree: true });
        }
        return true;
    };

    const attached = attach();
    if (!attached) {
        // **付くのを待つ。** 渡された時点ではまだどこにも繋がっていない。
        const schedule = options.scheduler
            || (typeof setTimeout === 'function' ? setTimeout : null);
        if (schedule) {
            for (const delay of RETRY_MS) timers.push(schedule(() => attach(), delay));
        }
    }

    return {
        ok: attached,
        reason: attached ? undefined : 'no sidebar panel yet',
        applied: () => on,
        refresh,
        dispose() {
            dead = true;
            const cancel = typeof clearTimeout === 'function' ? clearTimeout : null;
            if (cancel) for (const timer of timers) cancel(timer);
            observer?.disconnect?.();
            restore();
        },
    };
}
