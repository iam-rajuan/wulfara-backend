const request = require('supertest');

const {
  app,
  createCategory,
  createSupplierForUser,
  createUser,
} = require('./helpers/factories');

describe('public supplier directory search', () => {
  it('matches keyword searches across category, core product, certification, and supplier type fields', async () => {
    const machiningCategory = await createCategory({ name: 'Precision Machining' });
    const supplierUser = await createUser({
      role: 'supplier',
      email: 'directory-search@example.com',
    });

    await createSupplierForUser(supplierUser, {
      categories: [machiningCategory._id],
      coreProducts: ['Assembly fixtures'],
      certifications: ['ISO 9001'],
      supplierType: 'Service Provider',
      isApproved: true,
      listingStatus: 'Approved',
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
    });

    const categoryResponse = await request(app)
      .get('/api/v1/suppliers?listed=true&keyword=machining')
      .expect(200);

    expect(categoryResponse.body.count).toBe(1);
    expect(categoryResponse.body.data[0].companyName).toContain('Company');

    const productResponse = await request(app)
      .get('/api/v1/suppliers?listed=true&keyword=assembly')
      .expect(200);

    expect(productResponse.body.count).toBe(1);

    const certificationResponse = await request(app)
      .get('/api/v1/suppliers?listed=true&keyword=iso')
      .expect(200);

    expect(certificationResponse.body.count).toBe(1);

    const supplierTypeResponse = await request(app)
      .get('/api/v1/suppliers?listed=true&keyword=service')
      .expect(200);

    expect(supplierTypeResponse.body.count).toBe(1);
  });

  it('supports distance filtering when the client provides a location string', async () => {
    const supplierUser = await createUser({
      role: 'supplier',
      email: 'directory-distance@example.com',
    });

    await createSupplierForUser(supplierUser, {
      location: {
        type: 'Point',
        coordinates: [90.4125, 23.8103],
        formattedAddress: 'Dhaka, Bangladesh',
      },
      isApproved: true,
      listingStatus: 'Approved',
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
    });

    const response = await request(app)
      .get('/api/v1/suppliers?listed=true&location=Dhaka&distance=50')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.count).toBe(1);
  });
});
