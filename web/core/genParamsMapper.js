/**
 * genParamsMapper.js
 * Maps display/recipe generation parameter values (sampler, scheduler) to
 * ComfyUI internal widget values, enabling "Send Gen Params to Workflow".
 *
 * Strategy (3 layers):
 *   1. Direct lookup via SAMPLER_DISPLAY_TO_INTERNAL
 *   2. Combined-name parsing (e.g. "Euler a Karras" → sampler + scheduler)
 *   3. Graceful skip for model-specific / unrecognized values
 */

// ---------------------------------------------------------------------------
// Sampler display name → internal name (ComfyUI KSampler.SAMPLERS / SAMPLER_NAMES)
// ---------------------------------------------------------------------------
const SAMPLER_DISPLAY_TO_INTERNAL = {
    // --- Euler family ---
    'Euler':                     'euler',
    'euler':                     'euler',
    'Euler a':                   'euler_ancestral',
    'Euler A':                   'euler_ancestral',
    'Euler ancestral':           'euler_ancestral',
    'Euler Ancestral':           'euler_ancestral',
    'euler_ancestral':           'euler_ancestral',

    // --- Heun ---
    'Heun':                      'heun',
    'heun':                      'heun',
    'Heun++':                    'heunpp2',
    'heunpp2':                   'heunpp2',

    // --- DPM2 ---
    'DPM2':                      'dpm_2',
    'DPM 2':                     'dpm_2',
    'dpm_2':                     'dpm_2',
    'DPM2 a':                    'dpm_2_ancestral',
    'DPM2 Ancestral':            'dpm_2_ancestral',
    'dpm_2_ancestral':           'dpm_2_ancestral',

    // --- LMS ---
    'LMS':                       'lms',
    'lms':                       'lms',

    // --- DPM fast / adaptive ---
    'DPM fast':                  'dpm_fast',
    'DPM Fast':                  'dpm_fast',
    'dpm_fast':                  'dpm_fast',
    'DPM adaptive':              'dpm_adaptive',
    'DPM Adaptive':              'dpm_adaptive',
    'dpm_adaptive':              'dpm_adaptive',

    // --- DPM++ 2S ancestral ---
    'DPM++ 2S a':                'dpmpp_2s_ancestral',
    'DPM++ 2S A':                'dpmpp_2s_ancestral',
    'DPM++ 2S Ancestral':        'dpmpp_2s_ancestral',
    'dpmpp_2s_ancestral':        'dpmpp_2s_ancestral',
    // Older metadata occasionally drops the "S".  ComfyUI has never used
    // dpmpp_2_ancestral as a sampler name; the compatible implementation is 2S.
    'dpmpp_2_ancestral':         'dpmpp_2s_ancestral',

    // --- DPM++ SDE ---
    'DPM++ SDE':                 'dpmpp_sde',
    'dpmpp_sde':                 'dpmpp_sde',

    // --- DPM++ 2M ---
    'DPM++ 2M':                  'dpmpp_2m',
    'dpmpp_2m':                  'dpmpp_2m',

    // --- DPM++ 2M SDE ---
    'DPM++ 2M SDE':              'dpmpp_2m_sde',
    'dpmpp_2m_sde':              'dpmpp_2m_sde',

    // --- DPM++ 3M SDE ---
    'DPM++ 3M SDE':              'dpmpp_3m_sde',
    'dpmpp_3m_sde':              'dpmpp_3m_sde',

    // --- Others ---
    'DDIM':                      'ddim',
    'ddim':                      'ddim',
    'DDPM':                      'ddpm',
    'ddpm':                      'ddpm',
    'LCM':                       'lcm',
    'lcm':                       'lcm',
    'IPNDM':                     'ipndm',
    'ipndm':                     'ipndm',
    'DEIS':                      'deis',
    'deis':                      'deis',
    'UniPC':                     'uni_pc',
    'unipc':                     'uni_pc',
    'uni_pc':                    'uni_pc',

    // --- Restart / res_multistep ---
    'Restart':                   'res_multistep',
    'res_multistep':             'res_multistep',

    // --- ER SDE ---
    'ER SDE':                    'er_sde',
    'E-R SDE':                   'er_sde',
    'er_sde':                     'er_sde',

    // --- SA Solver ---
    'SA Solver':                 'sa_solver',
    'SA solver':                 'sa_solver',
    'sa_solver':                 'sa_solver',

    // --- Seeds ---
    'Seeds 2':                   'seeds_2',
    'seeds_2':                   'seeds_2',
    'Seeds 3':                   'seeds_3',
    'seeds_3':                   'seeds_3',
};

// ---------------------------------------------------------------------------
// Known scheduler suffixes (ComfyUI KSampler.SCHEDULERS)
// Sorted by length (descending) for longest-match-first parsing.
// ---------------------------------------------------------------------------
const SCHEDULER_SUFFIXES = [
    'sgm_uniform',
    'ddim_uniform',
    'linear_quadratic',
    'kl_optimal',
    'exponential',
    'karras',
    'simple',
    'normal',
    'beta',
];

// ---------------------------------------------------------------------------
// Scheduler-only values (values that are schedulers, not samplers)
// ---------------------------------------------------------------------------
const SCHEDULER_ONLY_VALUES = new Set([
    'simple', 'sgm_uniform', 'karras', 'exponential',
    'ddim_uniform', 'beta', 'normal', 'linear_quadratic', 'kl_optimal',
]);

/**
 * A1111 / Forge の `Schedule type` は**表示名**なので語間が空白になる。
 * `SGM Uniform` / `DDIM Uniform` / `Linear Quadratic` / `KL Optimal` の4種は
 * 小文字化だけでは ComfyUI の内部名（`sgm_uniform` 等）に一致せず、
 * **記録されているのに落ちて既定の `normal` になっていた**
 * （実測 2026-08-10 / 346レシピ: 記録あり86件中1件・`Civitai_Recipe_131241081`）。
 */
function schedulerKeyOf(value) {
    return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * CFG++ 系サンプラーは基底サンプラーの変種で、ComfyUI の内部名は末尾 `_cfg_pp`。
 * A1111 / Forge は表示名の末尾に `CFG++` を付けて記録する（例: `Euler a CFG++`）。
 * 対応表に無かったため `Euler a CFG++` が **`euler` へ落ちていた**——
 * ancestral と CFG++ の両方が消える。CFG++ は低CFG（1〜2）前提の手法なので、
 * 記録どおりの低いCFGのまま素の euler を回すと**眠く淡い絵**になる
 * （実測 2026-08-10 / `Civitai_Recipe_131241081`・cfg 1.5・ユーザー報告「少しぼやけている」）。
 *
 * 個別の表示名を並べるのではなく**接尾辞を剥がして基底を解く**ので、
 * `DPM++ 2M CFG++` のような未収録の綴りも同じ規則で通る。ただし ComfyUI に
 * 実在する変種だけを採用する（下の集合に無ければ従来どおり解決失敗として扱う）。
 */
const CFG_PP_SAMPLERS = new Set([
    'euler_cfg_pp',
    'euler_ancestral_cfg_pp',
    'dpmpp_2s_ancestral_cfg_pp',
    'dpmpp_2m_cfg_pp',
    'res_multistep_cfg_pp',
    'res_multistep_ancestral_cfg_pp',
    'gradient_estimation_cfg_pp',
]);
const CFG_PP_SUFFIX = /[\s_-]*cfg[\s_-]*(?:\+\+|pp)\s*$/i;

// ---------------------------------------------------------------------------
// Param key → widget name candidates (searched in order)
// ---------------------------------------------------------------------------
const PARAM_TO_WIDGET_CANDIDATES = {
    seed:      ['seed', 'noise_seed'],
    steps:     ['steps'],
    cfg:       ['cfg'],
    sampler:   ['sampler_name', 'sampler'],
    scheduler: ['scheduler'],
};

// ---------------------------------------------------------------------------
// Parse a combined sampler+scheduler value (space-separated or underscore)
// e.g., "Euler a Karras", "DPM++ 2M beta", "er_sde_beta"
// Returns { sampler: internalName|null, scheduler: internalName|null } or null
// ---------------------------------------------------------------------------
function parseCombinedSamplerName(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;
    const trimmed = rawValue.trim();
    if (!trimmed) return null;

    // Try space-separated first: split on last space
    const spaceIdx = trimmed.lastIndexOf(' ');
    if (spaceIdx > 0) {
        const candidateScheduler = trimmed.slice(spaceIdx + 1).trim().toLowerCase();
        if (SCHEDULER_SUFFIXES.includes(candidateScheduler)) {
            const samplerPart = trimmed.slice(0, spaceIdx).trim();
            const internalSampler = SAMPLER_DISPLAY_TO_INTERNAL[samplerPart];
            if (internalSampler) {
                return { sampler: internalSampler, scheduler: candidateScheduler };
            }
            // samplerPart might be a combined name itself (e.g., "DPM++ 2M SDE")
            // Try recursing (one level max) — already handled since we split at last space
        }
    }

    // Try underscore-separated: e.g., "er_sde_beta"
    const underIdx = trimmed.lastIndexOf('_');
    if (underIdx > 0) {
        const candidateScheduler = trimmed.slice(underIdx + 1).trim().toLowerCase();
        if (SCHEDULER_SUFFIXES.includes(candidateScheduler)) {
            const samplerPart = trimmed.slice(0, underIdx).trim();
            const internalSampler = SAMPLER_DISPLAY_TO_INTERNAL[samplerPart] || SAMPLER_DISPLAY_TO_INTERNAL[samplerPart.toLowerCase()];
            if (internalSampler) {
                return { sampler: internalSampler, scheduler: candidateScheduler };
            }
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Main resolver: takes a raw sampler value from recipe/showcase metadata
// and returns { sampler: internalName|null, scheduler: internalName|null }
// ---------------------------------------------------------------------------
function resolveSamplerScheduler(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') {
        return { sampler: null, scheduler: null };
    }

    const trimmed = rawValue.trim();
    if (!trimmed) return { sampler: null, scheduler: null };

    // 1. Try direct lookup first
    const direct = SAMPLER_DISPLAY_TO_INTERNAL[trimmed];
    if (direct) return { sampler: direct, scheduler: null };

    // 2. Try lowercase direct lookup
    const lowerDirect = SAMPLER_DISPLAY_TO_INTERNAL[trimmed.toLowerCase()];
    if (lowerDirect) return { sampler: lowerDirect, scheduler: null };

    // 2.5. CFG++ 変種。基底を解いてから `_cfg_pp` を戻す。
    //      先に置くのは、`Euler a CFG++` が下の combined 解析で
    //      `Euler a` + 未知語へ割れて ancestral だけ拾われるのを防ぐため。
    if (CFG_PP_SUFFIX.test(trimmed)) {
        const base = resolveSamplerScheduler(trimmed.replace(CFG_PP_SUFFIX, '').trim());
        if (base.sampler) {
            const candidate = `${base.sampler}_cfg_pp`;
            if (CFG_PP_SAMPLERS.has(candidate)) {
                return { sampler: candidate, scheduler: base.scheduler };
            }
        }
    }

    // 3. Scheduler-only value? (check BEFORE the "already internal name" regex,
    //    because scheduler values like "karras", "simple" also match that pattern)
    //    表示名の空白は内部名のアンダースコアに対応させる（`SGM Uniform` 等）。
    const schedulerKey = schedulerKeyOf(trimmed);
    if (SCHEDULER_ONLY_VALUES.has(schedulerKey)) {
        return { sampler: null, scheduler: schedulerKey };
    }

    // 4. Try combined name parsing before accepting an internal-looking name.
    //    Values such as dpmpp_2m_beta contain both sampler and scheduler.
    const combined = parseCombinedSamplerName(trimmed);
    if (combined) return combined;

    // 5. Already an internal name? (lowercase, no spaces)
    if (/^[a-z][a-z0-9_]+$/.test(trimmed)) {
        return { sampler: trimmed, scheduler: null };
    }

    // 6. Custom format like "multistep/dpmpp_2m_simple" — try extracting the last segment
    if (trimmed.includes('/')) {
        const parts = trimmed.split('/');
        const last = parts[parts.length - 1];
        if (last) {
            const subResult = resolveSamplerScheduler(last);
            if (subResult.sampler || subResult.scheduler) return subResult;
        }
    }

    // 7. Unrecognized — return null for both
    return { sampler: null, scheduler: null };
}

// ---------------------------------------------------------------------------
// Find which gen params can be sent to a given node, matching by widget names
// Returns array of { widgetName, value } objects
// ---------------------------------------------------------------------------
function findMatchingWidgets(nodeWidgetNames, resolvedParams) {
    if (!nodeWidgetNames || !Array.isArray(nodeWidgetNames) || nodeWidgetNames.length === 0) {
        return [];
    }

    const widgetSet = new Set(nodeWidgetNames.map(w => String(w).toLowerCase()));
    const updates = [];

    // Simple numeric/string params: seed, steps, cfg
    const simpleParams = [
        { key: 'seed', value: resolvedParams.seed },
        { key: 'steps', value: resolvedParams.steps },
        { key: 'cfg', value: resolvedParams.cfg },
    ];
    for (const { key, value } of simpleParams) {
        if (value === undefined || value === null || value === '') continue;
        const candidates = PARAM_TO_WIDGET_CANDIDATES[key] || [key];
        for (const candidate of candidates) {
            if (widgetSet.has(candidate.toLowerCase())) {
                updates.push({ widgetName: candidate, value: String(value) });
                break;
            }
        }
    }

    // Sampler
    if (resolvedParams.sampler) {
        const candidates = PARAM_TO_WIDGET_CANDIDATES.sampler;
        for (const candidate of candidates) {
            if (widgetSet.has(candidate.toLowerCase())) {
                updates.push({ widgetName: candidate, value: resolvedParams.sampler });
                break;
            }
        }
    }

    // Scheduler
    if (resolvedParams.scheduler) {
        const candidates = PARAM_TO_WIDGET_CANDIDATES.scheduler;
        for (const candidate of candidates) {
            if (widgetSet.has(candidate.toLowerCase())) {
                updates.push({ widgetName: candidate, value: resolvedParams.scheduler });
                break;
            }
        }
    }

    return updates;
}

export {
    SAMPLER_DISPLAY_TO_INTERNAL,
    SCHEDULER_SUFFIXES,
    SCHEDULER_ONLY_VALUES,
    PARAM_TO_WIDGET_CANDIDATES,
    parseCombinedSamplerName,
    resolveSamplerScheduler,
    findMatchingWidgets,
};
