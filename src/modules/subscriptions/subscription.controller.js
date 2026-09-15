const Supplier = require('../suppliers/supplier.model');
const Payment = require('./payment.model');
const Subscription = require('./subscription.model');
const { getStripeConfig } = require('./stripeConfig');

const { isProduction, stripeSecretKey, stripeWebhookSecret } = getStripeConfig();
const stripe = require('stripe')(stripeSecretKey || 'sk_test_dummy');
const PricingPlan = require('./pricingPlan.model');
const { inferPlanTier } = require('./planTier');
const { resolveDashboardOrigin } = require('../../utils/origins');
const {
  FEATURED_HERO_PLACEMENT,
  resolveSubscriptionAddons,
  sumAddonAmount,
} = require('./subscriptionAddons');
const {
  calculateDiscountedPlanPrice,
  hasCompanyInfo,
  hasIndustrySelection,
  resolvePlanListingPeriodOption,
  syncSupplierLifecycle,
} = require('../suppliers/supplierLifecycle');
const {
  STRIPE_ENVIRONMENT,
  STRIPE_SOURCE,
  ensureMonthlyPriceForPlan,
  syncBaseMonthlyPriceForPlan,
} = require('./stripeBilling.service');
const { expireElapsedSubscriptions } = require('./subscriptionEntitlement.service');
const {
  MONTHLY_SUBSCRIPTION_STATUSES,
  TERMINAL_STRIPE_SUBSCRIPTION_STATUSES,
  addUtcMonths,
  centsToAmount,
  dateFromUnix,
  getInvoicePaymentIntentId,
  getInvoicePeriod,
  getInvoiceSubscriptionId,
  getStripeObjectId,
  isMonthlyBillingCycle,
  toCents,
  unixFromDate,
} = require('./billingUtils');

const DEFAULT_LISTING_PERIODS = [
  { durationMonths: 12, isActive: true, discountPercent: 0, customLabel: '' },
  { durationMonths: 24, isActive: true, discountPercent: 15, customLabel: '' },
  { durationMonths: 48, isActive: true, discountPercent: 25, customLabel: '' },
];

const cloneDefaultListingPeriods = () =>
  DEFAULT_LISTING_PERIODS.map((period) => ({ ...period }));

const centsMatch = (left = 0, right = 0) => toCents(left) === toCents(right);

const isDuplicateKeyError = (error) => error?.code === 11000 || error?.code === 11001;

const throwDuplicateCheckoutError = () => {
  const error = new Error('An active or incomplete subscription already exists for this supplier.');
  error.statusCode = 409;
  throw error;
};

const getInvoiceMetadata = (invoice = {}) => ({
  ...(invoice.subscription_details?.metadata || {}),
  ...(invoice.metadata || {}),
});

const logStripeFlow = (scope, message, details = {}) => {
  console.info(`[${scope}] ${message}`, details);
};

const hasNoFurtherAutomaticPayments = (subscriptionRecord, periodEnd) =>
  Boolean(
    subscriptionRecord?.cancelAt &&
      periodEnd &&
      new Date(periodEnd).getTime() >= new Date(subscriptionRecord.cancelAt).getTime()
  );

const parseDurationMonths = (value) => {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string') {
    return Number.NaN;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return Number.NaN;
  }

  if (!/^\d+$/.test(trimmed)) {
    return Number.NaN;
  }

  return Number.parseInt(trimmed, 10);
};

const normalizeListingPeriods = (listingPeriods, { fallbackToDefault = false } = {}) => {
  if (listingPeriods === undefined) {
    return fallbackToDefault ? cloneDefaultListingPeriods() : undefined;
  }

  if (!Array.isArray(listingPeriods)) {
    const error = new Error('Listing periods must be an array.');
    error.statusCode = 400;
    throw error;
  }

  if (listingPeriods.length === 0) {
    const error = new Error('At least one listing period is required.');
    error.statusCode = 400;
    throw error;
  }

  const normalized = listingPeriods.map((period, index) => {
    const durationMonths = parseDurationMonths(period?.durationMonths);
    if (!Number.isInteger(durationMonths)) {
      const error = new Error(`Listing period #${index + 1}: duration must be an integer.`);
      error.statusCode = 400;
      throw error;
    }

    if (durationMonths <= 0) {
      const error = new Error(`Listing period #${index + 1}: duration must be greater than 0.`);
      error.statusCode = 400;
      throw error;
    }

    const rawDiscount = period?.discountPercent ?? 0;
    const discountPercent = rawDiscount === '' ? 0 : Number(rawDiscount);
    if (Number.isNaN(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      const error = new Error(`Listing period #${index + 1}: discount must be between 0 and 100.`);
      error.statusCode = 400;
      throw error;
    }

    return {
      durationMonths,
      isActive: period?.isActive !== false,
      discountPercent,
      customLabel: typeof period?.customLabel === 'string' ? period.customLabel.trim() : '',
    };
  });

  const duplicateDuration = normalized.find(
    (period, index) =>
      normalized.findIndex((candidate) => candidate.durationMonths === period.durationMonths) !== index
  );

  if (duplicateDuration) {
    const error = new Error(`A ${duplicateDuration.durationMonths}-month listing period already exists.`);
    error.statusCode = 400;
    throw error;
  }

  normalized.sort((a, b) => a.durationMonths - b.durationMonths);
  return normalized;
};

const serializePlan = (plan) => {
  const planObject = plan?.toObject ? plan.toObject() : plan;

  return {
    ...planObject,
    listingPeriods: normalizeListingPeriods(planObject?.listingPeriods, { fallbackToDefault: true }),
  };
};

const normalizePlanIdentity = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const ensureUniquePlanFields = async ({ id, internalName, name, slug }) => {
  const normalizedInternalName = normalizePlanIdentity(internalName);
  const normalizedName = normalizePlanIdentity(name);
  const normalizedSlug = normalizePlanIdentity(slug);

  if (!normalizedInternalName && !normalizedName && !normalizedSlug) {
    return;
  }

  const plans = await PricingPlan.find(id ? { _id: { $ne: id } } : {}).select('internalName name slug');

  const duplicatePlan = plans.find((plan) => {
    const planInternalName = normalizePlanIdentity(plan.internalName);
    const planName = normalizePlanIdentity(plan.name);
    const planSlug = normalizePlanIdentity(plan.slug);

    return (
      (normalizedInternalName && planInternalName === normalizedInternalName) ||
      (normalizedName && planName === normalizedName) ||
      (normalizedSlug && planSlug === normalizedSlug)
    );
  });

  if (!duplicatePlan) {
    return;
  }

  const duplicateField =
    normalizedSlug && normalizePlanIdentity(duplicatePlan.slug) === normalizedSlug
      ? 'slug'
      : normalizedInternalName &&
          normalizePlanIdentity(duplicatePlan.internalName) === normalizedInternalName
        ? 'internal name'
        : 'display name';

  const error = new Error(`A pricing plan with this ${duplicateField} already exists.`);
  error.statusCode = 400;
  throw error;
};

const ACTIVE_SUPPLIER_MATCH = {
  subscriptionStatus: 'active',
  paymentStatus: 'paid',
  isApproved: true,
  listingStatus: 'Approved',
};

const buildAdminSubscriptionOverview = async ({ status = 'all' } = {}) => {
  const normalizedStatus = String(status || 'all').trim().toLowerCase();
  const planMatch = {};

  if (normalizedStatus === 'active') {
    planMatch.isActive = true;
  } else if (normalizedStatus === 'draft') {
    planMatch.isActive = false;
  }

  const [plans, activeSupplierCounts, paidSuppliers, paidPayments, totalSuppliers] = await Promise.all([
    PricingPlan.find(planMatch).sort({ createdAt: -1 }),
    Supplier.aggregate([
      { $match: ACTIVE_SUPPLIER_MATCH },
      {
        $group: {
          _id: '$selectedPlan',
          count: { $sum: 1 },
        },
      },
    ]),
    Supplier.countDocuments(ACTIVE_SUPPLIER_MATCH),
    Payment.find({ status: 'paid' }).select('supplier plan amount createdAt'),
    Supplier.countDocuments(),
  ]);

  const supplierCountByPlanId = new Map(
    activeSupplierCounts
      .filter((entry) => entry?._id)
      .map((entry) => [entry._id.toString(), entry.count])
  );

  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const monthlyRevenue = paidPayments.reduce((total, payment) => {
    const createdAt = payment?.createdAt ? new Date(payment.createdAt) : null;
    if (!createdAt || createdAt < currentMonthStart || createdAt >= nextMonthStart) {
      return total;
    }

    return total + Number(payment.amount || 0);
  }, 0);

  const revenueByPlanId = new Map();
  paidPayments.forEach((payment) => {
    if (!payment?.plan) {
      return;
    }

    const planId = payment.plan.toString();
    const nextTotal = (revenueByPlanId.get(planId) || 0) + Number(payment.amount || 0);
    revenueByPlanId.set(planId, nextTotal);
  });

  const plansWithStats = plans.map((plan) => {
    const serialized = serializePlan(plan);
    const planId = plan._id.toString();

    return {
      ...serialized,
      activeSuppliersCount: supplierCountByPlanId.get(planId) || 0,
      lifetimeRevenue: revenueByPlanId.get(planId) || 0,
    };
  });

  const activePlansCount = plansWithStats.filter((plan) => plan.isActive).length;
  const packageConversion =
    totalSuppliers > 0 ? Number(((paidSuppliers / totalSuppliers) * 100).toFixed(1)) : 0;

  return {
    plans: plansWithStats,
    metrics: {
      activePackages: activePlansCount,
      paidSuppliers,
      monthlyRevenue,
      packageConversion,
      totalSuppliers,
    },
    filters: {
      status: normalizedStatus,
    },
  };
};

const getSupplierForCheckout = async (req) => {
  if (req.user.role === 'admin' && req.body.supplierId) {
    return Supplier.findById(req.body.supplierId);
  }

  return Supplier.findOne({ user: req.user.id });
};

const buildCheckoutQueries = (req, supplierProfile) => ({
  successQuery:
    req.user.role === 'admin'
      ? `?session_id={CHECKOUT_SESSION_ID}&supplierId=${supplierProfile._id.toString()}&mode=admin_assisted`
      : '?session_id={CHECKOUT_SESSION_ID}',
  cancelQuery:
    req.user.role === 'admin'
      ? `?cancelled=1&supplierId=${supplierProfile._id.toString()}&mode=admin_assisted`
      : '?cancelled=1',
});

const buildAddonSnapshots = (addons = []) =>
  addons.map((addon) => ({
    code: addon.code,
    name: addon.name,
    amount: addon.price ?? addon.amount ?? 0,
  }));

const buildCheckoutMetadata = ({
  supplierProfile,
  plan,
  billingCycle,
  listingPeriod,
  listingDiscountPercent,
  durationMonths,
  addons,
  checkoutType,
}) => ({
  supplierId: supplierProfile._id.toString(),
  planId: plan._id.toString(),
  planName: plan.name,
  planTier: inferPlanTier(plan),
  billingCycle,
  listingPeriod,
  durationMonths: String(durationMonths || ''),
  listingDiscountPercent: String(listingDiscountPercent || 0),
  addons: JSON.stringify(addons.map((addon) => addon.code)),
  selectedAddonIds: JSON.stringify(addons.map((addon) => addon.code)),
  featuredHeroPlacement: String(addons.some((addon) => addon.code === FEATURED_HERO_PLACEMENT.code)),
  featuredHeroPlacementAmount: String(
    addons.find((addon) => addon.code === FEATURED_HERO_PLACEMENT.code)?.price || 0
  ),
  checkoutType,
  environment: STRIPE_ENVIRONMENT,
  source: STRIPE_SOURCE,
});

const updateSupplierPendingSelection = async ({
  supplierProfile,
  plan,
  billingCycle,
  listingPeriod,
  addons,
}) => {
  supplierProfile.selectedPlan = plan._id;
  supplierProfile.selectedBillingCycle = billingCycle;
  supplierProfile.selectedListingPeriod = listingPeriod;
  supplierProfile.selectedAddons = addons.map((addon) => addon.code);
  supplierProfile.subscriptionPlan = inferPlanTier(plan);
  supplierProfile.subscriptionStatus = 'pending';
  supplierProfile.paymentStatus = 'pending';
  syncSupplierLifecycle(supplierProfile);
  await supplierProfile.save();
};

const activateSupplierEntitlement = async ({
  supplierProfile,
  plan,
  billingCycle,
  listingPeriod,
  addons,
  stripeCustomerId,
}) => {
  supplierProfile.subscriptionPlan = inferPlanTier(plan || supplierProfile.subscriptionPlan);
  if (plan?._id) {
    supplierProfile.selectedPlan = plan._id;
  }
  supplierProfile.selectedBillingCycle = billingCycle || supplierProfile.selectedBillingCycle;
  supplierProfile.selectedListingPeriod = listingPeriod || supplierProfile.selectedListingPeriod;
  supplierProfile.selectedAddons = addons.map((addon) => addon.code);
  supplierProfile.subscriptionStatus = 'active';
  supplierProfile.paymentStatus = 'paid';
  supplierProfile.isApproved = true;
  supplierProfile.listingStatus = 'Approved';
  supplierProfile.stripeCustomerId = stripeCustomerId || supplierProfile.stripeCustomerId;

  if (addons.some((addon) => addon.code === FEATURED_HERO_PLACEMENT.code)) {
    supplierProfile.featuredHeroPlacement = {
      enabled: true,
      activatedAt: supplierProfile.featuredHeroPlacement?.activatedAt || new Date(),
    };
  }

  syncSupplierLifecycle(supplierProfile);
  await supplierProfile.save();
};

const expireSupplierEntitlement = async (supplierProfile, subscriptionStatus = 'cancelled') => {
  supplierProfile.subscriptionStatus = subscriptionStatus;
  supplierProfile.paymentStatus = subscriptionStatus === 'cancelled' ? 'cancelled' : 'unpaid';
  supplierProfile.listingStatus = 'Hidden';
  syncSupplierLifecycle(supplierProfile);
  await supplierProfile.save();
};

const parseMetadataAddons = (metadata = {}) => {
  if (!metadata.addons && !metadata.selectedAddonIds) {
    return [];
  }

  try {
    return JSON.parse(metadata.addons || metadata.selectedAddonIds || '[]');
  } catch (error) {
    return [];
  }
};

const getResolvedAddonsFromMetadata = (metadata = {}, existingAddons = []) => {
  if (existingAddons?.length > 0) {
    return existingAddons;
  }

  const resolvedAddonSelection = resolveSubscriptionAddons({
    addons: parseMetadataAddons(metadata),
    featuredHeroPlacement: metadata.featuredHeroPlacement === 'true',
  });

  return buildAddonSnapshots(resolvedAddonSelection.addons);
};

const createCheckoutReservation = async ({
  supplierProfile,
  plan,
  billingCycle,
  billingCycleType,
  durationMonths,
  listingPeriod,
  listingDiscountPercent,
  baseAmount,
  effectiveRecurringAmount = 0,
  addonAmount,
  totalInitialAmount,
  currency = 'usd',
  addonSnapshots,
  metadata,
}) => {
  try {
    return await Subscription.create({
      supplier: supplierProfile._id,
      plan: plan._id,
      planName: plan.name,
      billingCycle,
      billingCycleType,
      durationMonths,
      listingPeriod,
      status: 'pending_checkout',
      stripeCustomerId: supplierProfile.stripeCustomerId || '',
      subscriptionEndDate: durationMonths ? addUtcMonths(new Date(), durationMonths) : null,
      cancelAt: durationMonths ? addUtcMonths(new Date(), durationMonths) : null,
      listingDiscountPercent: listingDiscountPercent || 0,
      baseAmount,
      effectiveRecurringAmount,
      addonAmount,
      totalInitialAmount,
      currency,
      selectedAddons: addonSnapshots,
      metadata,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throwDuplicateCheckoutError();
    }
    throw error;
  }
};

const getSubscriptionStartDate = (stripeSubscription, fallbackDate = new Date()) =>
  dateFromUnix(stripeSubscription?.start_date) ||
  dateFromUnix(stripeSubscription?.billing_cycle_anchor) ||
  fallbackDate;

const syncSubscriptionDatesFromStripe = (subscriptionRecord, stripeSubscription = {}) => {
  subscriptionRecord.stripeSubscriptionStatus = stripeSubscription.status || subscriptionRecord.stripeSubscriptionStatus;
  subscriptionRecord.subscriptionStartDate =
    dateFromUnix(stripeSubscription.start_date) || subscriptionRecord.subscriptionStartDate;
  subscriptionRecord.currentPeriodStart =
    dateFromUnix(stripeSubscription.current_period_start) || subscriptionRecord.currentPeriodStart;
  subscriptionRecord.currentPeriodEnd =
    dateFromUnix(stripeSubscription.current_period_end) || subscriptionRecord.currentPeriodEnd;
  subscriptionRecord.cancelAt = dateFromUnix(stripeSubscription.cancel_at) || subscriptionRecord.cancelAt;
  const currentPeriodEnd = dateFromUnix(stripeSubscription.current_period_end);
  subscriptionRecord.nextPaymentDate = hasNoFurtherAutomaticPayments(subscriptionRecord, currentPeriodEnd)
    ? null
    : currentPeriodEnd || subscriptionRecord.nextPaymentDate;
  subscriptionRecord.cancelAtPeriodEnd = Boolean(stripeSubscription.cancel_at_period_end);
  subscriptionRecord.stripeSubscriptionScheduleId =
    getStripeObjectId(stripeSubscription.schedule) || subscriptionRecord.stripeSubscriptionScheduleId;
};

const createRecurringCheckoutSession = async ({
  req,
  supplierProfile,
  plan,
  addons,
  resolvedBillingCycle,
  resolvedListingOption,
  basePrice,
  addonPrice,
}) => {
  const blockingSubscription = await Subscription.findOne({
    supplier: supplierProfile._id,
    billingCycleType: 'monthly',
    status: { $in: MONTHLY_SUBSCRIPTION_STATUSES },
    $or: [
      { subscriptionEndDate: null },
      { subscriptionEndDate: { $gt: new Date() } },
    ],
  });

  if (blockingSubscription) {
    const error = new Error('An active or incomplete monthly subscription already exists for this supplier.');
    error.statusCode = 409;
    throw error;
  }

  const durationMonths = resolvedListingOption.durationMonths;
  const appOrigin = resolveDashboardOrigin(req);
  const { successQuery, cancelQuery } = buildCheckoutQueries(req, supplierProfile);
  const addonSnapshots = buildAddonSnapshots(addons);
  const metadata = buildCheckoutMetadata({
    supplierProfile,
    plan,
    billingCycle: resolvedBillingCycle,
    listingPeriod: resolvedListingOption.label,
    listingDiscountPercent: resolvedListingOption.discountPercent,
    durationMonths,
    addons,
    checkoutType: 'monthly_subscription',
  });

  const subscriptionRecord = await createCheckoutReservation({
    supplierProfile,
    plan,
    billingCycle: resolvedBillingCycle,
    billingCycleType: 'monthly',
    durationMonths,
    listingPeriod: resolvedListingOption.label,
    listingDiscountPercent: resolvedListingOption.discountPercent || 0,
    baseAmount: plan.price,
    effectiveRecurringAmount: basePrice,
    addonAmount: addonPrice,
    totalInitialAmount: basePrice + addonPrice,
    addonSnapshots,
    metadata,
  });

  const stripePriceId = await ensureMonthlyPriceForPlan(stripe, plan, {
    amount: basePrice,
    durationMonths,
    listingDiscountPercent: resolvedListingOption.discountPercent || 0,
    currency: 'usd',
  });
  metadata.stripePriceId = stripePriceId;
  metadata.wulfaraSubscriptionId = subscriptionRecord._id.toString();

  const lineItems = [{ price: stripePriceId, quantity: 1 }];
  addons.forEach((addon) => {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: addon.name,
          description: addon.description,
          metadata: {
            source: STRIPE_SOURCE,
            environment: STRIPE_ENVIRONMENT,
            addonCode: addon.code,
          },
        },
        unit_amount: toCents(addon.price),
      },
      quantity: 1,
    });
  });

  const customerParams = supplierProfile.stripeCustomerId
    ? { customer: supplierProfile.stripeCustomerId }
    : { customer_email: supplierProfile.contactEmail || req.user.email };

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      payment_method_collection: 'always',
      line_items: lineItems,
      success_url: `${appOrigin}/listed${successQuery}`,
      cancel_url: `${appOrigin}/subscription${cancelQuery}`,
      client_reference_id: supplierProfile._id.toString(),
      metadata,
      subscription_data: {
        metadata,
      },
      ...customerParams,
    }, {
      idempotencyKey: `wulfara-monthly-checkout-${subscriptionRecord._id.toString()}`,
    });
  } catch (error) {
    await subscriptionRecord.deleteOne();
    throw error;
  }

  subscriptionRecord.stripeCheckoutSessionId = session.id;
  subscriptionRecord.stripeCustomerId = supplierProfile.stripeCustomerId || '';
  subscriptionRecord.stripePriceId = stripePriceId;
  subscriptionRecord.stripeProductId = plan.stripeProductId || '';
  subscriptionRecord.metadata = metadata;
  await subscriptionRecord.save();

  return {
    session,
    orderSummary: {
      checkoutMode: 'subscription',
      recurringInterval: 'month',
      durationMonths,
      subscriptionEndDate: subscriptionRecord.subscriptionEndDate,
      nextPaymentDate: null,
      recurringAmount: basePrice,
    },
  };
};

const createOneTimeCheckoutSession = async ({
  req,
  supplierProfile,
  plan,
  addons,
  resolvedBillingCycle,
  resolvedListingOption,
  basePrice,
  addonPrice,
}) => {
  const totalPrice = basePrice + addonPrice;
  const appOrigin = resolveDashboardOrigin(req);
  const { successQuery, cancelQuery } = buildCheckoutQueries(req, supplierProfile);
  const durationMonths = resolvedListingOption.durationMonths;
  const addonSnapshots = buildAddonSnapshots(addons);
  const metadata = buildCheckoutMetadata({
    supplierProfile,
    plan,
    billingCycle: resolvedBillingCycle,
    listingPeriod: resolvedListingOption.label,
    listingDiscountPercent: resolvedListingOption.discountPercent,
    durationMonths,
    addons,
    checkoutType: 'annual_one_time',
  });

  const subscriptionRecord = await createCheckoutReservation({
    supplierProfile,
    plan,
    billingCycle: resolvedBillingCycle,
    billingCycleType: 'annual',
    durationMonths,
    listingPeriod: resolvedListingOption.label,
    listingDiscountPercent: resolvedListingOption.discountPercent || 0,
    baseAmount: plan.price,
    effectiveRecurringAmount: 0,
    addonAmount: addonPrice,
    totalInitialAmount: totalPrice,
    addonSnapshots,
    metadata,
  });
  metadata.wulfaraSubscriptionId = subscriptionRecord._id.toString();

  const lineItems = [
    {
      price_data: {
        currency: 'usd',
        product_data: {
          name: `WULFARA ${plan.name} Plan - ${resolvedListingOption.label}`,
          description: [
            plan.description || 'B2B Marketplace Supplier Subscription',
            resolvedListingOption.discountPercent
              ? `${resolvedListingOption.discountPercent}% listing-duration discount applied`
              : '',
          ].filter(Boolean).join(' - '),
        },
        unit_amount: toCents(basePrice),
      },
      quantity: 1,
    },
  ];

  addons.forEach((addon) => {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: {
          name: addon.name,
          description: addon.description,
        },
        unit_amount: toCents(addon.price),
      },
      quantity: 1,
    });
  });

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${appOrigin}/listed${successQuery}`,
      cancel_url: `${appOrigin}/subscription${cancelQuery}`,
      client_reference_id: supplierProfile._id.toString(),
      metadata,
      customer: supplierProfile.stripeCustomerId || undefined,
      customer_email: supplierProfile.stripeCustomerId
        ? undefined
        : supplierProfile.contactEmail || req.user.email,
    }, {
      idempotencyKey: `wulfara-annual-checkout-${subscriptionRecord._id.toString()}`,
    });
  } catch (error) {
    await subscriptionRecord.deleteOne();
    throw error;
  }

  subscriptionRecord.stripeCheckoutSessionId = session.id;
  subscriptionRecord.stripeCustomerId = supplierProfile.stripeCustomerId || '';
  subscriptionRecord.metadata = metadata;
  await subscriptionRecord.save();

  await Payment.create({
    supplier: supplierProfile._id,
    stripeSessionId: session.id,
    plan: plan._id,
    planName: plan.name,
    billingCycle: resolvedBillingCycle,
    listingPeriod: resolvedListingOption.label,
    listingDiscountPercent: resolvedListingOption.discountPercent || 0,
    addons: addonSnapshots,
    baseAmount: basePrice,
    addonAmount: addonPrice,
    amount: totalPrice,
    paymentType: 'annual',
    currency: 'usd',
    status: 'pending',
  });

  return {
    session,
    orderSummary: {
      checkoutMode: 'payment',
      durationMonths,
      subscriptionEndDate: null,
      recurringAmount: 0,
    },
  };
};

// @desc    Create a Stripe Checkout Session
// @route   POST /api/v1/subscriptions/checkout-session
// @access  Private (Supplier only)
exports.createCheckoutSession = async (req, res) => {
  try {
    const { planId } = req.body;
    
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Please provide planId' });
    }

    const supplierProfile = await getSupplierForCheckout(req);
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
    }
    await expireElapsedSubscriptions({ supplierId: supplierProfile._id });

    if (!hasIndustrySelection(supplierProfile) || !hasCompanyInfo(supplierProfile)) {
      return res.status(400).json({
        success: false,
        message: 'Complete industry and company information before starting checkout',
      });
    }

    const plan = await PricingPlan.findOne({
      _id: planId,
      isActive: true,
    });

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Selected pricing plan was not found or is inactive' });
    }

    const { addons, unsupportedCodes } = resolveSubscriptionAddons(req.body);

    if (unsupportedCodes.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Unsupported add-on selection: ${unsupportedCodes.join(', ')}`,
      });
    }

    const resolvedBillingCycle = plan.billingCycle || '';
    const resolvedListingOption = resolvePlanListingPeriodOption(
      plan,
      req.body.listingPeriod || supplierProfile.selectedListingPeriod,
      resolvedBillingCycle
    );
    const resolvedListingPeriod = resolvedListingOption.label;
    const basePrice = calculateDiscountedPlanPrice(plan.price, resolvedListingOption.discountPercent);
    const addonPrice = sumAddonAmount(addons);

    await updateSupplierPendingSelection({
      supplierProfile,
      plan,
      billingCycle: resolvedBillingCycle,
      listingPeriod: resolvedListingPeriod,
      addons,
    });

    const checkoutResult = isMonthlyBillingCycle(resolvedBillingCycle)
      ? await createRecurringCheckoutSession({
          req,
          supplierProfile,
          plan,
          addons,
          resolvedBillingCycle,
          resolvedListingOption,
          basePrice,
          addonPrice,
        })
      : await createOneTimeCheckoutSession({
          req,
          supplierProfile,
          plan,
          addons,
          resolvedBillingCycle,
          resolvedListingOption,
          basePrice,
          addonPrice,
        });

    res.status(200).json({
      success: true,
      message: 'Checkout session created',
      paymentUrl: checkoutResult.session.url,
      orderSummary: {
        planId: plan._id,
        planName: plan.name,
        billingCycle: resolvedBillingCycle,
        listingPeriod: resolvedListingPeriod,
        listingDiscountPercent: resolvedListingOption.discountPercent || 0,
        addons: addons.map((addon) => ({
          code: addon.code,
          name: addon.name,
          amount: addon.price,
        })),
        basePrice,
        addonPrice,
        totalDueToday: basePrice + addonPrice,
        ...checkoutResult.orderSummary,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

const updateSubscriptionCancelAt = async (subscriptionRecord, stripeSubscription, fallbackDate = new Date()) => {
  if (!subscriptionRecord?.durationMonths || !subscriptionRecord.stripeSubscriptionId) {
    return;
  }

  const startDate = getSubscriptionStartDate(stripeSubscription, fallbackDate);
  const cancelAt = addUtcMonths(startDate, subscriptionRecord.durationMonths);
  subscriptionRecord.subscriptionStartDate = subscriptionRecord.subscriptionStartDate || startDate;
  subscriptionRecord.subscriptionEndDate = cancelAt;
  subscriptionRecord.cancelAt = cancelAt;

  if (stripe?.subscriptions?.update) {
    const updatedSubscription = await stripe.subscriptions.update(subscriptionRecord.stripeSubscriptionId, {
      cancel_at: unixFromDate(cancelAt),
      metadata: {
        ...(stripeSubscription?.metadata || {}),
        wulfaraSubscriptionId: subscriptionRecord._id.toString(),
        durationMonths: String(subscriptionRecord.durationMonths),
        environment: STRIPE_ENVIRONMENT,
        source: STRIPE_SOURCE,
      },
    });
    syncSubscriptionDatesFromStripe(subscriptionRecord, updatedSubscription);
  }
};

const retrieveStripeSubscriptionForInvoice = async (stripeSubscriptionId) => {
  if (!stripeSubscriptionId || !stripe?.subscriptions?.retrieve) {
    return null;
  }

  try {
    return await stripe.subscriptions.retrieve(stripeSubscriptionId);
  } catch (error) {
    return null;
  }
};

const syncRecoveredSubscriptionIdentity = async (subscriptionRecord, invoice, stripeSubscription, metadata = {}) => {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice) || getStripeObjectId(stripeSubscription);
  subscriptionRecord.stripeSubscriptionId = stripeSubscriptionId || subscriptionRecord.stripeSubscriptionId;
  subscriptionRecord.stripeCustomerId =
    getStripeObjectId(invoice.customer) ||
    getStripeObjectId(stripeSubscription?.customer) ||
    subscriptionRecord.stripeCustomerId;
  subscriptionRecord.stripePriceId = metadata.stripePriceId || subscriptionRecord.stripePriceId;

  if (metadata.planId && !subscriptionRecord.plan) {
    subscriptionRecord.plan = metadata.planId;
  }
  if (metadata.planName && !subscriptionRecord.planName) {
    subscriptionRecord.planName = metadata.planName;
  }
  if (metadata.billingCycle && !subscriptionRecord.billingCycle) {
    subscriptionRecord.billingCycle = metadata.billingCycle;
  }
  if (metadata.listingPeriod && !subscriptionRecord.listingPeriod) {
    subscriptionRecord.listingPeriod = metadata.listingPeriod;
  }
  if (metadata.durationMonths && !subscriptionRecord.durationMonths) {
    subscriptionRecord.durationMonths = Number(metadata.durationMonths) || subscriptionRecord.durationMonths;
  }
  if (metadata.listingDiscountPercent) {
    subscriptionRecord.listingDiscountPercent = Number(metadata.listingDiscountPercent || 0);
  }

  if (!subscriptionRecord.selectedAddons?.length) {
    subscriptionRecord.selectedAddons = getResolvedAddonsFromMetadata(metadata);
  }

  syncSubscriptionDatesFromStripe(subscriptionRecord, stripeSubscription || {});
  await subscriptionRecord.save();
  return subscriptionRecord;
};

const recoverSubscriptionForInvoice = async (invoice, stripeSubscription, metadata = {}) => {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice) || getStripeObjectId(stripeSubscription);
  const stripeCustomerId = getStripeObjectId(invoice.customer) || getStripeObjectId(stripeSubscription?.customer);
  const supplierId = metadata.supplierId;
  const supplierProfile =
    (supplierId ? await Supplier.findById(supplierId) : null) ||
    (stripeCustomerId ? await Supplier.findOne({ stripeCustomerId }) : null);

  if (!supplierProfile) {
    return null;
  }

  const plan = metadata.planId ? await PricingPlan.findById(metadata.planId) : null;
  const durationMonths = Number(metadata.durationMonths || 0) || null;
  const period = getInvoicePeriod(invoice);
  const startDate =
    getSubscriptionStartDate(stripeSubscription, period.start || dateFromUnix(invoice.created) || new Date());
  const cancelAt = dateFromUnix(stripeSubscription?.cancel_at) || (durationMonths ? addUtcMonths(startDate, durationMonths) : null);
  const addons = getResolvedAddonsFromMetadata(metadata);
  const addonAmount = addons.reduce((total, addon) => total + Number(addon.amount || 0), 0);

  try {
    return await Subscription.create({
      supplier: supplierProfile._id,
      plan: plan?._id || metadata.planId || null,
      planName: metadata.planName || plan?.name || '',
      billingCycle: metadata.billingCycle || 'Monthly',
      billingCycleType: 'monthly',
      durationMonths,
      listingPeriod: metadata.listingPeriod || '',
      status: stripeSubscription?.status || 'active',
      stripeCustomerId,
      stripeSubscriptionId,
      stripePriceId: metadata.stripePriceId || '',
      stripeProductId: plan?.stripeProductId || '',
      stripeSubscriptionStatus: stripeSubscription?.status || '',
      subscriptionStartDate: startDate,
      currentPeriodStart: period.start || dateFromUnix(stripeSubscription?.current_period_start) || null,
      currentPeriodEnd: period.end || dateFromUnix(stripeSubscription?.current_period_end) || null,
      nextPaymentDate: hasNoFurtherAutomaticPayments({ cancelAt }, period.end)
        ? null
        : period.end || dateFromUnix(stripeSubscription?.current_period_end) || null,
      subscriptionEndDate: cancelAt,
      cancelAt,
      cancelAtPeriodEnd: Boolean(stripeSubscription?.cancel_at_period_end),
      listingDiscountPercent: Number(metadata.listingDiscountPercent || 0),
      baseAmount: plan?.price || 0,
      effectiveRecurringAmount: Number(metadata.effectiveRecurringAmount || 0),
      addonAmount,
      totalInitialAmount: 0,
      currency: invoice.currency || 'usd',
      selectedAddons: addons,
      metadata,
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    const existing =
      (stripeSubscriptionId ? await Subscription.findOne({ stripeSubscriptionId }) : null) ||
      await Subscription.findOne({ supplier: supplierProfile._id }).sort({ createdAt: -1 });
    return existing
      ? syncRecoveredSubscriptionIdentity(existing, invoice, stripeSubscription, metadata)
      : null;
  }
};

const findSubscriptionForInvoice = async (invoice) => {
  const stripeSubscriptionId = getInvoiceSubscriptionId(invoice);
  let stripeSubscription = null;
  let metadata = getInvoiceMetadata(invoice);

  if (metadata.wulfaraSubscriptionId) {
    const byWulfaraId = await Subscription.findById(metadata.wulfaraSubscriptionId);
    if (byWulfaraId) {
      return syncRecoveredSubscriptionIdentity(byWulfaraId, invoice, stripeSubscription, metadata);
    }
  }

  if (stripeSubscriptionId) {
    const byStripeSubscription = await Subscription.findOne({ stripeSubscriptionId });
    if (byStripeSubscription) {
      return byStripeSubscription;
    }

    stripeSubscription = await retrieveStripeSubscriptionForInvoice(stripeSubscriptionId);
    metadata = {
      ...(stripeSubscription?.metadata || {}),
      ...metadata,
    };
  }

  const supplierId = metadata.supplierId;
  if (supplierId) {
    const bySupplier = await Subscription.findOne({ supplier: supplierId }).sort({ createdAt: -1 });
    if (bySupplier) {
      return syncRecoveredSubscriptionIdentity(bySupplier, invoice, stripeSubscription, metadata);
    }
  }

  const stripeCustomerId = getStripeObjectId(invoice.customer) || getStripeObjectId(stripeSubscription?.customer);
  if (stripeCustomerId) {
    const supplierProfile = await Supplier.findOne({ stripeCustomerId });
    if (supplierProfile) {
      const byCustomerSupplier = await Subscription.findOne({ supplier: supplierProfile._id }).sort({ createdAt: -1 });
      if (byCustomerSupplier) {
        return syncRecoveredSubscriptionIdentity(byCustomerSupplier, invoice, stripeSubscription, metadata);
      }
    }
  }

  return recoverSubscriptionForInvoice(invoice, stripeSubscription, metadata);
};

const handleMonthlyCheckoutCompleted = async (session) => {
  const metadata = session.metadata || {};
  const supplierId = session.client_reference_id || metadata.supplierId;
  const supplierProfile = await Supplier.findById(supplierId);
  if (!supplierProfile) {
    return { ignored: true, reason: 'supplier_not_found' };
  }

  const subscriptionRecord =
    (await Subscription.findOne({ stripeCheckoutSessionId: session.id })) ||
    (session.subscription
      ? await Subscription.findOne({ stripeSubscriptionId: getStripeObjectId(session.subscription) })
      : null);

  if (!subscriptionRecord && isProduction) {
    return { ignored: true, reason: 'unknown_session' };
  }

  const planId = metadata.planId || subscriptionRecord?.plan || null;
  const selectedPlan = planId ? await PricingPlan.findById(planId) : null;
  const addons = getResolvedAddonsFromMetadata(metadata, subscriptionRecord?.selectedAddons);
  const stripeSubscriptionId = getStripeObjectId(session.subscription);
  let stripeSubscription = typeof session.subscription === 'object' ? session.subscription : null;

  if (stripeSubscriptionId && !stripeSubscription && stripe?.subscriptions?.retrieve) {
    stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  }

  const record = subscriptionRecord || await Subscription.create({
    supplier: supplierProfile._id,
    plan: planId,
    planName: metadata.planName || selectedPlan?.name || '',
    billingCycle: metadata.billingCycle || 'Monthly',
    billingCycleType: 'monthly',
    durationMonths: Number(metadata.durationMonths || 0) || null,
    listingPeriod: metadata.listingPeriod || '',
    status: 'pending_checkout',
    stripeCheckoutSessionId: session.id,
    selectedAddons: addons,
  });

  record.plan = selectedPlan?._id || record.plan;
  record.planName = selectedPlan?.name || metadata.planName || record.planName;
  record.billingCycle = metadata.billingCycle || record.billingCycle;
  record.durationMonths = Number(metadata.durationMonths || record.durationMonths || 0) || record.durationMonths;
  record.listingPeriod = metadata.listingPeriod || record.listingPeriod;
  record.listingDiscountPercent = Number(metadata.listingDiscountPercent || record.listingDiscountPercent || 0);
  record.stripeCustomerId = getStripeObjectId(session.customer) || record.stripeCustomerId;
  record.stripeSubscriptionId = stripeSubscriptionId || record.stripeSubscriptionId;
  record.stripePriceId = metadata.stripePriceId || record.stripePriceId;
  record.status = record.status === 'active'
    ? 'active'
    : stripeSubscription?.status || 'incomplete';
  record.selectedAddons = addons;
  syncSubscriptionDatesFromStripe(record, stripeSubscription || {});

  if (record.stripeSubscriptionId) {
    await updateSubscriptionCancelAt(record, stripeSubscription || {}, dateFromUnix(session.created) || new Date());
  }

  supplierProfile.stripeCustomerId = record.stripeCustomerId || supplierProfile.stripeCustomerId;
  supplierProfile.selectedPlan = record.plan || supplierProfile.selectedPlan;
  supplierProfile.selectedBillingCycle = record.billingCycle || supplierProfile.selectedBillingCycle;
  supplierProfile.selectedListingPeriod = record.listingPeriod || supplierProfile.selectedListingPeriod;
  supplierProfile.selectedAddons = addons.map((addon) => addon.code);
  syncSupplierLifecycle(supplierProfile);
  await supplierProfile.save();
  await record.save();
  return { initialized: true };
};

const handleAnnualCheckoutCompleted = async (session) => {
  const metadata = session.metadata || {};
  const supplierId = session.client_reference_id || metadata.supplierId;
  const supplierProfile = await Supplier.findById(supplierId);
  if (!supplierProfile) {
    return { ignored: true, reason: 'supplier_not_found' };
  }

  const existingPayment = await Payment.findOne({ stripeSessionId: session.id });
  if (existingPayment?.status === 'paid') {
    return { duplicate: true };
  }

  if (session.payment_status && session.payment_status !== 'paid') {
    return { pending: true };
  }

  if (!existingPayment && isProduction) {
    return { ignored: true, reason: 'unknown_session' };
  }

  const planId = metadata.planId || null;
  const selectedPlan = planId ? await PricingPlan.findById(planId) : null;
  const addons = getResolvedAddonsFromMetadata(metadata, existingPayment?.addons);
  const addonAmount =
    existingPayment?.addonAmount ??
    addons.reduce((total, addon) => total + Number(addon.amount || 0), 0);
  const paidAmount = Number(session.amount_total || 0) / 100;
  const baseAmount = existingPayment?.baseAmount ?? Math.max(paidAmount - addonAmount, 0);

  if (existingPayment && !centsMatch(paidAmount, existingPayment.amount)) {
    existingPayment.status = 'failed';
    await existingPayment.save();
    return { ignored: true, reason: 'amount_mismatch' };
  }

  await activateSupplierEntitlement({
    supplierProfile,
    plan: selectedPlan || { tier: metadata.planTier, name: metadata.planName },
    billingCycle: metadata.billingCycle || '',
    listingPeriod: metadata.listingPeriod || '',
    addons,
    stripeCustomerId: getStripeObjectId(session.customer),
  });

  const durationMonths = Number(metadata.durationMonths || 0) || null;
  const startDate = dateFromUnix(session.created) || new Date();
  const endDate = durationMonths ? addUtcMonths(startDate, durationMonths) : null;
  const subscriptionRecord =
    (await Subscription.findOne({ stripeCheckoutSessionId: session.id })) ||
    await Subscription.create({
      supplier: supplierProfile._id,
      stripeCheckoutSessionId: session.id,
    });

  subscriptionRecord.plan = selectedPlan?._id || planId;
  subscriptionRecord.planName = metadata.planName || selectedPlan?.name || '';
  subscriptionRecord.billingCycle = metadata.billingCycle || '';
  subscriptionRecord.billingCycleType = 'annual';
  subscriptionRecord.durationMonths = durationMonths;
  subscriptionRecord.listingPeriod = metadata.listingPeriod || '';
  subscriptionRecord.status = 'active';
  subscriptionRecord.stripeCustomerId = getStripeObjectId(session.customer) || subscriptionRecord.stripeCustomerId;
  subscriptionRecord.subscriptionStartDate = startDate;
  subscriptionRecord.currentPeriodStart = startDate;
  subscriptionRecord.currentPeriodEnd = endDate;
  subscriptionRecord.subscriptionEndDate = endDate;
  subscriptionRecord.cancelAt = endDate;
  subscriptionRecord.nextPaymentDate = null;
  subscriptionRecord.listingDiscountPercent = Number(metadata.listingDiscountPercent || 0);
  subscriptionRecord.baseAmount = baseAmount;
  subscriptionRecord.addonAmount = addonAmount;
  subscriptionRecord.totalInitialAmount = paidAmount;
  subscriptionRecord.currency = session.currency || subscriptionRecord.currency || 'usd';
  subscriptionRecord.selectedAddons = addons;
  await subscriptionRecord.save();

  if (existingPayment) {
    existingPayment.plan = selectedPlan?._id || planId;
    existingPayment.planName = metadata.planName || selectedPlan?.name || '';
    existingPayment.billingCycle = metadata.billingCycle || '';
    existingPayment.listingPeriod = metadata.listingPeriod || '';
    existingPayment.listingDiscountPercent = Number(metadata.listingDiscountPercent || 0);
    existingPayment.addons = addons;
    existingPayment.baseAmount = baseAmount;
    existingPayment.addonAmount = addonAmount;
    existingPayment.amount = paidAmount;
    existingPayment.status = 'paid';
    existingPayment.paymentType = 'annual';
    existingPayment.currency = session.currency || 'usd';
    existingPayment.billingPeriodStart = startDate;
    existingPayment.billingPeriodEnd = endDate;
    await existingPayment.save();
  } else {
    await Payment.create({
      supplier: supplierProfile._id,
      plan: selectedPlan?._id || planId,
      planName: metadata.planName || selectedPlan?.name || '',
      billingCycle: metadata.billingCycle || '',
      listingPeriod: metadata.listingPeriod || '',
      listingDiscountPercent: Number(metadata.listingDiscountPercent || 0),
      addons,
      baseAmount,
      addonAmount,
      amount: paidAmount,
      status: 'paid',
      paymentType: 'annual',
      currency: session.currency || 'usd',
      stripeSessionId: session.id,
      billingPeriodStart: startDate,
      billingPeriodEnd: endDate,
    });
  }

  return { activated: true };
};

const handleInvoicePaid = async (invoice) => {
  const existingPayment = await Payment.findOne({ stripeInvoiceId: invoice.id });

  const subscriptionRecord = await findSubscriptionForInvoice(invoice);
  if (!subscriptionRecord) {
    logStripeFlow('Stripe', 'invoice.paid ignored: subscription not found', {
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: getInvoiceSubscriptionId(invoice),
    });
    return { ignored: true, reason: 'subscription_not_found' };
  }

  const supplierProfile = await Supplier.findById(subscriptionRecord.supplier);
  if (!supplierProfile) {
    return { ignored: true, reason: 'supplier_not_found' };
  }

  const paymentCount = await Payment.countDocuments({
    stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
    status: 'paid',
    ...(existingPayment ? { _id: { $ne: existingPayment._id } } : {}),
  });
  const period = getInvoicePeriod(invoice);
  const amountPaid = centsToAmount(invoice.amount_paid ?? invoice.total ?? 0);
  const isInitialInvoice =
    existingPayment?.paymentType === 'initial_subscription' ||
    (!existingPayment && paymentCount === 0);
  const addonAmount = isInitialInvoice ? subscriptionRecord.addonAmount || 0 : 0;
  const baseAmount = Math.max(amountPaid - addonAmount, 0);

  subscriptionRecord.status = 'active';
  subscriptionRecord.stripeSubscriptionStatus = 'active';
  subscriptionRecord.latestInvoiceId = invoice.id;
  subscriptionRecord.latestPaymentIntentId = getInvoicePaymentIntentId(invoice);
  subscriptionRecord.currentPeriodStart = period.start || subscriptionRecord.currentPeriodStart;
  subscriptionRecord.currentPeriodEnd = period.end || subscriptionRecord.currentPeriodEnd;
  subscriptionRecord.nextPaymentDate =
    subscriptionRecord.cancelAt && period.end && period.end >= subscriptionRecord.cancelAt
      ? null
      : period.end || subscriptionRecord.nextPaymentDate;
  await subscriptionRecord.save();

  const plan = subscriptionRecord.plan ? await PricingPlan.findById(subscriptionRecord.plan) : null;
  await activateSupplierEntitlement({
    supplierProfile,
    plan: plan || { tier: supplierProfile.subscriptionPlan, name: subscriptionRecord.planName },
    billingCycle: subscriptionRecord.billingCycle,
    listingPeriod: subscriptionRecord.listingPeriod,
    addons: subscriptionRecord.selectedAddons || [],
    stripeCustomerId: subscriptionRecord.stripeCustomerId,
  });

  if (existingPayment) {
    logStripeFlow('Stripe', 'invoice.paid already reconciled; entitlement refreshed', {
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
      supplierId: supplierProfile._id.toString(),
    });
    return { duplicate: true, entitlementRefreshed: true };
  }

  try {
    await Payment.create({
      supplier: supplierProfile._id,
      plan: subscriptionRecord.plan,
      planName: subscriptionRecord.planName,
      billingCycle: subscriptionRecord.billingCycle,
      listingPeriod: subscriptionRecord.listingPeriod,
      listingDiscountPercent: subscriptionRecord.listingDiscountPercent || 0,
      addons: paymentCount === 0 ? subscriptionRecord.selectedAddons || [] : [],
      baseAmount,
      addonAmount,
      amount: amountPaid,
      status: 'paid',
      paymentType: paymentCount === 0 ? 'initial_subscription' : 'recurring_invoice',
      billingPeriodStart: period.start,
      billingPeriodEnd: period.end,
      invoiceUrl: invoice.hosted_invoice_url || invoice.invoice_pdf || '',
      currency: invoice.currency || subscriptionRecord.currency || 'usd',
      stripeInvoiceId: invoice.id,
      stripePaymentIntentId: getInvoicePaymentIntentId(invoice),
      stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { duplicate: true };
    }
    throw error;
  }

  logStripeFlow('Stripe', 'invoice.paid reconciled', {
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscriptionRecord.stripeSubscriptionId,
    supplierId: supplierProfile._id.toString(),
  });
  return { paymentCreated: true };
};

const handleInvoiceFailure = async (invoice, status) => {
  const subscriptionRecord = await findSubscriptionForInvoice(invoice);
  if (!subscriptionRecord) {
    return { ignored: true, reason: 'subscription_not_found' };
  }

  subscriptionRecord.status = status;
  subscriptionRecord.lastPaymentFailureAt = new Date();
  subscriptionRecord.lastPaymentFailureReason =
    invoice.last_finalization_error?.message ||
    invoice.payment_intent?.last_payment_error?.message ||
    '';
  subscriptionRecord.latestInvoiceId = invoice.id || subscriptionRecord.latestInvoiceId;
  subscriptionRecord.latestPaymentIntentId = getInvoicePaymentIntentId(invoice);
  await subscriptionRecord.save();

  const supplierProfile = await Supplier.findById(subscriptionRecord.supplier);
  if (supplierProfile && supplierProfile.subscriptionStatus !== 'active') {
    supplierProfile.subscriptionStatus = 'failed';
    supplierProfile.paymentStatus = status === 'requires_action' ? 'pending' : 'failed';
    syncSupplierLifecycle(supplierProfile);
    await supplierProfile.save();
  }

  return { statusUpdated: true };
};

const handleStripeSubscriptionEvent = async (stripeSubscription) => {
  const stripeSubscriptionId = getStripeObjectId(stripeSubscription);
  const metadata = stripeSubscription.metadata || {};
  const subscriptionRecord =
    (stripeSubscriptionId ? await Subscription.findOne({ stripeSubscriptionId }) : null) ||
    (metadata.supplierId ? await Subscription.findOne({ supplier: metadata.supplierId }).sort({ createdAt: -1 }) : null);

  if (!subscriptionRecord) {
    return { ignored: true, reason: 'subscription_not_found' };
  }

  subscriptionRecord.stripeSubscriptionId = stripeSubscriptionId || subscriptionRecord.stripeSubscriptionId;
  subscriptionRecord.stripeCustomerId = getStripeObjectId(stripeSubscription.customer) || subscriptionRecord.stripeCustomerId;
  subscriptionRecord.status = stripeSubscription.status || subscriptionRecord.status;
  syncSubscriptionDatesFromStripe(subscriptionRecord, stripeSubscription);

  if (TERMINAL_STRIPE_SUBSCRIPTION_STATUSES.includes(stripeSubscription.status)) {
    const terminalDate = subscriptionRecord.cancelAt || subscriptionRecord.subscriptionEndDate;
    const endedAfterAgreedTerm = terminalDate && terminalDate <= new Date();
    subscriptionRecord.status =
      stripeSubscription.status === 'canceled' && endedAfterAgreedTerm
        ? 'completed'
        : stripeSubscription.status;
    subscriptionRecord.nextPaymentDate = null;
    subscriptionRecord.currentPeriodEnd = subscriptionRecord.currentPeriodEnd || terminalDate;
    await subscriptionRecord.save();

    const supplierProfile = await Supplier.findById(subscriptionRecord.supplier);
    if (supplierProfile) {
      await expireSupplierEntitlement(
        supplierProfile,
        subscriptionRecord.status === 'completed' ? 'inactive' : 'cancelled'
      );
    }
  } else {
    await subscriptionRecord.save();
  }

  return { statusUpdated: true };
};

const handleSubscriptionScheduleEvent = async (schedule, eventType) => {
  const scheduleId = getStripeObjectId(schedule);
  const stripeSubscriptionId = getStripeObjectId(schedule.subscription);
  const subscriptionRecord =
    (scheduleId ? await Subscription.findOne({ stripeSubscriptionScheduleId: scheduleId }) : null) ||
    (stripeSubscriptionId ? await Subscription.findOne({ stripeSubscriptionId }) : null);

  if (!subscriptionRecord) {
    return { ignored: true, reason: 'subscription_not_found' };
  }

  subscriptionRecord.stripeSubscriptionScheduleId = scheduleId || subscriptionRecord.stripeSubscriptionScheduleId;
  subscriptionRecord.stripeScheduleStatus = schedule.status || subscriptionRecord.stripeScheduleStatus;
  if (schedule.current_phase?.end_date) {
    subscriptionRecord.subscriptionEndDate = dateFromUnix(schedule.current_phase.end_date);
    subscriptionRecord.cancelAt = dateFromUnix(schedule.current_phase.end_date);
  }

  if (['subscription_schedule.completed', 'subscription_schedule.canceled', 'subscription_schedule.aborted'].includes(eventType)) {
    subscriptionRecord.status = eventType === 'subscription_schedule.completed' ? 'completed' : 'canceled';
    subscriptionRecord.nextPaymentDate = null;
  }

  await subscriptionRecord.save();

  if (['completed', 'canceled', 'aborted'].includes(schedule.status) ||
      ['subscription_schedule.completed', 'subscription_schedule.canceled', 'subscription_schedule.aborted'].includes(eventType)) {
    const supplierProfile = await Supplier.findById(subscriptionRecord.supplier);
    if (supplierProfile) {
      await expireSupplierEntitlement(
        supplierProfile,
        eventType === 'subscription_schedule.completed' ? 'inactive' : 'cancelled'
      );
    }
  }

  return { statusUpdated: true };
};

const resolveInvoiceFromInvoicePayment = async (invoicePayment = {}) => {
  const invoice = invoicePayment.invoice || invoicePayment.invoice_id;

  if (!invoice) {
    return null;
  }

  if (typeof invoice === 'object') {
    return invoice;
  }

  if (stripe?.invoices?.retrieve) {
    return stripe.invoices.retrieve(invoice, {
      expand: ['payment_intent', 'subscription'],
    });
  }

  return { id: invoice };
};

const getSupplierForCheckoutStatus = async (req) => {
  if (req.user.role === 'admin') {
    return req.query.supplierId ? Supplier.findById(req.query.supplierId) : null;
  }

  return Supplier.findOne({ user: req.user.id });
};

const buildCheckoutStatusPayload = ({ status, supplierProfile, subscriptionRecord, message, redirectTo }) => ({
  success: true,
  status,
  paymentStatus: supplierProfile?.paymentStatus || 'pending',
  subscriptionStatus: supplierProfile?.subscriptionStatus || subscriptionRecord?.status || 'pending',
  listingStatus: supplierProfile?.listingStatus || 'Pending',
  redirectTo: redirectTo || (status === 'paid' ? '/dashboard' : undefined),
  message,
});

const isLocalCheckoutConfirmed = (supplierProfile, subscriptionRecord) =>
  Boolean(
    supplierProfile?.paymentStatus === 'paid' &&
      supplierProfile?.subscriptionStatus === 'active' &&
      supplierProfile?.listingStatus === 'Approved' &&
      ['active', 'completed'].includes(subscriptionRecord?.status)
  );

const hasPaidStripeInvoice = (invoice = {}) =>
  invoice.status === 'paid' ||
  invoice.paid === true ||
  invoice.amount_paid > 0;

const getLatestInvoiceFromSession = async (session, stripeSubscription) => {
  const invoiceCandidate =
    stripeSubscription?.latest_invoice ||
    session.invoice ||
    session.latest_invoice ||
    null;

  if (!invoiceCandidate) {
    return null;
  }

  if (typeof invoiceCandidate === 'object') {
    return invoiceCandidate;
  }

  if (stripe?.invoices?.retrieve) {
    return stripe.invoices.retrieve(invoiceCandidate, {
      expand: ['payment_intent', 'subscription'],
    });
  }

  return { id: invoiceCandidate };
};

const normalizeInvoiceForCheckoutSession = (invoice, session, stripeSubscription) => {
  if (!invoice?.id) {
    return null;
  }

  const subscriptionId = getStripeObjectId(session.subscription) || getStripeObjectId(stripeSubscription);
  const periodStart =
    invoice.lines?.data?.[0]?.period?.start ||
    stripeSubscription?.current_period_start ||
    session.created;
  const periodEnd =
    invoice.lines?.data?.[0]?.period?.end ||
    stripeSubscription?.current_period_end ||
    null;

  return {
    ...invoice,
    subscription: invoice.subscription || subscriptionId,
    customer: invoice.customer || session.customer || stripeSubscription?.customer,
    currency: invoice.currency || session.currency || 'usd',
    amount_paid: invoice.amount_paid ?? session.amount_total ?? 0,
    payment_intent: invoice.payment_intent || session.payment_intent,
    subscription_details: {
      ...(invoice.subscription_details || {}),
      metadata: {
        ...(stripeSubscription?.metadata || {}),
        ...(session.metadata || {}),
        ...(invoice.subscription_details?.metadata || {}),
      },
    },
    metadata: {
      ...(stripeSubscription?.metadata || {}),
      ...(session.metadata || {}),
      ...(invoice.metadata || {}),
    },
    lines: invoice.lines || {
      data: [
        {
          period: {
            start: periodStart,
            end: periodEnd,
          },
        },
      ],
    },
  };
};

const ensureSessionBelongsToSupplier = ({ session, supplierProfile, subscriptionRecord }) => {
  const trustedSupplierId =
    session.client_reference_id ||
    session.metadata?.supplierId ||
    subscriptionRecord?.supplier?.toString();
  const requestedSupplierId = supplierProfile?._id?.toString();

  if (!trustedSupplierId || !requestedSupplierId || trustedSupplierId !== requestedSupplierId) {
    const error = new Error('Checkout session does not belong to this supplier.');
    error.statusCode = 403;
    error.code = 'UNAUTHORIZED_SESSION';
    throw error;
  }

  if (subscriptionRecord?.supplier?.toString() !== requestedSupplierId) {
    const error = new Error('Local checkout reservation does not belong to this supplier.');
    error.statusCode = 403;
    error.code = 'UNAUTHORIZED_SESSION';
    throw error;
  }
};

const findSubscriptionForCheckoutSession = async (sessionId, session = {}) => {
  const metadataSubscriptionId = session.metadata?.wulfaraSubscriptionId;

  return (
    (await Subscription.findOne({ stripeCheckoutSessionId: sessionId })) ||
    (metadataSubscriptionId ? await Subscription.findById(metadataSubscriptionId) : null) ||
    (session.subscription
      ? await Subscription.findOne({ stripeSubscriptionId: getStripeObjectId(session.subscription) })
      : null)
  );
};

// @desc    Verify/reconcile Stripe Checkout status after redirect
// @route   GET /api/v1/subscriptions/checkout-status
// @access  Private (Supplier/Admin)
exports.getCheckoutStatus = async (req, res) => {
  const sessionId = String(req.query.session_id || '').trim();

  if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(400).json({
      success: false,
      status: 'invalid_session',
      message: 'Invalid checkout session.',
    });
  }

  try {
    const supplierProfile = await getSupplierForCheckoutStatus(req);
    if (!supplierProfile) {
      return res.status(404).json({
        success: false,
        status: 'not_found',
        message: 'Supplier profile not found.',
      });
    }

    let subscriptionRecord = await findSubscriptionForCheckoutSession(sessionId);

    if (subscriptionRecord) {
      ensureSessionBelongsToSupplier({ session: { id: sessionId }, supplierProfile, subscriptionRecord });

      if (isLocalCheckoutConfirmed(supplierProfile, subscriptionRecord)) {
        return res.status(200).json(buildCheckoutStatusPayload({
          status: 'paid',
          supplierProfile,
          subscriptionRecord,
          message: 'Payment already confirmed.',
        }));
      }
    }

    logStripeFlow('CheckoutVerify', 'local state pending; retrieving Stripe session', {
      checkoutSessionId: sessionId,
      supplierId: supplierProfile._id.toString(),
    });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription', 'subscription.latest_invoice', 'payment_intent'],
    });

    if (session.livemode) {
      return res.status(400).json({
        success: false,
        status: 'invalid_session',
        message: 'Live Stripe sessions are not accepted in this environment.',
      });
    }

    subscriptionRecord = subscriptionRecord || await findSubscriptionForCheckoutSession(sessionId, session);
    ensureSessionBelongsToSupplier({ session, supplierProfile, subscriptionRecord });

    if (session.status === 'expired') {
      return res.status(410).json(buildCheckoutStatusPayload({
        status: 'expired',
        supplierProfile,
        subscriptionRecord,
        message: 'Checkout session expired.',
      }));
    }

    const isSubscriptionCheckout =
      session.mode === 'subscription' || session.metadata?.checkoutType === 'monthly_subscription';

    if (!isSubscriptionCheckout) {
      if (session.payment_status !== 'paid') {
        return res.status(200).json(buildCheckoutStatusPayload({
          status: 'processing',
          supplierProfile,
          subscriptionRecord,
          message: 'Payment is still processing.',
        }));
      }

      const result = await handleAnnualCheckoutCompleted(session);
      logStripeFlow('CheckoutVerify', 'annual checkout reconciled', {
        checkoutSessionId: sessionId,
        supplierId: supplierProfile._id.toString(),
        result,
      });
      const refreshedSupplier = await Supplier.findById(supplierProfile._id);
      const refreshedSubscription = await findSubscriptionForCheckoutSession(sessionId, session);
      return res.status(200).json(buildCheckoutStatusPayload({
        status: 'paid',
        supplierProfile: refreshedSupplier,
        subscriptionRecord: refreshedSubscription,
        message: 'Payment confirmed.',
      }));
    }

    const stripeSubscription =
      typeof session.subscription === 'object'
        ? session.subscription
        : session.subscription && stripe?.subscriptions?.retrieve
          ? await stripe.subscriptions.retrieve(session.subscription)
          : null;

    const invoice = await getLatestInvoiceFromSession(session, stripeSubscription);
    const subscriptionStatus = stripeSubscription?.status || '';
    const invoiceStatus = invoice?.status || '';
    const terminalFailure =
      ['incomplete_expired', 'canceled', 'unpaid'].includes(subscriptionStatus) ||
      ['void', 'uncollectible'].includes(invoiceStatus);

    if (terminalFailure) {
      return res.status(200).json(buildCheckoutStatusPayload({
        status: 'failed',
        supplierProfile,
        subscriptionRecord,
        message: 'Payment could not be confirmed.',
      }));
    }

    if (!hasPaidStripeInvoice(invoice)) {
      return res.status(200).json(buildCheckoutStatusPayload({
        status: 'processing',
        supplierProfile,
        subscriptionRecord,
        message: 'Stripe has not confirmed the initial invoice payment yet.',
      }));
    }

    await handleMonthlyCheckoutCompleted({
      ...session,
      subscription: stripeSubscription || session.subscription,
    });

    const normalizedInvoice = normalizeInvoiceForCheckoutSession(invoice, session, stripeSubscription);
    if (!normalizedInvoice) {
      return res.status(200).json(buildCheckoutStatusPayload({
        status: 'processing',
        supplierProfile,
        subscriptionRecord,
        message: 'Payment is confirmed, invoice details are still syncing.',
      }));
    }

    const result = await handleInvoicePaid(normalizedInvoice);
    logStripeFlow('CheckoutVerify', 'monthly checkout reconciled', {
      checkoutSessionId: sessionId,
      stripeSubscriptionId: getStripeObjectId(stripeSubscription) || getStripeObjectId(session.subscription),
      stripeInvoiceId: normalizedInvoice.id,
      supplierId: supplierProfile._id.toString(),
      result,
    });

    const refreshedSupplier = await Supplier.findById(supplierProfile._id);
    const refreshedSubscription = await findSubscriptionForCheckoutSession(sessionId, session);
    return res.status(200).json(buildCheckoutStatusPayload({
      status: 'paid',
      supplierProfile: refreshedSupplier,
      subscriptionRecord: refreshedSubscription,
      message: 'Payment confirmed.',
    }));
  } catch (error) {
    if (error.statusCode === 403 || error.code === 'UNAUTHORIZED_SESSION') {
      return res.status(403).json({
        success: false,
        status: 'unauthorized',
        message: 'This checkout session is not available for your account.',
      });
    }

    if (error?.type === 'StripeInvalidRequestError' || error?.code === 'resource_missing') {
      return res.status(404).json({
        success: false,
        status: 'invalid_session',
        message: 'Checkout session was not found.',
      });
    }

    console.error('[CheckoutVerify] reconciliation error', {
      checkoutSessionId: sessionId,
      message: error.message,
    });

    return res.status(500).json({
      success: false,
      status: 'reconciliation_error',
      message: 'Payment verification is temporarily unavailable.',
    });
  }
};

// @desc    Stripe Webhook Handler
// @route   POST /api/v1/subscriptions/webhook
// @access  Public
exports.stripeWebhook = async (req, res) => {
  const payload = req.body;
  const sig = req.headers['stripe-signature'];
  const endpointSecret = stripeWebhookSecret || 'whsec_dummy';

  let event;

  try {
    if (stripeWebhookSecret) {
      event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
    } else if (isProduction) {
      return res.status(500).send('Stripe webhook secret is not configured.');
    } else {
      event = JSON.parse(payload.toString());
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.livemode) {
    return res.status(200).json({ received: true, ignored: true, reason: 'live_mode_not_allowed' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const checkoutType = session.metadata?.checkoutType;
        const mode = session.mode;
        const result = mode === 'subscription' || checkoutType === 'monthly_subscription'
          ? await handleMonthlyCheckoutCompleted(session)
          : await handleAnnualCheckoutCompleted(session);
        return res.status(200).json({ received: true, ...result });
      }
      case 'invoice.paid': {
        const result = await handleInvoicePaid(event.data.object);
        return res.status(200).json({ received: true, ...result });
      }
      case 'invoice_payment.paid': {
        const invoice = await resolveInvoiceFromInvoicePayment(event.data.object);
        if (!invoice) {
          return res.status(200).json({ received: true, ignored: true, reason: 'invoice_not_found' });
        }
        const result = await handleInvoicePaid(invoice);
        return res.status(200).json({ received: true, ...result });
      }
      case 'invoice.payment_failed': {
        const result = await handleInvoiceFailure(event.data.object, 'payment_failed');
        return res.status(200).json({ received: true, ...result });
      }
      case 'invoice.payment_action_required': {
        const result = await handleInvoiceFailure(event.data.object, 'requires_action');
        return res.status(200).json({ received: true, ...result });
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const result = await handleStripeSubscriptionEvent(event.data.object);
        return res.status(200).json({ received: true, ...result });
      }
      case 'subscription_schedule.created':
      case 'subscription_schedule.updated':
      case 'subscription_schedule.completed':
      case 'subscription_schedule.canceled':
      case 'subscription_schedule.aborted': {
        const result = await handleSubscriptionScheduleEvent(event.data.object, event.type);
        return res.status(200).json({ received: true, ...result });
      }
      default:
        return res.status(200).json({ received: true, ignored: true, reason: 'event_not_handled' });
    }
  } catch (err) {
    console.error('Error processing Stripe webhook:', err);
    return res.status(500).json({ received: false, message: err.message });
  }
};

// @desc    Get all invoices/payments for the logged-in supplier
// @route   GET /api/v1/subscriptions/invoices
// @access  Private (Supplier only)
exports.getInvoices = async (req, res) => {
  try {
    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }
    await expireElapsedSubscriptions({ supplierId: supplierProfile._id });

    const payments = await Payment.find({ supplier: supplierProfile._id }).sort('-createdAt');
    const currentSubscription = await Subscription.findOne({ supplier: supplierProfile._id })
      .populate({ path: 'plan', select: 'name slug price billingCycle isActive' })
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: payments.length,
      data: payments,
      currentSubscription,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current billing subscription for the logged-in supplier
// @route   GET /api/v1/subscriptions/current
// @access  Private (Supplier only)
exports.getCurrentSubscription = async (req, res) => {
  try {
    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }
    await expireElapsedSubscriptions({ supplierId: supplierProfile._id });

    const currentSubscription = await Subscription.findOne({ supplier: supplierProfile._id })
      .populate({ path: 'plan', select: 'name slug price billingCycle isActive' })
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: currentSubscription,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all payments (Admin)
// @route   GET /api/v1/subscriptions/admin/payments
// @access  Private/Admin
exports.getAllPayments = async (req, res) => {
  try {
    const payments = await Payment.find().populate('supplier').sort('-createdAt');
    res.status(200).json({ success: true, count: payments.length, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all active supplier subscriptions (Admin)
// @route   GET /api/v1/subscriptions/admin/active
// @access  Private/Admin
exports.getActiveSubscriptions = async (req, res) => {
  try {
    const suppliers = await Supplier.find(ACTIVE_SUPPLIER_MATCH)
      .populate({ path: 'user', select: 'name email status isVerified' })
      .populate({ path: 'selectedPlan', select: 'name slug price billingCycle isActive' })
      .sort('-updatedAt');
    const supplierIds = suppliers.map((supplier) => supplier._id);
    const subscriptions = await Subscription.find({ supplier: { $in: supplierIds } })
      .sort({ createdAt: -1 })
      .lean();
    const subscriptionBySupplierId = new Map();
    subscriptions.forEach((subscription) => {
      const supplierId = subscription.supplier?.toString();
      if (supplierId && !subscriptionBySupplierId.has(supplierId)) {
        subscriptionBySupplierId.set(supplierId, subscription);
      }
    });

    res.status(200).json({
      success: true,
      count: suppliers.length,
      data: suppliers.map((supplier) => ({
        ...(supplier.toObject ? supplier.toObject() : supplier),
        currentSubscription: subscriptionBySupplierId.get(supplier._id.toString()) || null,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


// @desc    Get all active pricing plans
// @route   GET /api/v1/subscriptions/plans
// @access  Public
exports.getPlans = async (req, res) => {
  try {
    const plans = await PricingPlan.find({ isActive: true });
    res.status(200).json({
      success: true,
      count: plans.length,
      data: plans.map((plan) => serializePlan(plan)),
      addons: [
        {
          code: FEATURED_HERO_PLACEMENT.code,
          name: FEATURED_HERO_PLACEMENT.name,
          price: FEATURED_HERO_PLACEMENT.price,
          description: FEATURED_HERO_PLACEMENT.description,
        },
      ],
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single pricing plan
// @route   GET /api/v1/subscriptions/plans/:id
// @access  Public
exports.getPlan = async (req, res) => {
  try {
    const plan = await PricingPlan.findById(req.params.id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.status(200).json({ success: true, data: serializePlan(plan) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get subscription package overview for admin
// @route   GET /api/v1/subscriptions/admin/overview
// @access  Private/Admin
exports.getAdminSubscriptionOverview = async (req, res) => {
  try {
    const overview = await buildAdminSubscriptionOverview({ status: req.query.status });
    res.status(200).json({
      success: true,
      data: overview,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all pricing plans for admin
// @route   GET /api/v1/subscriptions/admin/plans
// @access  Private/Admin
exports.getAdminPlans = async (req, res) => {
  try {
    const plans = await PricingPlan.find().sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      count: plans.length,
      data: plans.map((plan) => serializePlan(plan)),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single pricing plan for admin
// @route   GET /api/v1/subscriptions/admin/plans/:id
// @access  Private/Admin
exports.getAdminPlan = async (req, res) => {
  try {
    const plan = await PricingPlan.findById(req.params.id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    res.status(200).json({ success: true, data: serializePlan(plan) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new pricing plan
// @route   POST /api/v1/subscriptions/plans
// @access  Private (Admin only)
exports.createPlan = async (req, res) => {
  try {
    req.body.listingPeriods = normalizeListingPeriods(req.body.listingPeriods, { fallbackToDefault: true });
    await ensureUniquePlanFields({
      internalName: req.body.internalName,
      name: req.body.name,
      slug: req.body.slug,
    });
    const plan = await PricingPlan.create(req.body);
    if (isMonthlyBillingCycle(plan.billingCycle)) {
      await syncBaseMonthlyPriceForPlan(stripe, plan);
    }
    res.status(201).json({ success: true, data: serializePlan(plan) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// @desc    Update a pricing plan
// @route   PUT /api/v1/subscriptions/plans/:id
// @access  Private (Admin only)
exports.updatePlan = async (req, res) => {
  try {
    const existingPlan = await PricingPlan.findById(req.params.id);
    if (!existingPlan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'listingPeriods')) {
      req.body.listingPeriods = normalizeListingPeriods(req.body.listingPeriods);
    }

    await ensureUniquePlanFields({
      id: existingPlan._id,
      internalName: Object.prototype.hasOwnProperty.call(req.body, 'internalName')
        ? req.body.internalName
        : existingPlan.internalName,
      name: Object.prototype.hasOwnProperty.call(req.body, 'name')
        ? req.body.name
        : existingPlan.name,
      slug: Object.prototype.hasOwnProperty.call(req.body, 'slug')
        ? req.body.slug
        : existingPlan.slug,
    });

    const plan = await PricingPlan.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    if (isMonthlyBillingCycle(plan.billingCycle)) {
      await syncBaseMonthlyPriceForPlan(stripe, plan);
    }

    res.status(200).json({ success: true, data: serializePlan(plan) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// @desc    Delete a pricing plan
// @route   DELETE /api/v1/subscriptions/plans/:id
// @access  Private (Admin only)
exports.deletePlan = async (req, res) => {
  try {
    const plan = await PricingPlan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    await PricingPlan.findByIdAndDelete(req.params.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
