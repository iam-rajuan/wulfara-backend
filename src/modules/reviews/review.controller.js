const Review = require('./review.model');
const Supplier = require('../suppliers/supplier.model');
const Rfq = require('../rfqs/rfq.model');

/**
 * @desc    Create new review
 * @route   POST /api/v1/reviews
 * @access  Private (Buyer)
 */
exports.createReview = async (req, res, next) => {
  try {
    const { supplierId, rfqId, rating, comment } = req.body;

    // Check if supplier exists
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Check if RFQ exists and belongs to the buyer
    const rfq = await Rfq.findById(rfqId);
    if (!rfq) {
      return res.status(404).json({ success: false, message: 'RFQ not found' });
    }

    // Ensure only the buyer of the RFQ can review
    if (rfq.buyerUser && rfq.buyerUser.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to review this RFQ' });
    }

    // Check if RFQ is completed/resolved
    if (rfq.status !== 'resolved' && rfq.status !== 'closed') {
      return res.status(400).json({ success: false, message: 'Can only review completed RFQs' });
    }

    // Create review
    const review = await Review.create({
      buyer: req.user.id,
      supplier: supplierId,
      rfq: rfqId,
      rating,
      comment
    });

    res.status(201).json({
      success: true,
      data: review
    });
  } catch (err) {
    // Check if duplicate review
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'You have already submitted a review for this RFQ' });
    }
    console.error('Error creating review:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};

/**
 * @desc    Get reviews for a supplier
 * @route   GET /api/v1/reviews/supplier/:supplierId
 * @access  Public
 */
exports.getSupplierReviews = async (req, res, next) => {
  try {
    const reviews = await Review.find({ supplier: req.params.supplierId })
      .populate('buyer', 'name avatar') // assuming buyer has name
      .sort('-createdAt');

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (err) {
    console.error('Error fetching reviews:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
};
