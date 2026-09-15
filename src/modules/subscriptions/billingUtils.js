const MONTHLY_SUBSCRIPTION_STATUSES = [
  'pending_checkout',
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'payment_failed',
  'requires_action',
];

const TERMINAL_STRIPE_SUBSCRIPTION_STATUSES = [
  'canceled',
  'incomplete_expired',
];

const isMonthlyBillingCycle = (value = '') => /month|monthly/i.test(String(value));

const isAnnualBillingCycle = (value = '') => /annual|annually|year|yearly/i.test(String(value));

const toCents = (amount = 0) => Math.round(Number(amount || 0) * 100);

const centsToAmount = (amount = 0) => Number((Number(amount || 0) / 100).toFixed(2));

const getStripeObjectId = (value) => {
  if (!value) {
    return '';
  }

  return typeof value === 'string' ? value : value.id || '';
};

const dateFromUnix = (value) => {
  if (!value) {
    return null;
  }

  return new Date(Number(value) * 1000);
};

const unixFromDate = (value) => {
  if (!value) {
    return null;
  }

  return Math.floor(new Date(value).getTime() / 1000);
};

const addUtcMonths = (date, months) => {
  const start = new Date(date);
  const result = new Date(start.getTime());
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + Number(months || 0));

  const lastDayInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDayInTargetMonth));
  return result;
};

const getInvoiceSubscriptionId = (invoice = {}) =>
  getStripeObjectId(invoice.subscription) ||
  getStripeObjectId(invoice.parent?.subscription_details?.subscription) ||
  getStripeObjectId(invoice.lines?.data?.[0]?.subscription);

const getInvoicePaymentIntentId = (invoice = {}) =>
  getStripeObjectId(invoice.payment_intent) ||
  getStripeObjectId(invoice.confirmation_secret?.payment_intent);

const getInvoicePeriod = (invoice = {}) => {
  const line = Array.isArray(invoice.lines?.data) ? invoice.lines.data[0] : null;
  const period = line?.period || {};

  return {
    start: dateFromUnix(period.start),
    end: dateFromUnix(period.end),
  };
};

module.exports = {
  MONTHLY_SUBSCRIPTION_STATUSES,
  TERMINAL_STRIPE_SUBSCRIPTION_STATUSES,
  addUtcMonths,
  centsToAmount,
  dateFromUnix,
  getInvoicePaymentIntentId,
  getInvoicePeriod,
  getInvoiceSubscriptionId,
  getStripeObjectId,
  isAnnualBillingCycle,
  isMonthlyBillingCycle,
  toCents,
  unixFromDate,
};
