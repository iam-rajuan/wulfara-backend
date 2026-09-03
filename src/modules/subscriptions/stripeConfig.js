const normalizeStripeMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'live' || normalized === 'test') {
    return normalized;
  }

  return process.env.NODE_ENV === 'production' ? 'live' : 'test';
};

const getStripeConfig = (env = process.env) => {
  const stripeMode = normalizeStripeMode(env.STRIPE_MODE);
  const stripeSecretKey = env.STRIPE_SECRET_KEY || '';
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET || '';
  const isProduction = env.NODE_ENV === 'production';

  if (!stripeSecretKey) {
    throw new Error('STRIPE_SECRET_KEY is required.');
  }

  const expectedPrefix = stripeMode === 'live' ? 'sk_live_' : 'sk_test_';
  if (!stripeSecretKey.startsWith(expectedPrefix)) {
    throw new Error(
      `STRIPE_SECRET_KEY must start with ${expectedPrefix} when STRIPE_MODE=${stripeMode}.`
    );
  }

  if (isProduction && !stripeWebhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required in production.');
  }

  return {
    stripeMode,
    stripeSecretKey,
    stripeWebhookSecret,
    isProduction,
  };
};

module.exports = {
  getStripeConfig,
  normalizeStripeMode,
};
