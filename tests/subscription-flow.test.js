const request = require('supertest');

const {
  app,
  authHeader,
  createCategory,
  createPricingPlan,
  createSupplierForUser,
  createUser,
  tokenForUser,
  uniqueEmail,
  models: { Payment, Subscription, Supplier },
} = require('./helpers/factories');

const stripeFactory = require('stripe');
const {
  FEATURED_HERO_PLACEMENT,
} = require('../src/modules/subscriptions/subscriptionAddons');
const { ensureMonthlyPriceForPlan } = require('../src/modules/subscriptions/stripeBilling.service');
const { expireElapsedSubscriptions } = require('../src/modules/subscriptions/subscriptionEntitlement.service');
const Rfq = require('../src/modules/rfqs/rfq.model');

describe('subscription and stripe flow', () => {
  const createCheckoutReadySupplier = async () => {
    const category = await createCategory({ name: `Checkout Category ${Date.now()}` });
    const plan = await createPricingPlan({ name: 'Checkout Plan', slug: `checkout-${Date.now()}` });
    const user = await createUser({
      role: 'supplier',
      email: uniqueEmail('checkout-supplier'),
    });

    const supplier = await createSupplierForUser(user, {
      categories: [category._id],
    });

    return { category, plan, supplier, user };
  };

  const createActiveMonthlySubscription = async ({
    user,
    supplier,
    plan,
    stripeSubscriptionId = `sub_active_${Date.now()}`,
    stripeCustomerId = `cus_active_${Date.now()}`,
    currentPeriodStart = new Date('2024-05-01T00:00:00.000Z'),
    currentPeriodEnd = new Date('2024-06-01T00:00:00.000Z'),
    subscriptionEndDate = new Date('2027-07-01T00:00:00.000Z'),
    amount = 499,
  } = {}) => {
    const context = supplier && user ? { supplier, user } : await createCheckoutReadySupplier();
    const resolvedSupplier = supplier || context.supplier;
    const resolvedUser = user || context.user;
    const resolvedPlan = plan || await createPricingPlan({
      name: 'Active Monthly Plan',
      slug: `active-monthly-${Date.now()}`,
      price: amount,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 38, isActive: true }],
    });

    resolvedSupplier.subscriptionStatus = 'active';
    resolvedSupplier.paymentStatus = 'paid';
    resolvedSupplier.isApproved = true;
    resolvedSupplier.listingStatus = 'Approved';
    resolvedSupplier.selectedPlan = resolvedPlan._id;
    resolvedSupplier.selectedBillingCycle = 'Monthly';
    resolvedSupplier.selectedListingPeriod = '38 Months';
    resolvedSupplier.subscriptionPlan = 'premium';
    resolvedSupplier.stripeCustomerId = stripeCustomerId;
    await resolvedSupplier.save();

    const subscription = await Subscription.create({
      supplier: resolvedSupplier._id,
      plan: resolvedPlan._id,
      planName: resolvedPlan.name,
      billingCycle: 'Monthly',
      billingCycleType: 'monthly',
      durationMonths: 38,
      listingPeriod: '38 Months',
      status: 'active',
      stripeCustomerId,
      stripeSubscriptionId,
      stripeSubscriptionStatus: 'active',
      subscriptionStartDate: new Date('2024-01-01T00:00:00.000Z'),
      currentPeriodStart,
      currentPeriodEnd,
      nextPaymentDate: currentPeriodEnd,
      subscriptionEndDate,
      cancelAt: subscriptionEndDate,
      effectiveRecurringAmount: amount,
      totalInitialAmount: amount,
    });

    await Payment.create({
      supplier: resolvedSupplier._id,
      plan: resolvedPlan._id,
      amount,
      status: 'paid',
      paymentType: 'recurring_invoice',
      billingPeriodStart: currentPeriodStart,
      billingPeriodEnd: currentPeriodEnd,
      stripeInvoiceId: `in_paid_${Date.now()}_${Math.random()}`,
      stripeSubscriptionId,
    });

    return {
      user: resolvedUser,
      supplier: resolvedSupplier,
      plan: resolvedPlan,
      subscription,
      stripeSubscriptionId,
      stripeCustomerId,
      currentPeriodStart,
      currentPeriodEnd,
      subscriptionEndDate,
    };
  };

  it('creates Stripe checkout sessions with production-safe dashboard URLs', async () => {
    const { plan, user, supplier } = await createCheckoutReadySupplier();

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
        billingCycle: 'Annual',
        listingPeriod: '12-months',
      })
      .expect(200);

    expect(response.body.paymentUrl).toBe('https://stripe.test/checkout/default');

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    expect(latestCall.success_url).toBe(
      'https://dashboard.wulfara.test/listed?session_id={CHECKOUT_SESSION_ID}'
    );
    expect(latestCall.cancel_url).toBe('https://dashboard.wulfara.test/subscription?cancelled=1');

    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSupplier.selectedPlan.toString()).toBe(plan._id.toString());
    expect(refreshedSupplier.subscriptionStatus).toBe('pending');
    expect(refreshedSupplier.paymentStatus).toBe('pending');
    expect(refreshedSupplier.onboardingStep).toBe('payment');
  });

  it('keeps the base checkout total unchanged when no add-on is selected', async () => {
    const { plan, user, supplier } = await createCheckoutReadySupplier();

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
      })
      .expect(200);

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const payment = await Payment.findOne({ supplier: supplier._id });

    expect(latestCall.line_items).toHaveLength(1);
    expect(latestCall.metadata.featuredHeroPlacement).toBe('false');
    expect(response.body.orderSummary).toMatchObject({
      basePrice: plan.price,
      addonPrice: 0,
      totalDueToday: plan.price,
    });
    expect(payment.addons).toHaveLength(0);
    expect(payment.baseAmount).toBe(plan.price);
    expect(payment.addonAmount).toBe(0);
    expect(payment.amount).toBe(plan.price);
  });

  it('uses the selected monthly pricing plan as the only source of checkout amount and billing metadata', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Monthly Premium',
      slug: `monthly-premium-${Date.now()}`,
      price: 149,
      billingCycle: 'Monthly',
      listingPeriods: [
        { durationMonths: 10, discountPercent: 0, isActive: true },
        { durationMonths: 20, discountPercent: 10, isActive: true },
      ],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: monthlyPlan._id.toString(),
        billingCycle: 'Annual (Tampered)',
        listingPeriod: '999 Months',
      })
      .expect(200);

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const refreshedSupplier = await Supplier.findById(supplier._id);

    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id });

    expect(latestCall.mode).toBe('subscription');
    expect(latestCall.line_items[0]).toEqual({ price: 'price_test_default', quantity: 1 });
    expect(latestCall.metadata.billingCycle).toBe('Monthly');
    expect(latestCall.metadata.listingPeriod).toBe('10 Months');
    expect(stripeFactory.__mock.createPrice.mock.calls.at(-1)[0].unit_amount).toBe(14900);
    expect(stripeFactory.__mock.createPrice.mock.calls.at(-1)[0].recurring.interval_count).toBe(1);
    expect(subscriptionRecord.effectiveRecurringAmount).toBe(149);
    expect(refreshedSupplier.selectedPlan.toString()).toBe(monthlyPlan._id.toString());
    expect(refreshedSupplier.selectedBillingCycle).toBe('Monthly');
    expect(refreshedSupplier.selectedListingPeriod).toBe('10 Months');
  });

  it('uses the selected yearly pricing plan as the only source of checkout amount and billing metadata', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const yearlyPlan = await createPricingPlan({
      name: 'Yearly Premium',
      slug: `yearly-premium-${Date.now()}`,
      price: 999,
      billingCycle: 'Annual (Paid Upfront)',
    });

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: yearlyPlan._id.toString(),
      })
      .expect(200);

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(latestCall.line_items[0].price_data.unit_amount).toBe(99900);
    expect(latestCall.metadata.billingCycle).toBe('Annual (Paid Upfront)');
    expect(latestCall.metadata.listingPeriod).toBe('12 Months');
    expect(response.body.orderSummary).toMatchObject({
      planId: yearlyPlan._id.toString(),
      planName: yearlyPlan.name,
      billingCycle: 'Annual (Paid Upfront)',
      listingPeriod: '12 Months',
      basePrice: 999,
      totalDueToday: 999,
    });
    expect(refreshedSupplier.selectedPlan.toString()).toBe(yearlyPlan._id.toString());
    expect(refreshedSupplier.selectedBillingCycle).toBe('Annual (Paid Upfront)');
    expect(refreshedSupplier.selectedListingPeriod).toBe('12 Months');
  });

  it('derives billing and listing metadata from the pricing plan when the frontend sends only the plan id', async () => {
    const { plan, user, supplier } = await createCheckoutReadySupplier();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
      })
      .expect(200);

    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(refreshedSupplier.selectedBillingCycle).toBe(plan.billingCycle);
    expect(refreshedSupplier.selectedListingPeriod).toBe('12 Months');
  });

  it('preserves a valid admin-configured listing period separately from the billing cycle', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const customPlan = await createPricingPlan({
      name: 'Custom Duration Plan',
      slug: `custom-duration-${Date.now()}`,
      price: 320,
      billingCycle: 'Monthly',
      listingPeriods: [
        { durationMonths: 10, discountPercent: 0, isActive: true },
        { durationMonths: 24, discountPercent: 15, isActive: true },
      ],
    });

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: customPlan._id.toString(),
        listingPeriod: '10 Months',
      })
      .expect(200);

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id }).sort({ createdAt: -1 });
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(latestCall.mode).toBe('subscription');
    expect(latestCall.metadata.billingCycle).toBe('Monthly');
    expect(latestCall.metadata.listingPeriod).toBe('10 Months');
    expect(response.body.orderSummary.listingPeriod).toBe('10 Months');
    expect(subscriptionRecord.listingPeriod).toBe('10 Months');
    expect(refreshedSupplier.selectedListingPeriod).toBe('10 Months');
  });

  it('applies the selected listing period discount to the checkout amount', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const discountedPlan = await createPricingPlan({
      name: 'Discounted Duration Plan',
      slug: `discounted-duration-${Date.now()}`,
      price: 100,
      billingCycle: 'Monthly',
      listingPeriods: [
        { durationMonths: 24, discountPercent: 8, isActive: true },
        { durationMonths: 45, discountPercent: 10, isActive: true },
      ],
    });

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: discountedPlan._id.toString(),
        listingPeriod: '24 Months',
      })
      .expect(200);

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id }).sort({ createdAt: -1 });

    expect(latestCall.mode).toBe('subscription');
    expect(stripeFactory.__mock.createPrice.mock.calls.at(-1)[0].unit_amount).toBe(9200);
    expect(latestCall.metadata.listingPeriod).toBe('24 Months');
    expect(latestCall.metadata.listingDiscountPercent).toBe('8');
    expect(response.body.orderSummary).toMatchObject({
      listingPeriod: '24 Months',
      listingDiscountPercent: 8,
      basePrice: 92,
      totalDueToday: 92,
    });
    expect(subscriptionRecord.listingPeriod).toBe('24 Months');
    expect(subscriptionRecord.listingDiscountPercent).toBe(8);
    expect(subscriptionRecord.effectiveRecurringAmount).toBe(92);
    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(0);
  });

  it('adds featured hero placement to the backend-calculated Stripe total and ignores tampered frontend pricing', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const premiumPlan = await createPricingPlan({
      name: 'Premium Supplier',
      slug: `premium-supplier-${Date.now()}`,
      price: 300,
      billingCycle: 'Annual',
    });

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: premiumPlan._id.toString(),
        addons: [FEATURED_HERO_PLACEMENT.code],
        featuredHeroPlacement: true,
        addonPrice: 0.01,
      })
      .expect(200);

    const latestCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const payment = await Payment.findOne({ supplier: supplier._id });
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(latestCall.line_items).toHaveLength(2);
    expect(latestCall.line_items[0].price_data.unit_amount).toBe(30000);
    expect(latestCall.line_items[1].price_data.unit_amount).toBe(1500);
    expect(latestCall.metadata.addons).toBe(JSON.stringify([FEATURED_HERO_PLACEMENT.code]));
    expect(latestCall.metadata.featuredHeroPlacement).toBe('true');
    expect(latestCall.metadata.featuredHeroPlacementAmount).toBe('15');
    expect(response.body.orderSummary).toMatchObject({
      basePrice: 300,
      addonPrice: 15,
      totalDueToday: 315,
    });
    expect(payment.addons).toEqual([
      expect.objectContaining({
        code: FEATURED_HERO_PLACEMENT.code,
        name: FEATURED_HERO_PLACEMENT.name,
        amount: 15,
      }),
    ]);
    expect(payment.baseAmount).toBe(300);
    expect(payment.addonAmount).toBe(15);
    expect(payment.amount).toBe(315);
    expect(payment.status).toBe('pending');
    expect(refreshedSupplier.selectedAddons).toContain(FEATURED_HERO_PLACEMENT.code);
    expect(refreshedSupplier.featuredHeroPlacement?.enabled).not.toBe(true);
  });

  it('rejects unsupported add-ons safely', async () => {
    const { plan, user } = await createCheckoutReadySupplier();

    const response = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
        addons: ['fake_addon'],
      })
      .expect(400);

    expect(response.body.message).toContain('Unsupported add-on selection');
    expect(await Payment.countDocuments()).toBe(0);
  });

  it('only exposes active admin-created plans to suppliers', async () => {
    const activePlan = await createPricingPlan({
      name: 'Active Supplier Plan',
      slug: `active-supplier-plan-${Date.now()}`,
      price: 99,
      iconKey: 'rocket',
      badgeText: 'Best Value',
      accentColor: '#10B981',
      features: ['Verified supplier badge', 'Priority support'],
      isActive: true,
    });
    const archivedPlan = await createPricingPlan({
      name: 'Archived Supplier Plan',
      slug: `archived-supplier-plan-${Date.now()}`,
      price: 49,
      iconKey: 'shield',
      isActive: false,
    });

    const response = await request(app).get('/api/v1/subscriptions/plans').expect(200);
    const planIds = response.body.data.map((plan) => plan._id);

    expect(planIds).toContain(activePlan._id.toString());
    expect(planIds).not.toContain(archivedPlan._id.toString());
    expect(response.body.data.find((plan) => plan._id === activePlan._id.toString())).toMatchObject({
      name: 'Active Supplier Plan',
      price: 99,
      iconKey: 'rocket',
      badgeText: 'Best Value',
      accentColor: '#10B981',
      features: ['Verified supplier badge', 'Priority support'],
      isActive: true,
    });
  });

  it('blocks saved selections and Stripe checkout for archived plans', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const archivedPlan = await createPricingPlan({
      name: 'Archived Checkout Plan',
      slug: `archived-checkout-plan-${Date.now()}`,
      price: 149,
      isActive: false,
    });

    const saveResponse = await request(app)
      .put('/api/v1/suppliers/onboarding/subscription')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: archivedPlan._id.toString() })
      .expect(404);

    expect(saveResponse.body.message).toContain('inactive');

    const checkoutResponse = await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: archivedPlan._id.toString() })
      .expect(404);

    expect(checkoutResponse.body.message).toContain('inactive');
    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(0);
  });

  it('activates featured hero placement exactly once on successful webhook delivery and keeps wrong metadata from activating the wrong supplier', async () => {
    const { plan, supplier: targetSupplier, user } = await createCheckoutReadySupplier();
    const { supplier: otherSupplier } = await createCheckoutReadySupplier();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
        addons: [FEATURED_HERO_PLACEMENT.code],
      })
      .expect(200);

    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_default',
          client_reference_id: targetSupplier._id.toString(),
          amount_total: 101400,
          customer: 'cus_test_123',
          metadata: {
            supplierId: otherSupplier._id.toString(),
            planId: plan._id.toString(),
            planName: 'Premium',
            billingCycle: 'Annual',
            listingPeriod: '12-months',
            addons: JSON.stringify([FEATURED_HERO_PLACEMENT.code]),
            featuredHeroPlacement: 'true',
          },
        },
      },
    };

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);

    let refreshedTarget = await Supplier.findById(targetSupplier._id);
    let refreshedOther = await Supplier.findById(otherSupplier._id);
    let payments = await Payment.find({ stripeSessionId: 'cs_test_default' });

    expect(refreshedTarget.subscriptionStatus).toBe('active');
    expect(refreshedTarget.paymentStatus).toBe('paid');
    expect(refreshedTarget.isApproved).toBe(true);
    expect(refreshedTarget.listingStatus).toBe('Approved');
    expect(refreshedTarget.onboardingStep).toBe('listed');
    expect(refreshedTarget.selectedAddons).toContain(FEATURED_HERO_PLACEMENT.code);
    expect(refreshedTarget.featuredHeroPlacement.enabled).toBe(true);
    expect(refreshedOther.subscriptionStatus).not.toBe('active');
    expect(payments).toHaveLength(1);
    expect(payments[0].addons).toEqual([
      expect.objectContaining({
        code: FEATURED_HERO_PLACEMENT.code,
        amount: 15,
      }),
    ]);
    expect(payments[0].baseAmount).toBe(plan.price);
    expect(payments[0].addonAmount).toBe(15);
    expect(payments[0].amount).toBe(1014);

    const duplicateResponse = await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);

    expect(duplicateResponse.body.duplicate).toBe(true);

    refreshedTarget = await Supplier.findById(targetSupplier._id);
    payments = await Payment.find({ stripeSessionId: 'cs_test_default' });

    expect(refreshedTarget.subscriptionStatus).toBe('active');
    expect(refreshedTarget.featuredHeroPlacement.enabled).toBe(true);
    expect(payments).toHaveLength(1);
  });

  it('does not activate a supplier when Stripe paid amount does not match the pending checkout', async () => {
    const { plan, supplier, user } = await createCheckoutReadySupplier();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
      })
      .expect(200);

    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_default',
          client_reference_id: supplier._id.toString(),
          amount_total: 100,
          payment_status: 'paid',
          customer: 'cus_amount_mismatch',
          metadata: {
            supplierId: supplier._id.toString(),
            planId: plan._id.toString(),
            planName: plan.name,
            billingCycle: plan.billingCycle,
            listingPeriod: '12 Months',
          },
        },
      },
    };

    const response = await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);

    const refreshedSupplier = await Supplier.findById(supplier._id);
    const payment = await Payment.findOne({ supplier: supplier._id });

    expect(response.body.reason).toBe('amount_mismatch');
    expect(refreshedSupplier.subscriptionStatus).toBe('pending');
    expect(refreshedSupplier.paymentStatus).toBe('pending');
    expect(refreshedSupplier.isApproved).toBe(false);
    expect(payment.status).toBe('failed');
  });

  it('does not activate featured hero placement after failed or cancelled checkout flows', async () => {
    const { plan, user, supplier } = await createCheckoutReadySupplier();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
        addons: [FEATURED_HERO_PLACEMENT.code],
      })
      .expect(200);

    let refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSupplier.subscriptionStatus).toBe('pending');
    expect(refreshedSupplier.paymentStatus).toBe('pending');
    expect(refreshedSupplier.onboardingStep).toBe('payment');
    expect(refreshedSupplier.isApproved).toBe(false);
    expect(refreshedSupplier.featuredHeroPlacement?.enabled).not.toBe(true);

    const failedEvent = {
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_test_failed',
          metadata: {
            supplierId: supplier._id.toString(),
          },
        },
      },
    };

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(failedEvent))
      .expect(200);

    refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSupplier.subscriptionStatus).toBe('pending');
    expect(refreshedSupplier.paymentStatus).toBe('pending');
    expect(refreshedSupplier.isApproved).toBe(false);
    expect(refreshedSupplier.featuredHeroPlacement?.enabled).not.toBe(true);
    expect(await Payment.countDocuments()).toBe(1);
    const payment = await Payment.findOne({ supplier: supplier._id });
    expect(payment.status).toBe('pending');
    expect(payment.addons).toEqual([
      expect.objectContaining({ code: FEATURED_HERO_PLACEMENT.code, amount: 15 }),
    ]);
  });

  it('accepts the legacy stripe webhook alias path', async () => {
    const { plan, supplier } = await createCheckoutReadySupplier();

    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_alias',
          client_reference_id: supplier._id.toString(),
          amount_total: 49900,
          customer: 'cus_test_alias',
          metadata: {
            supplierId: supplier._id.toString(),
            planId: plan._id.toString(),
            planName: 'Premium',
            billingCycle: 'Annual',
            listingPeriod: '12-months',
          },
        },
      },
    };

    await request(app)
      .post('/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);

    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
  });

  it('returns backend-controlled add-on definitions with active plans', async () => {
    await createPricingPlan({ name: 'Plans API', slug: `plans-api-${Date.now()}` });

    const response = await request(app).get('/api/v1/subscriptions/plans').expect(200);

    expect(response.body.addons).toEqual([
      expect.objectContaining({
        code: FEATURED_HERO_PLACEMENT.code,
        name: FEATURED_HERO_PLACEMENT.name,
        price: 15,
      }),
    ]);
  });

  it('creates monthly Stripe Checkout in subscription mode with a one-month recurring price and finite cancel_at metadata', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Monthly Managed Plan',
      slug: `monthly-managed-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
      listingPeriods: [
        { durationMonths: 38, discountPercent: 15, isActive: true },
      ],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: monthlyPlan._id.toString(),
        listingPeriod: '38 Months',
        addons: [FEATURED_HERO_PLACEMENT.code],
        amount: 1,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.orderSummary.checkoutMode).toBe('subscription');
        expect(body.orderSummary.durationMonths).toBe(38);
        expect(body.orderSummary.recurringAmount).toBe(424.15);
        expect(body.orderSummary.totalDueToday).toBe(439.15);
      });

    const priceCall = stripeFactory.__mock.createPrice.mock.calls.at(-1)[0];
    const sessionCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id });
    const pendingPayments = await Payment.find({ supplier: supplier._id });

    expect(priceCall.recurring).toEqual({ interval: 'month', interval_count: 1 });
    expect(priceCall.unit_amount).toBe(42415);
    expect(priceCall.metadata.durationMonths).toBe('38');
    expect(sessionCall.mode).toBe('subscription');
    expect(sessionCall.line_items[0]).toEqual({ price: 'price_test_default', quantity: 1 });
    expect(sessionCall.line_items[1].price_data.unit_amount).toBe(1500);
    expect(sessionCall.metadata.checkoutType).toBe('monthly_subscription');
    expect(sessionCall.metadata.environment).toBe('test');
    expect(subscriptionRecord.durationMonths).toBe(38);
    expect(subscriptionRecord.effectiveRecurringAmount).toBe(424.15);
    expect(subscriptionRecord.addonAmount).toBe(15);
    expect(pendingPayments).toHaveLength(0);
  });

  it('allows an active monthly supplier to schedule cancellation at current period end without removing entitlement', async () => {
    const currentPeriodEnd = new Date('2024-06-01T00:00:00.000Z');
    const {
      user,
      supplier,
      subscription,
      stripeSubscriptionId,
      stripeCustomerId,
    } = await createActiveMonthlySubscription({ currentPeriodEnd });

    stripeFactory.__mock.retrieveSubscription.mockResolvedValueOnce({
      id: stripeSubscriptionId,
      status: 'active',
      livemode: false,
      customer: stripeCustomerId,
      current_period_start: 1714521600,
      current_period_end: 1717200000,
      cancel_at: 1814400000,
      cancel_at_period_end: false,
      metadata: {},
    });
    stripeFactory.__mock.updateSubscription.mockResolvedValueOnce({
      id: stripeSubscriptionId,
      status: 'active',
      customer: stripeCustomerId,
      current_period_start: 1714521600,
      current_period_end: 1717200000,
      cancel_at: 1717200000,
      cancel_at_period_end: true,
      metadata: {},
    });

    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('cancellation_scheduled');
        expect(body.data.cancelAtPeriodEnd).toBe(true);
        expect(body.data.nextPaymentDate).toBeNull();
      });

    expect(stripeFactory.__mock.updateSubscription).toHaveBeenCalledWith(
      stripeSubscriptionId,
      expect.objectContaining({ cancel_at_period_end: true })
    );

    const refreshedSubscription = await Subscription.findById(subscription._id);
    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSubscription.cancelAtPeriodEnd).toBe(true);
    expect(refreshedSubscription.nextPaymentDate).toBeNull();
    expect(refreshedSubscription.cancelAt.toISOString()).toBe(currentPeriodEnd.toISOString());
    expect(refreshedSubscription.subscriptionEndDate.toISOString()).toBe(currentPeriodEnd.toISOString());
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
  });

  it('normalizes current subscription billing metadata for monthly cancellation UI eligibility', async () => {
    const { user, subscription } = await createActiveMonthlySubscription({
      stripeSubscriptionId: 'sub_current_shape',
      stripeCustomerId: 'cus_current_shape',
    });
    subscription.billingCycleType = 'one_time';
    subscription.billingCycle = 'Monthly';
    await subscription.save();

    await request(app)
      .get('/api/v1/subscriptions/current')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.billingCycle).toBe('Monthly');
        expect(body.data.billingCycleType).toBe('one_time');
        expect(body.data.isMonthlyRecurring).toBe(true);
        expect(body.data.canCancelAtPeriodEnd).toBe(true);
        expect(body.data.cancellationScheduled).toBe(false);
        expect(body.data.recurringAmount).toBe(499);
        expect(body.data.stripeSubscriptionId).toBe('sub_current_shape');
      });
  });

  it('cancels an active monthly subscription even when billingCycleType is stale', async () => {
    const { user, subscription, stripeSubscriptionId, stripeCustomerId } = await createActiveMonthlySubscription({
      stripeSubscriptionId: 'sub_stale_type_cancel',
      stripeCustomerId: 'cus_stale_type_cancel',
    });
    subscription.billingCycleType = 'one_time';
    subscription.billingCycle = 'Monthly';
    await subscription.save();

    stripeFactory.__mock.retrieveSubscription.mockResolvedValueOnce({
      id: stripeSubscriptionId,
      status: 'active',
      livemode: false,
      customer: stripeCustomerId,
      current_period_start: 1714521600,
      current_period_end: 1717200000,
      cancel_at: 1814400000,
      cancel_at_period_end: false,
      metadata: {},
    });
    stripeFactory.__mock.updateSubscription.mockResolvedValueOnce({
      id: stripeSubscriptionId,
      status: 'active',
      customer: stripeCustomerId,
      current_period_start: 1714521600,
      current_period_end: 1717200000,
      cancel_at: 1717200000,
      cancel_at_period_end: true,
      metadata: {},
    });

    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.cancelAtPeriodEnd).toBe(true);
        expect(body.data.nextPaymentDate).toBeNull();
      });

    expect(stripeFactory.__mock.updateSubscription).toHaveBeenCalledWith(
      stripeSubscriptionId,
      expect.objectContaining({ cancel_at_period_end: true })
    );
  });

  it('rejects annual subscriptions from the monthly cancellation endpoint', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const annualPlan = await createPricingPlan({
      name: 'Annual Cancel Guard',
      slug: `annual-cancel-guard-${Date.now()}`,
      billingCycle: 'Annual',
    });

    await Subscription.create({
      supplier: supplier._id,
      plan: annualPlan._id,
      planName: annualPlan.name,
      billingCycle: 'Annual',
      billingCycleType: 'annual',
      status: 'active',
      subscriptionEndDate: new Date('2025-01-01T00:00:00.000Z'),
    });

    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(tokenForUser(user)))
      .expect(400);

    expect(stripeFactory.__mock.updateSubscription).not.toHaveBeenCalled();
  });

  it('requires authentication for monthly cancellation', async () => {
    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .expect(401);
  });

  it('does not let a supplier cancel another supplier subscription id from the request body', async () => {
    const { subscription: victimSubscription } = await createActiveMonthlySubscription({
      stripeSubscriptionId: 'sub_victim_cancel',
      stripeCustomerId: 'cus_victim_cancel',
    });
    const attackerUser = await createUser({
      role: 'supplier',
      email: uniqueEmail('cancel-attacker'),
    });
    await createSupplierForUser(attackerUser);

    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(tokenForUser(attackerUser)))
      .send({ stripeSubscriptionId: victimSubscription.stripeSubscriptionId })
      .expect(404);

    expect(stripeFactory.__mock.updateSubscription).not.toHaveBeenCalled();
    const unchangedVictim = await Subscription.findById(victimSubscription._id);
    expect(unchangedVictim.cancelAtPeriodEnd).toBe(false);
  });

  it('keeps duplicate cancellation requests idempotent', async () => {
    const currentPeriodStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const currentPeriodEnd = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const currentPeriodStartUnix = Math.floor(currentPeriodStart.getTime() / 1000);
    const currentPeriodEndUnix = Math.floor(currentPeriodEnd.getTime() / 1000);
    const {
      user,
      subscription,
      stripeSubscriptionId,
      stripeCustomerId,
    } = await createActiveMonthlySubscription({ currentPeriodStart, currentPeriodEnd });

    stripeFactory.__mock.retrieveSubscription.mockResolvedValue({
      id: stripeSubscriptionId,
      status: 'active',
      livemode: false,
      customer: stripeCustomerId,
      current_period_start: currentPeriodStartUnix,
      current_period_end: currentPeriodEndUnix,
      cancel_at: 1814400000,
      cancel_at_period_end: false,
      metadata: {},
    });
    stripeFactory.__mock.updateSubscription.mockResolvedValue({
      id: stripeSubscriptionId,
      status: 'active',
      customer: stripeCustomerId,
      current_period_start: currentPeriodStartUnix,
      current_period_end: currentPeriodEndUnix,
      cancel_at: currentPeriodEndUnix,
      cancel_at_period_end: true,
      metadata: {},
    });

    const token = tokenForUser(user);
    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(token))
      .expect(200);
    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(token))
      .expect(200)
      .expect(({ body }) => {
        expect(body.message).toContain('already scheduled');
      });

    expect(stripeFactory.__mock.updateSubscription).toHaveBeenCalledTimes(1);
    const refreshedSubscription = await Subscription.findById(subscription._id);
    expect(refreshedSubscription.cancelAtPeriodEnd).toBe(true);
    expect(refreshedSubscription.nextPaymentDate).toBeNull();
  });

  it('does not mutate local state when Stripe cancellation scheduling fails', async () => {
    const { user, subscription, stripeSubscriptionId, stripeCustomerId } = await createActiveMonthlySubscription();

    stripeFactory.__mock.retrieveSubscription.mockResolvedValueOnce({
      id: stripeSubscriptionId,
      status: 'active',
      livemode: false,
      customer: stripeCustomerId,
      current_period_start: 1714521600,
      current_period_end: 1717200000,
      cancel_at: 1814400000,
      cancel_at_period_end: false,
      metadata: {},
    });
    stripeFactory.__mock.updateSubscription.mockRejectedValueOnce(new Error('Stripe temporary failure'));

    await request(app)
      .post('/api/v1/subscriptions/current/cancel')
      .set(authHeader(tokenForUser(user)))
      .expect(502);

    const refreshedSubscription = await Subscription.findById(subscription._id);
    expect(refreshedSubscription.cancelAtPeriodEnd).toBe(false);
    expect(refreshedSubscription.nextPaymentDate.toISOString()).toBe(subscription.currentPeriodEnd.toISOString());
    expect(refreshedSubscription.status).toBe('active');
  });

  it('syncs customer.subscription.updated cancellation scheduling without hiding listing entitlement', async () => {
    const { supplier, subscription, stripeSubscriptionId, stripeCustomerId } = await createActiveMonthlySubscription();

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'customer.subscription.updated',
        livemode: false,
        data: {
          object: {
            id: stripeSubscriptionId,
            status: 'active',
            customer: stripeCustomerId,
            current_period_start: 1714521600,
            current_period_end: 1717200000,
            cancel_at: 1717200000,
            cancel_at_period_end: true,
            metadata: { supplierId: supplier._id.toString() },
          },
        },
      }))
      .expect(200);

    const refreshedSubscription = await Subscription.findById(subscription._id);
    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSubscription.status).toBe('active');
    expect(refreshedSubscription.cancelAtPeriodEnd).toBe(true);
    expect(refreshedSubscription.nextPaymentDate).toBeNull();
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
  });

  it('terminates entitlement on customer.subscription.deleted after a scheduled customer cancellation', async () => {
    const { supplier, subscription, stripeSubscriptionId, stripeCustomerId } = await createActiveMonthlySubscription();
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = subscription.currentPeriodEnd;
    subscription.subscriptionEndDate = subscription.currentPeriodEnd;
    subscription.nextPaymentDate = null;
    await subscription.save();
    supplier.featuredHeroPlacement = { enabled: true, activatedAt: new Date('2024-01-01T00:00:00.000Z') };
    await supplier.save();

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'customer.subscription.deleted',
        livemode: false,
        data: {
          object: {
            id: stripeSubscriptionId,
            status: 'canceled',
            customer: stripeCustomerId,
            current_period_end: Math.floor(subscription.currentPeriodEnd.getTime() / 1000),
            cancel_at: Math.floor(subscription.currentPeriodEnd.getTime() / 1000),
            cancel_at_period_end: false,
            metadata: { supplierId: supplier._id.toString() },
          },
        },
      }))
      .expect(200);

    const refreshedSubscription = await Subscription.findById(subscription._id);
    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSubscription.status).toBe('canceled');
    expect(refreshedSubscription.nextPaymentDate).toBeNull();
    expect(refreshedSupplier.subscriptionStatus).toBe('cancelled');
    expect(refreshedSupplier.paymentStatus).toBe('cancelled');
    expect(refreshedSupplier.isApproved).toBe(false);
    expect(refreshedSupplier.listingStatus).toBe('Hidden');
    expect(refreshedSupplier.featuredHeroPlacement.enabled).toBe(false);
    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(1);
  });

  it('preserves entitlement if Stripe sends terminal cancellation before the paid period ends', async () => {
    const futurePeriodEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const { supplier, subscription, stripeSubscriptionId, stripeCustomerId } = await createActiveMonthlySubscription({
      currentPeriodEnd: futurePeriodEnd,
      subscriptionEndDate: futurePeriodEnd,
    });
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = futurePeriodEnd;
    subscription.subscriptionEndDate = futurePeriodEnd;
    subscription.nextPaymentDate = null;
    await subscription.save();

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'customer.subscription.deleted',
        livemode: false,
        data: {
          object: {
            id: stripeSubscriptionId,
            status: 'canceled',
            customer: stripeCustomerId,
            current_period_end: Math.floor(futurePeriodEnd.getTime() / 1000),
            cancel_at: Math.floor(futurePeriodEnd.getTime() / 1000),
            cancel_at_period_end: false,
            metadata: { supplierId: supplier._id.toString() },
          },
        },
      }))
      .expect(200)
      .expect(({ body }) => {
        expect(body.entitlementPreservedUntil).toBeTruthy();
      });

    const refreshedSubscription = await Subscription.findById(subscription._id);
    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSubscription.status).toBe('active');
    expect(refreshedSubscription.stripeSubscriptionStatus).toBe('canceled');
    expect(refreshedSubscription.cancelAtPeriodEnd).toBe(true);
    expect(refreshedSubscription.nextPaymentDate).toBeNull();
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.isApproved).toBe(true);
    expect(refreshedSupplier.listingStatus).toBe('Approved');
  });

  it('blocks repurchase while cancellation is scheduled and allows it after terminal cancellation', async () => {
    const { user, supplier, subscription, plan } = await createActiveMonthlySubscription();
    subscription.cancelAtPeriodEnd = true;
    subscription.nextPaymentDate = null;
    await subscription.save();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: plan._id.toString() })
      .expect(409);

    subscription.status = 'canceled';
    subscription.cancelAt = new Date(Date.now() - 60 * 1000);
    subscription.subscriptionEndDate = subscription.cancelAt;
    await subscription.save();
    supplier.subscriptionStatus = 'cancelled';
    supplier.paymentStatus = 'cancelled';
    supplier.listingStatus = 'Hidden';
    await supplier.save();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: plan._id.toString() })
      .expect(200);
  });

  it('reuses a stored Stripe customer and blocks duplicate active monthly checkout', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    supplier.stripeCustomerId = 'cus_existing_123';
    await supplier.save();
    const monthlyPlan = await createPricingPlan({
      name: 'Customer Reuse Plan',
      slug: `customer-reuse-${Date.now()}`,
      price: 99,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 3, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: monthlyPlan._id.toString(),
      })
      .expect(200);

    const sessionCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    expect(sessionCall.customer).toBe('cus_existing_123');
    expect(sessionCall.customer_email).toBeUndefined();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: monthlyPlan._id.toString(),
      })
      .expect(409);
  });

  it('initializes monthly subscription on checkout completion and creates recurring payment records from invoice.paid only once', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Invoice Source Plan',
      slug: `invoice-source-${Date.now()}`,
      price: 100,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 3, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: monthlyPlan._id.toString(),
        addons: [FEATURED_HERO_PLACEMENT.code],
      })
      .expect(200);

    const checkoutEvent = {
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: 'cs_test_default',
          mode: 'subscription',
          client_reference_id: supplier._id.toString(),
          customer: 'cus_test_123',
          subscription: 'sub_test_123',
          created: 1704067200,
          metadata: {
            supplierId: supplier._id.toString(),
            planId: monthlyPlan._id.toString(),
            planName: monthlyPlan.name,
            billingCycle: monthlyPlan.billingCycle,
            listingPeriod: '3 Months',
            durationMonths: '3',
            listingDiscountPercent: '0',
            addons: JSON.stringify([FEATURED_HERO_PLACEMENT.code]),
            featuredHeroPlacement: 'true',
            checkoutType: 'monthly_subscription',
            environment: 'test',
            source: 'wulfara',
          },
        },
      },
    };

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(checkoutEvent))
      .expect(200);

    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(0);

    const updatedSubscriptionCall = stripeFactory.__mock.updateSubscription.mock.calls.at(-1);
    expect(updatedSubscriptionCall[0]).toBe('sub_test_123');
    expect(new Date(updatedSubscriptionCall[1].cancel_at * 1000).toISOString()).toBe('2024-04-01T00:00:00.000Z');

    const firstInvoice = {
      id: 'in_first',
      amount_paid: 11500,
      currency: 'usd',
      subscription: 'sub_test_123',
      payment_intent: 'pi_first',
      hosted_invoice_url: 'https://stripe.test/invoices/in_first',
      lines: {
        data: [
          {
            period: {
              start: 1704067200,
              end: 1706745600,
            },
          },
        ],
      },
    };

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'invoice.paid', livemode: false, data: { object: firstInvoice } }))
      .expect(200);

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'invoice.paid', livemode: false, data: { object: firstInvoice } }))
      .expect(200)
      .expect(({ body }) => expect(body.duplicate).toBe(true));

    stripeFactory.__mock.retrieveInvoice.mockResolvedValue(firstInvoice);

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'invoice_payment.paid',
        livemode: false,
        data: { object: { id: 'ivp_first', invoice: 'in_first' } },
      }))
      .expect(200)
      .expect(({ body }) => expect(body.duplicate).toBe(true));

    const secondInvoice = {
      ...firstInvoice,
      id: 'in_second',
      amount_paid: 10000,
      payment_intent: 'pi_second',
      hosted_invoice_url: 'https://stripe.test/invoices/in_second',
      lines: {
        data: [
          {
            period: {
              start: 1706745600,
              end: 1709251200,
            },
          },
        ],
      },
    };

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'invoice.paid', livemode: false, data: { object: secondInvoice } }))
      .expect(200);

    const payments = await Payment.find({ supplier: supplier._id }).sort({ createdAt: 1 });
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(payments).toHaveLength(2);
    expect(payments[0].paymentType).toBe('initial_subscription');
    expect(payments[0].addonAmount).toBe(15);
    expect(payments[1].paymentType).toBe('recurring_invoice');
    expect(payments[1].addonAmount).toBe(0);
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
    expect(refreshedSupplier.featuredHeroPlacement.enabled).toBe(true);
  });

  it('marks invoice failures locally without hiding an already active paid listing', async () => {
    const { supplier } = await createCheckoutReadySupplier();
    const plan = await createPricingPlan({
      name: 'Failure Sync Plan',
      slug: `failure-sync-${Date.now()}`,
      billingCycle: 'Monthly',
    });
    await Subscription.create({
      supplier: supplier._id,
      plan: plan._id,
      planName: plan.name,
      billingCycle: 'Monthly',
      billingCycleType: 'monthly',
      status: 'active',
      stripeSubscriptionId: 'sub_failure',
      durationMonths: 3,
      listingPeriod: '3 Months',
    });
    supplier.subscriptionStatus = 'active';
    supplier.paymentStatus = 'paid';
    supplier.isApproved = true;
    supplier.listingStatus = 'Approved';
    await supplier.save();

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'invoice.payment_failed',
        livemode: false,
        data: {
          object: {
            id: 'in_failed',
            subscription: 'sub_failure',
            payment_intent: 'pi_failed',
          },
        },
      }))
      .expect(200);

    const subscriptionRecord = await Subscription.findOne({ stripeSubscriptionId: 'sub_failure' });
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(subscriptionRecord.status).toBe('payment_failed');
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
  });

  it('reconciles a paid monthly checkout from the success-page verification before webhook delivery', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Success Page Recovery Plan',
      slug: `success-page-recovery-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 38, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    const metadata = stripeFactory.__mock.createSession.mock.calls.at(-1)[0].metadata;
    stripeFactory.__mock.retrieveSession.mockResolvedValue({
      id: 'cs_test_default',
      livemode: false,
      status: 'complete',
      payment_status: 'paid',
      mode: 'subscription',
      client_reference_id: supplier._id.toString(),
      customer: 'cus_success_page_first',
      metadata,
      subscription: {
        id: 'sub_success_page_first',
        status: 'active',
        customer: 'cus_success_page_first',
        start_date: 1704067200,
        current_period_start: 1704067200,
        current_period_end: 1706745600,
        cancel_at: null,
        cancel_at_period_end: false,
        latest_invoice: {
          id: 'in_success_page_first',
          status: 'paid',
          paid: true,
          amount_paid: 49900,
          currency: 'usd',
          subscription: 'sub_success_page_first',
          payment_intent: 'pi_success_page_first',
          hosted_invoice_url: 'https://stripe.test/invoices/in_success_page_first',
          lines: {
            data: [
              {
                period: {
                  start: 1704067200,
                  end: 1706745600,
                },
              },
            ],
          },
        },
        metadata,
      },
    });

    await request(app)
      .get('/api/v1/subscriptions/checkout-status?session_id=cs_test_default')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('paid');
        expect(body.paymentStatus).toBe('paid');
        expect(body.subscriptionStatus).toBe('active');
        expect(body.redirectTo).toBe('/dashboard');
      });

    const refreshedSupplier = await Supplier.findById(supplier._id);
    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id });
    const payments = await Payment.find({ supplier: supplier._id });

    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
    expect(subscriptionRecord.stripeSubscriptionId).toBe('sub_success_page_first');
    expect(subscriptionRecord.status).toBe('active');
    expect(payments).toHaveLength(1);
    expect(payments[0].stripeInvoiceId).toBe('in_success_page_first');
    expect(payments[0].paymentType).toBe('initial_subscription');
  });

  it('reconciles the latest paid monthly checkout when the session id is no longer in the URL', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'No Session Recovery Plan',
      slug: `no-session-recovery-${Date.now()}`,
      price: 753,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 48, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    const metadata = stripeFactory.__mock.createSession.mock.calls.at(-1)[0].metadata;
    stripeFactory.__mock.retrieveSession.mockResolvedValue({
      id: 'cs_test_default',
      livemode: false,
      status: 'complete',
      payment_status: 'paid',
      mode: 'subscription',
      client_reference_id: supplier._id.toString(),
      customer: 'cus_no_session_recovery',
      metadata,
      subscription: {
        id: 'sub_no_session_recovery',
        status: 'active',
        customer: 'cus_no_session_recovery',
        start_date: 1704067200,
        current_period_start: 1704067200,
        current_period_end: 1706745600,
        cancel_at: null,
        cancel_at_period_end: false,
        latest_invoice: {
          id: 'in_no_session_recovery',
          status: 'paid',
          paid: true,
          amount_paid: 75300,
          currency: 'usd',
          subscription: 'sub_no_session_recovery',
          payment_intent: 'pi_no_session_recovery',
          hosted_invoice_url: 'https://stripe.test/invoices/in_no_session_recovery',
          lines: {
            data: [
              {
                period: {
                  start: 1704067200,
                  end: 1706745600,
                },
              },
            ],
          },
        },
        metadata,
      },
    });

    await request(app)
      .get('/api/v1/subscriptions/checkout-status')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('paid');
        expect(body.paymentStatus).toBe('paid');
        expect(body.subscriptionStatus).toBe('active');
        expect(body.redirectTo).toBe('/dashboard');
      });

    const refreshedSupplier = await Supplier.findById(supplier._id);
    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id });

    expect(stripeFactory.__mock.retrieveSession).toHaveBeenCalledWith(
      'cs_test_default',
      expect.objectContaining({
        expand: ['subscription', 'subscription.latest_invoice', 'payment_intent'],
      })
    );
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
    expect(subscriptionRecord.stripeSubscriptionId).toBe('sub_no_session_recovery');
    expect(subscriptionRecord.status).toBe('active');
    expect(await Payment.countDocuments({ stripeInvoiceId: 'in_no_session_recovery' })).toBe(1);
  });

  it('returns confirmed local state without calling Stripe when webhook already activated the listing', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Webhook First Status Plan',
      slug: `webhook-first-status-${Date.now()}`,
      price: 199,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 3, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    const metadata = stripeFactory.__mock.createSession.mock.calls.at(-1)[0].metadata;

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'checkout.session.completed',
        livemode: false,
        data: {
          object: {
            id: 'cs_test_default',
            mode: 'subscription',
            client_reference_id: supplier._id.toString(),
            customer: 'cus_webhook_first',
            subscription: 'sub_webhook_first',
            created: 1704067200,
            metadata,
          },
        },
      }))
      .expect(200);

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'invoice.paid',
        livemode: false,
        data: {
          object: {
            id: 'in_webhook_first',
            amount_paid: 19900,
            currency: 'usd',
            subscription: 'sub_webhook_first',
            payment_intent: 'pi_webhook_first',
            lines: {
              data: [
                {
                  period: {
                    start: 1704067200,
                    end: 1706745600,
                  },
                },
              ],
            },
          },
        },
      }))
      .expect(200);

    stripeFactory.__mock.retrieveSession.mockClear();

    await request(app)
      .get('/api/v1/subscriptions/checkout-status?session_id=cs_test_default')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('paid');
        expect(body.paymentStatus).toBe('paid');
      });

    expect(stripeFactory.__mock.retrieveSession).not.toHaveBeenCalled();
    expect(await Payment.countDocuments({ stripeInvoiceId: 'in_webhook_first' })).toBe(1);
  });

  it('keeps duplicate success-page polling idempotent for the same Stripe invoice', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Duplicate Poll Plan',
      slug: `duplicate-poll-${Date.now()}`,
      price: 299,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 6, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    const metadata = stripeFactory.__mock.createSession.mock.calls.at(-1)[0].metadata;
    stripeFactory.__mock.retrieveSession.mockResolvedValue({
      id: 'cs_test_default',
      livemode: false,
      status: 'complete',
      payment_status: 'paid',
      mode: 'subscription',
      client_reference_id: supplier._id.toString(),
      customer: 'cus_duplicate_poll',
      metadata,
      subscription: {
        id: 'sub_duplicate_poll',
        status: 'active',
        customer: 'cus_duplicate_poll',
        start_date: 1704067200,
        current_period_start: 1704067200,
        current_period_end: 1706745600,
        latest_invoice: {
          id: 'in_duplicate_poll',
          status: 'paid',
          paid: true,
          amount_paid: 29900,
          currency: 'usd',
          subscription: 'sub_duplicate_poll',
          payment_intent: 'pi_duplicate_poll',
          lines: {
            data: [
              {
                period: {
                  start: 1704067200,
                  end: 1706745600,
                },
              },
            ],
          },
        },
        metadata,
      },
    });

    await request(app)
      .get('/api/v1/subscriptions/checkout-status?session_id=cs_test_default')
      .set(authHeader(tokenForUser(user)))
      .expect(200);

    await request(app)
      .get('/api/v1/subscriptions/checkout-status?session_id=cs_test_default')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => expect(body.status).toBe('paid'));

    expect(await Payment.countDocuments({ stripeInvoiceId: 'in_duplicate_poll' })).toBe(1);
    expect(await Subscription.countDocuments({ supplier: supplier._id })).toBe(1);
  });

  it('rejects another supplier attempting to verify a valid checkout session they do not own', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const attackerUser = await createUser({
      role: 'supplier',
      email: uniqueEmail('attacker-supplier'),
    });
    const attackerSupplier = await createSupplierForUser(attackerUser, {
      categories: supplier.categories,
    });
    const monthlyPlan = await createPricingPlan({
      name: 'Ownership Guard Plan',
      slug: `ownership-guard-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 3, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    await request(app)
      .get('/api/v1/subscriptions/checkout-status?session_id=cs_test_default')
      .set(authHeader(tokenForUser(attackerUser)))
      .expect(403)
      .expect(({ body }) => expect(body.status).toBe('unauthorized'));

    const refreshedAttacker = await Supplier.findById(attackerSupplier._id);
    expect(refreshedAttacker.paymentStatus).not.toBe('paid');
    expect(await Payment.countDocuments({ supplier: attackerSupplier._id })).toBe(0);
  });

  it('does not activate a listing when the retrieved monthly session has no paid initial invoice', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Unpaid Session Plan',
      slug: `unpaid-session-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 3, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    const metadata = stripeFactory.__mock.createSession.mock.calls.at(-1)[0].metadata;
    stripeFactory.__mock.retrieveSession.mockResolvedValue({
      id: 'cs_test_default',
      livemode: false,
      status: 'complete',
      payment_status: 'unpaid',
      mode: 'subscription',
      client_reference_id: supplier._id.toString(),
      customer: 'cus_unpaid_session',
      metadata,
      subscription: {
        id: 'sub_unpaid_session',
        status: 'incomplete',
        customer: 'cus_unpaid_session',
        latest_invoice: {
          id: 'in_unpaid_session',
          status: 'open',
          paid: false,
          amount_paid: 0,
          currency: 'usd',
          subscription: 'sub_unpaid_session',
        },
        metadata,
      },
    });

    await request(app)
      .get('/api/v1/subscriptions/checkout-status?session_id=cs_test_default')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('processing');
        expect(body.paymentStatus).toBe('pending');
      });

    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSupplier.paymentStatus).toBe('pending');
    expect(refreshedSupplier.subscriptionStatus).toBe('pending');
    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(0);
  });

  it('reuses cached monthly Stripe Prices and creates a new Price when the effective amount changes', async () => {
    const stripe = stripeFactory();
    const monthlyPlan = await createPricingPlan({
      name: 'Price Cache Plan',
      slug: `price-cache-${Date.now()}`,
      price: 200,
      billingCycle: 'Monthly',
    });

    const firstPriceId = await ensureMonthlyPriceForPlan(stripe, monthlyPlan, {
      amount: 200,
      durationMonths: 12,
      listingDiscountPercent: 0,
    });
    const reloadedPlan = await monthlyPlan.constructor.findById(monthlyPlan._id);
    const reusedPriceId = await ensureMonthlyPriceForPlan(stripe, reloadedPlan, {
      amount: 200,
      durationMonths: 12,
      listingDiscountPercent: 0,
    });
    stripeFactory.__mock.createPrice.mockResolvedValueOnce({ id: 'price_test_new_amount' });
    const newPriceId = await ensureMonthlyPriceForPlan(stripe, reloadedPlan, {
      amount: 220,
      durationMonths: 12,
      listingDiscountPercent: 0,
    });

    expect(firstPriceId).toBe('price_test_default');
    expect(reusedPriceId).toBe('price_test_default');
    expect(newPriceId).toBe('price_test_new_amount');
    expect(stripeFactory.__mock.createPrice).toHaveBeenCalledTimes(2);
  });

  it('replaces stale cached Stripe Price and Product ids for the current Stripe key', async () => {
    const stripe = stripeFactory();
    const monthlyPlan = await createPricingPlan({
      name: 'Stale Price Cache Plan',
      slug: `stale-price-cache-${Date.now()}`,
      price: 753,
      billingCycle: 'Monthly',
      stripeProductId: 'prod_missing_current_key',
      stripePrices: [{
        billingCycleType: 'monthly',
        currency: 'usd',
        unitAmount: 75300,
        interval: 'month',
        intervalCount: 1,
        durationMonths: 48,
        listingDiscountPercent: 0,
        stripePriceId: 'price_missing_current_key',
        isActive: true,
      }],
    });

    stripeFactory.__mock.retrievePrice.mockRejectedValueOnce(
      Object.assign(new Error("No such price: 'price_missing_current_key'"), {
        code: 'resource_missing',
        type: 'StripeInvalidRequestError',
      })
    );
    stripeFactory.__mock.retrieveProduct.mockRejectedValueOnce(
      Object.assign(new Error("No such product: 'prod_missing_current_key'"), {
        code: 'resource_missing',
        type: 'StripeInvalidRequestError',
      })
    );
    stripeFactory.__mock.createProduct.mockResolvedValueOnce({ id: 'prod_test_replacement' });
    stripeFactory.__mock.createPrice.mockResolvedValueOnce({ id: 'price_test_replacement' });

    const replacementPriceId = await ensureMonthlyPriceForPlan(stripe, monthlyPlan, {
      amount: 753,
      durationMonths: 48,
      listingDiscountPercent: 0,
    });

    const reloadedPlan = await monthlyPlan.constructor.findById(monthlyPlan._id);
    const stalePrice = reloadedPlan.stripePrices.find(
      (price) => price.stripePriceId === 'price_missing_current_key'
    );
    const replacementPrice = reloadedPlan.stripePrices.find(
      (price) => price.stripePriceId === 'price_test_replacement'
    );

    expect(replacementPriceId).toBe('price_test_replacement');
    expect(reloadedPlan.stripeProductId).toBe('prod_test_replacement');
    expect(stalePrice.isActive).toBe(false);
    expect(replacementPrice.isActive).toBe(true);
  });

  it('expires ended local subscriptions and removes public listing entitlement without touching legacy suppliers', async () => {
    const category = await createCategory({ name: `Expiry Category ${Date.now()}` });
    const activeUser = await createUser({ role: 'supplier', email: uniqueEmail('expiry-active') });
    const legacyUser = await createUser({ role: 'supplier', email: uniqueEmail('expiry-legacy') });
    const expiredSupplier = await createSupplierForUser(activeUser, {
      categories: [category._id],
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      isApproved: true,
      listingStatus: 'Approved',
    });
    const legacySupplier = await createSupplierForUser(legacyUser, {
      categories: [category._id],
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      isApproved: true,
      listingStatus: 'Approved',
    });
    await Subscription.create({
      supplier: expiredSupplier._id,
      billingCycle: 'Annual',
      billingCycleType: 'annual',
      status: 'active',
      durationMonths: 12,
      subscriptionEndDate: new Date(Date.now() - 60 * 1000),
    });

    await request(app).get('/api/v1/suppliers?listed=true').expect(200);

    const refreshedExpired = await Supplier.findById(expiredSupplier._id);
    const refreshedLegacy = await Supplier.findById(legacySupplier._id);

    expect(refreshedExpired.subscriptionStatus).toBe('inactive');
    expect(refreshedExpired.paymentStatus).toBe('unpaid');
    expect(refreshedExpired.listingStatus).toBe('Hidden');
    expect(refreshedLegacy.subscriptionStatus).toBe('active');
    expect(refreshedLegacy.paymentStatus).toBe('paid');
  });

  it('recovers invoice.paid when it arrives before checkout.session.completed', async () => {
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Webhook Race Plan',
      slug: `webhook-race-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 3, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: monthlyPlan._id.toString() })
      .expect(200);

    const sessionCall = stripeFactory.__mock.createSession.mock.calls.at(-1)[0];
    const invoice = {
      id: 'in_race_first',
      amount_paid: 49900,
      currency: 'usd',
      customer: 'cus_race',
      subscription: 'sub_race',
      payment_intent: 'pi_race_first',
      subscription_details: {
        metadata: sessionCall.metadata,
      },
      lines: {
        data: [
          {
            period: {
              start: 1704067200,
              end: 1706745600,
            },
          },
        ],
      },
    };

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'invoice.paid', livemode: false, data: { object: invoice } }))
      .expect(200);

    const subscriptionRecord = await Subscription.findOne({ supplier: supplier._id });
    const payments = await Payment.find({ supplier: supplier._id });
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(subscriptionRecord.stripeSubscriptionId).toBe('sub_race');
    expect(subscriptionRecord.status).toBe('active');
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(499);
    expect(refreshedSupplier.subscriptionStatus).toBe('active');
    expect(refreshedSupplier.paymentStatus).toBe('paid');
    expect(refreshedSupplier.listingStatus).toBe('Approved');
  });

  it('prevents concurrent monthly checkout from creating duplicate Stripe sessions', async () => {
    await Subscription.syncIndexes();
    const { user, supplier } = await createCheckoutReadySupplier();
    const monthlyPlan = await createPricingPlan({
      name: 'Concurrent Monthly Plan',
      slug: `concurrent-monthly-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
      listingPeriods: [{ durationMonths: 38, isActive: true }],
    });

    const token = tokenForUser(user);
    const requests = await Promise.all([
      request(app)
        .post('/api/v1/subscriptions/checkout-session')
        .set(authHeader(token))
        .send({ planId: monthlyPlan._id.toString() }),
      request(app)
        .post('/api/v1/subscriptions/checkout-session')
        .set(authHeader(token))
        .send({ planId: monthlyPlan._id.toString() }),
    ]);

    const statusCodes = requests.map((response) => response.status).sort();
    expect(statusCodes).toEqual([200, 409]);
    expect(await Subscription.countDocuments({ supplier: supplier._id })).toBe(1);
    expect(stripeFactory.__mock.createSession).toHaveBeenCalledTimes(1);
  });

  it('blocks duplicate annual checkout while allowing future repurchase after completion', async () => {
    await Subscription.syncIndexes();
    const { user, supplier } = await createCheckoutReadySupplier();
    const annualPlan = await createPricingPlan({
      name: 'Annual Duplicate Guard',
      slug: `annual-duplicate-${Date.now()}`,
      price: 8988,
      billingCycle: 'Annual (Paid Upfront)',
      listingPeriods: [{ durationMonths: 12, isActive: true }],
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: annualPlan._id.toString() })
      .expect(200);

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: annualPlan._id.toString() })
      .expect(409);

    await Subscription.updateOne(
      { supplier: supplier._id },
      { status: 'completed', subscriptionEndDate: new Date(Date.now() - 1000), nextPaymentDate: null }
    );
    stripeFactory.__mock.createSession.mockResolvedValueOnce({
      id: 'cs_test_annual_repurchase',
      url: 'https://stripe.test/checkout/annual-repurchase',
    });

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({ planId: annualPlan._id.toString() })
      .expect(200);

    expect(await Subscription.countDocuments({ supplier: supplier._id })).toBe(2);
  });

  it('expires subscriptions from the fallback service without removing payment history or legacy suppliers', async () => {
    const category = await createCategory({ name: `Fallback Expiry ${Date.now()}` });
    const plan = await createPricingPlan({ name: 'Fallback Plan', slug: `fallback-plan-${Date.now()}` });
    const expiredUser = await createUser({ role: 'supplier', email: uniqueEmail('fallback-expired') });
    const legacyUser = await createUser({ role: 'supplier', email: uniqueEmail('fallback-legacy') });
    const expiredSupplier = await createSupplierForUser(expiredUser, {
      categories: [category._id],
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      isApproved: true,
      listingStatus: 'Approved',
      featuredHeroPlacement: { enabled: true, activatedAt: new Date('2024-01-01T00:00:00.000Z') },
    });
    const legacySupplier = await createSupplierForUser(legacyUser, {
      categories: [category._id],
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      isApproved: true,
      listingStatus: 'Approved',
    });
    await Subscription.create({
      supplier: expiredSupplier._id,
      plan: plan._id,
      billingCycle: 'Monthly',
      billingCycleType: 'monthly',
      status: 'active',
      durationMonths: 1,
      subscriptionEndDate: new Date(Date.now() - 60 * 1000),
    });
    await Payment.create({
      supplier: expiredSupplier._id,
      plan: plan._id,
      amount: 499,
      status: 'paid',
      paymentType: 'recurring_invoice',
      stripeInvoiceId: 'in_expiry_history',
    });

    const expiredCount = await expireElapsedSubscriptions();
    const refreshedExpired = await Supplier.findById(expiredSupplier._id);
    const refreshedLegacy = await Supplier.findById(legacySupplier._id);

    expect(expiredCount).toBe(1);
    expect(refreshedExpired.subscriptionStatus).toBe('inactive');
    expect(refreshedExpired.paymentStatus).toBe('unpaid');
    expect(refreshedExpired.isApproved).toBe(false);
    expect(refreshedExpired.listingStatus).toBe('Hidden');
    expect(refreshedExpired.featuredHeroPlacement.enabled).toBe(false);
    expect(await Payment.countDocuments({ supplier: expiredSupplier._id })).toBe(1);
    expect(refreshedLegacy.subscriptionStatus).toBe('active');
    expect(refreshedLegacy.paymentStatus).toBe('paid');
  });

  it('expires elapsed scheduled cancellations during onboarding gating and asks supplier to subscribe again', async () => {
    const periodEnd = new Date(Date.now() - 60 * 1000);
    const { user, supplier, subscription } = await createActiveMonthlySubscription({
      currentPeriodEnd: periodEnd,
      subscriptionEndDate: periodEnd,
    });
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = periodEnd;
    subscription.subscriptionEndDate = periodEnd;
    subscription.nextPaymentDate = null;
    await subscription.save();

    await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(tokenForUser(user)))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.supplier.subscriptionStatus).toBe('cancelled');
        expect(body.data.supplier.paymentStatus).toBe('cancelled');
        expect(body.data.supplier.isApproved).toBe(false);
        expect(body.data.supplier.listingStatus).toBe('Hidden');
        expect(body.data.onboarding.isComplete).toBe(false);
        expect(body.data.onboarding.nextRoute).toBe('/subscription');
      });

    const refreshedSubscription = await Subscription.findById(subscription._id);
    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSubscription.status).toBe('canceled');
    expect(refreshedSupplier.onboardingStep).toBe('payment');
  });

  it('does not expose a final-period boundary as another next payment date', async () => {
    const { supplier } = await createCheckoutReadySupplier();
    const plan = await createPricingPlan({
      name: 'Final Period Plan',
      slug: `final-period-${Date.now()}`,
      price: 499,
      billingCycle: 'Monthly',
    });
    const periodStart = new Date('2024-01-01T00:00:00.000Z');
    const periodEnd = new Date('2024-02-01T00:00:00.000Z');
    await Subscription.create({
      supplier: supplier._id,
      plan: plan._id,
      planName: plan.name,
      billingCycle: 'Monthly',
      billingCycleType: 'monthly',
      status: 'active',
      stripeSubscriptionId: 'sub_final_period',
      durationMonths: 1,
      listingPeriod: '1 Month',
      subscriptionStartDate: periodStart,
      subscriptionEndDate: periodEnd,
      cancelAt: periodEnd,
      effectiveRecurringAmount: 499,
    });

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'invoice.paid',
        livemode: false,
        data: {
          object: {
            id: 'in_final_period',
            amount_paid: 49900,
            currency: 'usd',
            subscription: 'sub_final_period',
            lines: {
              data: [
                {
                  period: {
                    start: Math.floor(periodStart.getTime() / 1000),
                    end: Math.floor(periodEnd.getTime() / 1000),
                  },
                },
              ],
            },
          },
        },
      }))
      .expect(200);

    const subscriptionRecord = await Subscription.findOne({ stripeSubscriptionId: 'sub_final_period' });
    expect(subscriptionRecord.nextPaymentDate).toBeNull();
  });

  it('uses Stripe subscription termination to remove paid listing entitlement', async () => {
    const { supplier } = await createCheckoutReadySupplier();
    const plan = await createPricingPlan({
      name: 'Terminal Subscription Plan',
      slug: `terminal-subscription-${Date.now()}`,
      billingCycle: 'Monthly',
    });
    const cancelAt = Math.floor((Date.now() - 60 * 1000) / 1000);
    await Subscription.create({
      supplier: supplier._id,
      plan: plan._id,
      planName: plan.name,
      billingCycle: 'Monthly',
      billingCycleType: 'monthly',
      status: 'active',
      stripeSubscriptionId: 'sub_terminal',
      durationMonths: 1,
      listingPeriod: '1 Month',
      subscriptionEndDate: new Date(cancelAt * 1000),
      cancelAt: new Date(cancelAt * 1000),
    });
    supplier.subscriptionStatus = 'active';
    supplier.paymentStatus = 'paid';
    supplier.isApproved = true;
    supplier.listingStatus = 'Approved';
    await supplier.save();
    await Payment.create({
      supplier: supplier._id,
      plan: plan._id,
      amount: 499,
      status: 'paid',
      paymentType: 'recurring_invoice',
      stripeInvoiceId: 'in_terminal_history',
      stripeSubscriptionId: 'sub_terminal',
    });

    await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({
        type: 'customer.subscription.deleted',
        livemode: false,
        data: {
          object: {
            id: 'sub_terminal',
            status: 'canceled',
            customer: 'cus_terminal',
            cancel_at: cancelAt,
            current_period_end: cancelAt,
            metadata: {
              supplierId: supplier._id.toString(),
              planId: plan._id.toString(),
            },
          },
        },
      }))
      .expect(200);

    const subscriptionRecord = await Subscription.findOne({ stripeSubscriptionId: 'sub_terminal' });
    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(subscriptionRecord.status).toBe('completed');
    expect(subscriptionRecord.nextPaymentDate).toBeNull();
    expect(refreshedSupplier.subscriptionStatus).toBe('inactive');
    expect(refreshedSupplier.paymentStatus).toBe('unpaid');
    expect(refreshedSupplier.isApproved).toBe(false);
    expect(refreshedSupplier.listingStatus).toBe('Hidden');
    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(1);
  });

  it('blocks premium supplier actions after a canceled subscription reaches period end', async () => {
    const periodEnd = new Date(Date.now() - 60 * 1000);
    const { user, supplier, subscription } = await createActiveMonthlySubscription({
      currentPeriodEnd: periodEnd,
      subscriptionEndDate: periodEnd,
    });
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = periodEnd;
    subscription.nextPaymentDate = null;
    await subscription.save();

    const rfq = await Rfq.create({
      supplier: supplier._id,
      buyerName: 'Buyer Person',
      buyerEmail: uniqueEmail('buyer-rfq'),
      subject: 'Need parts',
      details: 'Please quote this order.',
      quantity: 12,
    });

    const token = tokenForUser(user);

    await request(app)
      .get('/api/v1/suppliers/dashboard')
      .set(authHeader(token))
      .expect(200);

    await request(app)
      .get('/api/v1/rfqs/supplier')
      .set(authHeader(token))
      .expect(403);

    await request(app)
      .put(`/api/v1/rfqs/${rfq._id}/status`)
      .set(authHeader(token))
      .send({ status: 'reviewed' })
      .expect(403);

    await request(app)
      .post(`/api/v1/rfqs/${rfq._id}/messages`)
      .set(authHeader(token))
      .send({ text: 'Supplier reply' })
      .expect(403);

    await request(app)
      .post('/api/v1/rfqs/upload-url')
      .set(authHeader(token))
      .send({ contentType: 'application/pdf' })
      .expect(403);

    await request(app)
      .post('/api/v1/suppliers/upload-url')
      .set(authHeader(token))
      .send({ folder: 'galleries', contentType: 'image/png' })
      .expect(403);

    await request(app)
      .put(`/api/v1/suppliers/${supplier._id}`)
      .set(authHeader(token))
      .send({ products: [{ title: 'Premium Product' }] })
      .expect(403);

    await request(app)
      .put(`/api/v1/suppliers/${supplier._id}`)
      .set(authHeader(token))
      .send({ description: 'Allowed basic account recovery edit.' })
      .expect(200);

    const refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSupplier.subscriptionStatus).toBe('cancelled');
    expect(refreshedSupplier.paymentStatus).toBe('cancelled');
    expect(refreshedSupplier.isApproved).toBe(false);
    expect(refreshedSupplier.listingStatus).toBe('Hidden');
  });

  it('does not allow buyers to send RFQs to suppliers without active paid entitlement', async () => {
    const periodEnd = new Date(Date.now() - 60 * 1000);
    const { supplier, subscription } = await createActiveMonthlySubscription({
      currentPeriodEnd: periodEnd,
      subscriptionEndDate: periodEnd,
    });
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = periodEnd;
    subscription.nextPaymentDate = null;
    await subscription.save();

    await request(app)
      .post('/api/v1/rfqs')
      .send({
        supplierId: supplier._id,
        buyerName: 'Buyer Person',
        buyerEmail: uniqueEmail('blocked-buyer'),
        subject: 'Need quote',
        details: 'Quote request should not reach expired supplier.',
        quantity: 5,
      })
      .expect(403);
  });
});
