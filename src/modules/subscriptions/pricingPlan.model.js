const mongoose = require('mongoose');
const { PLAN_TIERS, inferPlanTier } = require('./planTier');

const buildDefaultListingPeriods = () => ([
  { durationMonths: 12, isActive: true, discountPercent: 0, customLabel: '' },
  { durationMonths: 24, isActive: true, discountPercent: 15, customLabel: '' },
  { durationMonths: 48, isActive: true, discountPercent: 25, customLabel: '' },
]);

const PLAN_ICON_KEYS = ['award', 'shield', 'diamond', 'rocket', 'star', 'bolt'];

const listingPeriodSchema = new mongoose.Schema(
  {
    durationMonths: {
      type: Number,
      required: [true, 'Please add a listing duration in months'],
      min: [1, 'Duration must be greater than 0'],
      validate: {
        validator: Number.isInteger,
        message: 'Duration must be an integer',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    discountPercent: {
      type: Number,
      default: 0,
      min: [0, 'Discount can not be negative'],
      max: [100, 'Discount can not be more than 100'],
    },
    customLabel: {
      type: String,
      default: '',
      trim: true,
      maxlength: [120, 'Custom label can not be more than 120 characters'],
    },
  },
  { _id: false }
);

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
  iconKey: {
    type: String,
    enum: PLAN_ICON_KEYS,
    default: 'award',
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
  listingPeriods: {
    type: [listingPeriodSchema],
    default: buildDefaultListingPeriods,
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
