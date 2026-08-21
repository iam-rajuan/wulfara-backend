const PLAN_TIERS = ['free', 'basic', 'pro', 'premium'];

const normalizeCandidate = (value = '') => value.toString().trim().toLowerCase();

const inferPlanTier = (source) => {
  if (!source) {
    return 'free';
  }

  const plan =
    typeof source === 'string'
      ? { name: source }
      : source;

  const candidates = [
    plan.tier,
    plan.internalName,
    plan.slug,
    plan.name,
  ]
    .filter(Boolean)
    .map(normalizeCandidate);

  for (const candidate of candidates) {
    if (PLAN_TIERS.includes(candidate)) {
      return candidate;
    }

    if (candidate.includes('premium')) {
      return 'premium';
    }

    if (candidate === 'pro' || candidate.includes('-pro') || candidate.includes(' pro ')) {
      return 'pro';
    }

    if (candidate.includes('basic') || candidate.includes('starter')) {
      return 'basic';
    }

    if (candidate.includes('free')) {
      return 'free';
    }
  }

  if (typeof plan.price === 'number' && plan.price <= 0) {
    return 'free';
  }

  return 'premium';
};

module.exports = {
  PLAN_TIERS,
  inferPlanTier,
};
