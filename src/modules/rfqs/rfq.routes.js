const express = require('express');
const {
  createRfq,
  getSupplierRfqs,
  updateRfqStatus
} = require('./rfq.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

// Optional auth middleware for createRfq to capture logged-in users, 
// but we'll let the controller handle it directly using req.headers later if needed.
// For now, we will leave createRfq as strictly public (no token required).
router.post('/', createRfq);

// Supplier protected routes
router.get('/supplier', protect, authorize('supplier', 'admin'), getSupplierRfqs);
router.put('/:id/status', protect, authorize('supplier', 'admin'), updateRfqStatus);

module.exports = router;
