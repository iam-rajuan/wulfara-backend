const express = require('express');
const {
  getSuppliers,
  getSupplier,
  createSupplierProfile,
  updateSupplierProfile,
  deleteSupplierProfile,
  getUploadUrl,
  getSupplierDashboard,
  reviewSupplier,
  updateSupplierVerification,
  featureSupplier,
  getOnboardingStatus,
  saveOnboardingIndustry,
  saveOnboardingCompanyInfo,
  saveOnboardingSubscription,
  createAdminAssistedSupplier
} = require('./supplier.controller');

const router = express.Router();

const { protect, authorize, authorizeAdminPermissions, authorizePermissions, protectOptional } = require('../../middlewares/auth');

router.get('/dashboard', protect, authorize('supplier', 'admin'), getSupplierDashboard);
router.post('/upload-url', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.manage'), getUploadUrl);
router.get('/onboarding', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.read'), getOnboardingStatus);
router.put('/onboarding/industry', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.manage'), saveOnboardingIndustry);
router.put('/onboarding/company-info', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.manage'), saveOnboardingCompanyInfo);
router.put('/onboarding/subscription', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('subscriptions.manage'), saveOnboardingSubscription);
router.post('/admin-assisted', protect, authorize('admin'), authorizePermissions('suppliers.manage'), createAdminAssistedSupplier);

router.route('/')
  .get(protectOptional, getSuppliers)
  .post(protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.manage'), createSupplierProfile);

router.route('/:id')
  .get(protectOptional, getSupplier) // Public (but checks approval inside)
  .put(protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.manage'), updateSupplierProfile)
  .delete(protect, authorize('supplier', 'admin'), authorizeAdminPermissions('suppliers.manage'), deleteSupplierProfile);

// Admin controls
router.put('/:id/review', protect, authorize('admin'), authorizePermissions('listings.manage'), reviewSupplier);
router.put('/:id/verification', protect, authorize('admin'), authorizePermissions('listings.manage'), updateSupplierVerification);
router.put('/:id/feature', protect, authorize('admin'), authorizePermissions('listings.manage'), featureSupplier);

module.exports = router;
