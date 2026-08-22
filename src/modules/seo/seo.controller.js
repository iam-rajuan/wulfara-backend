const SeoSetting = require('./seo.model');
const { generatePresignedUrl } = require('../../utils/s3');
const Supplier = require('../suppliers/supplier.model');
const Review = require('../reviews/review.model');

// @desc    Get all SEO settings
// @route   GET /api/v1/seo
// @access  Public
exports.getSeoSettings = async (req, res) => {
  try {
    const settings = await SeoSetting.find();
    res.status(200).json({ success: true, count: settings.length, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get SEO settings for a specific path
// @route   GET /api/v1/seo/:path
// @access  Public
exports.getSeoByPath = async (req, res) => {
  try {
    // Need to handle paths that contain slashes by encoding/decoding or querying via query params.
    // For simplicity, we assume path is passed as a route param but encoded.
    const decodedPath = decodeURIComponent(req.params.path);
    const setting = await SeoSetting.findOne({ path: decodedPath });
    
    if (!setting) {
      return res.status(404).json({ success: false, message: 'SEO setting not found for this path' });
    }
    
    res.status(200).json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create or update SEO settings for a path
// @route   PUT /api/v1/seo
// @access  Private (Admin only)
exports.updateSeoSettings = async (req, res) => {
  try {
    const { path, title, description, keywords, ogImage } = req.body;

    if (!path) {
      return res.status(400).json({ success: false, message: 'Please provide a path' });
    }

    let setting = await SeoSetting.findOne({ path });

    if (setting) {
      // Update existing
      setting = await SeoSetting.findOneAndUpdate(
        { path },
        { title, description, keywords, ogImage },
        { new: true, runValidators: true }
      );
    } else {
      // Create new
      setting = await SeoSetting.create({
        path,
        title,
        description,
        keywords,
        ogImage
      });
    }

    res.status(200).json({ success: true, data: setting });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get SEO summary metrics for admin preview
// @route   GET /api/v1/seo/summary
// @access  Private (Admin only)
exports.getSeoSummary = async (req, res) => {
  try {
    const [supplierCount, reviewCount, supplierRatings] = await Promise.all([
      Supplier.countDocuments({
        isApproved: true,
        listingStatus: 'Approved',
      }),
      Review.countDocuments(),
      Supplier.find({
        isApproved: true,
        listingStatus: 'Approved',
        totalReviews: { $gt: 0 },
      }).select('averageRating'),
    ]);

    const averageRating = supplierRatings.length > 0
      ? Math.round(
          (supplierRatings.reduce((sum, supplier) => sum + Number(supplier.averageRating || 0), 0) /
            supplierRatings.length) *
            10
        ) / 10
      : 0;

    res.status(200).json({
      success: true,
      data: {
        supplierCount,
        reviewCount,
        averageRating,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get pre-signed URL for SEO image upload
// @route   POST /api/v1/seo/upload-url
// @access  Private (Admin only)
exports.getUploadUrl = async (req, res) => {
  try {
    const { contentType } = req.body;

    if (!contentType) {
      return res.status(400).json({ success: false, message: 'Content type is required' });
    }

    const urlData = await generatePresignedUrl('seo', contentType);
    res.status(200).json({ success: true, data: urlData });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
