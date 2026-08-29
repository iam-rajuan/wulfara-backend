const ONBOARDING_STEPS = {
  INDUSTRY: 'industry',
  COMPANY_INFO: 'company-info',
  SUBSCRIPTION: 'subscription',
  PAYMENT: 'payment',
  LISTED: 'listed',
};

const PLACEHOLDER_DESCRIPTIONS = [
  'Profile pending details. Please update your company description in settings.',
  'Profile created by admin.',
];

const hasMeaningfulDescription = (description = '') => {
  if (!description) {
    return false;
  }

  return !PLACEHOLDER_DESCRIPTIONS.includes(description.trim());
};

const hasCompanyInfo = (supplier) => {
  if (!supplier) {
    return false;
  }

  return Boolean(
    supplier.companyName &&
      supplier.contactEmail &&
      supplier.contactPhone &&
      supplier.location?.formattedAddress &&
      hasMeaningfulDescription(supplier.description)
  );
};

const hasIndustrySelection = (supplier) =>
  Boolean(supplier && Array.isArray(supplier.categories) && supplier.categories.length > 0);

const hasSelectedPlan = (supplier) =>
  Boolean(
    supplier &&
      (supplier.selectedPlan ||
        (supplier.subscriptionPlan && supplier.subscriptionPlan !== 'free'))
  );

const formatListingPeriodLabel = (durationMonths) => {
  const duration = Number(durationMonths);

  if (!Number.isInteger(duration) || duration <= 0) {
    return '';
  }

  return `${duration} ${duration === 1 ? 'Month' : 'Months'}`;
};

const normalizeListingPeriodLabel = (value = '') =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');

const getPlanListingPeriodOptions = (plan) => {
  const listingPeriods = Array.isArray(plan?.listingPeriods) ? plan.listingPeriods : [];

  return listingPeriods
    .filter(
      (period) =>
        period?.isActive !== false &&
        Number.isInteger(Number(period?.durationMonths)) &&
        Number(period?.durationMonths) > 0
    )
    .map((period) => ({
      durationMonths: Number(period.durationMonths),
      discountPercent: Number(period.discountPercent || 0),
      customLabel: typeof period?.customLabel === 'string' ? period.customLabel.trim() : '',
      label: formatListingPeriodLabel(period.durationMonths),
    }))
    .sort((a, b) => a.durationMonths - b.durationMonths);
};

const normalizeDiscountPercent = (discountPercent = 0) => {
  const parsedDiscount = Number(discountPercent || 0);

  if (Number.isNaN(parsedDiscount)) {
    return 0;
  }

  return Math.min(Math.max(parsedDiscount, 0), 100);
};

const calculateDiscountedPlanPrice = (basePrice = 0, discountPercent = 0) => {
  const parsedBasePrice = Number(basePrice || 0);
  const normalizedDiscount = normalizeDiscountPercent(discountPercent);

  if (Number.isNaN(parsedBasePrice) || parsedBasePrice <= 0) {
    return 0;
  }

  return Math.round((parsedBasePrice * (1 - normalizedDiscount / 100)) * 100) / 100;
};

const deriveListingPeriod = (billingCycle = '', fallback = '') => {
  const normalizedBillingCycle = String(billingCycle || '').trim().toLowerCase();

  if (!normalizedBillingCycle) {
    return fallback || '';
  }

  if (normalizedBillingCycle.includes('month')) {
    return '1 Month';
  }

  if (normalizedBillingCycle.includes('quarter')) {
    return '3 Months';
  }

  if (normalizedBillingCycle.includes('semi') || normalizedBillingCycle.includes('6')) {
    return '6 Months';
  }

  if (normalizedBillingCycle.includes('annual') || normalizedBillingCycle.includes('year') || normalizedBillingCycle.includes('12')) {
    return '12 Months';
  }

  return fallback || billingCycle;
};

const resolvePlanListingPeriod = (plan, preferredValue = '', billingCycleFallback = '') => {
  const resolvedOption = resolvePlanListingPeriodOption(plan, preferredValue, billingCycleFallback);
  return resolvedOption.label;
};

const resolvePlanListingPeriodOption = (plan, preferredValue = '', billingCycleFallback = '') => {
  const options = getPlanListingPeriodOptions(plan);

  if (options.length > 0) {
    const normalizedPreferred = normalizeListingPeriodLabel(preferredValue);
    const matchedOption = options.find((option) => {
      const canonical = normalizeListingPeriodLabel(option.label);
      const singular = normalizeListingPeriodLabel(`${option.durationMonths} month`);
      const plural = normalizeListingPeriodLabel(`${option.durationMonths} months`);

      return normalizedPreferred && (
        normalizedPreferred === canonical ||
        normalizedPreferred === singular ||
        normalizedPreferred === plural
      );
    });

    return matchedOption || options[0];
  }

  return {
    durationMonths: null,
    discountPercent: 0,
    customLabel: '',
    label: deriveListingPeriod(billingCycleFallback || plan?.billingCycle || '', preferredValue),
  };
};

const isSupplierListed = (supplier) =>
  Boolean(
    supplier &&
      (
        (
          supplier.subscriptionStatus === 'active' &&
          supplier.paymentStatus === 'paid' &&
          supplier.isApproved === true &&
          supplier.listingStatus === 'Approved'
        ) ||
        (
          supplier.onboardingStep === ONBOARDING_STEPS.LISTED &&
          supplier.onboardingCompletedAt
        )
      )
  );

const getNextOnboardingStep = (supplier) => {
  if (!hasIndustrySelection(supplier)) {
    return ONBOARDING_STEPS.INDUSTRY;
  }

  if (!hasCompanyInfo(supplier)) {
    return ONBOARDING_STEPS.COMPANY_INFO;
  }

  if (!hasSelectedPlan(supplier)) {
    return ONBOARDING_STEPS.SUBSCRIPTION;
  }

  if (!isSupplierListed(supplier)) {
    return ONBOARDING_STEPS.PAYMENT;
  }

  return ONBOARDING_STEPS.LISTED;
};

const syncSupplierLifecycle = (supplier) => {
  const nextStep = getNextOnboardingStep(supplier);
  supplier.onboardingStep = nextStep;

  if (nextStep === ONBOARDING_STEPS.LISTED) {
    supplier.onboardingCompletedAt = supplier.onboardingCompletedAt || new Date();
  } else {
    supplier.onboardingCompletedAt = null;
  }

  return nextStep;
};

const getOnboardingRoute = (step) => {
  switch (step) {
    case ONBOARDING_STEPS.INDUSTRY:
      return '/choose-industry';
    case ONBOARDING_STEPS.COMPANY_INFO:
      return '/company-info';
    case ONBOARDING_STEPS.SUBSCRIPTION:
      return '/subscription';
    case ONBOARDING_STEPS.PAYMENT:
      return '/subscription';
    case ONBOARDING_STEPS.LISTED:
    default:
      return '/dashboard';
  }
};

module.exports = {
  ONBOARDING_STEPS,
  getNextOnboardingStep,
  getOnboardingRoute,
  hasCompanyInfo,
  hasIndustrySelection,
  hasSelectedPlan,
  calculateDiscountedPlanPrice,
  formatListingPeriodLabel,
  getPlanListingPeriodOptions,
  deriveListingPeriod,
  resolvePlanListingPeriod,
  resolvePlanListingPeriodOption,
  isSupplierListed,
  syncSupplierLifecycle,
};
