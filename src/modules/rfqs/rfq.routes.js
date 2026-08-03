const express = require('express');
const {
  createRfq,
  getSupplierRfqs,
  updateRfqStatus,
  getBuyerRfqs,
  addMessageToRfq,
  getRfqMessages,
  getGlobalRfqs,
  getRfqById,
  getUploadUrl,
  getRfqStats
} = require('./rfq.controller');

const router = express.Router();
const { protect, authorize, protectOptional } = require('../../middlewares/auth');

router.post('/', protectOptional, createRfq);
router.post('/upload-url', protect, getUploadUrl);
router.get('/', protect, authorize('admin'), getGlobalRfqs);

// Buyer protected routes
router.get('/buyer', protect, getBuyerRfqs);

// Supplier protected routes
router.get('/supplier', protect, authorize('supplier', 'admin'), getSupplierRfqs);

// Admin stats route (Must come BEFORE ID-based routes)
router.get('/stats', protect, authorize('admin'), getRfqStats);

// ID-based routes (Must come AFTER specific string routes)
router.get('/:id', protect, getRfqById);
router.put('/:id/status', protect, authorize('supplier', 'admin'), updateRfqStatus);

// Messaging routes
router.route('/:id/messages')
  .post(protect, addMessageToRfq)
  .get(protect, getRfqMessages);

module.exports = router;
