/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { buildRecipeWorkflow } from './recipeWorkflowBuilder.js';
import { compactModelName } from './modelFileNames.js';

/**
 * 回し方。
 *
 * `seeds_only` は**軸を1本も持たない**——動かすのは seed だけ。
 * 「同じ条件で運が良かっただけではないか」を確かめる実験がこれで、再現の作業で
 * 一番よく要る。**退化した軸で代用できない**（軸には異なる値が2つ要り、
 * 同じ値を2つ置くのは禁じてある）ので、回し方として別に持つ。
 */
export const SWEEP_MODES = Object.freeze(['seeds_only', 'single_axis_seeds', 'cartesian', 'cartesian_seeds']);
const MODES = new Set(SWEEP_MODES);
const MAX_CELLS = 500;

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export function sweepSignature(value) {
    const text = canonical(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `sweep-v1-${hash.toString(16).padStart(8, '0')}`;
}

function validateAxis(axis, index) {
    assert(axis && typeof axis === 'object', `axis ${index + 1} is required`);
    assert(typeof axis.id === 'string' && axis.id, `axis ${index + 1} needs an id`);
    assert(Array.isArray(axis.values) && axis.values.length >= 2, `${axis.id} needs at least two values`);
    assert(axis.values.filter(value => value?.baseline === true).length === 1, `${axis.id} needs one baseline`);
    // **同じ値を2度置かない。** 「3点あるように見えて実は2点」の軸を通すと、
    // セル数は増えるのに組み上がるグラフが同じになり、`signature` が衝突する。
    // 実行側はそれを「既に出ている」と読むので、**別条件のはずの絵を使い回す**
    // ——赤くならないまま比較が壊れる。実データで1件踏んだ（負の強度 + クランプ）。
    const encoded = axis.values.map(value => canonical(value?.value));
    assert(new Set(encoded).size === encoded.length,
        `${axis.id} repeats a value (${encoded.length - new Set(encoded).size} duplicate(s))`);
    if (axis.kind === 'prompt_placeholder') {
        assert(/^\{[^{}]+\}$/.test(axis.token || ''), `${axis.id} needs a {placeholder} token`);
    }
}

function combinations(axes, index = 0, selected = {}) {
    if (index >= axes.length) return [selected];
    const axis = axes[index];
    return axis.values.flatMap(value => combinations(
        axes,
        index + 1,
        { ...selected, [axis.id]: clone(value) },
    ));
}

function axisLabels(axes, selections) {
    return axes.map(axis => ({
        axis: axis.id,
        label: axis.label || axis.id,
        value: clone(selections[axis.id]?.value),
        valueLabel: selections[axis.id]?.label ?? String(selections[axis.id]?.value ?? ''),
        baseline: selections[axis.id]?.baseline === true,
    }));
}

export function expandSweepTemplate(template) {
    assert(template && MODES.has(template.mode), 'Unsupported sweep mode');
    const seedsOnly = template.mode === 'seeds_only';
    const axes = Array.isArray(template.axes) ? template.axes : [];
    if (seedsOnly) {
        // **軸を持たせない。** 持たせると「seed だけを振る」ではなくなるのに、
        // 名前は seeds_only のままになる——後から見て何を測ったのか判らなくなる。
        assert(axes.length === 0, 'seeds_only takes no axis');
    } else {
        assert(axes.length > 0, 'At least one axis is required');
    }
    axes.forEach(validateAxis);
    if (template.mode === 'single_axis_seeds') {
        assert(axes.length === 1, 'single_axis_seeds accepts one axis');
    }

    const usesSeeds = template.mode !== 'cartesian';
    const seeds = usesSeeds ? template.seeds : [null];
    assert(Array.isArray(seeds) && seeds.length > 0, 'At least one seed is required');
    if (usesSeeds) {
        seeds.forEach(seed => assert(Number.isSafeInteger(seed) && seed >= 0, 'Seeds must be safe non-negative integers'));
    }

    // 軸が0本のとき `combinations([])` は「空の選択1つ」を返すので、
    // seed の数だけセルができる。**seeds_only はこの性質にそのまま乗る。**
    const axisCombinations = combinations(axes);
    const cells = [];
    for (const selections of axisCombinations) {
        for (const seed of seeds) {
            const labels = axisLabels(axes, selections);
            const baseline = labels.every(label => label.baseline) && (!usesSeeds || seed === seeds[0]);
            const signatureBasis = {
                templateId: template.id || null,
                recipeId: template.recipeId || null,
                selections: labels.map(({ axis, value }) => ({ axis, value })),
                seed,
            };
            cells.push({
                id: `cell-${String(cells.length + 1).padStart(3, '0')}`,
                labels,
                selections: clone(selections),
                seed,
                baseline,
                signature: sweepSignature(signatureBasis),
                status: 'pending',
            });
        }
    }
    assert(cells.length <= MAX_CELLS, `Sweep exceeds ${MAX_CELLS} cells`);
    assert(cells.some(cell => cell.baseline), 'Baseline cell is missing');
    return cells;
}

function positivePrompt(recipe) {
    return String(recipe?.gen_params?.prompt ?? '');
}

function setPositivePrompt(recipe, value) {
    recipe.gen_params = { ...(recipe.gen_params || {}), prompt: value };
}

function loraIdentity(lora, index) {
    return String(lora?.modelVersionId ?? lora?.file_name ?? lora?.name ?? index);
}

function normalizedLoraName(value) {
    return compactModelName(value);
}

function selectedLora(recipe, axis) {
    assert(Array.isArray(recipe.loras) && recipe.loras.length > 0, 'Recipe has no LoRA');
    const target = String(axis.target ?? '0');
    const index = recipe.loras.findIndex((lora, loraIndex) => loraIdentity(lora, loraIndex) === target);
    const resolvedIndex = index >= 0 ? index : Number(target);
    assert(Number.isInteger(resolvedIndex) && recipe.loras[resolvedIndex], `LoRA target ${target} was not found`);
    return { lora: recipe.loras[resolvedIndex], index: resolvedIndex };
}

function patchManifestLoraStrength(recipe, targetLora, strength) {
    const required = recipe?.replay_manifest?.required_resources;
    if (!Array.isArray(required)) return;
    const names = [targetLora.file_name, targetLora.name, targetLora.localPath]
        .map(normalizedLoraName).filter(Boolean);
    const versionId = String(targetLora.modelVersionId ?? '');
    for (const item of required) {
        if (item?.kind !== 'lora') continue;
        const resource = item.resource || {};
        const itemNames = [resource.file_name, resource.name, resource.localPath]
            .map(normalizedLoraName).filter(Boolean);
        const matches = (versionId && String(resource.modelVersionId ?? '') === versionId)
            || names.some(name => itemNames.includes(name));
        if (!matches) continue;
        item.expected = { ...(item.expected || {}), strength_model: strength, strength_clip: strength };
    }
}

/**
 * manifest から、差し替えで居なくなった LoRA の要求を外す。
 *
 * **外さないと、要求と実際の鎖が食い違ったまま「厳密再現」を名乗る。**
 * 一致の見方は `patchManifestLoraStrength` と同じ（版ID優先・名前で補う）。
 */
function dropManifestLora(recipe, targetLora) {
    const required = recipe?.replay_manifest?.required_resources;
    if (!Array.isArray(required)) return;
    const names = [targetLora?.file_name, targetLora?.name, targetLora?.localPath]
        .map(normalizedLoraName).filter(Boolean);
    const versionId = String(targetLora?.modelVersionId ?? '');
    recipe.replay_manifest = {
        ...recipe.replay_manifest,
        required_resources: required.filter(item => {
            if (item?.kind !== 'lora') return true;
            const resource = item.resource || {};
            const itemNames = [resource.file_name, resource.name, resource.localPath]
                .map(normalizedLoraName).filter(Boolean);
            const matches = (versionId && String(resource.modelVersionId ?? '') === versionId)
                || names.some(name => itemNames.includes(name));
            return !matches;
        }),
    };
}

function applyAxis(recipe, axis, selected) {
    const value = clone(selected.value);
    switch (axis.kind) {
        case 'prompt_placeholder': {
            const prompt = positivePrompt(recipe);
            assert(prompt.includes(axis.token), `Prompt does not contain ${axis.token}`);
            setPositivePrompt(recipe, prompt.split(axis.token).join(String(value ?? '')));
            break;
        }
        case 'prompt_append': {
            const suffix = String(value ?? '').trim();
            setPositivePrompt(recipe, [positivePrompt(recipe).trim(), suffix].filter(Boolean).join(', '));
            break;
        }
        case 'lora_strength': {
            const { lora, index } = selectedLora(recipe, axis);
            const strength = Number(value);
            assert(Number.isFinite(strength), 'LoRA strength must be finite');
            recipe.loras[index] = {
                ...lora,
                strength,
                strength_model: strength,
                strength_clip: strength,
                user_override: true,
            };
            patchManifestLoraStrength(recipe, recipe.loras[index], strength);
            break;
        }
        case 'checkpoint': {
            // **`file_name` だけ差し替えても効かない。** 組み立ては
            // `inLibrary ? localPath : null` を先に見るので（`getResourceFilename`）、
            // 引き直し済みの記録では**古い `localPath` が勝って同じ絵が出る**
            // ——セル数だけ増えて、振ったことにならない。
            const swapped = typeof value === 'string' ? { file_name: value } : (value || {});
            const name = swapped.file_name || swapped.localPath || swapped.name || '';
            recipe.checkpoint = {
                ...(recipe.checkpoint || {}),
                ...swapped,
                ...(name ? { file_name: name, localPath: name, inLibrary: true } : {}),
            };
            break;
        }
        case 'lora_swap': {
            // **これが「キャラを変数にする」軸。**（裁定②）
            //
            // `lora_strength` は同じ LoRA の効き目を振るが、こちらは**別の LoRA へ
            // 差し替える**。実行リストの正体は「レコードの一部を固定し、キャラ／
            // checkpoint／LoRA を変数にした画像群」なので、足りないのは束ではなく
            // **この軸**だった（実測で `lora_swap` は0件・`lora_strength` だけが在った）。
            const { lora, index } = selectedLora(recipe, axis);
            const replacement = typeof value === 'string' ? { file_name: value } : (value || {});
            assert(
                String(replacement.file_name || replacement.name || '').trim(),
                'lora_swap needs a file name to switch to',
            );
            // **効き目は引き継ぎ、身元は引き継がない。** `modelVersionId` や hash は
            // 元の LoRA を指しているので、差し替えた先へ付けたままにすると
            // 「別の物を元の版として記録した」ことになる。
            const {
                modelVersionId: _versionId, modelId: _modelId, hash: _hash, civitai: _civitai,
                file_name: _fileName, name: _name, localPath: _localPath,
                ...carried
            } = lora || {};
            recipe.loras[index] = {
                ...carried,
                ...replacement,
                name: replacement.name || replacement.file_name,
                user_override: true,
                // **差し替え元を控える。** 2つとも要る:
                //   `swappedFrom`      … 組み上がったグラフのノードを見つけるため
                //   `swappedFromIdentity` … 軸の `target` から**この項目**を引くため
                // 控えないと、差し替えた瞬間に身元が変わって `selectedLora()` が
                // 見つけられなくなる（実測で60件中60件が「target が無い」で落ちた）。
                swappedFrom: [lora?.file_name, lora?.name, lora?.localPath].filter(Boolean).map(String),
                swappedFromIdentity: loraIdentity(lora, index),
            };
            // manifest は元の LoRA を要求したままなので、その項目を外す。
            // **残すと「要求どおりに再現した」の意味が変わる。**
            dropManifestLora(recipe, lora);
            break;
        }
        case 'generation_parameter':
            assert(typeof axis.parameter === 'string' && axis.parameter, 'generation_parameter needs parameter');
            recipe.gen_params = { ...(recipe.gen_params || {}), [axis.parameter]: value };
            break;
        default:
            throw new Error(`Unsupported axis kind: ${axis.kind}`);
    }
}

function patchBuiltLoraStrength(prompt, recipe, axis, selected) {
    const strength = Number(selected.value);
    const { lora } = selectedLora(recipe, axis);
    const wantedNames = [lora.file_name, lora.name, lora.localPath]
        .map(normalizedLoraName).filter(Boolean);
    const loraNodes = Object.values(prompt).filter(node => /lora/i.test(node?.class_type || ''));
    let changed = 0;
    for (const node of loraNodes) {
        const inputs = node.inputs || {};
        const nodeName = normalizedLoraName(inputs.lora_name || inputs.name);
        const directMatch = wantedNames.includes(nodeName)
            || (loraNodes.length === 1 && recipe.loras.length === 1);
        if (directMatch) {
            let directChanged = false;
            for (const key of ['strength', 'strength_model', 'strength_clip']) {
                if (Object.hasOwn(inputs, key)) {
                    inputs[key] = strength;
                    directChanged = true;
                }
            }
            changed += directChanged ? 1 : 0;
        }
        if (Array.isArray(inputs.loras)) {
            inputs.loras = inputs.loras.map((entry, index) => {
                const entryName = normalizedLoraName(entry?.name || entry?.lora_name);
                const matches = wantedNames.includes(entryName)
                    || (inputs.loras.length === 1 && recipe.loras.length === 1 && index === 0);
                if (!matches) return entry;
                changed += 1;
                return {
                    ...entry,
                    strength,
                    clipStrength: strength,
                    strength_model: strength,
                    strength_clip: strength,
                };
            });
        }
    }
    assert(changed > 0, `LoRA target ${axis.target ?? 0} is not present in the built workflow`);
}

/**
 * 組み上がったグラフの側で LoRA を差し替える。
 *
 * **記録を書き換えるだけでは足りない。** 実測（2026-08-20・実データ）で、
 * 埋め込みグラフを持つ記録は `buildRecipeWorkflow()` がそのグラフを**そのまま
 * 使う**ので、`recipe.loras` をいくら書き換えてもノードの `lora_name` は動かない。
 * その状態で計画を組むと、3セルが**全部同じグラフ**になり——しかも
 * 「宣言外の入力を動かした」検査は何も動いていないので通る。
 * `signature` まで一致するので、実行側は片方を「既に出ている」と見なして
 * **別条件のはずの絵を使い回す。** 赤くならないまま比較が壊れる形なので、
 * `lora_strength` と同じ対をここにも置く。
 *
 * **見つからなければ投げる。** グラフに居ない LoRA は差し替えようがない
 * ——黙って何もしないと、上と同じ「3セルが同じ絵」に戻る。
 */
/**
 * 差し替え済みの記録から、軸が指していた項目を引く。
 *
 * **`selectedLora()` はここでは使えない。** あちらは今の身元で探すが、
 * 差し替えた項目の身元は既に**差し替え先のもの**になっている。
 */
function swappedLora(recipe, axis) {
    const target = String(axis?.target ?? '');
    const loras = Array.isArray(recipe?.loras) ? recipe.loras : [];
    const index = loras.findIndex(item => String(item?.swappedFromIdentity ?? '') === target);
    if (index >= 0) return { lora: loras[index], index };
    // まだ差し替えていない形（同値の baseline など）は従来どおり引く。
    return selectedLora(recipe, axis);
}

function patchBuiltLoraSwap(prompt, recipe, axis, selected) {
    const { lora } = swappedLora(recipe, axis);
    const wantedNames = [
        ...(Array.isArray(lora?.swappedFrom) ? lora.swappedFrom : []),
        lora?.file_name, lora?.name, lora?.localPath,
    ].map(normalizedLoraName).filter(Boolean);
    const nextName = String(selected?.value ?? '');
    assert(nextName, 'lora_swap needs a file name to switch to');

    const loraNodes = Object.values(prompt).filter(node => /lora/i.test(node?.class_type || ''));
    let changed = 0;
    for (const node of loraNodes) {
        const inputs = node.inputs || {};
        if (Object.hasOwn(inputs, 'lora_name')) {
            const nodeName = normalizedLoraName(inputs.lora_name);
            if (wantedNames.includes(nodeName) || normalizedLoraName(nextName) === nodeName) {
                inputs.lora_name = nextName;
                changed += 1;
            }
        }
        if (Array.isArray(inputs.loras)) {
            inputs.loras = inputs.loras.map((entry) => {
                const entryName = normalizedLoraName(entry?.name || entry?.lora_name);
                if (!wantedNames.includes(entryName) && normalizedLoraName(nextName) !== entryName) return entry;
                changed += 1;
                return {
                    ...entry,
                    ...(Object.hasOwn(entry, 'name') ? { name: nextName } : {}),
                    ...(Object.hasOwn(entry, 'lora_name') ? { lora_name: nextName } : {}),
                };
            });
        }
    }
    assert(changed > 0,
        `LoRA target ${axis.target ?? 0} is not present in the built workflow, so it cannot be swapped`);
}

function patchBuiltSweepAxes(prompt, recipe, template, cell) {
    for (const axis of template.axes || []) {
        if (axis.kind === 'lora_strength') {
            patchBuiltLoraStrength(prompt, recipe, axis, cell.selections[axis.id]);
        }
        if (axis.kind === 'lora_swap') {
            patchBuiltLoraSwap(prompt, recipe, axis, cell.selections[axis.id]);
        }
    }
}

export function applySweepCell(recipe, template, cell) {
    const result = clone(recipe);
    // 軸0本（`seeds_only`）でも通る。**seed だけが下で入る。**
    for (const axis of template.axes || []) applyAxis(result, axis, cell.selections[axis.id]);
    if (cell.seed !== null && cell.seed !== undefined) {
        result.gen_params = { ...(result.gen_params || {}), seed: cell.seed };
    }
    return result;
}

function flatten(value, path = '', output = new Map()) {
    if (value === null || typeof value !== 'object') {
        output.set(path, canonical(value));
        return output;
    }
    if (Array.isArray(value)) {
        output.set(`${path}.__length`, String(value.length));
        value.forEach((item, index) => flatten(item, `${path}.${index}`, output));
        return output;
    }
    const keys = Object.keys(value).sort();
    output.set(`${path}.__keys`, keys.join(','));
    keys.forEach(key => flatten(value[key], path ? `${path}.${key}` : key, output));
    return output;
}

function changedPaths(before, after) {
    const left = flatten(before);
    const right = flatten(after);
    return [...new Set([...left.keys(), ...right.keys()])]
        .filter(path => left.get(path) !== right.get(path));
}

const PARAMETER_INPUTS = {
    // **Flux では CFG は `cfg` に入らない。** 組み立ては `FluxGuidance.guidance` へ
    // 書き、`KSampler.cfg` は 1 のまま置く（Flux の作法）。実測（2026-08-20・
    // レシピ `17b5304a…` / base_model `Flux.1 D`）で `cfg_scale` を振ると
    // 動くのは `6.inputs.guidance` だけ、`8.inputs.cfg` は 1 で不動だった。
    // ここに `guidance` が無いと、**正しい掃引が「宣言外の入力を動かした」として
    // 弾かれる**——検査が厳しすぎるのではなく、対応表が足りていない。
    cfg_scale: new Set(['cfg', 'guidance']),
    steps: new Set(['steps']),
    denoising_strength: new Set(['denoise']),
    sampler: new Set(['sampler_name', 'scheduler']),
    scheduler: new Set(['scheduler']),
    width: new Set(['width']),
    height: new Set(['height']),
    clip_skip: new Set(['stop_at_clip_layer']),
};

function allowedInputNames(template, includeSeed) {
    const allowed = new Set();
    if (includeSeed) {
        allowed.add('seed');
        allowed.add('noise_seed');
    }
    for (const axis of template.axes || []) {
        if (axis.kind === 'prompt_placeholder' || axis.kind === 'prompt_append') allowed.add('text');
        if (axis.kind === 'lora_strength') {
            allowed.add('strength');
            allowed.add('strength_model');
            allowed.add('strength_clip');
        }
        if (axis.kind === 'checkpoint') {
            allowed.add('ckpt_name');
            allowed.add('unet_name');
            allowed.add('model_name');
        }
        if (axis.kind === 'lora_swap') {
            allowed.add('lora_name');
            // 名前だけを差し替えるが、**組み立てが強度も書き直す形の鎖がある**
            // （`inputs.loras` の配列を持つノード）。宣言に入れておかないと、
            // 正しい差し替えが「宣言外の入力を動かした」として弾かれる。
            allowed.add('strength');
            allowed.add('strength_model');
            allowed.add('strength_clip');
        }
        if (axis.kind === 'generation_parameter') {
            const names = PARAMETER_INPUTS[axis.parameter] || new Set([axis.parameter]);
            names.forEach(name => allowed.add(name));
        }
    }
    return allowed;
}

/**
 * **実行に一切効かない欄。** ここだけは差分を数えない。
 *
 * `_meta` は ComfyUI の表示用で、本体は**エラー文言を組むときにしか読まない**
 * （実測: `execution.py` の `validate_prompt` が `_meta.title` を
 * 「Node 'X' not found」の X に使うだけ）。`_meta.lora_aliases` は Unbake が
 * 診断用に書いている印で、**書き手2箇所・読み手0件**（実測）。
 *
 * 外す理由は「厳しすぎるから」ではない。**`lora_swap` と `checkpoint` の軸は、
 * 定義からしてノードの表示名を変える**——LoRA を差し替えれば題も別名も変わる。
 * 数えたままだと、正しい差し替えが全件「宣言外の入力を動かした」として弾かれる
 * （実データ60件で **58件が落ち、うち44件はこの `_meta` だけが理由**だった）。
 *
 * **`.inputs.` 以外を無条件に許すのではない。** ノードの増減
 * （`__keys` / `__length`）は今までどおり弾く——差し替え先が未導入で
 * LoRA が鎖から落ちた、を見逃してはいけない。
 */
const DISPLAY_ONLY_PATH = /^[^.]+\._meta(\.|$)/;

export function assertOnlySweepInputsChanged(baselinePrompt, candidatePrompt, template, options = {}) {
    const paths = changedPaths(baselinePrompt, candidatePrompt);
    const allowed = allowedInputNames(template, options.includeSeed === true);
    const unexpected = paths.filter(path => {
        if (DISPLAY_ONLY_PATH.test(path)) return false;
        const match = path.match(/^[^.]+\.inputs\.([^.]+)/);
        return !match || !allowed.has(match[1]);
    });
    if (unexpected.length) {
        throw new Error(`Sweep changed unintended graph inputs: ${unexpected.join(', ')}`);
    }
    return paths;
}

export function buildSweepPlan(recipe, template, options = {}) {
    const cells = expandSweepTemplate(template);
    const built = cells.map(cell => {
        const variedRecipe = applySweepCell(recipe, template, cell);
        // 掃引が組むのは**実際に投入されるグラフ**。再現側と同じ材料を渡さないと、
        // 判定側と実行側で正規化がずれる（埋め込みが片方だけ効く）。
        const workflow = buildRecipeWorkflow(variedRecipe, {
            // **投げるのはこちらなので、こちらの名前で保存する**（2026-08-26）。
            // 作者の行き先へ落とすと、出した絵を自分で見つけられない。
            ownOutputs: true,
            objectInfo: options.objectInfo,
            knownModelCatalog: options.knownModelCatalog,
            // 大きすぎる再現の上限。**組み立てまで届かないと効かない。**
            maxReplayPixels: options.maxReplayPixels,
            embeddings: options.embeddings,
        });
        patchBuiltSweepAxes(workflow.prompt, variedRecipe, template, cell);
        return { ...cell, recipe: variedRecipe, workflow };
    });
    const baseline = built.find(cell => cell.baseline);
    assert(baseline, 'Baseline cell is missing');
    for (const cell of built) {
        assertOnlySweepInputsChanged(baseline.workflow.prompt, cell.workflow.prompt, template, {
            includeSeed: template.mode !== 'cartesian',
        });
        cell.signature = sweepSignature({
            prompt: cell.workflow.prompt,
            recipeId: template.recipeId || recipe.id || null,
        });
    }
    return { cells: built, baselineId: baseline.id };
}

export function estimateSweep(template, secondsPerCell = 60) {
    const cellCount = expandSweepTemplate(template).length;
    const safeSeconds = Number.isFinite(Number(secondsPerCell)) && Number(secondsPerCell) >= 0
        ? Number(secondsPerCell)
        : 60;
    return {
        cellCount,
        estimatedSeconds: Math.ceil(cellCount * safeSeconds),
    };
}
