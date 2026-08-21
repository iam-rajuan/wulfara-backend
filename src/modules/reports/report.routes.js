const express = require('express');
const { getDashboard } = require('./report.controller');

const router = express.Router();
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

router.get('/dashboard', protect, authorize('admin'), authorizePermissions('dashboard.view'), getDashboard);

module.exports = router;
