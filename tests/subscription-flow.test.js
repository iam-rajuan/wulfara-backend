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
  models: { Payment, Supplier },
} = require('./helpers/factories');

const stripeFactory = require('stripe');
const {
  FEATURED_HERO_PLACEMENT,
} = require('../src/modules/subscriptions/subscriptionAddons');

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

    expect(latestCall.line_items[0].price_data.unit_amount).toBe(14900);
    expect(latestCall.metadata.billingCycle).toBe('Monthly');
    expect(latestCall.metadata.listingPeriod).toBe('10 Months');
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
    const payment = await Payment.findOne({ supplier: supplier._id }).sort({ createdAt: -1 });
    const refreshedSupplier = await Supplier.findById(supplier._id);

    expect(latestCall.metadata.billingCycle).toBe('Monthly');
    expect(latestCall.metadata.listingPeriod).toBe('10 Months');
    expect(response.body.orderSummary.listingPeriod).toBe('10 Months');
    expect(payment.listingPeriod).toBe('10 Months');
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
    const payment = await Payment.findOne({ supplier: supplier._id }).sort({ createdAt: -1 });

    expect(latestCall.line_items[0].price_data.unit_amount).toBe(9200);
    expect(latestCall.metadata.listingPeriod).toBe('24 Months');
    expect(latestCall.metadata.listingDiscountPercent).toBe('8');
    expect(response.body.orderSummary).toMatchObject({
      listingPeriod: '24 Months',
      listingDiscountPercent: 8,
      basePrice: 92,
      totalDueToday: 92,
    });
    expect(payment.listingPeriod).toBe('24 Months');
    expect(payment.baseAmount).toBe(92);
    expect(payment.amount).toBe(92);
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
});
