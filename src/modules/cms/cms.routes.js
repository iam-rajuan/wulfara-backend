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
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

router.route('/banners')
  .get(getBanners)
  .post(protect, authorize('admin'), authorizePermissions('content.manage'), createBanner);

router.route('/banners/:id')
  .put(protect, authorize('admin'), authorizePermissions('content.manage'), updateBanner)
  .delete(protect, authorize('admin'), authorizePermissions('content.manage'), deleteBanner);

router.route('/pages')
  .get(getPages)
  .post(protect, authorize('admin'), authorizePermissions('content.manage'), createPage);

router.route('/pages/:id')
  .put(protect, authorize('admin'), authorizePermissions('content.manage'), updatePage)
  .delete(protect, authorize('admin'), authorizePermissions('content.manage'), deletePage);

module.exports = router;
