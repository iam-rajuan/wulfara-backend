const { logger } = require('./logger');
const User = require('../modules/users/user.model');
const {
  getAdminRoleBySlug,
  seedDefaultAdminRoles,
} = require('../modules/adminRoles/adminRole.service');
const {
  getProtectedSuperAdminEmails,
  getSeededSuperAdminAccounts,
} = require('./superAdminConfig');

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

const deriveNameFromEmail = (email, fallbackLabel) => {
  const localPart = (email || '').split('@')[0].trim();
  if (!localPart) {
    return fallbackLabel;
  }

  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

const getAdminSeedConfig = () => ({
  syncOnStart: parseBoolean(process.env.ADMIN_SEED_SYNC_ON_START, false),
  accounts: [
    ...getSeededSuperAdminAccounts(),
    {
      label: 'Admin',
      name: (process.env.ADMIN_SEED_NAME || '').trim(),
      email: (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase(),
      password: process.env.ADMIN_SEED_PASSWORD || '',
      roleSlug: (process.env.ADMIN_SEED_ROLE_SLUG || 'admin').trim().toLowerCase(),
    },
  ],
});

const syncSingleAdminAccount = async (accountConfig) => {
  await seedDefaultAdminRoles();
  const adminRole = await getAdminRoleBySlug(accountConfig.roleSlug);

  let user = await User.findOne({ email: accountConfig.email }).select('+password');
  const isNewUser = !user;
  const resolvedName = accountConfig.name || deriveNameFromEmail(accountConfig.email, accountConfig.label);

  if (!user) {
    user = new User({
      name: resolvedName,
      email: accountConfig.email,
      password: accountConfig.password,
      role: 'admin',
      adminRole: adminRole?._id || null,
      isVerified: true,
      status: 'Active',
    });

    await user.save();
    logger.info({ email: accountConfig.email, action: 'created', roleSlug: accountConfig.roleSlug }, 'Admin seed synced from environment');
    return { skipped: false, action: 'created', email: accountConfig.email, roleSlug: accountConfig.roleSlug };
  }

  let shouldSave = false;

  if (user.name !== resolvedName) {
    user.name = resolvedName;
    shouldSave = true;
  }

  if (user.role !== 'admin') {
    user.role = 'admin';
    shouldSave = true;
  }

  if (adminRole && String(user.adminRole || '') !== String(adminRole._id)) {
    user.adminRole = adminRole._id;
    shouldSave = true;
  }

  if (!user.isVerified) {
    user.isVerified = true;
    shouldSave = true;
  }

  if (user.status !== 'Active') {
    user.status = 'Active';
    shouldSave = true;
  }

  const passwordMatches = await user.matchPassword(accountConfig.password);
  if (!passwordMatches) {
    user.password = accountConfig.password;
    shouldSave = true;
  }

  if (!shouldSave) {
    logger.info({ email: accountConfig.email, action: 'unchanged', roleSlug: accountConfig.roleSlug }, 'Admin seed already in sync');
    return { skipped: false, action: 'unchanged', email: accountConfig.email, roleSlug: accountConfig.roleSlug };
  }

  await user.save();
  logger.info(
    { email: accountConfig.email, action: isNewUser ? 'created' : 'updated', roleSlug: accountConfig.roleSlug },
    'Admin seed synced from environment'
  );

  return { skipped: false, action: 'updated', email: accountConfig.email, roleSlug: accountConfig.roleSlug };
};

const syncAdminUserFromEnv = async ({ force = false } = {}) => {
  const config = getAdminSeedConfig();

  if (!force && !config.syncOnStart) {
    return { skipped: true, reason: 'startup_sync_disabled' };
  }

  const accountsToSeed = config.accounts.filter((account) => account.email && account.password);
  if (accountsToSeed.length === 0) {
    logger.warn('Admin seed skipped because no seeded admin credentials were configured');
    return { skipped: true, reason: 'missing_credentials' };
  }

  const results = [];
  for (const account of accountsToSeed) {
    results.push(await syncSingleAdminAccount(account));
  }

  return {
    skipped: false,
    results,
  };
};

const enforceProtectedSuperAdmins = async () => {
  await seedDefaultAdminRoles();
  const superAdminRole = await getAdminRoleBySlug('super-admin');
  if (!superAdminRole) {
    return [];
  }

  const protectedEmails = getProtectedSuperAdminEmails();
  const results = [];

  for (const email of protectedEmails) {
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      continue;
    }

    let shouldSave = false;

    if (user.role !== 'admin') {
      user.role = 'admin';
      shouldSave = true;
    }

    if (String(user.adminRole || '') !== String(superAdminRole._id)) {
      user.adminRole = superAdminRole._id;
      shouldSave = true;
    }

    if (!user.isVerified) {
      user.isVerified = true;
      shouldSave = true;
    }

    if (user.status !== 'Active') {
      user.status = 'Active';
      shouldSave = true;
    }

    if (shouldSave) {
      await user.save();
      logger.info({ email, action: 'locked-super-admin' }, 'Protected super admin enforced from environment');
      results.push({ email, action: 'locked-super-admin', roleSlug: 'super-admin' });
    }
  }

  return results;
};

module.exports = {
  enforceProtectedSuperAdmins,
  getAdminSeedConfig,
  syncAdminUserFromEnv,
};
