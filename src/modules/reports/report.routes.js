const express = require('express');
const { getDashboard, exportDashboard } = require('./report.controller');

const router = express.Router();
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

router.get('/dashboard', protect, authorize('admin'), authorizePermissions('dashboard.view'), getDashboard);
router.get('/dashboard/export', protect, authorize('admin'), authorizePermissions('dashboard.view'), exportDashboard);

module.exports = router;
