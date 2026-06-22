const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Please add a banner title']
  },
  imageUrl: {
    type: String,
    required: [true, 'Please add a banner image URL']
  },
  linkTarget: {
    type: String
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('Banner', bannerSchema);
