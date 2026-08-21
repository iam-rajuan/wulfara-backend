const AdminRole = require('./adminRole.model');
const User = require('../users/user.model');
const {
  buildAdminRoleResponse,
  getPermissionCatalog,
  listAdminRolesWithCounts,
  listAdminUsersWithAccess,
  normalizePermissions,
} = require('./adminRole.service');
const { isProtectedSuperAdminEmail } = require('../../utils/superAdminConfig');

const slugify = (value = '') =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

exports.getPermissionCatalog = async (req, res) => {
  res.status(200).json({ success: true, data: getPermissionCatalog() });
};

exports.getAdminRoles = async (req, res) => {
  try {
    const roles = await listAdminRolesWithCounts();
    res.status(200).json({ success: true, count: roles.length, data: roles });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createAdminRole = async (req, res) => {
  try {
    const name = req.body.name?.trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'Role name is required' });
    }

    const slug = slugify(req.body.slug || name);
    const existingRole = await AdminRole.findOne({ slug });
    if (existingRole) {
      return res.status(400).json({ success: false, message: 'A role with that name already exists' });
    }

    const role = await AdminRole.create({
      name,
      slug,
      description: req.body.description?.trim() || '',
      permissions: normalizePermissions(req.body.permissions),
      isSystem: false,
      isDefault: false,
    });

    res.status(201).json({ success: true, data: await buildAdminRoleResponse(role) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateAdminRole = async (req, res) => {
  try {
    const role = await AdminRole.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Admin role not found' });
    }

    if (role.isSystem && req.body.name && req.body.name.trim() !== role.name) {
      return res.status(400).json({ success: false, message: 'System role names cannot be changed' });
    }

    if (req.body.name) {
      role.name = req.body.name.trim();
    }
    if (req.body.description !== undefined) {
      role.description = req.body.description.trim();
    }
    if (Array.isArray(req.body.permissions)) {
      role.permissions = normalizePermissions(req.body.permissions);
    }

    await role.save();
    res.status(200).json({ success: true, data: await buildAdminRoleResponse(role) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteAdminRole = async (req, res) => {
  try {
    const role = await AdminRole.findById(req.params.id);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Admin role not found' });
    }

    if (role.isSystem) {
      return res.status(400).json({ success: false, message: 'System roles cannot be deleted' });
    }

    const assignedUsers = await User.countDocuments({ role: 'admin', adminRole: role._id });
    if (assignedUsers > 0) {
      return res.status(400).json({
        success: false,
        message: 'Reassign users before deleting this role',
      });
    }

    await role.deleteOne();
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getAdminUsers = async (req, res) => {
  try {
    const adminUsers = await listAdminUsersWithAccess();
    res.status(200).json({ success: true, count: adminUsers.length, data: adminUsers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.assignAdminRoleToUser = async (req, res) => {
  try {
    const { adminRoleId } = req.body;
    const user = await User.findById(req.params.userId);

    if (!user || user.role !== 'admin') {
      return res.status(404).json({ success: false, message: 'Admin user not found' });
    }

    const role = await AdminRole.findById(adminRoleId);
    if (!role) {
      return res.status(404).json({ success: false, message: 'Admin role not found' });
    }

    const isProtectedUser = isProtectedSuperAdminEmail(user.email);
    if (isProtectedUser && role.slug !== 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Protected super admin accounts cannot be assigned a different role',
      });
    }

    if (!isProtectedUser && role.slug === 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Super Admin can only be assigned to protected seeded accounts',
      });
    }

    user.adminRole = role._id;
    await user.save();
    await user.populate('adminRole');

    const decoratedUser = await require('./adminRole.service').decorateUserWithAccess(user);
    res.status(200).json({ success: true, data: decoratedUser });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
