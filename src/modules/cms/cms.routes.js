const express = require('express');
const {
  getBanners,
  createBanner,
  updateBanner,
  deleteBanner,
  getPages,
  createPage,
  updatePage,
  deletePage
} = require('./cms.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

router.route('/banners')
  .get(getBanners)
  .post(protect, authorize('admin'), createBanner);

router.route('/banners/:id')
  .put(protect, authorize('admin'), updateBanner)
  .delete(protect, authorize('admin'), deleteBanner);

router.route('/pages')
  .get(getPages)
  .post(protect, authorize('admin'), createPage);

router.route('/pages/:id')
  .put(protect, authorize('admin'), updatePage)
  .delete(protect, authorize('admin'), deletePage);

module.exports = router;
