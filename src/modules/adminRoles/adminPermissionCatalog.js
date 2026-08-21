const ADMIN_PERMISSION_GROUPS = [
  {
    key: 'general',
    label: 'General & Dashboard',
    permissions: [
      {
        key: 'dashboard.view',
        label: 'View Main Dashboard',
        description: 'Access platform-level dashboard analytics and operational summaries.',
      },
      {
        key: 'settings.manage',
        label: 'Manage General Settings',
        description: 'Update general platform and company-level admin settings.',
      },
      {
        key: 'notifications.manage',
        label: 'Manage Notification Settings',
        description: 'Configure internal notification preferences and delivery rules.',
      },
      {
        key: 'roles.manage',
        label: 'Manage Roles & Permissions',
        description: 'Create custom admin roles, edit permissions, and assign admin access.',
      },
    ],
  },
  {
    key: 'users',
    label: 'Users & Suppliers',
    permissions: [
      {
        key: 'users.read',
        label: 'View Buyers & Users',
        description: 'View buyer and internal user records.',
      },
      {
        key: 'users.manage',
        label: 'Manage Buyers & Users',
        description: 'Create, update, suspend, and delete buyer or internal user records.',
      },
      {
        key: 'suppliers.read',
        label: 'View Suppliers',
        description: 'Access supplier records and verification details.',
      },
      {
        key: 'suppliers.manage',
        label: 'Manage Suppliers',
        description: 'Approve supplier actions, create assisted suppliers, and update supplier records.',
      },
      {
        key: 'listings.manage',
        label: 'Review Listings',
        description: 'Approve, reject, feature, and moderate supplier listings.',
      },
    ],
  },
  {
    key: 'commercial',
    label: 'Commercial & Billing',
    permissions: [
      {
        key: 'categories.manage',
        label: 'Manage Categories',
        description: 'Create and maintain supplier categories and related media.',
      },
      {
        key: 'subscriptions.read',
        label: 'View Subscriptions',
        description: 'View plans, invoices, active subscriptions, and subscription state.',
      },
      {
        key: 'subscriptions.manage',
        label: 'Manage Subscriptions',
        description: 'Create, edit, and remove subscription plans and billing settings.',
      },
      {
        key: 'revenue.view',
        label: 'View Revenue',
        description: 'Access billing totals, payment history, and revenue reporting.',
      },
    ],
  },
  {
    key: 'operations',
    label: 'Operations & Content',
    permissions: [
      {
        key: 'rfqs.read',
        label: 'View RFQs',
        description: 'View global RFQs and related admin dispute data.',
      },
      {
        key: 'rfqs.manage',
        label: 'Manage RFQs',
        description: 'Update RFQ status and intervene in RFQ workflows.',
      },
      {
        key: 'content.manage',
        label: 'Manage Content',
        description: 'Create and edit homepage banners and CMS pages.',
      },
      {
        key: 'seo.manage',
        label: 'Manage SEO',
        description: 'Update SEO settings and metadata.',
      },
    ],
  },
];

const ALL_ADMIN_PERMISSIONS = ADMIN_PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.key)
);

const DEFAULT_ADMIN_ROLE_DEFINITIONS = [
  {
    name: 'Super Admin',
    slug: 'super-admin',
    description: 'Unrestricted full access to all platform settings and operational data.',
    permissions: ALL_ADMIN_PERMISSIONS,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Admin',
    slug: 'admin',
    description: 'Broad management access across users, suppliers, listings, content, and operations.',
    permissions: [
      'dashboard.view',
      'settings.manage',
      'notifications.manage',
      'users.read',
      'users.manage',
      'suppliers.read',
      'suppliers.manage',
      'listings.manage',
      'categories.manage',
      'rfqs.read',
      'rfqs.manage',
      'content.manage',
      'seo.manage',
    ],
    isSystem: true,
    isDefault: true,
  },
  {
    name: 'Finance Admin',
    slug: 'finance-admin',
    description: 'Billing and financial reporting access with subscription visibility and management.',
    permissions: [
      'dashboard.view',
      'subscriptions.read',
      'subscriptions.manage',
      'revenue.view',
    ],
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Support Admin',
    slug: 'support-admin',
    description: 'Customer support access for viewing users, suppliers, and RFQ workflows.',
    permissions: [
      'dashboard.view',
      'users.read',
      'suppliers.read',
      'rfqs.read',
      'notifications.manage',
    ],
    isSystem: true,
    isDefault: false,
  },
];

module.exports = {
  ADMIN_PERMISSION_GROUPS,
  ALL_ADMIN_PERMISSIONS,
  DEFAULT_ADMIN_ROLE_DEFINITIONS,
};
