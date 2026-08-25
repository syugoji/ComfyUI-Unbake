/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
function basename(value) {
    return String(value || '').replaceAll('\\', '/').split('/').at(-1) || '';
}

function normalizedName(value) {
    return basename(value)
        .replace(/\.(?:safetensors|ckpt|pt|pth)$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function finiteStrength(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function loraName(lora) {
    return lora?.name || lora?.lora_name || lora?.file_name || '';
}

function loraCandidateNames(lora) {
    return [
        loraName(lora),
        ...(Array.isArray(lora?.aliases) ? lora.aliases : []),
        ...(Array.isArray(lora?.promptAliases) ? lora.promptAliases : []),
        ...(Array.isArray(lora?.prompt_aliases) ? lora.prompt_aliases : []),
    ].filter(Boolean);
}

function indexLorasByUniqueName(entries) {
    const byName = new Map();
    for (const lora of entries) {
        for (const candidate of loraCandidateNames(lora)) {
            const key = normalizedName(candidate);
            if (!key) continue;
            if (!byName.has(key)) {
                byName.set(key, lora);
            } else if (byName.get(key) !== lora) {
                // Never guess when two resources claim the same alias.
                byName.set(key, null);
            }
        }
    }
    return byName;
}

export function injectA1111LoraTags(parameters, loras) {
    if (typeof parameters !== 'string' || !parameters.trim()) return parameters;
    const entries = Array.isArray(loras) ? loras : [];
    if (entries.length === 0) return parameters;

    const resolvedByName = indexLorasByUniqueName(entries);

    const existing = new Set();
    const normalizedParameters = parameters.replace(
        /<lora:([^:>]+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*>/gi,
        (tag, rawName, rawStrength) => {
            const key = normalizedName(rawName);
            if (key) existing.add(key);
            const resolved = resolvedByName.get(key);
            const resolvedName = resolved ? loraName(resolved) : '';
            if (resolved) {
                for (const candidate of loraCandidateNames(resolved)) {
                    const candidateKey = normalizedName(candidate);
                    if (candidateKey) existing.add(candidateKey);
                }
            }
            return resolvedName ? `<lora:${resolvedName}:${rawStrength}>` : tag;
        },
    );

    const tags = [];
    for (const lora of entries) {
        const name = loraName(lora);
        const key = normalizedName(name);
        if (!name || !key || existing.has(key) || lora?.isDeleted) continue;
        const strength = finiteStrength(
            lora?.strength_model ?? lora?.weight ?? lora?.strength,
            1,
        );
        tags.push(`<lora:${name}:${strength}>`);
        existing.add(key);
    }
    if (tags.length === 0) return normalizedParameters;

    const insertion = ` ${tags.join(' ')}`;
    const negativeIndex = normalizedParameters.indexOf('\nNegative prompt:');
    if (negativeIndex >= 0) {
        return `${normalizedParameters.slice(0, negativeIndex).trimEnd()}${insertion}${normalizedParameters.slice(negativeIndex)}`;
    }

    const stepsIndex = normalizedParameters.lastIndexOf('\nSteps:');
    if (stepsIndex >= 0) {
        return `${normalizedParameters.slice(0, stepsIndex).trimEnd()}${insertion}${normalizedParameters.slice(stepsIndex)}`;
    }
    return `${normalizedParameters.trimEnd()}${insertion}`;
}

export function applyA1111LoraStrengths(graph, loras) {
    const entries = Array.isArray(loras) ? loras : [];
    if (!graph || entries.length === 0) return;

    const byName = indexLorasByUniqueName(entries);

    const nodes = Array.isArray(graph._nodes)
        ? graph._nodes
        : Array.isArray(graph.nodes)
            ? graph.nodes
            : [];
    for (const node of nodes) {
        if (node?.type !== 'LoraLoader' && node?.comfyClass !== 'LoraLoader') continue;
        const widgets = Array.isArray(node.widgets) ? node.widgets : [];
        const nameWidget = widgets.find(widget => widget?.name === 'lora_name');
        const key = normalizedName(nameWidget?.value);
        const lora = byName.get(key);
        if (!lora) continue;

        // The native A1111 importer can preserve a raw prompt alias or encode
        // slash separators. Restore the exact ComfyUI library value after it
        // has created the node, just as we restore the separate strengths.
        const resolvedName = loraName(lora);
        if (nameWidget && resolvedName) nameWidget.value = resolvedName;

        const modelStrength = finiteStrength(
            lora?.strength_model ?? lora?.weight ?? lora?.strength,
            1,
        );
        const clipStrength = finiteStrength(
            lora?.strength_clip ?? lora?.weight ?? lora?.strength,
            modelStrength,
        );
        const modelWidget = widgets.find(widget => widget?.name === 'strength_model');
        const clipWidget = widgets.find(widget => widget?.name === 'strength_clip');
        if (modelWidget) modelWidget.value = modelStrength;
        if (clipWidget) clipWidget.value = clipStrength;
    }
}
