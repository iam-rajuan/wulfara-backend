const express = require('express');
const {
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  clearAllNotifications,
} = require('./notification.controller');
const { protect } = require('../../middlewares/auth');

const router = express.Router();

// Protect all notification routes
router.use(protect);

router.route('/')
  .get(getUserNotifications);

router.route('/read-all')
  .patch(markAllAsRead);

router.route('/clear-all')
  .delete(clearAllNotifications);

router.route('/:id/read')
  .patch(markAsRead);

module.exports = router;
