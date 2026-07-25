export const DIFFICULTY_LEVELS = ['low', 'medium', 'high'];

export const COST_TIER_BY_DIFFICULTY = {
  low: 'cheap',
  medium: 'standard',
  high: 'premium',
};

// 任务领域维度。用于按模型擅长方向匹配 profile。
// 与 costTier 正交:同一 costTier 内不同模型可能有不同 strengths。
export const TASK_DOMAINS = ['frontend', 'backend', 'systems', 'algorithm', 'refactor', 'docs'];

// 模型支持的输入/输出模态。当前 Pi worker 架构禁止 visual 委派,
// 但保留字段以便未来放开 vision-input/image-output 时可路由。
export const MODALITIES = ['text', 'vision', 'image-output'];

// 关键词 → domain 推断表。命中即推断为该 domain;多个命中取首个。
// 仅当 task 未显式声明 domain 时使用。
const DOMAIN_KEYWORDS = [
  ['frontend', [/\bfront[- ]?end\b/i, /\bUI\b/i, /\bcomponent\b/i, /\bCSS\b/i, /\bReact\b/i, /\bVue\b/i, /\bSvelte\b/i, /\bSolid\b/i, /\b样式\b/, /\b组件\b/, /\b页面\b/, /\bbutton\b/i, /\bform\b/i, /\bcanvas\b/i, /\bSVG\b/i]],
  ['backend', [/\bback[- ]?end\b/i, /\bAPI\b/i, /\bendpoint\b/i, /\bservice\b/i, /\bdatabase\b/i, /\bSQL\b/i, /\bORM\b/i, /\bserver\b/i, /\broute\b/i, /\b接口\b/, /\b服务端\b/, /\bmigration\b/i, /\bschema\b/i]],
  ['systems', [/\bperformance\b/i, /\bconcurrency\b/i, /\bmemory\b/i, /\bcache\b/i, /\bruntime\b/i, /\bdaemon\b/i, /\bkernel\b/i, /\b性能\b/, /\b并发\b/, /\b内存\b/, /\b缓存\b/, /\bRuntime\b/i, /\bCLI\b/i, /\bbinary\b/i]],
  ['algorithm', [/\balgorithm\b/i, /\bsort(?:ing)?\b/i, /\bsearch(?:ing)?\b/i, /\bgraph\b/i, /\btree\b/i, /\bDP\b/i, /\bdynamic programming\b/i, /\b算法\b/, /\b排序\b/, /\b搜索\b/, /\bcomplexity\b/i]],
  ['refactor', [/\brefactor\b/i, /\bcleanup\b/i, /\brestructure\b/i, /\bmodernize\b/i, /\bmigrate\b/i, /\b重构\b/, /\b清理\b/, /\b迁移\b/]],
  ['docs', [/\bREADME\b/i, /\bdocumentation\b/i, /\bdocs\b/i, /\bCHANGELOG\b/i, /\b文档\b/, /\b说明\b/]],
];

export function inferDifficulty(task) {
  let score = 0;
  const signals = [];
  if ((task.goal ?? "").length > 800) { score += 2; signals.push('goal-length>800'); }
  else if ((task.goal ?? "").length > 300) { score += 1; signals.push('goal-length>300'); }
  if ((task.acceptanceCriteria ?? []).length >= 8) { score += 2; signals.push(`acceptance=${(task.acceptanceCriteria ?? []).length}`); }
  else if ((task.acceptanceCriteria ?? []).length >= 4) { score += 1; signals.push(`acceptance=${(task.acceptanceCriteria ?? []).length}`); }
  if (task.risk === 'high') { score += 3; signals.push('risk=high'); }
  else if (task.risk === 'medium') { score += 1; signals.push('risk=medium'); }
  if ((task.constraints ?? []).length >= 5) { score += 1; signals.push(`constraints=${(task.constraints ?? []).length}`); }
  if ((task.requiredCapabilities ?? []).includes('tool-use')) { score += 1; signals.push('tool-use'); }
  if ((task.verification ?? []).length >= 3) { score += 1; signals.push(`verification=${(task.verification ?? []).length}`); }
  if ((task.allowedPaths ?? []).length >= 5) { score += 1; signals.push(`allowedPaths=${(task.allowedPaths ?? []).length}`); }
  if ((task.forbiddenPaths ?? []).length >= 5) { score += 1; signals.push(`forbiddenPaths=${(task.forbiddenPaths ?? []).length}`); }

  let difficulty;
  if (score >= 5) difficulty = 'high';
  else if (score >= 2) difficulty = 'medium';
  else difficulty = 'low';
  return { difficulty, score, signals };
}

// 从 task.goal 文本推断 domain。task.domain 显式声明优先。
// 返回 { domain, source } —— source 为 'explicit' | 'inferred' | null。
export function inferTaskDomain(task) {
  if (typeof task.domain === 'string' && task.domain.length > 0) {
    return { domain: task.domain, source: 'explicit' };
  }
  const goal = task.goal ?? '';
  for (const [domain, patterns] of DOMAIN_KEYWORDS) {
    if (patterns.some((re) => re.test(goal))) {
      return { domain, source: 'inferred' };
    }
  }
  return { domain: null, source: null };
}

// 旧入口:仅按难度 costTier 选,保留向后兼容。
export function selectProfileByDifficulty(config, difficulty) {
  const targetTier = COST_TIER_BY_DIFFICULTY[difficulty];
  if (!targetTier) return null;
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.costTier === targetTier) return { name, ...profile };
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (profile.costTier && profile.costTier !== targetTier) continue;
    return { name, ...profile };
  }
  return null;
}

// 综合选择 profile。三层匹配:
//  1. 显式 options.profile → 直接返回(用户/调用方覆盖)
//  2. costTier 筛候选 → domain ∈ strengths 软匹配(命中即用,未命中继续)
//  3. modalities 硬匹配:task.requiredCapabilities 含 vision-input 时,profile.modalities 必须含 vision
//  4. 兜底:costTier 候选集第一个;若无 costTier 配置则 defaultProfile
// 注:仅在 config.profiles(用户实际接入的模型)里挑,不假设任何未配置的模型存在。
export function selectProfileForTask(config, task, options = {}) {
  // M5: high-risk 任务不委派给 Pi(除非显式指定 profile),直接返回 null 避免无效路由。
  if (task.risk === 'high' && !options.profile) return null;
  if (options.profile) {
    const named = config.profiles[options.profile];
    if (!named) throw new Error(`Unknown profile: ${options.profile}`);
    return { name: options.profile, ...named };
  }

  const { difficulty, score, signals } = inferDifficulty(task);
  const { domain, source: domainSource } = inferTaskDomain(task);
  const targetTier = COST_TIER_BY_DIFFICULTY[difficulty];

  // 候选集:严格匹配 costTier 的 profile。未声明 costTier 的 profile 不参与自动路由
  // (老配置无 costTier 时统一走 defaultProfile 兜底,避免按 Object.entries 顺序误选)。
  let candidates = Object.entries(config.profiles)
    .filter(([, p]) => p.costTier === targetTier)
    .map(([name, p]) => ({ name, ...p }));

  // 该 costTier 无候选:若用户根本没给任何 profile 配 costTier,回退到 defaultProfile;
  // 若用户配了其他 tier 但唯独缺这个 tier,则退化为全部 profile 兜底(优先保证能选出)。
  const hasAnyCostTier = Object.values(config.profiles).some((p) => p.costTier);
  if (candidates.length === 0) {
    if (!hasAnyCostTier && config.defaultProfile && config.profiles[config.defaultProfile]) {
      const dp = config.profiles[config.defaultProfile];
      return {
        name: config.defaultProfile,
        provider: dp.provider,
        model: dp.model,
        thinking: dp.thinking,
        apiKeyEnv: dp.apiKeyEnv,
        capabilities: dp.capabilities,
        fallbackProfiles: dp.fallbackProfiles ?? [],
        costTier: dp.costTier ?? null,
        strengths: dp.strengths ?? [],
        modalities: dp.modalities ?? ['text'],
        monthlyPlan: dp.monthlyPlan ?? null,
        routing: {
          difficulty, difficultyScore: score, difficultySignals: signals,
          domain, domainSource, targetTier,
          matchReason: 'defaultProfile-no-tier-configured',
          candidatesConsidered: [config.defaultProfile],
        },
      };
    }
    candidates = Object.entries(config.profiles).map(([name, p]) => ({ name, ...p }));
  }

  // modalities 硬匹配:视觉/图像任务必须路由到声明了对应 modality 的 profile。
  // 若候选集里没有,说明用户未配置视觉/图像模型 → 路由失败,返回 null 由调用方报阻塞。
  const needsVision = (task.requiredCapabilities ?? []).includes('vision-input');
  const needsImageOutput = (task.requiredCapabilities ?? []).includes('image-output');
  if (needsVision) {
    candidates = candidates.filter((p) => (p.modalities ?? ['text']).includes('vision'));
  }
  if (needsImageOutput) {
    candidates = candidates.filter((p) => (p.modalities ?? ['text']).includes('image-output'));
  }
  if (candidates.length === 0) return null;

  // domain strengths 软匹配:命中即优先,未命中保持原候选集。
  let selected = null;
  let matchReason = 'costTier-fallback';
  if (domain) {
    const strong = candidates.find((p) => Array.isArray(p.strengths) && p.strengths.includes(domain));
    if (strong) {
      selected = strong;
      matchReason = `strengths:${domain}`;
    }
  }
  if (!selected) {
    selected = candidates[0] ?? null;
    if (selected && domain && domainSource === 'inferred') {
      matchReason = `costTier-no-strength-match:${domain}`;
    } else if (selected) {
      matchReason = `costTier:${targetTier ?? 'none'}`;
    } else {
      matchReason = 'defaultProfile';
    }
  }

  // 最终兜底:defaultProfile。
  if (!selected && config.defaultProfile) {
    const dp = config.profiles[config.defaultProfile];
    if (dp) selected = { name: config.defaultProfile, ...dp };
  }

  return selected
    ? {
        name: selected.name,
        provider: selected.provider,
        model: selected.model,
        thinking: selected.thinking,
        apiKeyEnv: selected.apiKeyEnv,
        capabilities: selected.capabilities,
        fallbackProfiles: selected.fallbackProfiles ?? [],
        costTier: selected.costTier ?? null,
        strengths: selected.strengths ?? [],
        modalities: selected.modalities ?? ['text'],
        monthlyPlan: selected.monthlyPlan ?? null,
        routing: {
          difficulty,
          difficultyScore: score,
          difficultySignals: signals,
          domain,
          domainSource,
          targetTier,
          matchReason,
          candidatesConsidered: candidates.map((c) => c.name),
        },
      }
    : null;
}
