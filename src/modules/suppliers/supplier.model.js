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
      /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
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
  establishedYear: {
    type: String,
  },
  employeeCount: {
    type: String,
  },
  annualTurnover: {
    type: String,
  },
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
    url: String,
    uploadedAt: {
      type: Date,
      default: Date.now
    },
    reviewStatus: {
      type: String,
      enum: ['Pending Review', 'Approved', 'Rejected'],
      default: 'Pending Review'
    },
    reviewedAt: {
      type: Date,
      default: null
    },
    reviewedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      default: null
    },
    reviewNote: {
      type: String,
      maxlength: [500, 'Review note can not be more than 500 characters'],
      default: ''
    }
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
    enum: ['Pending', 'Approved', 'Rejected', 'Hidden', 'Suspended'],
    default: 'Pending'
  },
  subscriptionPlan: {
    type: String,
    enum: ['free', 'basic', 'pro', 'premium'],
    default: 'free'
  },
  selectedPlan: {
    type: mongoose.Schema.ObjectId,
    ref: 'PricingPlan',
    default: null
  },
  selectedBillingCycle: {
    type: String,
    default: ''
  },
  selectedListingPeriod: {
    type: String,
    default: ''
  },
  selectedAddons: {
    type: [String],
    default: []
  },
  subscriptionStatus: {
    type: String,
    enum: ['inactive', 'pending', 'active', 'cancelled', 'failed'],
    default: 'inactive'
  },
  paymentStatus: {
    type: String,
    enum: ['unpaid', 'pending', 'paid', 'failed', 'cancelled'],
    default: 'unpaid'
  },
  onboardingStep: {
    type: String,
    enum: ['industry', 'company-info', 'subscription', 'payment', 'listed'],
    default: 'industry'
  },
  onboardingCompletedAt: {
    type: Date,
    default: null
  },
  stripeCustomerId: {
    type: String
  },
  featuredHeroPlacement: {
    enabled: {
      type: Boolean,
      default: false
    },
    activatedAt: {
      type: Date,
      default: null
    }
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  averageRating: {
    type: Number,
    min: [0, 'Rating must be at least 0'],
    max: [5, 'Rating must can not be more than 5'],
    default: 0
  },
  totalReviews: {
    type: Number,
    default: 0
  },
  verificationChecklist: {
    identity: {
      type: Boolean,
      default: false
    },
    business: {
      type: Boolean,
      default: false
    },
    tax: {
      type: Boolean,
      default: false
    },
    updatedAt: {
      type: Date,
      default: null
    },
    updatedBy: {
      type: mongoose.Schema.ObjectId,
      ref: 'User',
      default: null
    }
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
