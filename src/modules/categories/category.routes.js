const express = require('express');
const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  getUploadUrl
} = require('./category.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.route('/upload-url')
  .post(protect, authorize('admin'), getUploadUrl);

router.route('/')
  .get(getCategories)
  .post(protect, authorize('admin'), createCategory);

router.route('/:id')
  .get(getCategory)
  .put(protect, authorize('admin'), updateCategory)
  .delete(protect, authorize('admin'), deleteCategory);

module.exports = router;
