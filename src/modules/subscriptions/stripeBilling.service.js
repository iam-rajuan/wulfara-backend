const { toCents } = require('./billingUtils');

const STRIPE_ENVIRONMENT = 'test';
const STRIPE_SOURCE = 'wulfara';

const findCachedMonthlyPrice = (plan, { unitAmount, currency, durationMonths, listingDiscountPercent }) =>
  (plan.stripePrices || []).find((price) =>
    price?.isActive !== false &&
    price?.stripePriceId &&
    price.billingCycleType === 'monthly' &&
    price.currency === currency &&
    Number(price.unitAmount) === Number(unitAmount) &&
    Number(price.intervalCount || 1) === 1 &&
    Number(price.durationMonths || 0) === Number(durationMonths || 0) &&
    Number(price.listingDiscountPercent || 0) === Number(listingDiscountPercent || 0)
  );

const ensureStripeProductForPlan = async (stripe, plan) => {
  if (plan.stripeProductId) {
    return plan.stripeProductId;
  }

  const product = await stripe.products.create({
    name: `WULFARA ${plan.name}`,
    description: plan.description || 'WULFARA supplier listing plan',
    metadata: {
      wulfaraPlanId: plan._id.toString(),
      environment: STRIPE_ENVIRONMENT,
      source: STRIPE_SOURCE,
    },
  });

  plan.stripeProductId = product.id;
  return product.id;
};

const ensureMonthlyPriceForPlan = async (
  stripe,
  plan,
  { amount, durationMonths, listingDiscountPercent = 0, currency = 'usd' } = {}
) => {
  const unitAmount = toCents(amount);
  const normalizedCurrency = String(currency || 'usd').toLowerCase();
  const cachedPrice = findCachedMonthlyPrice(plan, {
    unitAmount,
    currency: normalizedCurrency,
    durationMonths,
    listingDiscountPercent,
  });

  if (cachedPrice) {
    return cachedPrice.stripePriceId;
  }

  const stripeProductId = await ensureStripeProductForPlan(stripe, plan);
  const price = await stripe.prices.create({
    product: stripeProductId,
    currency: normalizedCurrency,
    unit_amount: unitAmount,
    recurring: {
      interval: 'month',
      interval_count: 1,
    },
    metadata: {
      wulfaraPlanId: plan._id.toString(),
      environment: STRIPE_ENVIRONMENT,
      source: STRIPE_SOURCE,
      billingCycle: 'monthly',
      durationMonths: String(durationMonths || ''),
      listingDiscountPercent: String(listingDiscountPercent || 0),
      effectiveRecurringAmount: String(amount || 0),
    },
  });

  plan.stripePrices = [
    ...(plan.stripePrices || []),
    {
      billingCycleType: 'monthly',
      currency: normalizedCurrency,
      unitAmount,
      interval: 'month',
      intervalCount: 1,
      durationMonths,
      listingDiscountPercent,
      stripePriceId: price.id,
      isActive: true,
      createdAt: new Date(),
    },
  ];

  if (!listingDiscountPercent && !durationMonths) {
    plan.stripeMonthlyPriceId = price.id;
    plan.stripeMonthlyUnitAmount = unitAmount;
    plan.stripeMonthlyCurrency = normalizedCurrency;
  }

  await plan.save();
  return price.id;
};

const syncBaseMonthlyPriceForPlan = async (stripe, plan) =>
  ensureMonthlyPriceForPlan(stripe, plan, {
    amount: plan.price,
    durationMonths: null,
    listingDiscountPercent: 0,
    currency: plan.stripeMonthlyCurrency || 'usd',
  });

module.exports = {
  STRIPE_ENVIRONMENT,
  STRIPE_SOURCE,
  ensureMonthlyPriceForPlan,
  ensureStripeProductForPlan,
  syncBaseMonthlyPriceForPlan,
};
