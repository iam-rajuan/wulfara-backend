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
  models: { Supplier, Payment },
} = require('./helpers/factories');
const { syncSupplierLifecycle } = require('../src/modules/suppliers/supplierLifecycle');

describe('public directory and admin subscription visibility', () => {
  const listSupplier = async (supplier, categoryId, plan) => {
    supplier.categories = supplier.categories.length ? supplier.categories : [categoryId];
    supplier.selectedPlan = plan._id;
    supplier.selectedBillingCycle = 'Annual';
    supplier.subscriptionPlan = plan.tier || 'premium';
    supplier.subscriptionStatus = 'active';
    supplier.paymentStatus = 'paid';
    supplier.isApproved = true;
    supplier.listingStatus = 'Approved';
    syncSupplierLifecycle(supplier);
    await supplier.save();
    return supplier;
  };

  const activateFeaturedHeroPlacement = async (supplier) => {
    supplier.selectedAddons = ['featured_hero_placement'];
    supplier.featuredHeroPlacement = {
      enabled: true,
      activatedAt: new Date(),
    };
    await supplier.save();
    return supplier;
  };

  it('only exposes listed suppliers publicly and through eligibleForRfq filters', async () => {
    const category = await createCategory({ name: 'Directory Category' });
    const plan = await createPricingPlan({
      name: 'Directory Pro',
      slug: 'directory-pro',
      tier: 'pro',
    });

    const listedUser = await createUser({ role: 'supplier', email: uniqueEmail('listed') });
    const pendingUser = await createUser({ role: 'supplier', email: uniqueEmail('pending') });
    const failedUser = await createUser({ role: 'supplier', email: uniqueEmail('failed') });
    const inactiveUser = await createUser({ role: 'supplier', email: uniqueEmail('inactive') });

    const listedSupplier = await createSupplierForUser(listedUser, { categories: [category._id] });
    await listSupplier(listedSupplier, category._id, plan);

    await createSupplierForUser(pendingUser, {
      categories: [category._id],
      selectedPlan: plan._id,
      selectedBillingCycle: 'Annual',
      subscriptionStatus: 'pending',
      paymentStatus: 'pending',
    });

    await createSupplierForUser(failedUser, {
      categories: [category._id],
      selectedPlan: plan._id,
      selectedBillingCycle: 'Annual',
      subscriptionPlan: plan.tier,
      subscriptionStatus: 'failed',
      paymentStatus: 'failed',
      listingStatus: 'Pending',
    });

    await createSupplierForUser(inactiveUser, {
      categories: [category._id],
      selectedPlan: plan._id,
      selectedBillingCycle: 'Annual',
      subscriptionPlan: plan.tier,
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      isApproved: false,
      listingStatus: 'Pending',
    });

    const publicResponse = await request(app).get('/api/v1/suppliers').expect(200);
    expect(publicResponse.body.data).toHaveLength(1);
    expect(publicResponse.body.data[0]._id).toBe(listedSupplier._id.toString());

    const rfqEligibleResponse = await request(app)
      .get('/api/v1/suppliers?eligibleForRfq=true')
      .expect(200);

    expect(rfqEligibleResponse.body.data).toHaveLength(1);
    expect(rfqEligibleResponse.body.data[0]._id).toBe(listedSupplier._id.toString());
  });

  it('returns self-registered and admin-assisted listed suppliers identically in eligible supplier selection', async () => {
    const category = await createCategory({ name: 'RFQ Category' });
    const plan = await createPricingPlan({ name: 'RFQ Plan', slug: 'rfq-plan', tier: 'premium' });
    const admin = await createUser({ role: 'admin', email: uniqueEmail('admin-rfq') });

    const direct = await registerAndVerifySupplier({ email: uniqueEmail('direct-rfq') });
    let directSupplier = await Supplier.findOne({ user: direct.user._id });
    directSupplier.categories = [category._id];
    directSupplier.description = 'Fully onboarded direct supplier';
    directSupplier.contactPhone = '+15550002222';
    directSupplier.location = {
      type: 'Point',
      coordinates: [90.4125, 23.8103],
      formattedAddress: 'Direct City',
    };
    await listSupplier(directSupplier, category._id, plan);

    const assistedResponse = await request(app)
      .post('/api/v1/suppliers/admin-assisted')
      .set(authHeader(tokenForUser(admin)))
      .send({
        name: 'RFQ Assisted',
        email: uniqueEmail('assisted-rfq'),
        password: 'Password123!',
        companyName: 'Assisted RFQ Metals',
        phone: '+15550003333',
      })
      .expect(201);

    let assistedSupplier = await Supplier.findById(assistedResponse.body.data.supplier._id);
    assistedSupplier.categories = [category._id];
    assistedSupplier.description = 'Fully onboarded assisted supplier';
    assistedSupplier.contactPhone = '+15550003333';
    assistedSupplier.location = {
      type: 'Point',
      coordinates: [90.5125, 23.9103],
      formattedAddress: 'Assisted City',
    };
    await listSupplier(assistedSupplier, category._id, plan);

    const eligibleResponse = await request(app)
      .get('/api/v1/suppliers?eligibleForRfq=true')
      .expect(200);

    const returnedIds = eligibleResponse.body.data.map((supplier) => supplier._id).sort();
    expect(returnedIds).toEqual(
      [directSupplier._id.toString(), assistedSupplier._id.toString()].sort()
    );
  });

  it('sorts featured suppliers ahead of normal suppliers in the public directory', async () => {
    const category = await createCategory({ name: 'Featured Category' });
    const plan = await createPricingPlan({ name: 'Featured Plan', slug: 'featured-plan', tier: 'premium' });
    const featuredUser = await createUser({ role: 'supplier', email: uniqueEmail('featured') });
    const normalUser = await createUser({ role: 'supplier', email: uniqueEmail('normal') });

    const featuredSupplier = await createSupplierForUser(featuredUser, {
      categories: [category._id],
      companyName: 'Featured Metals',
    });
    const normalSupplier = await createSupplierForUser(normalUser, {
      categories: [category._id],
      companyName: 'Normal Metals',
    });

    await listSupplier(featuredSupplier, category._id, plan);
    await listSupplier(normalSupplier, category._id, plan);
    await activateFeaturedHeroPlacement(featuredSupplier);

    const response = await request(app)
      .get(`/api/v1/suppliers?categories=${category._id.toString()}`)
      .expect(200);

    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]._id).toBe(featuredSupplier._id.toString());
    expect(response.body.data[0].featuredHeroPlacement.enabled).toBe(true);
    expect(response.body.data[1]._id).toBe(normalSupplier._id.toString());
  });

  it('protects and filters the active subscriptions admin endpoint', async () => {
    const category = await createCategory({ name: 'Subscription Category' });
    const plan = await createPricingPlan({ name: 'Active Plan', slug: 'active-plan', tier: 'premium' });
    const admin = await createUser({ role: 'admin', email: uniqueEmail('subs-admin') });
    const supplierUser = await createUser({ role: 'supplier', email: uniqueEmail('subs-supplier') });
    const activeUser = await createUser({ role: 'supplier', email: uniqueEmail('active-supplier') });

    await createSupplierForUser(supplierUser, {
      categories: [category._id],
      selectedPlan: plan._id,
      selectedBillingCycle: 'Annual',
      subscriptionStatus: 'failed',
      paymentStatus: 'failed',
      listingStatus: 'Pending',
    });

    const activeSupplier = await createSupplierForUser(activeUser, {
      categories: [category._id],
      selectedPlan: plan._id,
      selectedBillingCycle: 'Annual',
      selectedListingPeriod: '12-months',
    });
    await listSupplier(activeSupplier, category._id, plan);

    await request(app).get('/api/v1/subscriptions/admin/active').expect(401);

    await request(app)
      .get('/api/v1/subscriptions/admin/active')
      .set(authHeader(tokenForUser(supplierUser)))
      .expect(403);

    const response = await request(app)
      .get('/api/v1/subscriptions/admin/active')
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(response.body.count).toBe(1);
    expect(response.body.data[0]._id).toBe(activeSupplier._id.toString());
    expect(response.body.data[0].user.email).toBe(activeUser.email);
    expect(response.body.data[0].selectedPlan.name).toBe(plan.name);
    expect(response.body.data[0].selectedPlan.price).toBe(plan.price);
  });

  it('returns a real admin overview for subscription packages', async () => {
    const category = await createCategory({ name: 'Overview Category' });
    const activePlan = await createPricingPlan({
      name: 'Overview Premium',
      slug: 'overview-premium',
      price: 320,
      isActive: true,
    });
    const draftPlan = await createPricingPlan({
      name: 'Overview Draft',
      slug: 'overview-draft',
      price: 120,
      isActive: false,
    });
    const admin = await createUser({ role: 'admin', email: uniqueEmail('subs-overview-admin') });
    const activeUser = await createUser({ role: 'supplier', email: uniqueEmail('subs-overview-active') });
    const inactiveUser = await createUser({ role: 'supplier', email: uniqueEmail('subs-overview-inactive') });

    const activeSupplier = await createSupplierForUser(activeUser, {
      categories: [category._id],
      selectedPlan: activePlan._id,
      selectedBillingCycle: 'Monthly',
      selectedListingPeriod: '12-months',
    });
    await listSupplier(activeSupplier, category._id, activePlan);

    await createSupplierForUser(inactiveUser, {
      categories: [category._id],
      selectedPlan: draftPlan._id,
      selectedBillingCycle: 'Monthly',
      subscriptionStatus: 'inactive',
      paymentStatus: 'unpaid',
      listingStatus: 'Pending',
      isApproved: false,
    });

    await Payment.create({
      supplier: activeSupplier._id,
      plan: activePlan._id,
      planName: activePlan.name,
      billingCycle: 'Monthly',
      listingPeriod: '12-months',
      amount: 320,
      status: 'paid',
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
      updatedAt: new Date('2026-08-12T10:00:00.000Z'),
    });

    await request(app).get('/api/v1/subscriptions/admin/overview').expect(401);

    const response = await request(app)
      .get('/api/v1/subscriptions/admin/overview')
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(response.body.data.metrics.activePackages).toBe(1);
    expect(response.body.data.metrics.paidSuppliers).toBe(1);
    expect(response.body.data.metrics.monthlyRevenue).toBe(320);
    expect(response.body.data.metrics.packageConversion).toBe(50);
    expect(response.body.data.plans).toHaveLength(2);

    const returnedActivePlan = response.body.data.plans.find((plan) => plan._id === activePlan._id.toString());
    const returnedDraftPlan = response.body.data.plans.find((plan) => plan._id === draftPlan._id.toString());

    expect(returnedActivePlan.activeSuppliersCount).toBe(1);
    expect(returnedActivePlan.lifetimeRevenue).toBe(320);
    expect(returnedDraftPlan.activeSuppliersCount).toBe(0);

    const filteredResponse = await request(app)
      .get('/api/v1/subscriptions/admin/overview?status=draft')
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(filteredResponse.body.data.plans).toHaveLength(1);
    expect(filteredResponse.body.data.plans[0]._id).toBe(draftPlan._id.toString());
  });

  it('returns admin-only plan detail and full plan catalog including drafts', async () => {
    const admin = await createUser({ role: 'admin', email: uniqueEmail('subs-admin-plans') });
    const supplier = await createUser({ role: 'supplier', email: uniqueEmail('subs-supplier-plans') });
    const activePlan = await createPricingPlan({
      name: 'Admin Visible Active',
      slug: 'admin-visible-active',
      isActive: true,
    });
    const draftPlan = await createPricingPlan({
      name: 'Admin Visible Draft',
      slug: 'admin-visible-draft',
      isActive: false,
    });

    await request(app).get('/api/v1/subscriptions/admin/plans').expect(401);

    await request(app)
      .get('/api/v1/subscriptions/admin/plans')
      .set(authHeader(tokenForUser(supplier)))
      .expect(403);

    const plansResponse = await request(app)
      .get('/api/v1/subscriptions/admin/plans')
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    const returnedIds = plansResponse.body.data.map((plan) => plan._id);
    expect(returnedIds).toContain(activePlan._id.toString());
    expect(returnedIds).toContain(draftPlan._id.toString());

    const singlePlanResponse = await request(app)
      .get(`/api/v1/subscriptions/admin/plans/${draftPlan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(singlePlanResponse.body.data._id).toBe(draftPlan._id.toString());
    expect(singlePlanResponse.body.data.isActive).toBe(false);
  });
});
