const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  buyer: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: [true, 'A review must belong to a buyer']
  },
  supplier: {
    type: mongoose.Schema.ObjectId,
    ref: 'Supplier',
    required: [true, 'A review must belong to a supplier']
  },
  rfq: {
    type: mongoose.Schema.ObjectId,
    ref: 'Rfq',
    required: [true, 'A review must be associated with an RFQ']
  },
  rating: {
    type: Number,
    required: [true, 'Please add a rating between 1 and 5'],
    min: 1,
    max: 5
  },
  comment: {
    type: String,
    required: [true, 'Please add a comment'],
    maxlength: 1000
  }
}, { timestamps: true });

// Prevent user from submitting more than one review per RFQ
reviewSchema.index({ rfq: 1, buyer: 1 }, { unique: true });

// Static method to calculate average rating
reviewSchema.statics.calcAverageRating = async function(supplierId) {
  const obj = await this.aggregate([
    {
      $match: { supplier: supplierId }
    },
    {
      $group: {
        _id: '$supplier',
        averageRating: { $avg: '$rating' },
        totalReviews: { $sum: 1 }
      }
    }
  ]);

  try {
    if (obj.length > 0) {
      await this.model('Supplier').findByIdAndUpdate(supplierId, {
        averageRating: Math.round(obj[0].averageRating * 10) / 10, // Round to 1 decimal place
        totalReviews: obj[0].totalReviews
      });
    } else {
      await this.model('Supplier').findByIdAndUpdate(supplierId, {
        averageRating: 0,
        totalReviews: 0
      });
    }
  } catch (err) {
    console.error(err);
  }
};

// Call calcAverageRating after save
reviewSchema.post('save', function() {
  this.constructor.calcAverageRating(this.supplier);
});

// Call calcAverageRating after remove
reviewSchema.post('remove', function() {
  this.constructor.calcAverageRating(this.supplier);
});

module.exports = mongoose.model('Review', reviewSchema);
