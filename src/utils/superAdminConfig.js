const normalizeEmail = (value) => value.trim().toLowerCase();

const splitEmails = (value = '') =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeEmail);

const getSeededSuperAdminAccounts = () => {
  const accounts = [];

  for (let index = 1; index <= 10; index += 1) {
    const suffix = index === 1 ? '' : `_${index}`;
    const email = process.env[`SUPER_ADMIN_SEED_EMAIL${suffix}`]?.trim().toLowerCase() || '';
    const password = process.env[`SUPER_ADMIN_SEED_PASSWORD${suffix}`] || '';
    const name = process.env[`SUPER_ADMIN_SEED_NAME${suffix}`]?.trim() || '';

    if (email && password) {
      accounts.push({
        label: 'Super Admin',
        email,
        password,
        name,
        roleSlug: 'super-admin',
      });
    }
  }

  return accounts;
};

const getProtectedSuperAdminEmails = () => {
  const seededEmails = getSeededSuperAdminAccounts().map((account) => account.email);
  const lockedEmails = splitEmails(process.env.SUPER_ADMIN_LOCKED_EMAILS || '');

  return [...new Set([...seededEmails, ...lockedEmails])];
};

const isProtectedSuperAdminEmail = (email = '') =>
  getProtectedSuperAdminEmails().includes(normalizeEmail(email));

module.exports = {
  getProtectedSuperAdminEmails,
  getSeededSuperAdminAccounts,
  isProtectedSuperAdminEmail,
  normalizeEmail,
};
