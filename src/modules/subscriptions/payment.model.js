const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  supplier: {
    type: mongoose.Schema.ObjectId,
    ref: 'Supplier',
    required: true
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
