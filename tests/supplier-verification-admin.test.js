const request = require('supertest');

const {
  app,
  authHeader,
  createCategory,
  createPricingPlan,
  createSupplierForUser,
  createUser,
  tokenForUser,
  models: { Payment, Supplier, User },
} = require('./helpers/factories');

describe('admin supplier verification detail flow', () => {
  it('returns public supplier detail with safe user avatar fallback data', async () => {
    const supplierUser = await createUser({
      role: 'supplier',
      email: 'supplier-public@example.com',
      avatar: 'https://cdn.test/avatars/public-supplier.png',
    });

    const supplier = await createSupplierForUser(supplierUser, {
      isApproved: true,
      listingStatus: 'Approved',
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      logo: 'no-logo.jpg',
      gallery: [
        {
          title: 'Factory Floor',
          type: 'Factory Images',
          isPdf: false,
          url: 'https://cdn.test/suppliers/factory-floor.png',
        },
      ],
    });

    const response = await request(app)
      .get(`/api/v1/suppliers/${supplier._id}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.user).toEqual(
      expect.objectContaining({
        _id: supplierUser._id.toString(),
        avatar: 'https://cdn.test/avatars/public-supplier.png',
      })
    );
    expect(response.body.data.logo).toBe('no-logo.jpg');
  });

  it('returns admin verification detail data with documents and payment summary', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin-verification@example.com' });
    const supplierUser = await createUser({ role: 'supplier', email: 'supplier-verification@example.com' });
    const category = await createCategory({ name: 'Metals' });
    const plan = await createPricingPlan({ name: 'Premium', slug: 'premium-verify' });

    const supplier = await createSupplierForUser(supplierUser, {
      categories: [category._id],
      selectedPlan: plan._id,
      subscriptionPlan: 'premium',
      selectedBillingCycle: 'Annual',
      selectedListingPeriod: '12 Months',
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      gallery: [
        {
          title: 'Business License.pdf',
          type: 'Certificates',
          isPdf: true,
          size: '2.4 MB',
          url: 'https://cdn.test/suppliers/license.pdf',
        },
      ],
    });

    await Payment.create({
      supplier: supplier._id,
      plan: plan._id,
      planName: 'Premium',
      billingCycle: 'Annual',
      listingPeriod: '12 Months',
      amount: 1200,
      status: 'paid',
    });

    const response = await request(app)
      .get(`/api/v1/suppliers/${supplier._id}`)
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.companyName).toBe(supplier.companyName);
    expect(response.body.data.verificationChecklist).toEqual(
      expect.objectContaining({
        identity: false,
        business: false,
        tax: false,
      })
    );
    expect(response.body.data.verificationDocuments).toHaveLength(1);
    expect(response.body.data.verificationDocuments[0]).toEqual(
      expect.objectContaining({
        title: 'Business License.pdf',
        reviewStatus: 'Pending Review',
      })
    );
    expect(response.body.data.paymentSummary).toEqual(
      expect.objectContaining({
        paymentCount: 1,
        totalPaidAmount: 1200,
      })
    );
    expect(response.body.data.paymentSummary.latestPayment).toEqual(
      expect.objectContaining({
        amount: 1200,
        status: 'paid',
      })
    );
  });

  it('persists checklist and document review updates from admin actions', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin-update@example.com' });
    const supplierUser = await createUser({ role: 'supplier', email: 'supplier-update@example.com' });

    const supplier = await createSupplierForUser(supplierUser, {
      gallery: [
        {
          title: 'Tax Certificate.pdf',
          type: 'Certificates',
          isPdf: true,
          size: '1.1 MB',
          url: 'https://cdn.test/suppliers/tax-certificate.pdf',
        },
      ],
    });

    const documentId = supplier.gallery[0]._id.toString();

    const response = await request(app)
      .put(`/api/v1/suppliers/${supplier._id}/verification`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        checklist: {
          identity: true,
          tax: true,
        },
        documents: [
          {
            id: documentId,
            reviewStatus: 'Approved',
          },
        ],
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.verificationChecklist.identity).toBe(true);
    expect(response.body.data.verificationChecklist.tax).toBe(true);
    expect(response.body.data.verificationDocuments[0].reviewStatus).toBe('Approved');

    const storedSupplier = await Supplier.findById(supplier._id);
    expect(storedSupplier.verificationChecklist.identity).toBe(true);
    expect(storedSupplier.verificationChecklist.tax).toBe(true);
    expect(storedSupplier.verificationChecklist.updatedBy.toString()).toBe(admin._id.toString());
    expect(storedSupplier.gallery[0].reviewStatus).toBe('Approved');
    expect(storedSupplier.gallery[0].reviewedBy.toString()).toBe(admin._id.toString());
  });

  it('suspends the linked user account when an admin suspends the supplier', async () => {
    const admin = await createUser({ role: 'admin', email: 'admin-review@example.com' });
    const supplierUser = await createUser({ role: 'supplier', email: 'supplier-review@example.com' });
    const supplier = await createSupplierForUser(supplierUser);

    await request(app)
      .put(`/api/v1/suppliers/${supplier._id}/review`)
      .set(authHeader(tokenForUser(admin)))
      .send({ listingStatus: 'Suspended' })
      .expect(200);

    const storedUser = await User.findById(supplierUser._id);
    const storedSupplier = await Supplier.findById(supplier._id);

    expect(storedSupplier.listingStatus).toBe('Suspended');
    expect(storedUser.status).toBe('Suspended');
  });
});
