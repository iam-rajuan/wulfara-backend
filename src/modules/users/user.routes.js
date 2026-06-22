const express = require('express');
const {
  getUsers,
  getUser,
  updateUser,
  deleteUser,
  getMe
} = require('./user.controller');

const router = express.Router();
const { protect, authorize } = require('../../middlewares/auth');

// Protect all routes below
router.use(protect);

router.get('/me', getMe);

// Admin only routes below
router.use(authorize('admin'));
router.route('/')
  .get(getUsers);

router.route('/:id')
  .get(getUser)
  .put(updateUser)
  .delete(deleteUser);

module.exports = router;
