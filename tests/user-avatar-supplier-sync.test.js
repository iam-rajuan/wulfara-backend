const request = require('supertest');

const {
  app,
  authHeader,
  createSupplierForUser,
  createUser,
  tokenForUser,
  models: { Supplier },
} = require('./helpers/factories');

describe('supplier avatar and company logo separation', () => {
  it('does not copy avatar to supplier logo when no dedicated company logo exists', async () => {
    const supplierUser = await createUser({
      role: 'supplier',
      email: 'supplier-avatar-sync@example.com',
    });

    const supplier = await createSupplierForUser(supplierUser, {
      logo: 'no-logo.jpg',
    });

    const avatarUrl = 'https://cdn.test/avatars/supplier-profile.png';

    const response = await request(app)
      .put('/api/v1/users/me')
      .set(authHeader(tokenForUser(supplierUser)))
      .send({
        name: supplierUser.name,
        avatar: avatarUrl,
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.avatar).toBe(avatarUrl);

    const storedSupplier = await Supplier.findById(supplier._id);
    expect(storedSupplier.logo).toBe('no-logo.jpg');
  });

  it('does not overwrite an existing dedicated supplier logo', async () => {
    const supplierUser = await createUser({
      role: 'supplier',
      email: 'supplier-avatar-preserve@example.com',
      avatar: 'https://cdn.test/avatars/original-avatar.png',
    });

    const supplier = await createSupplierForUser(supplierUser, {
      logo: 'https://cdn.test/logos/company-logo.png',
    });

    const avatarUrl = 'https://cdn.test/avatars/new-avatar.png';

    await request(app)
      .put('/api/v1/users/me')
      .set(authHeader(tokenForUser(supplierUser)))
      .send({
        name: supplierUser.name,
        avatar: avatarUrl,
      })
      .expect(200);

    const storedSupplier = await Supplier.findById(supplier._id);
    expect(storedSupplier.logo).toBe('https://cdn.test/logos/company-logo.png');
  });
});
