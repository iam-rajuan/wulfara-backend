const request = require('supertest');

const {
  app,
  authHeader,
  createPricingPlan,
  createUser,
  tokenForUser,
  models: { PricingPlan },
} = require('./helpers/factories');

describe('pricing plan listing period management', () => {
  it('loads existing listing periods and falls back safely for legacy plans', async () => {
    const admin = await createUser({ role: 'admin', email: 'listing-admin-read@example.com' });
    const plan = await createPricingPlan({
      name: 'Legacy Premium',
      slug: 'legacy-premium',
      listingPeriods: [
        { durationMonths: 12, discountPercent: 0 },
        { durationMonths: 24, discountPercent: 15 },
      ],
    });

    const response = await request(app)
      .get(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(response.body.data.listingPeriods).toEqual([
      expect.objectContaining({ durationMonths: 12 }),
      expect.objectContaining({ durationMonths: 24 }),
    ]);

    const legacyPlan = await createPricingPlan({
      name: 'Legacy Without Periods',
      slug: 'legacy-without-periods',
    });
    await PricingPlan.updateOne({ _id: legacyPlan._id }, { $unset: { listingPeriods: 1 } });

    const legacyResponse = await request(app)
      .get(`/api/v1/subscriptions/plans/${legacyPlan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(legacyResponse.body.data.listingPeriods.map((period) => period.durationMonths)).toEqual([12, 24, 48]);
  });

  it('edits, adds, sorts, and persists flexible listing periods without changing price', async () => {
    const admin = await createUser({ role: 'admin', email: 'listing-admin-update@example.com' });
    const plan = await createPricingPlan({
      name: 'Flexible Premium',
      slug: 'flexible-premium',
      price: 4900,
      iconKey: 'award',
      listingPeriods: [
        { durationMonths: 12, discountPercent: 0 },
        { durationMonths: 24, discountPercent: 15 },
        { durationMonths: 48, discountPercent: 25 },
      ],
    });

    const updateResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        iconKey: 'rocket',
        listingPeriods: [
          { durationMonths: 24, discountPercent: 15 },
          { durationMonths: 6, discountPercent: 0 },
          { durationMonths: 48, discountPercent: 25 },
          { durationMonths: 18, discountPercent: 10 },
          { durationMonths: 12, discountPercent: 0 },
          { durationMonths: 36, discountPercent: 20 },
        ],
      })
      .expect(200);

    expect(updateResponse.body.data.price).toBe(4900);
    expect(updateResponse.body.data.iconKey).toBe('rocket');
    expect(updateResponse.body.data.listingPeriods.map((period) => period.durationMonths)).toEqual([6, 12, 18, 24, 36, 48]);

    const reloadResponse = await request(app)
      .get(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(reloadResponse.body.data.price).toBe(4900);
    expect(reloadResponse.body.data.iconKey).toBe('rocket');
    expect(reloadResponse.body.data.listingPeriods.map((period) => period.durationMonths)).toEqual([6, 12, 18, 24, 36, 48]);

    await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        listingPeriods: [
          { durationMonths: 6, discountPercent: 0 },
          { durationMonths: 12, discountPercent: 0 },
          { durationMonths: 20, discountPercent: 10 },
          { durationMonths: 24, discountPercent: 15 },
          { durationMonths: 36, discountPercent: 20 },
          { durationMonths: 48, discountPercent: 25 },
        ],
      })
      .expect(200);

    const updatedReloadResponse = await request(app)
      .get(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .expect(200);

    expect(updatedReloadResponse.body.data.listingPeriods.map((period) => period.durationMonths)).toEqual([6, 12, 20, 24, 36, 48]);
  });

  it('rejects duplicate, zero, negative, and invalid string durations', async () => {
    const admin = await createUser({ role: 'admin', email: 'listing-admin-invalid@example.com' });
    const plan = await createPricingPlan({
      name: 'Invalid Premium',
      slug: 'invalid-premium',
    });

    const duplicateResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        listingPeriods: [
          { durationMonths: 12 },
          { durationMonths: 12 },
        ],
      })
      .expect(400);

    expect(duplicateResponse.body.message).toBe('A 12-month listing period already exists.');

    const zeroResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        listingPeriods: [{ durationMonths: 0 }],
      })
      .expect(400);

    expect(zeroResponse.body.message).toContain('greater than 0');

    const negativeResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        listingPeriods: [{ durationMonths: -6 }],
      })
      .expect(400);

    expect(negativeResponse.body.message).toContain('greater than 0');

    const invalidStringResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        listingPeriods: [{ durationMonths: 'abc' }],
      })
      .expect(400);

    expect(invalidStringResponse.body.message).toContain('integer');

    const invalidDiscountResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${plan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        listingPeriods: [{ durationMonths: 12, discountPercent: 120 }],
      })
      .expect(400);

    expect(invalidDiscountResponse.body.message).toContain('between 0 and 100');
  });

  it('rejects duplicate plan identity fields across all plans', async () => {
    const admin = await createUser({ role: 'admin', email: 'listing-admin-unique@example.com' });
    const activePlan = await createPricingPlan({
      internalName: 'Premium Basic',
      name: 'Premium Basic',
      slug: 'premium-basic',
      isActive: true,
    });
    const draftPlan = await createPricingPlan({
      internalName: 'Draft Exclusive',
      name: 'Draft Exclusive',
      slug: 'draft-exclusive',
      isActive: false,
    });

    const duplicateCreateResponse = await request(app)
      .post('/api/v1/subscriptions/plans')
      .set(authHeader(tokenForUser(admin)))
      .send({
        internalName: 'Draft Exclusive',
        name: 'Another Plan',
        slug: 'another-plan',
        price: 55,
      })
      .expect(400);

    expect(duplicateCreateResponse.body.message).toContain('internal name');

    const duplicateUpdateResponse = await request(app)
      .put(`/api/v1/subscriptions/plans/${activePlan._id}`)
      .set(authHeader(tokenForUser(admin)))
      .send({
        name: draftPlan.name,
      })
      .expect(400);

    expect(duplicateUpdateResponse.body.message).toContain('display name');
  });
});
