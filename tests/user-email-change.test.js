jest.mock('../src/utils/sendEmail', () => jest.fn().mockResolvedValue({ id: 'email-test-id' }));

const request = require('supertest');

const {
  app,
  authHeader,
  createSupplierForUser,
  createUser,
  tokenForUser,
  models: { Supplier, User },
} = require('./helpers/factories');

describe('user email change otp flow', () => {
  it('blocks direct email updates through /users/me', async () => {
    const user = await createUser({ role: 'supplier', email: 'locked-email@example.com' });
    await createSupplierForUser(user, { contactEmail: 'locked-email@example.com' });

    const response = await request(app)
      .put('/api/v1/users/me')
      .set(authHeader(tokenForUser(user)))
      .send({ email: 'new-email@example.com' })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.message).toMatch(/Email address is locked/i);
  });

  it('changes the login email after a valid otp verification without overwriting supplier contact email', async () => {
    const user = await createUser({ role: 'supplier', email: 'supplier-old@example.com' });
    const supplier = await createSupplierForUser(user, { contactEmail: 'company-contact@example.com' });

    const requestResponse = await request(app)
      .post('/api/v1/users/me/email-change/request')
      .set(authHeader(tokenForUser(user)))
      .send({ email: 'supplier-new@example.com' })
      .expect(200);

    expect(requestResponse.body.success).toBe(true);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.pendingEmail).toBe('supplier-new@example.com');
    expect(updatedUser.emailChangeCode).toHaveLength(6);

    const verifyResponse = await request(app)
      .post('/api/v1/users/me/email-change/verify')
      .set(authHeader(tokenForUser(user)))
      .send({ otp: updatedUser.emailChangeCode })
      .expect(200);

    expect(verifyResponse.body.success).toBe(true);
    expect(verifyResponse.body.data.email).toBe('supplier-new@example.com');

    const storedUser = await User.findById(user._id);
    const storedSupplier = await Supplier.findById(supplier._id);

    expect(storedUser.email).toBe('supplier-new@example.com');
    expect(storedUser.pendingEmail).toBe('');
    expect(storedUser.emailChangeCode).toBe('');
    expect(storedUser.emailChangeExpires).toBeNull();
    expect(storedSupplier.contactEmail).toBe('company-contact@example.com');
  });
});
