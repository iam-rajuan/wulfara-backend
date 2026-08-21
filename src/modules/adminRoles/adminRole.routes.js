const express = require('express');
const {
  assignAdminRoleToUser,
  createAdminRole,
  deleteAdminRole,
  getAdminRoles,
  getAdminUsers,
  getPermissionCatalog,
  updateAdminRole,
} = require('./adminRole.controller');
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

const router = express.Router();

router.use(protect);
router.use(authorize('admin'));
router.use(authorizePermissions('roles.manage'));

router.get('/catalog', getPermissionCatalog);
router.get('/admin-users', getAdminUsers);
router.patch('/admin-users/:userId', assignAdminRoleToUser);

router.route('/')
  .get(getAdminRoles)
  .post(createAdminRole);

router.route('/:id')
  .put(updateAdminRole)
  .delete(deleteAdminRole);

module.exports = router;
