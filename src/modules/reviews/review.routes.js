const express = require('express');
const { createReview, getSupplierReviews } = require('./review.controller');
const { protect, authorize } = require('../../middlewares/auth');

const router = express.Router();

router.post('/', protect, authorize('buyer'), createReview);
router.get('/supplier/:supplierId', getSupplierReviews);

module.exports = router;
