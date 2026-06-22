const express = require('express');
const {
  getSuppliers,
  getSupplier,
  createSupplierProfile,
  updateSupplierProfile,
  deleteSupplierProfile,
  getUploadUrl,
  getSupplierDashboard,
  approveSupplier,
  featureSupplier
} = require('./supplier.controller');

const router = express.Router();

const { protect, authorize } = require('../../middlewares/auth');

router.get('/dashboard', protect, authorize('supplier', 'admin'), getSupplierDashboard);
router.post('/upload-url', protect, authorize('supplier', 'admin'), getUploadUrl);

router.route('/')
  .get(getSuppliers)
  .post(protect, authorize('supplier', 'admin'), createSupplierProfile);

router.route('/:id')
  .get(getSupplier) // Public (but checks approval inside)
  .put(protect, authorize('supplier', 'admin'), updateSupplierProfile)
  .delete(protect, authorize('supplier', 'admin'), deleteSupplierProfile);

// Admin controls
router.put('/:id/approve', protect, authorize('admin'), approveSupplier);
router.put('/:id/feature', protect, authorize('admin'), featureSupplier);

module.exports = router;
