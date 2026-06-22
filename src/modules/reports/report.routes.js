const express = require('express');
const { getDashboard } = require('./report.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.get('/dashboard', protect, authorize('admin'), getDashboard);

module.exports = router;
