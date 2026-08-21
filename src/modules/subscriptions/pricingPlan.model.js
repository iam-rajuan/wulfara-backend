const mongoose = require('mongoose');
const { PLAN_TIERS, inferPlanTier } = require('./planTier');

const pricingPlanSchema = new mongoose.Schema({
  internalName: {
    type: String,
    required: [true, 'Please add an internal plan name']
  },
  name: {
    type: String,
    required: [true, 'Please add a display plan name']
  },
  slug: {
    type: String,
    required: [true, 'Please add a slug'],
    unique: true
  },
  description: {
    type: String,
    default: ''
  },
  badgeText: {
    type: String,
    default: ''
  },
  accentColor: {
    type: String,
    default: '#D4AF37'
  },
  price: {
    type: Number,
    required: [true, 'Please add a price']
  },
  billingCycle: {
    type: String,
    default: 'Annual (Paid Upfront)'
  },
  tier: {
    type: String,
    enum: PLAN_TIERS,
    default: 'premium',
  },
  taxCategory: {
    type: String,
    default: 'Standard Digital Service'
  },
  allowCoupons: {
    type: Boolean,
    default: true
  },
  autoRenewal: {
    type: Boolean,
    default: true
  },
  features: {
    type: [String],
    default: []
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

pricingPlanSchema.pre('validate', function setDefaultTier() {
  this.tier = inferPlanTier(this);
});

module.exports = mongoose.model('PricingPlan', pricingPlanSchema);
