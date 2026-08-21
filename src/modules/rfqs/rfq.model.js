const mongoose = require('mongoose');

const rfqSchema = new mongoose.Schema({
  supplier: {
    type: mongoose.Schema.ObjectId,
    ref: 'Supplier',
    required: [true, 'RFQ must be sent to a specific supplier']
  },
  buyerUser: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    default: null // Optional: for registered buyers
  },
  buyerName: {
    type: String,
    required: [true, 'Please provide your name']
  },
  buyerEmail: {
    type: String,
    required: [true, 'Please provide your email address'],
    match: [
      /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
      'Please add a valid email'
    ]
  },
  buyerPhone: {
    type: String
  },
  subject: {
    type: String,
    required: [true, 'Please provide a subject for your RFQ'],
    maxlength: 100
  },
  details: {
    type: String,
    required: [true, 'Please provide details for the quotation request'],
    maxlength: 2000
  },
  quantity: {
    type: Number,
    required: [true, 'Please specify the estimated quantity needed']
  },
  attachments: {
    type: [String],
    default: [] // S3 URLs for any attached documents
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'responded', 'closed', 'disputed', 'resolved'],
    default: 'pending'
  }
}, { timestamps: true });

module.exports = mongoose.model('Rfq', rfqSchema);
