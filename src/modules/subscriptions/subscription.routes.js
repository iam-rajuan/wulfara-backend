const express = require('express');
const {
  createCheckoutSession,
  getInvoices,
  getPlans,
  getPlan,
  createPlan,
  updatePlan
} = require('./subscription.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.post('/checkout-session', protect, authorize('supplier', 'admin'), createCheckoutSession);
router.get('/invoices', protect, authorize('supplier', 'admin'), getInvoices);

// Pricing Plan Routes
router.route('/plans')
  .get(getPlans)
  .post(protect, authorize('admin'), createPlan);

router.route('/plans/:id')
  .get(getPlan)
  .put(protect, authorize('admin'), updatePlan);

module.exports = router;
