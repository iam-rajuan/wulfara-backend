const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please add a page title']
  },
  slug: {
    type: String,
    required: [true, 'Please add a slug'],
    unique: true
  },
  htmlContent: {
    type: String,
    required: [true, 'Please add HTML content']
  },
  seoMetaDescription: {
    type: String
  }
}, { timestamps: true });

module.exports = mongoose.model('Page', pageSchema);
