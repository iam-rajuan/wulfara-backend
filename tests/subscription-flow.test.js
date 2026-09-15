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
    expect(refreshedExpired.listingStatus).toBe('Hidden');
    expect(await Payment.countDocuments({ supplier: expiredSupplier._id })).toBe(1);
    expect(refreshedLegacy.subscriptionStatus).toBe('active');
    expect(refreshedLegacy.paymentStatus).toBe('paid');
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
    expect(refreshedSupplier.listingStatus).toBe('Hidden');
    expect(await Payment.countDocuments({ supplier: supplier._id })).toBe(1);
  });
});
