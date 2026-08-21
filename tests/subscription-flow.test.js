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

  it('activates suppliers exactly once on successful webhook delivery and keeps wrong metadata from activating the wrong supplier', async () => {
    const { plan, supplier: targetSupplier } = await createCheckoutReadySupplier();
    const { supplier: otherSupplier } = await createCheckoutReadySupplier();

    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_success',
          client_reference_id: targetSupplier._id.toString(),
          amount_total: 99900,
          customer: 'cus_test_123',
          metadata: {
            supplierId: otherSupplier._id.toString(),
            planId: plan._id.toString(),
            planName: 'Premium',
            billingCycle: 'Annual',
            listingPeriod: '12-months',
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
    let payments = await Payment.find({ stripeSessionId: 'cs_test_success' });

    expect(refreshedTarget.subscriptionStatus).toBe('active');
    expect(refreshedTarget.paymentStatus).toBe('paid');
    expect(refreshedTarget.isApproved).toBe(true);
    expect(refreshedTarget.listingStatus).toBe('Approved');
    expect(refreshedTarget.onboardingStep).toBe('listed');
    expect(refreshedOther.subscriptionStatus).not.toBe('active');
    expect(payments).toHaveLength(1);

    const duplicateResponse = await request(app)
      .post('/api/v1/subscriptions/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event))
      .expect(200);

    expect(duplicateResponse.body.duplicate).toBe(true);

    refreshedTarget = await Supplier.findById(targetSupplier._id);
    payments = await Payment.find({ stripeSessionId: 'cs_test_success' });

    expect(refreshedTarget.subscriptionStatus).toBe('active');
    expect(payments).toHaveLength(1);
  });

  it('does not list suppliers after failed or cancelled checkout flows', async () => {
    const { plan, user, supplier } = await createCheckoutReadySupplier();

    await request(app)
      .post('/api/v1/subscriptions/checkout-session')
      .set(authHeader(tokenForUser(user)))
      .send({
        planId: plan._id.toString(),
        billingCycle: 'Annual',
        listingPeriod: '12-months',
      })
      .expect(200);

    let refreshedSupplier = await Supplier.findById(supplier._id);
    expect(refreshedSupplier.subscriptionStatus).toBe('pending');
    expect(refreshedSupplier.paymentStatus).toBe('pending');
    expect(refreshedSupplier.onboardingStep).toBe('payment');
    expect(refreshedSupplier.isApproved).toBe(false);

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
    expect(await Payment.countDocuments()).toBe(0);
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
});
