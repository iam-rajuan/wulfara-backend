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
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

router.route('/upload-url')
  .post(protect, authorize('admin'), authorizePermissions('categories.manage'), getUploadUrl);

router.route('/')
  .get(getCategories)
  .post(protect, authorize('admin'), authorizePermissions('categories.manage'), createCategory);

router.route('/:id')
  .get(getCategory)
  .put(protect, authorize('admin'), authorizePermissions('categories.manage'), updateCategory)
  .delete(protect, authorize('admin'), authorizePermissions('categories.manage'), deleteCategory);

module.exports = router;
