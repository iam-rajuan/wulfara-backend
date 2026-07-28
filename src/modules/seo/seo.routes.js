const express = require('express');
const {
  getSeoSettings,
  getSeoByPath,
  updateSeoSettings
} = require('./seo.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.route('/')
  .get(getSeoSettings)
  .put(protect, authorize('admin'), updateSeoSettings);

// NOTE: This must be below the '/' routes to avoid conflicting if we add other static routes.
// We expect the path to be URL encoded (e.g. %2F for /)
router.get('/:path', getSeoByPath);

module.exports = router;
