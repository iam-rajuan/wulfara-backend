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
  models: { Supplier },
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
});
