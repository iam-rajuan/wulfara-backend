const request = require('supertest');

const {
  app,
  authHeader,
  createCategory,
  createPricingPlan,
  createSupplierForUser,
  createUser,
  registerAndVerifySupplier,
  tokenForUser,
  uniqueEmail,
  models: { Supplier, User },
} = require('./helpers/factories');

describe('supplier lifecycle acceptance', () => {
  it('creates supplier accounts in the correct initial onboarding state', async () => {
    const { token, user, supplier } = await registerAndVerifySupplier();

    expect(user.role).toBe('supplier');
    expect(supplier.onboardingStep).toBe('industry');
    expect(supplier.onboardingCompletedAt).toBeNull();

    const response = await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(token))
      .expect(200);

    expect(response.body.data.onboarding).toMatchObject({
      step: 'industry',
      nextRoute: '/choose-industry',
      isComplete: false,
    });
  });

  it('persists onboarding progress and resumes correctly after relogin', async () => {
    const category = await createCategory({ name: 'Steel' });
    const activePlan = await createPricingPlan({ name: 'Pro', slug: 'pro-plan' });
    const inactivePlan = await createPricingPlan({
      name: 'Dormant',
      slug: 'inactive-plan',
      isActive: false,
    });
    const { payload, user } = await registerAndVerifySupplier({
      email: uniqueEmail('lifecycle'),
      companyName: 'Lifecycle Metals',
    });

    let loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    await request(app)
      .put('/api/v1/suppliers/onboarding/industry')
      .set(authHeader(loginResponse.body.token))
      .send({ categoryIds: [category._id.toString()] })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding.step).toBe('company-info');
      });

    let supplier = await Supplier.findOne({ user: user._id }).populate('categories');
    expect(supplier.categories).toHaveLength(1);
    expect(supplier.categories[0].name).toBe('Steel');

    loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(loginResponse.body.token))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding.step).toBe('company-info');
      });

    await request(app)
      .put('/api/v1/suppliers/onboarding/company-info')
      .set(authHeader(loginResponse.body.token))
      .send({
        companyName: 'Lifecycle Metals Ltd.',
        description: 'Manufacturer of carbon and alloy steel products.',
        contactEmail: 'SALES@lifecycle.test',
        contactPhone: '+15550009999',
        website: 'https://lifecycle.test',
        address: '123 Steel Road',
        supplierType: 'Manufacturer',
        coreProducts: ['Steel coils', 'Steel sheets'],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding.step).toBe('subscription');
      });

    supplier = await Supplier.findOne({ user: user._id });
    expect(supplier.companyName).toBe('Lifecycle Metals Ltd.');
    expect(supplier.contactEmail).toBe('sales@lifecycle.test');
    expect(supplier.location.formattedAddress).toBe('123 Steel Road (Test Geocoded)');
    expect(supplier.coreProducts).toEqual(['Steel coils', 'Steel sheets']);

    loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(loginResponse.body.token))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding.step).toBe('subscription');
      });

    await request(app)
      .put('/api/v1/suppliers/onboarding/subscription')
      .set(authHeader(loginResponse.body.token))
      .send({ planId: inactivePlan._id.toString() })
      .expect(404);

    await request(app)
      .put('/api/v1/suppliers/onboarding/subscription')
      .set(authHeader(loginResponse.body.token))
      .send({
        planId: activePlan._id.toString(),
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding.step).toBe('payment');
      });

    supplier = await Supplier.findOne({ user: user._id });
    expect(supplier.selectedPlan.toString()).toBe(activePlan._id.toString());
    expect(supplier.selectedBillingCycle).toBe(activePlan.billingCycle);
    expect(supplier.selectedListingPeriod).toBe('12 Months');
    expect(supplier.subscriptionStatus).toBe('pending');
    expect(supplier.paymentStatus).toBe('unpaid');
    expect(supplier.onboardingStep).toBe('payment');

    loginResponse = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(loginResponse.body.token))
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding).toMatchObject({
          step: 'payment',
          nextRoute: '/subscription',
          isComplete: false,
        });
      });
  });

  it('returns dashboard onboarding data that supports gating for every lifecycle stage', async () => {
    const category = await createCategory({ name: 'Gating Category' });
    const plan = await createPricingPlan({ name: 'Premium', slug: 'premium-gating' });

    const cases = [
      {
        step: 'industry',
        expectedRoute: '/choose-industry',
        supplier: {
          description: 'Profile pending details. Please update your company description in settings.',
          contactPhone: '',
          categories: [],
        },
      },
      {
        step: 'company-info',
        expectedRoute: '/company-info',
        supplier: {
          categories: [category._id],
          description: 'Profile pending details. Please update your company description in settings.',
          contactPhone: '',
        },
      },
      {
        step: 'subscription',
        expectedRoute: '/subscription',
        supplier: {
          categories: [category._id],
        },
      },
      {
        step: 'payment',
        expectedRoute: '/subscription',
        supplier: {
          categories: [category._id],
          selectedPlan: plan._id,
          selectedBillingCycle: 'Annual',
          subscriptionStatus: 'pending',
        },
      },
      {
        step: 'listed',
        expectedRoute: '/dashboard',
        supplier: {
          categories: [category._id],
          selectedPlan: plan._id,
          selectedBillingCycle: 'Annual',
          subscriptionPlan: 'premium',
          subscriptionStatus: 'active',
          paymentStatus: 'paid',
          isApproved: true,
          listingStatus: 'Approved',
        },
      },
    ];

    for (const scenario of cases) {
      const user = await createUser({
        name: `${scenario.step} Supplier`,
        email: uniqueEmail(scenario.step),
        role: 'supplier',
      });
      await createSupplierForUser(user, scenario.supplier);

      const response = await request(app)
        .get('/api/v1/suppliers/dashboard')
        .set(authHeader(tokenForUser(user)))
        .expect(200);

      expect(response.body.data.onboarding.step).toBe(scenario.step);
      expect(response.body.data.onboarding.nextRoute).toBe(scenario.expectedRoute);
    }
  });

  it('keeps admin-assisted onboarding on the same supplier lifecycle and validation path', async () => {
    const admin = await createUser({ role: 'admin', email: uniqueEmail('admin') });
    const category = await createCategory({ name: 'Admin Category' });
    const plan = await createPricingPlan({ name: 'Admin Plan', slug: 'admin-plan' });

    const createResponse = await request(app)
      .post('/api/v1/suppliers/admin-assisted')
      .set(authHeader(tokenForUser(admin)))
      .send({
        name: 'Assisted Supplier',
        email: uniqueEmail('assisted'),
        password: 'Password123!',
        companyName: 'Assisted Metals',
        phone: '+18885550101',
      })
      .expect(201);

    const supplierId = createResponse.body.data.supplier._id;
    const assistedUser = await User.findById(createResponse.body.data.supplier.user);
    let assistedSupplier = await Supplier.findById(supplierId);

    expect(assistedUser.role).toBe('supplier');
    expect(assistedSupplier.onboardingStep).toBe('industry');

    await request(app)
      .put('/api/v1/suppliers/onboarding/industry')
      .set(authHeader(tokenForUser(admin)))
      .send({ supplierId, categoryIds: [category._id.toString()] })
      .expect(200);

    await request(app)
      .put('/api/v1/suppliers/onboarding/company-info')
      .set(authHeader(tokenForUser(admin)))
      .send({
        supplierId,
        companyName: 'Assisted Metals Updated',
        description: 'Admin-assisted supplier with completed profile.',
        contactEmail: 'assistedsales@example.com',
        contactPhone: '+18885550102',
        address: '456 Foundry Lane',
        supplierType: 'Distributor',
      })
      .expect(200);

    await request(app)
      .put('/api/v1/suppliers/onboarding/subscription')
      .set(authHeader(tokenForUser(admin)))
      .send({
        supplierId,
        planId: plan._id.toString(),
        billingCycle: 'Annual',
        listingPeriod: '6-months',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.onboarding.step).toBe('payment');
        expect(body.data.onboarding.nextRoute).toBe('/subscription');
      });

    assistedSupplier = await Supplier.findById(supplierId);
    expect(assistedSupplier.categories.map(String)).toContain(category._id.toString());
    expect(assistedSupplier.companyName).toBe('Assisted Metals Updated');
    expect(assistedSupplier.selectedPlan.toString()).toBe(plan._id.toString());
    expect(assistedSupplier.subscriptionStatus).toBe('pending');
    expect(assistedSupplier.onboardingStep).toBe('payment');
  });

  it('does not send suppliers into obsolete cart or listing-period onboarding routes', async () => {
    const category = await createCategory({ name: 'Obsolete Flow Category' });
    const plan = await createPricingPlan({ name: 'Simplified Plan', slug: 'simplified-plan' });
    const { token, supplier } = await registerAndVerifySupplier();

    supplier.categories = [category._id];
    supplier.description = 'Completed profile description';
    supplier.contactPhone = '+15550007777';
    supplier.location = {
      type: 'Point',
      coordinates: [90.4125, 23.8103],
      formattedAddress: 'Dhaka, Bangladesh',
    };
    supplier.selectedPlan = plan._id;
    supplier.selectedBillingCycle = 'Annual';
    supplier.subscriptionStatus = 'pending';
    supplier.paymentStatus = 'unpaid';
    await supplier.save();

    const response = await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(token))
      .expect(200);

    expect(response.body.data.onboarding.step).toBe('payment');
    expect(response.body.data.onboarding.nextRoute).toBe('/subscription');
  });

  it('keeps listed suppliers publicly discoverable even if legacy approval flags drift', async () => {
    const category = await createCategory({ name: 'Public Search Category' });
    const user = await createUser({ role: 'supplier', email: uniqueEmail('public-search') });
    const supplier = await createSupplierForUser(user, {
      companyName: 'Discoverable Supplier',
      description: 'Supplier that should remain visible in public search.',
      contactEmail: 'public-search@example.com',
      contactPhone: '+15550001234',
      categories: [category._id],
      isApproved: false,
      listingStatus: 'Pending',
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      location: {
        type: 'Point',
        coordinates: [90.4125, 23.8103],
        formattedAddress: 'Dhaka, Bangladesh',
      },
    });

    supplier.onboardingStep = 'listed';
    supplier.onboardingCompletedAt = new Date();
    await supplier.save();

    await request(app)
      .get(`/api/v1/suppliers/${supplier._id}`)
      .expect(200);

    const listResponse = await request(app)
      .get('/api/v1/suppliers')
      .expect(200);

    expect(listResponse.body.data.some((entry) => entry._id.toString() === supplier._id.toString())).toBe(true);
  });

  it('blocks buyer accounts from supplier onboarding endpoints', async () => {
    const buyer = await createUser({ role: 'buyer', email: uniqueEmail('buyer') });

    await request(app)
      .get('/api/v1/suppliers/onboarding')
      .set(authHeader(tokenForUser(buyer)))
      .expect(403);
  });
});
