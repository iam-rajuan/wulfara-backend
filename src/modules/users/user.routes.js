const express = require('express');
const {
  getUsers,
  createUser,
  getUser,
  updateUser,
  deleteUser,
  getMe,
  updateMe,
  getUploadUrl
} = require('./user.controller');

const router = express.Router();
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

// Protect all routes below
router.use(protect);

router.route('/me')
  .get(getMe)
  .put(updateMe);

router.post('/upload-url', getUploadUrl);

// Admin only routes below
router.use(authorize('admin'));
router.route('/')
  .get(authorizePermissions('users.read'), getUsers)
  .post(authorizePermissions('users.manage'), createUser);

router.route('/:id')
  .get(authorizePermissions('users.read'), getUser)
  .put(authorizePermissions('users.manage'), updateUser)
  .delete(authorizePermissions('users.manage'), deleteUser);

module.exports = router;
