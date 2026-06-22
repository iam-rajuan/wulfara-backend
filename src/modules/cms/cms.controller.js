const Banner = require('./banner.model');
const Page = require('./page.model');

// @desc    Get all banners
// @route   GET /api/v1/cms/banners
// @access  Public
exports.getBanners = async (req, res) => {
  try {
    const banners = await Banner.find({ isActive: true });
    res.status(200).json({ success: true, count: banners.length, data: banners });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a banner
// @route   POST /api/v1/cms/banners
// @access  Private (Admin only)
exports.createBanner = async (req, res) => {
  try {
    const banner = await Banner.create(req.body);
    res.status(201).json({ success: true, data: banner });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all static pages
// @route   GET /api/v1/cms/pages
// @access  Public
exports.getPages = async (req, res) => {
  try {
    const pages = await Page.find();
    res.status(200).json({ success: true, count: pages.length, data: pages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a static page
// @route   POST /api/v1/cms/pages
// @access  Private (Admin only)
exports.createPage = async (req, res) => {
  try {
    const page = await Page.create(req.body);
    res.status(201).json({ success: true, data: page });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
