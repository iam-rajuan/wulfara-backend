const mongoose = require('mongoose');

const pricingPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a plan name']
  },
  price: {
    type: Number,
    required: [true, 'Please add a price']
  },
  features: {
    type: [String],
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('PricingPlan', pricingPlanSchema);
