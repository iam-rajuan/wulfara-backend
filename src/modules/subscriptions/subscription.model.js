const mongoose = require('mongoose');

const subscriptionAddonSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const subscriptionSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.ObjectId,
      ref: 'Supplier',
      required: true,
    },
    plan: {
      type: mongoose.Schema.ObjectId,
      ref: 'PricingPlan',
      default: null,
      index: true,
    },
    planName: {
      type: String,
      default: '',
    },
    billingCycle: {
      type: String,
      default: '',
    },
    billingCycleType: {
      type: String,
      enum: ['monthly', 'annual', 'one_time'],
      default: 'one_time',
      index: true,
    },
    durationMonths: {
      type: Number,
      min: 1,
      default: null,
    },
    listingPeriod: {
      type: String,
      default: '',
    },
    status: {
      type: String,
      enum: [
        'pending_checkout',
        'incomplete',
        'trialing',
        'active',
        'past_due',
        'payment_failed',
        'requires_action',
        'unpaid',
        'paused',
        'canceled',
        'completed',
        'expired',
        'incomplete_expired',
      ],
      default: 'pending_checkout',
      index: true,
    },
    stripeCustomerId: { type: String, default: '', index: true },
    stripeSubscriptionId: { type: String, default: '' },
    stripeSubscriptionScheduleId: { type: String, default: '', index: true },
    stripeCheckoutSessionId: { type: String, default: '' },
    stripePriceId: { type: String, default: '' },
    stripeProductId: { type: String, default: '' },
    stripeSubscriptionStatus: { type: String, default: '' },
    stripeScheduleStatus: { type: String, default: '' },
    subscriptionStartDate: { type: Date, default: null },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    nextPaymentDate: { type: Date, default: null },
    subscriptionEndDate: { type: Date, default: null },
    cancelAt: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    listingDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },
    baseAmount: { type: Number, default: 0, min: 0 },
    effectiveRecurringAmount: { type: Number, default: 0, min: 0 },
    addonAmount: { type: Number, default: 0, min: 0 },
    totalInitialAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
    selectedAddons: {
      type: [subscriptionAddonSchema],
      default: [],
    },
    latestInvoiceId: { type: String, default: '' },
    latestPaymentIntentId: { type: String, default: '' },
    lastPaymentFailureAt: { type: Date, default: null },
    lastPaymentFailureReason: { type: String, default: '' },
    metadata: {
      type: Map,
      of: String,
      default: {},
    },
  },
  { timestamps: true }
);

const ACTIVE_LOCAL_SUBSCRIPTION_STATUSES = [
  'pending_checkout',
  'incomplete',
  'trialing',
  'active',
  'past_due',
  'payment_failed',
  'requires_action',
  'unpaid',
  'paused',
];

subscriptionSchema.index(
  { stripeSubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeSubscriptionId: { $type: 'string', $gt: '' } },
  }
);

subscriptionSchema.index(
  { stripeCheckoutSessionId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeCheckoutSessionId: { $type: 'string', $gt: '' } },
  }
);

subscriptionSchema.index(
  { supplier: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ACTIVE_LOCAL_SUBSCRIPTION_STATUSES },
    },
  }
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
