const AdminRole = require('./adminRole.model');
const User = require('../users/user.model');
const { isProtectedSuperAdminEmail } = require('../../utils/superAdminConfig');
const {
  ADMIN_PERMISSION_GROUPS,
  ALL_ADMIN_PERMISSIONS,
  DEFAULT_ADMIN_ROLE_DEFINITIONS,
} = require('./adminPermissionCatalog');

const normalizePermissions = (permissions = []) =>
  [...new Set(permissions.filter((permission) => ALL_ADMIN_PERMISSIONS.includes(permission)))].sort();

const serializeAdminRole = (adminRole) => {
  if (!adminRole) {
    return null;
  }

  const plainRole = adminRole.toObject ? adminRole.toObject() : adminRole;

  return {
    _id: plainRole._id,
    name: plainRole.name,
    slug: plainRole.slug,
    description: plainRole.description || '',
    permissions: normalizePermissions(plainRole.permissions),
    isSystem: Boolean(plainRole.isSystem),
    isDefault: Boolean(plainRole.isDefault),
  };
};

const isSuperAdminRole = (adminRole) => adminRole?.slug === 'super-admin';

const getEffectivePermissions = (user) => {
  if (!user || user.role !== 'admin') {
    return [];
  }

  if (!user.adminRole) {
    return [...ALL_ADMIN_PERMISSIONS];
  }

  if (isSuperAdminRole(user.adminRole)) {
    return [...ALL_ADMIN_PERMISSIONS];
  }

  return normalizePermissions(user.adminRole.permissions);
};

const decorateUserWithAccess = async (user) => {
  if (!user) {
    return null;
  }

  const plainUser = user.toObject ? user.toObject() : { ...user };

  let adminRole = plainUser.adminRole || null;
  if (plainUser.role === 'admin' && adminRole && !adminRole.slug) {
    adminRole = await AdminRole.findById(adminRole);
  }

  if (plainUser.role === 'admin' && !adminRole) {
    return {
      ...plainUser,
      adminRole: null,
      permissions: [...ALL_ADMIN_PERMISSIONS],
      isSuperAdmin: true,
    };
  }

  const serializedRole = serializeAdminRole(adminRole);
  const permissions =
    plainUser.role === 'admin'
      ? isSuperAdminRole(serializedRole)
        ? [...ALL_ADMIN_PERMISSIONS]
        : normalizePermissions(serializedRole?.permissions)
      : [];

  return {
    ...plainUser,
    adminRole: serializedRole,
    permissions,
    isSuperAdmin: plainUser.role === 'admin' ? isSuperAdminRole(serializedRole) : false,
    isProtectedSuperAdmin: plainUser.role === 'admin' ? isProtectedSuperAdminEmail(plainUser.email) : false,
  };
};

const seedDefaultAdminRoles = async () => {
  for (const definition of DEFAULT_ADMIN_ROLE_DEFINITIONS) {
    await AdminRole.findOneAndUpdate(
      { slug: definition.slug },
      {
        $set: {
          name: definition.name,
          description: definition.description,
          permissions: normalizePermissions(definition.permissions),
          isSystem: definition.isSystem,
          isDefault: definition.isDefault,
        },
        $setOnInsert: { slug: definition.slug },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  }
};

const getAdminRoleBySlug = async (slug) => AdminRole.findOne({ slug });

const getDefaultAssignableAdminRole = async () =>
  (await AdminRole.findOne({ isDefault: true })) || getAdminRoleBySlug('admin');

const assignFallbackAdminRoles = async ({ fallbackSlug = 'super-admin' } = {}) => {
  const fallbackRole = await getAdminRoleBySlug(fallbackSlug);
  if (!fallbackRole) {
    return;
  }

  await User.updateMany(
    { role: 'admin', $or: [{ adminRole: { $exists: false } }, { adminRole: null }] },
    { $set: { adminRole: fallbackRole._id } }
  );
};

const buildAdminRoleResponse = async (adminRole) => {
  const serializedRole = serializeAdminRole(adminRole);
  const usersCount = await User.countDocuments({ role: 'admin', adminRole: serializedRole._id });

  return {
    ...serializedRole,
    usersCount,
  };
};

const listAdminRolesWithCounts = async () => {
  const roles = await AdminRole.find().sort({ isSystem: -1, name: 1 });
  return Promise.all(roles.map((role) => buildAdminRoleResponse(role)));
};

const listAdminUsersWithAccess = async () => {
  const adminUsers = await User.find({ role: 'admin' }).populate('adminRole').sort({ createdAt: 1 });
  return Promise.all(adminUsers.map((user) => decorateUserWithAccess(user)));
};

const getPermissionCatalog = () =>
  ADMIN_PERMISSION_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    permissions: group.permissions.map((permission) => ({ ...permission })),
  }));

module.exports = {
  ALL_ADMIN_PERMISSIONS,
  assignFallbackAdminRoles,
  buildAdminRoleResponse,
  decorateUserWithAccess,
  getAdminRoleBySlug,
  getDefaultAssignableAdminRole,
  getEffectivePermissions,
  getPermissionCatalog,
  isSuperAdminRole,
  listAdminRolesWithCounts,
  listAdminUsersWithAccess,
  normalizePermissions,
  seedDefaultAdminRoles,
  serializeAdminRole,
};
