const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../src/utils/sendEmail', () => jest.fn().mockResolvedValue(true));
jest.mock('../src/utils/geocode', () =>
  jest.fn(async (address) => ({
    coordinates: [90.4125, 23.8103],
    formattedAddress: `${address} (Test Geocoded)`,
  }))
);
jest.mock('../src/utils/s3', () => ({
  generatePresignedUrl: jest.fn(async (prefix) => ({
    uploadUrl: `https://uploads.test/${prefix}`,
    url: `https://cdn.test/${prefix}/uploaded-file`,
    fileUrl: `https://cdn.test/${prefix}/uploaded-file`,
    key: `${prefix}/uploaded-file`,
  })),
}));
jest.mock('stripe', () => {
  const createSession = jest.fn().mockResolvedValue({
    id: 'cs_test_default',
    url: 'https://stripe.test/checkout/default',
  });
  const retrieveSession = jest.fn().mockResolvedValue({
    id: 'cs_test_default',
    livemode: false,
    status: 'complete',
    payment_status: 'paid',
    mode: 'subscription',
    client_reference_id: '',
    customer: 'cus_test_default',
    subscription: 'sub_test_default',
    metadata: {},
  });
  const retrieveInvoice = jest.fn();
  const constructEvent = jest.fn();
  const createProduct = jest.fn().mockResolvedValue({
    id: 'prod_test_default',
  });
  const createPrice = jest.fn().mockResolvedValue({
    id: 'price_test_default',
  });
  const retrieveSubscription = jest.fn().mockResolvedValue({
    id: 'sub_test_default',
    status: 'incomplete',
    customer: 'cus_test_default',
    start_date: 1704067200,
    current_period_start: 1704067200,
    current_period_end: 1706745600,
    cancel_at: null,
    cancel_at_period_end: false,
    metadata: {},
  });
  const updateSubscription = jest.fn(async (id, params) => ({
    id,
    status: 'incomplete',
    customer: 'cus_test_default',
    start_date: 1704067200,
    current_period_start: 1704067200,
    current_period_end: 1706745600,
    cancel_at: params.cancel_at_period_end ? 1706745600 : params.cancel_at,
    cancel_at_period_end: Boolean(params.cancel_at_period_end),
    metadata: params.metadata || {},
  }));

  const factory = jest.fn(() => ({
    checkout: {
      sessions: {
        create: createSession,
        retrieve: retrieveSession,
      },
    },
    invoices: {
      retrieve: retrieveInvoice,
    },
    products: {
      create: createProduct,
    },
    prices: {
      create: createPrice,
    },
    subscriptions: {
      retrieve: retrieveSubscription,
      update: updateSubscription,
    },
    webhooks: {
      constructEvent,
    },
  }));

  factory.__mock = {
    createPrice,
    createProduct,
    createSession,
    retrieveSession,
    retrieveInvoice,
    constructEvent,
    retrieveSubscription,
    updateSubscription,
  };

  return factory;
});

let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_EXPIRES_IN = '30d';
  process.env.STRIPE_SECRET_KEY = 'sk_test_mocked';
  process.env.MONGOMS_MD5_CHECK = 'false';
  delete process.env.STRIPE_WEBHOOK_SECRET;

  mongoServer = await MongoMemoryServer.create({
    binary: {
      checkMD5: false,
    },
  });
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  if (mongoose.connection.readyState === 1) {
    await Promise.all(
      Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({}))
    );
  }

  const stripeFactory = require('stripe');
  stripeFactory.__mock.createSession.mockReset();
  stripeFactory.__mock.createSession.mockResolvedValue({
    id: 'cs_test_default',
    url: 'https://stripe.test/checkout/default',
  });
  stripeFactory.__mock.retrieveSession.mockReset();
  stripeFactory.__mock.retrieveSession.mockResolvedValue({
    id: 'cs_test_default',
    livemode: false,
    status: 'complete',
    payment_status: 'paid',
    mode: 'subscription',
    client_reference_id: '',
    customer: 'cus_test_default',
    subscription: 'sub_test_default',
    metadata: {},
  });
  stripeFactory.__mock.retrieveInvoice.mockReset();
  stripeFactory.__mock.createProduct.mockReset();
  stripeFactory.__mock.createProduct.mockResolvedValue({
    id: 'prod_test_default',
  });
  stripeFactory.__mock.createPrice.mockReset();
  stripeFactory.__mock.createPrice.mockResolvedValue({
    id: 'price_test_default',
  });
  stripeFactory.__mock.retrieveSubscription.mockReset();
  stripeFactory.__mock.retrieveSubscription.mockResolvedValue({
    id: 'sub_test_default',
    status: 'incomplete',
    customer: 'cus_test_default',
    start_date: 1704067200,
    current_period_start: 1704067200,
    current_period_end: 1706745600,
    cancel_at: null,
    cancel_at_period_end: false,
    metadata: {},
  });
  stripeFactory.__mock.updateSubscription.mockReset();
  stripeFactory.__mock.updateSubscription.mockImplementation(async (id, params) => ({
    id,
    status: 'incomplete',
    customer: 'cus_test_default',
    start_date: 1704067200,
    current_period_start: 1704067200,
    current_period_end: 1706745600,
    cancel_at: params.cancel_at_period_end ? 1706745600 : params.cancel_at,
    cancel_at_period_end: Boolean(params.cancel_at_period_end),
    metadata: params.metadata || {},
  }));
  stripeFactory.__mock.constructEvent.mockReset();
  jest.clearAllMocks();
});

afterAll(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoServer) {
    await mongoServer.stop();
  }
});
