const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  supplier: {
    type: mongoose.Schema.ObjectId,
    ref: 'Supplier',
    required: true
  },
  stripeSessionId: {
    type: String,
    unique: true,
    sparse: true
  },
  plan: {
    type: mongoose.Schema.ObjectId,
    ref: 'PricingPlan',
    default: null
  },
  planName: {
    type: String,
    default: ''
  },
  billingCycle: {
    type: String,
    default: ''
  },
  listingPeriod: {
    type: String,
    default: ''
  },
  listingDiscountPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  addons: {
    type: [{
      code: { type: String, required: true },
      name: { type: String, required: true },
      amount: { type: Number, required: true, min: 0 },
    }],
    default: []
  },
  baseAmount: {
    type: Number,
    default: 0
  },
  addonAmount: {
    type: Number,
    default: 0
  },
  amount: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['paid', 'pending', 'failed'],
    default: 'paid'
  },
  invoiceUrl: {
    type: String
  }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
