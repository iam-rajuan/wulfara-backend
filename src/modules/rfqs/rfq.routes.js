const express = require('express');
const {
  createRfq,
  getSupplierRfqs,
  updateRfqStatus,
  getBuyerRfqs,
  addMessageToRfq,
  getRfqMessages,
  getGlobalRfqs
} = require('./rfq.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.post('/', createRfq);
router.get('/', protect, authorize('admin'), getGlobalRfqs);

// Buyer protected routes
router.get('/buyer', protect, getBuyerRfqs);

// Messaging routes
router.route('/:id/messages')
  .post(protect, addMessageToRfq)
  .get(protect, getRfqMessages);

// Supplier protected routes
router.get('/supplier', protect, authorize('supplier', 'admin'), getSupplierRfqs);
router.put('/:id/status', protect, authorize('supplier', 'admin'), updateRfqStatus);

module.exports = router;
