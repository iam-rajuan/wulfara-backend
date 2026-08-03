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
  coreProducts: [{
    type: String
  }],
  certifications: [{
    type: String
  }],
  serviceAreas: [{
    type: String
  }],
  moq: {
    value: String,
    unit: String
  },
  businessHours: {
    weekdays: { start: String, end: String },
    weekends: String
  },
  shippingOptions: {
    fob: Boolean,
    cif: Boolean,
    exw: Boolean
  },
  categories: [{
    type: mongoose.Schema.ObjectId,
    ref: 'Category'
  }],
  products: [{
    title: { type: String, required: true },
    description: String,
    category: String,
    moq: String,
    priceVis: String,
    status: { type: String, enum: ['Published', 'Draft'], default: 'Draft' },
    image: String
  }],
  logo: {
    type: String,
    default: 'no-logo.jpg'
  },
  gallery: [{
    title: String,
    type: { type: String }, // 'Product Images', 'Factory Images', 'Certificates'
    isPdf: Boolean,
    isPrimary: Boolean,
    size: String,
    url: String
  }],
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0] // [longitude, latitude]
    },
    formattedAddress: String
  },
  supplierType: {
    type: String,
    enum: ['Manufacturer', 'Distributor', 'Wholesaler', 'Broker', 'Service Provider'],
    default: 'Manufacturer'
  },
  avgResponseTime: {
    type: String,
    default: '~24 Hours'
  },
  isApproved: {
    type: Boolean,
    default: false // Requires admin approval to be listed
  },
  listingStatus: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending'
  },
  subscriptionPlan: {
    type: String,
    enum: ['free', 'premium'],
    default: 'free'
  },
  stripeCustomerId: {
    type: String
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  averageRating: {
    type: Number,
    min: [1, 'Rating must be at least 1'],
    max: [5, 'Rating must can not be more than 5'],
    default: 0
  },
  totalReviews: {
    type: Number,
    default: 0
  },
  monthlyViews: {
    type: Map,
    of: Number,
    default: {}
  }
}, { timestamps: true });

// Add 2dsphere index for geospatial queries
supplierSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Supplier', supplierSchema);
