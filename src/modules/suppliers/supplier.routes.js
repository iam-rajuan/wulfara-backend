const express = require('express');
const {
  getSuppliers,
  getSupplier,
  createSupplierProfile,
  updateSupplierProfile,
  deleteSupplierProfile,
  getUploadUrl
} = require('./supplier.controller');

const router = express.Router();

const { protect, authorize } = require('../../middlewares/auth');

router.post('/upload-url', protect, authorize('supplier', 'admin'), getUploadUrl);

router.route('/')
  .get(getSuppliers)
  .post(protect, authorize('supplier', 'admin'), createSupplierProfile);

router.route('/:id')
  .get(getSupplier) // Public (but checks approval inside)
  .put(protect, authorize('supplier', 'admin'), updateSupplierProfile)
  .delete(protect, authorize('supplier', 'admin'), deleteSupplierProfile);

module.exports = router;
