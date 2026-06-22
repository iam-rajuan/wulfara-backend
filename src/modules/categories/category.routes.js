const express = require('express');
const {
  getCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory
} = require('./category.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.route('/')
  .get(getCategories)
  .post(protect, authorize('admin'), createCategory);

router.route('/:id')
  .get(getCategory)
  .put(protect, authorize('admin'), updateCategory)
  .delete(protect, authorize('admin'), deleteCategory);

module.exports = router;
