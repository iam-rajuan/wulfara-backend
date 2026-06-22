const express = require('express');
const {
  createCheckoutSession,
  simulateWebhook
} = require('./subscription.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.post('/checkout-session', protect, authorize('supplier', 'admin'), createCheckoutSession);
router.get('/simulate-payment', simulateWebhook);

module.exports = router;
