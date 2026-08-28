const express = require('express');
const {
  createCheckoutSession,
  getInvoices,
  getPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  getAllPayments,
  getActiveSubscriptions,
  getAdminSubscriptionOverview,
  getAdminPlans,
  getAdminPlan,
} = require('./subscription.controller');

const router = express.Router();
const { protect, authorize, authorizeAdminPermissions, authorizePermissions } = require('../../middlewares/auth');

router.post('/checkout-session', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('subscriptions.manage'), createCheckoutSession);
router.get('/invoices', protect, authorize('supplier', 'admin'), authorizeAdminPermissions('subscriptions.read'), getInvoices);

// Pricing Plan Routes
router.route('/plans')
  .get(getPlans)
  .post(protect, authorize('admin'), authorizePermissions('subscriptions.manage'), createPlan);

router.route('/plans/:id')
  .get(getPlan)
  .put(protect, authorize('admin'), authorizePermissions('subscriptions.manage'), updatePlan)
  .delete(protect, authorize('admin'), authorizePermissions('subscriptions.manage'), deletePlan);

// Admin Payments Route
router.get('/admin/payments', protect, authorize('admin'), authorizePermissions('revenue.view'), getAllPayments);
router.get('/admin/active', protect, authorize('admin'), authorizePermissions('subscriptions.read'), getActiveSubscriptions);
router.get('/admin/overview', protect, authorize('admin'), authorizePermissions('subscriptions.read'), getAdminSubscriptionOverview);
router.get('/admin/plans', protect, authorize('admin'), authorizePermissions('subscriptions.manage'), getAdminPlans);
router.get('/admin/plans/:id', protect, authorize('admin'), authorizePermissions('subscriptions.manage'), getAdminPlan);

module.exports = router;
