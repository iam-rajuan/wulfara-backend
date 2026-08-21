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
  const constructEvent = jest.fn();

  const factory = jest.fn(() => ({
    checkout: {
      sessions: {
        create: createSession,
      },
    },
    webhooks: {
      constructEvent,
    },
  }));

  factory.__mock = {
    createSession,
    constructEvent,
  };

  return factory;
});

let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_EXPIRES_IN = '30d';
  process.env.DASHBOARD_ORIGIN = 'https://dashboard.wulfara.test';
  process.env.WEBSITE_ORIGIN = 'https://www.wulfara.test';
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
