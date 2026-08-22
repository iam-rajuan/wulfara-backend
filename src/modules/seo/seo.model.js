const mongoose = require('mongoose');

const seoSchema = new mongoose.Schema({
  path: {
    type: String,
    required: [true, 'Please specify the path (e.g. / or /suppliers)'],
    unique: true
  },
  title: {
    type: String,
    required: [true, 'Please add a meta title']
  },
  description: {
    type: String,
    required: [true, 'Please add a meta description']
  },
  keywords: {
    type: [String],
    default: []
  },
  ogImage: {
    type: String,
    default: ''
  },
  indexEnabled: {
    type: Boolean,
    default: true
  },
  followOutbound: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('SeoSetting', seoSchema);
