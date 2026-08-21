const request = require('supertest');

const {
  app,
  authHeader,
  createUser,
  tokenForUser,
} = require('./helpers/factories');
const AdminRole = require('../src/modules/adminRoles/adminRole.model');
const {
  seedDefaultAdminRoles,
} = require('../src/modules/adminRoles/adminRole.service');

describe('admin roles and permission enforcement', () => {
  beforeEach(async () => {
    process.env.SUPER_ADMIN_LOCKED_EMAILS = 'locked-super-admin@example.com';
    await seedDefaultAdminRoles();
  });

  it('allows super admins to manage roles and blocks support admins from restricted admin APIs', async () => {
    const superAdminRole = await AdminRole.findOne({ slug: 'super-admin' });
    const supportRole = await AdminRole.findOne({ slug: 'support-admin' });
    const financeRole = await AdminRole.findOne({ slug: 'finance-admin' });

    const superAdmin = await createUser({
      role: 'admin',
      adminRole: superAdminRole._id,
    });
    const supportAdmin = await createUser({
      role: 'admin',
      adminRole: supportRole._id,
    });
    const financeAdmin = await createUser({
      role: 'admin',
      adminRole: financeRole._id,
    });

    const rolesResponse = await request(app)
      .get('/api/v1/admin-roles')
      .set(authHeader(tokenForUser(superAdmin)))
      .expect(200);

    expect(rolesResponse.body.count).toBeGreaterThanOrEqual(4);

    const createRoleResponse = await request(app)
      .post('/api/v1/admin-roles')
      .set(authHeader(tokenForUser(superAdmin)))
      .send({
        name: 'Regional Support Lead',
        description: 'Custom support scope with RFQ visibility.',
        permissions: ['dashboard.view', 'rfqs.read'],
      })
      .expect(201);

    expect(createRoleResponse.body.data.slug).toBe('regional-support-lead');

    await request(app)
      .get('/api/v1/admin-roles')
      .set(authHeader(tokenForUser(supportAdmin)))
      .expect(403);

    await request(app)
      .get('/api/v1/subscriptions/admin/active')
      .set(authHeader(tokenForUser(supportAdmin)))
      .expect(403);

    const financeResponse = await request(app)
      .get('/api/v1/subscriptions/admin/active')
      .set(authHeader(tokenForUser(financeAdmin)))
      .expect(200);

    expect(financeResponse.body.success).toBe(true);
  });

  it('locks protected super admin emails and prevents assigning super-admin to other admins', async () => {
    const superAdminRole = await AdminRole.findOne({ slug: 'super-admin' });
    const adminRole = await AdminRole.findOne({ slug: 'admin' });

    const superAdmin = await createUser({
      role: 'admin',
      email: 'locked-super-admin@example.com',
      adminRole: superAdminRole._id,
    });
    const regularAdmin = await createUser({
      role: 'admin',
      email: 'regular-admin@example.com',
      adminRole: adminRole._id,
    });

    await request(app)
      .patch(`/api/v1/admin-roles/admin-users/${superAdmin._id}`)
      .set(authHeader(tokenForUser(superAdmin)))
      .send({ adminRoleId: adminRole._id.toString() })
      .expect(403);

    await request(app)
      .patch(`/api/v1/admin-roles/admin-users/${regularAdmin._id}`)
      .set(authHeader(tokenForUser(superAdmin)))
      .send({ adminRoleId: superAdminRole._id.toString() })
      .expect(403);
  });
});
