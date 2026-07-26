const Category = require('./category.model');
const { generatePresignedUrl } = require('../../utils/s3');
// @desc    Get all categories
// @route   GET /api/v1/categories
// @access  Public
exports.getCategories = async (req, res) => {
  try {
    const categories = await Category.find();
    res.status(200).json({ success: true, count: categories.length, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc    Get single category
// @route   GET /api/v1/categories/:id
// @access  Public
exports.getCategory = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    res.status(200).json({ success: true, data: category });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc    Create new category
// @route   POST /api/v1/categories
// @access  Private/Admin
exports.createCategory = async (req, res) => {
  try {
    const category = await Category.create(req.body);
    res.status(201).json({ success: true, data: category });
  } catch (error) {
    // Handle mongoose duplicate key error for name
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Duplicate field value entered' });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc    Update category
// @route   PUT /api/v1/categories/:id
// @access  Private/Admin
exports.updateCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    res.status(200).json({ success: true, data: category });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc    Delete category
// @route   DELETE /api/v1/categories/:id
// @access  Private/Admin
exports.deleteCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get pre-signed URL for S3 upload for categories
// @route   POST /api/v1/categories/upload-url
// @access  Private/Admin
exports.getUploadUrl = async (req, res) => {
  try {
    const { contentType } = req.body;
    
    // Ensure valid content type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!contentType || !allowedTypes.includes(contentType)) {
        return res.status(400).json({ success: false, message: 'Please provide a valid contentType (image/jpeg, image/png, image/webp)' });
    }
    
    const urlData = await generatePresignedUrl('categories', contentType);

    res.status(200).json({
      success: true,
      data: urlData
    });
  } catch (error) {
    console.error('S3 Presign Error:', error);
    res.status(500).json({ success: false, message: 'Error generating upload URL' });
  }
};
