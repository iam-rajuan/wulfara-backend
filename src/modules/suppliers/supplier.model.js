const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true,
    unique: true // A user can only have one supplier profile
  },
  companyName: {
    type: String,
    required: [true, 'Please add a company name'],
    trim: true,
    maxlength: [100, 'Company name can not be more than 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Please add a company description'],
    maxlength: [1000, 'Description can not be more than 1000 characters']
  },
  contactEmail: {
    type: String,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
      'Please add a valid email'
    ]
  },
  contactPhone: {
    type: String,
    maxlength: [20, 'Phone number can not be longer than 20 characters']
  },
  website: {
    type: String,
    match: [
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/,
      'Please use a valid URL with HTTP or HTTPS'
    ]
  },
  categories: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Category'
  }],
  products: [{
    name: { type: String, required: true },
    description: String,
    price: Number
  }],
  logo: {
    type: String,
    default: 'no-logo.jpg'
  },
  gallery: {
    type: [String],
    default: []
  },
  isApproved: {
    type: Boolean,
    default: false // Requires admin approval to be listed
  },
  subscriptionPlan: {
    type: String,
    enum: ['free', 'premium'],
    default: 'free'
  },
  stripeCustomerId: {
    type: String
  }
}, { timestamps: true });

module.exports = mongoose.model('Supplier', supplierSchema);
