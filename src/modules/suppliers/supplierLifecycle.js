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
  deriveListingPeriod,
  isSupplierListed,
  syncSupplierLifecycle,
};
