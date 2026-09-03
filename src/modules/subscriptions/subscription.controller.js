const Supplier = require('../suppliers/supplier.model');
const Payment = require('./payment.model');
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

const DEFAULT_LISTING_PERIODS = [
  { durationMonths: 12, isActive: true, discountPercent: 0, customLabel: '' },
  { durationMonths: 24, isActive: true, discountPercent: 15, customLabel: '' },
  { durationMonths: 48, isActive: true, discountPercent: 25, customLabel: '' },
];

const cloneDefaultListingPeriods = () =>
  DEFAULT_LISTING_PERIODS.map((period) => ({ ...period }));

const toCents = (amount = 0) => Math.round(Number(amount || 0) * 100);

const centsMatch = (left = 0, right = 0) => toCents(left) === toCents(right);

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
    const totalPrice = basePrice + addonPrice;

    supplierProfile.selectedPlan = plan._id;
    supplierProfile.selectedBillingCycle = resolvedBillingCycle;
    supplierProfile.selectedListingPeriod = resolvedListingPeriod;
    supplierProfile.selectedAddons = addons.map((addon) => addon.code);
    supplierProfile.subscriptionPlan = inferPlanTier(plan);
    supplierProfile.subscriptionStatus = 'pending';
    supplierProfile.paymentStatus = 'pending';
    syncSupplierLifecycle(supplierProfile);
    await supplierProfile.save();

    const appOrigin = resolveDashboardOrigin(req);

    const adminAssistedQuery =
      req.user.role === 'admin'
        ? `?session_id={CHECKOUT_SESSION_ID}&supplierId=${supplierProfile._id.toString()}&mode=admin_assisted`
        : '?session_id={CHECKOUT_SESSION_ID}';
    const cancelQuery =
      req.user.role === 'admin'
        ? `?cancelled=1&supplierId=${supplierProfile._id.toString()}&mode=admin_assisted`
        : '?cancelled=1';

    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `WULFARA ${plan.name} Plan - ${resolvedListingPeriod}`,
            description: [
              plan.description || 'B2B Marketplace Supplier Subscription',
              resolvedListingOption.discountPercent
                ? `${resolvedListingOption.discountPercent}% listing-duration discount applied`
                : '',
            ].filter(Boolean).join(' - '),
          },
          unit_amount: Math.round(basePrice * 100),
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
          unit_amount: Math.round(Number(addon.price || 0) * 100),
        },
        quantity: 1,
      });
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment', // Use 'payment' for one-time or 'subscription' if using Stripe Billing
      success_url: `${appOrigin}/listed${adminAssistedQuery}`,
      cancel_url: `${appOrigin}/subscription${cancelQuery}`,
      client_reference_id: supplierProfile._id.toString(),
      metadata: {
        supplierId: supplierProfile._id.toString(),
        planId: plan._id.toString(),
        planName: plan.name,
        planTier: inferPlanTier(plan),
        billingCycle: resolvedBillingCycle,
        listingPeriod: resolvedListingPeriod,
        listingDiscountPercent: String(resolvedListingOption.discountPercent || 0),
        addons: JSON.stringify(addons.map((addon) => addon.code)),
        featuredHeroPlacement: String(
          addons.some((addon) => addon.code === FEATURED_HERO_PLACEMENT.code)
        ),
        featuredHeroPlacementAmount: String(
          addons.find((addon) => addon.code === FEATURED_HERO_PLACEMENT.code)?.price || 0
        ),
      }
    });

    await Payment.create({
      supplier: supplierProfile._id,
      stripeSessionId: session.id,
      plan: plan._id,
      planName: plan.name,
      billingCycle: resolvedBillingCycle,
      listingPeriod: resolvedListingPeriod,
      listingDiscountPercent: resolvedListingOption.discountPercent || 0,
      addons: addons.map((addon) => ({
        code: addon.code,
        name: addon.name,
        amount: addon.price,
      })),
      baseAmount: basePrice,
      addonAmount: addonPrice,
      amount: totalPrice,
      status: 'pending',
    });

    res.status(200).json({
      success: true,
      message: 'Checkout session created',
      paymentUrl: session.url,
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
        totalDueToday: totalPrice,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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
    // Only construct event if a secret is provided, otherwise trust payload (for dev fallback)
    if (stripeWebhookSecret) {
      event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
    } else if (isProduction) {
      return res.status(500).send('Stripe webhook secret is not configured.');
    } else {
      // Parse raw body for dev fallback if no secret is configured
      event = JSON.parse(payload.toString());
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const supplierId = session.client_reference_id || session.metadata.supplierId;
    const planName = session.metadata?.planName || 'premium';
    const planId = session.metadata?.planId || null;
    const planTier = session.metadata?.planTier || null;
    const billingCycle = session.metadata?.billingCycle || '';
    const listingPeriod = session.metadata?.listingPeriod || '';
    const listingDiscountPercent = Number(session.metadata?.listingDiscountPercent || 0);

    try {
      const supplierProfile = await Supplier.findById(supplierId);
      if (supplierProfile) {
        const existingPayment = await Payment.findOne({ stripeSessionId: session.id });
        if (existingPayment?.status === 'paid') {
          return res.status(200).json({ received: true, duplicate: true });
        }

        if (session.payment_status && session.payment_status !== 'paid') {
          return res.status(200).json({ received: true, pending: true });
        }

        if (!existingPayment && isProduction) {
          console.error('Stripe webhook ignored unknown checkout session:', session.id);
          return res.status(200).json({ received: true, ignored: true, reason: 'unknown_session' });
        }

        const selectedPlan = planId ? await PricingPlan.findById(planId) : null;
        let metadataAddons = [];
        if (session.metadata?.addons) {
          try {
            metadataAddons = JSON.parse(session.metadata.addons);
          } catch (error) {
            metadataAddons = [];
          }
        }
        const resolvedAddonSelection = resolveSubscriptionAddons({
          addons: metadataAddons,
          featuredHeroPlacement: session.metadata?.featuredHeroPlacement === 'true',
        });
        const addons =
          existingPayment?.addons?.length > 0
            ? existingPayment.addons
            : resolvedAddonSelection.addons.map((addon) => ({
                code: addon.code,
                name: addon.name,
                amount: addon.price,
              }));
        const hasFeaturedHeroPlacement = addons.some(
          (addon) => addon.code === FEATURED_HERO_PLACEMENT.code
        );
        const addonAmount =
          existingPayment?.addonAmount ??
          addons.reduce((total, addon) => total + Number(addon.amount || 0), 0);
        const paidAmount = Number(session.amount_total || 0) / 100;
        const baseAmount = existingPayment?.baseAmount ?? Math.max(paidAmount - addonAmount, 0);

        if (existingPayment && !centsMatch(paidAmount, existingPayment.amount)) {
          existingPayment.status = 'failed';
          await existingPayment.save();
          console.error('Stripe webhook amount mismatch:', {
            sessionId: session.id,
            paidAmount,
            expectedAmount: existingPayment.amount,
          });
          return res.status(200).json({ received: true, ignored: true, reason: 'amount_mismatch' });
        }

        supplierProfile.subscriptionPlan = inferPlanTier(selectedPlan || planTier || planName);
        supplierProfile.selectedPlan = planId || supplierProfile.selectedPlan;
        supplierProfile.selectedBillingCycle = billingCycle || supplierProfile.selectedBillingCycle;
        supplierProfile.selectedListingPeriod = listingPeriod || supplierProfile.selectedListingPeriod;
        supplierProfile.selectedAddons = addons.map((addon) => addon.code);
        supplierProfile.subscriptionStatus = 'active';
        supplierProfile.paymentStatus = 'paid';
        supplierProfile.isApproved = true;
        supplierProfile.listingStatus = 'Approved';
        supplierProfile.stripeCustomerId = session.customer;
        if (hasFeaturedHeroPlacement) {
          supplierProfile.featuredHeroPlacement = {
            enabled: true,
            activatedAt: supplierProfile.featuredHeroPlacement?.activatedAt || new Date(),
          };
        }
        syncSupplierLifecycle(supplierProfile);
        await supplierProfile.save();

        if (existingPayment) {
          existingPayment.plan = planId;
          existingPayment.planName = planName;
          existingPayment.billingCycle = billingCycle;
          existingPayment.listingPeriod = listingPeriod;
          existingPayment.listingDiscountPercent = listingDiscountPercent;
          existingPayment.addons = addons;
          existingPayment.baseAmount = baseAmount;
          existingPayment.addonAmount = addonAmount;
          existingPayment.amount = paidAmount;
          existingPayment.status = 'paid';
          await existingPayment.save();
        } else {
          await Payment.create({
            supplier: supplierProfile._id,
            plan: planId,
            planName,
            billingCycle,
            listingPeriod,
            listingDiscountPercent,
            addons,
            baseAmount,
            addonAmount,
            amount: paidAmount,
            status: 'paid',
            stripeSessionId: session.id,
          });
        }
      }
    } catch (err) {
      console.error('Error upgrading supplier profile:', err);
    }
  }

  res.status(200).json({ received: true });
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

    const payments = await Payment.find({ supplier: supplierProfile._id }).sort('-createdAt');

    res.status(200).json({ success: true, count: payments.length, data: payments });
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

    res.status(200).json({
      success: true,
      count: suppliers.length,
      data: suppliers,
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
