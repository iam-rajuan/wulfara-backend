const mongoose = require('mongoose');

const favoriteSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  supplier: {
    type: mongoose.Schema.ObjectId,
    ref: 'Supplier',
    required: true
  }
}, { timestamps: true });

// Prevent a user from favoriting the same supplier twice
favoriteSchema.index({ user: 1, supplier: 1 }, { unique: true });

module.exports = mongoose.model('Favorite', favoriteSchema);
