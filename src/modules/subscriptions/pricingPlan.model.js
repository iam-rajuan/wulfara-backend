const mongoose = require('mongoose');

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

module.exports = mongoose.model('PricingPlan', pricingPlanSchema);
