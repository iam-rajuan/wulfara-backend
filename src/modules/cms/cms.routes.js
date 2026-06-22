const express = require('express');
const {
  getBanners,
  createBanner,
  getPages,
  createPage
} = require('./cms.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.route('/banners')
  .get(getBanners)
  .post(protect, authorize('admin'), createBanner);

router.route('/pages')
  .get(getPages)
  .post(protect, authorize('admin'), createPage);

module.exports = router;
