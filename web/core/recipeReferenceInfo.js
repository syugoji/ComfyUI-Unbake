/*
 * Copyright (C) 2026 syugoji
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ComfyUI-Unbake の一部。**この行の意味**——著作権の所在を明示してある限り、
 * 後から別のライセンスを足せる。表示が無いまま配ると、それが言いづらくなる。
 */
import { t } from '../i18n/index.js';
// Build a plain-text reference summary of a recipe (checkpoint, LoRA stack,
// prompts, generation params). Recipes that cannot be replayed still carry
// reference value in their ingredients — this makes them extractable.

export const PARAM_DISPLAY_NAMES = {
    steps: 'Steps',
    sampler: 'Sampler',
    scheduler: 'Scheduler',
    cfg_scale: 'CFG',
    seed: 'Seed',
    size: 'Size',
    clip_skip: 'Clip Skip',
    denoising_strength: 'Denoising Strength',
    model: 'Model',
    vae: 'VAE',
    hires_upscale: 'Hires Upscale',
    hires_resize: 'Hires Resize',
    hires_steps: 'Hires Steps',
    hires_upscaler: 'Hires Upscaler',
    hires_cfg_scale: 'Hires CFG',
};

function resourceStatus(resource) {
    if (resource?.isDeleted) return t('core.recipeReferenceInfo.1');
    // Two different payload shapes report local ownership, and each one omits
    // the other's key: the analysis endpoints (analyze-image /
    // analyze-local-image) emit `existsLocally`, while the recipe detail
    // endpoint (/api/lm/recipe/{id}) — the one the modal actually renders from
    // — emits `inLibrary`. Checking only `existsLocally` silently dropped the
    // 未所持 mark for every recipe opened from the UI.
    if (resource?.existsLocally === false || resource?.inLibrary === false) {
        return t('core.recipeReferenceInfo.2');
    }
    return '';
}

function resourceLabel(resource) {
    const name = resource?.name || resource?.file_name || resource?.modelName || 'Unknown';
    const parts = [String(name)];
    if (resource?.version) parts.push(`(${resource.version})`);
    const hash = String(resource?.hash || '').slice(0, 12);
    if (hash) parts.push(`[${hash}]`);
    const status = resourceStatus(resource);
    if (status) parts.push(`※${status}`);
    return parts.join(' ');
}

export function buildRecipeReferenceText(recipe) {
    if (!recipe || typeof recipe !== 'object') return '';
    const lines = [];
    if (recipe.title) lines.push(t('core.recipeReferenceInfo.3', { p1: recipe.title }));

    const checkpoint = recipe.checkpoint;
    if (checkpoint && typeof checkpoint === 'object') {
        lines.push(`Checkpoint: ${resourceLabel(checkpoint)}`);
    }

    for (const lora of Array.isArray(recipe.loras) ? recipe.loras : []) {
        if (!lora || typeof lora !== 'object') continue;
        const weight = lora.weight ?? lora.strength ?? 1;
        lines.push(`LoRA: ${resourceLabel(lora)} x${weight}`);
    }

    for (const embedding of Array.isArray(recipe.embeddings) ? recipe.embeddings : []) {
        if (!embedding || typeof embedding !== 'object') continue;
        lines.push(`Embedding: ${resourceLabel(embedding)}`);
    }

    const genParams = recipe.gen_params && typeof recipe.gen_params === 'object'
        ? recipe.gen_params
        : {};
    if (genParams.prompt) {
        lines.push('', 'Prompt:', String(genParams.prompt));
    }
    if (genParams.negative_prompt) {
        lines.push('', 'Negative prompt:', String(genParams.negative_prompt));
    }

    const paramParts = [];
    for (const [key, value] of Object.entries(genParams)) {
        if (key === 'prompt' || key === 'negative_prompt') continue;
        if (value === undefined || value === null || value === '') continue;
        paramParts.push(`${PARAM_DISPLAY_NAMES[key] || key}: ${value}`);
    }
    if (paramParts.length) lines.push('', paramParts.join(' | '));

    if (recipe.source_path) lines.push('', `Source: ${recipe.source_path}`);

    return lines.join('\n');
}
