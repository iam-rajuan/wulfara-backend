const mongoose = require('mongoose');
const slugify = require('slugify');

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a category name'],
    unique: true,
    trim: true,
    maxlength: [50, 'Name can not be more than 50 characters']
  },
  slug: String,
  description: {
    type: String,
    required: [true, 'Please add a description'],
    maxlength: [500, 'Description can not be more than 500 characters']
  },
  icon: {
    type: String,
    default: 'no-icon.png'
  },
  banner: {
    type: String,
    default: 'no-banner.jpg'
  },
  displayOrder: {
    type: Number,
    default: 1
  },
  parentCategory: {
    type: mongoose.Schema.ObjectId,
    ref: 'Category',
    default: null
  },
  status: {
    type: String,
    enum: ['Active', 'Hidden', 'Draft'],
    default: 'Active'
  }
}, { timestamps: true });

// Create category slug from the name
categorySchema.pre('save', function() {
  this.slug = slugify(this.name, { lower: true });
});

module.exports = mongoose.model('Category', categorySchema);
