const express = require('express');
const {
  getSeoSettings,
  getSeoSummary,
  getSeoByPath,
  updateSeoSettings,
  getUploadUrl
} = require('./seo.controller');

const router = express.Router();
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

router.route('/')
  .get(getSeoSettings)
  .put(protect, authorize('admin'), authorizePermissions('seo.manage'), updateSeoSettings);

router.get('/summary', protect, authorize('admin'), authorizePermissions('seo.manage'), getSeoSummary);
router.post('/upload-url', protect, authorize('admin'), authorizePermissions('seo.manage'), getUploadUrl);

// NOTE: This must be below the '/' routes to avoid conflicting if we add other static routes.
// We expect the path to be URL encoded (e.g. %2F for /)
router.get('/:path', getSeoByPath);

module.exports = router;
