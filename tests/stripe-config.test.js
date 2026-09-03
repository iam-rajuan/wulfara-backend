const { getStripeConfig, normalizeStripeMode } = require('../src/modules/subscriptions/stripeConfig');

describe('stripe config mode validation', () => {
  it('defaults to test mode outside production', () => {
    expect(normalizeStripeMode(undefined)).toBe('test');
  });

  it('defaults to live mode in production', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    expect(normalizeStripeMode(undefined)).toBe('live');

    process.env.NODE_ENV = originalNodeEnv;
  });

  it('accepts test mode with a test key in production', () => {
    const config = getStripeConfig({
      NODE_ENV: 'production',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_123',
    });

    expect(config.stripeMode).toBe('test');
    expect(config.isProduction).toBe(true);
  });

  it('rejects a mismatched key prefix for live mode', () => {
    expect(() =>
      getStripeConfig({
        NODE_ENV: 'production',
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
      })
    ).toThrow('STRIPE_SECRET_KEY must start with sk_live_ when STRIPE_MODE=live.');
  });

  it('requires a webhook secret in production', () => {
    expect(() =>
      getStripeConfig({
        NODE_ENV: 'production',
        STRIPE_MODE: 'test',
        STRIPE_SECRET_KEY: 'sk_test_123',
      })
    ).toThrow('STRIPE_WEBHOOK_SECRET is required in production.');
  });
});
