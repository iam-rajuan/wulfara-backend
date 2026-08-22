const Favorite = require('./favorite.model');
const Supplier = require('../suppliers/supplier.model');

// @desc    Add supplier to favorites
// @route   POST /api/v1/favorites
// @access  Private (Buyer/User)
exports.addFavorite = async (req, res) => {
  try {
    const { supplierId } = req.body;

    // Verify supplier exists
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Check if already favorited
    const existingFavorite = await Favorite.findOne({ user: req.user.id, supplier: supplierId });
    if (existingFavorite) {
      return res.status(400).json({ success: false, message: 'Supplier is already in your favorites' });
    }

    const favorite = await Favorite.create({
      user: req.user.id,
      supplier: supplierId
    });

    res.status(201).json({ success: true, data: favorite });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all favorite suppliers for logged-in user
// @route   GET /api/v1/favorites
// @access  Private (Buyer/User)
exports.getFavorites = async (req, res) => {
  try {
    const favorites = await Favorite.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate({
      path: 'supplier',
      select: 'companyName description logo categories location user isApproved isVerified avgResponseTime supplierType averageRating totalReviews'
    });

    res.status(200).json({ success: true, count: favorites.length, data: favorites });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Remove supplier from favorites
// @route   DELETE /api/v1/favorites/:id
// @access  Private (Buyer/User)
exports.removeFavorite = async (req, res) => {
  try {
    const favorite = await Favorite.findById(req.params.id);

    if (!favorite) {
      return res.status(404).json({ success: false, message: 'Favorite not found' });
    }

    // Ensure user owns this favorite
    if (favorite.user.toString() !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Not authorized to remove this favorite' });
    }

    await favorite.deleteOne();

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
