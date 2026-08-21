const request = require('supertest');

const app = require('../../src/app');
const User = require('../../src/modules/users/user.model');
const Supplier = require('../../src/modules/suppliers/supplier.model');
const Category = require('../../src/modules/categories/category.model');
const PricingPlan = require('../../src/modules/subscriptions/pricingPlan.model');
const PendingRegistration = require('../../src/modules/auth/pendingRegistration.model');
const Payment = require('../../src/modules/subscriptions/payment.model');
const generateToken = require('../../src/utils/generateToken');
const { syncSupplierLifecycle } = require('../../src/modules/suppliers/supplierLifecycle');

let counter = 0;

const uniqueEmail = (prefix = 'user') => {
  counter += 1;
  return `${prefix}-${counter}@example.com`;
};

const authHeader = (token) => ({
  Authorization: `Bearer ${token}`,
});

const createUser = async (overrides = {}) =>
  User.create({
    name: overrides.name || 'Test User',
    email: overrides.email || uniqueEmail('user'),
    password: overrides.password || 'Password123!',
    role: overrides.role || 'buyer',
    adminRole: overrides.adminRole || null,
    isVerified: overrides.isVerified ?? true,
    status: overrides.status || 'Active',
  });

const tokenForUser = (user) => generateToken(user._id.toString());

const createCategory = async (overrides = {}) =>
  Category.create({
    name: overrides.name || `Category ${counter + 1}`,
    description: overrides.description || 'Test category description',
    status: overrides.status || 'Active',
    ...overrides,
  });

const createPricingPlan = async (overrides = {}) =>
  PricingPlan.create({
    internalName: overrides.internalName || `plan-${counter + 1}`,
    name: overrides.name || 'Premium',
    slug: overrides.slug || `premium-${counter + 1}`,
    description: overrides.description || 'Premium listing plan',
    price: overrides.price ?? 999,
    billingCycle: overrides.billingCycle || 'Annual',
    tier: overrides.tier,
    isActive: overrides.isActive ?? true,
    ...overrides,
  });

const createSupplierForUser = async (user, overrides = {}) => {
  const supplier = await Supplier.create({
    user: user._id,
    companyName: overrides.companyName || `${user.name} Company`,
    description: overrides.description || 'Reliable industrial supplier for testing.',
    contactEmail: overrides.contactEmail || user.email,
    contactPhone: overrides.contactPhone || '+15551234567',
    website: overrides.website || 'https://supplier.test',
    categories: overrides.categories || [],
    coreProducts: overrides.coreProducts || ['Steel coils'],
    location:
      overrides.location || {
        type: 'Point',
        coordinates: [90.4125, 23.8103],
        formattedAddress: 'Dhaka, Bangladesh',
      },
    supplierType: overrides.supplierType || 'Manufacturer',
    selectedPlan: overrides.selectedPlan ?? null,
    selectedBillingCycle: overrides.selectedBillingCycle || '',
    selectedListingPeriod: overrides.selectedListingPeriod || '',
    subscriptionPlan: overrides.subscriptionPlan || 'free',
    subscriptionStatus: overrides.subscriptionStatus || 'inactive',
    paymentStatus: overrides.paymentStatus || 'unpaid',
    isApproved: overrides.isApproved ?? false,
    listingStatus: overrides.listingStatus || 'Pending',
    certifications: overrides.certifications || [],
    employeeCount: overrides.employeeCount || '',
    establishedYear: overrides.establishedYear || '',
    annualTurnover: overrides.annualTurnover || '',
    gallery: overrides.gallery || [],
  });

  syncSupplierLifecycle(supplier);
  await supplier.save();
  return supplier;
};

const registerAndVerifySupplier = async (overrides = {}) => {
  const payload = {
    name: overrides.name || 'Supplier User',
    email: overrides.email || uniqueEmail('supplier'),
    password: overrides.password || 'Password123!',
    role: 'supplier',
    companyName: overrides.companyName || 'Supplier Co',
    phone: overrides.phone || '+15550001111',
  };

  await request(app).post('/api/v1/auth/register').send(payload).expect(201);
  const pending = await PendingRegistration.findOne({ email: payload.email.toLowerCase() });

  const verifyResponse = await request(app)
    .post('/api/v1/auth/verify-email')
    .send({ email: payload.email, verifyCode: pending.verifyCode })
    .expect(200);

  const user = await User.findOne({ email: payload.email.toLowerCase() });
  const supplier = await Supplier.findOne({ user: user._id });

  return {
    payload,
    pending,
    user,
    supplier,
    token: verifyResponse.body.token,
  };
};

module.exports = {
  app,
  authHeader,
  createCategory,
  createPricingPlan,
  createSupplierForUser,
  createUser,
  registerAndVerifySupplier,
  tokenForUser,
  uniqueEmail,
  models: {
    Payment,
    PendingRegistration,
    PricingPlan,
    Supplier,
    User,
  },
};
