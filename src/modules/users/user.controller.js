const User = require('./user.model');
const { syncSupplierLifecycle } = require('../suppliers/supplierLifecycle');
const { decorateUserWithAccess, getDefaultAssignableAdminRole } = require('../adminRoles/adminRole.service');
const AdminRole = require('../adminRoles/adminRole.model');
const { isProtectedSuperAdminEmail } = require('../../utils/superAdminConfig');

// @desc    Get all users
// @route   GET /api/v1/users
// @access  Private/Admin
exports.getUsers = async (req, res) => {
  try {
    const users = await User.find().populate('adminRole');
    const decoratedUsers = await Promise.all(users.map((user) => decorateUserWithAccess(user)));
    res.status(200).json({ success: true, count: decoratedUsers.length, data: decoratedUsers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const Supplier = require('../suppliers/supplier.model');

// @desc    Create user
// @route   POST /api/v1/users
// @access  Private/Admin
exports.createUser = async (req, res) => {
  try {
    const payload = { ...req.body };

    if (payload.role === 'admin' && !payload.adminRole) {
      const defaultAdminRole = await getDefaultAssignableAdminRole();
      if (defaultAdminRole) {
        payload.adminRole = defaultAdminRole._id;
      }
    }

    const user = await User.create(payload);

    if (user.role === 'supplier') {
      const supplier = await Supplier.create({
        user: user._id,
        companyName: req.body.companyName || user.name + " Company",
        contactEmail: user.email,
        description: "Profile created by admin."
      });
      syncSupplierLifecycle(supplier);
      await supplier.save();
    }

    await user.populate('adminRole');
    res.status(201).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single user
// @route   GET /api/v1/users/:id
// @access  Private/Admin
exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('adminRole');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(200).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update user
// @route   PUT /api/v1/users/:id
// @access  Private/Admin
exports.updateUser = async (req, res) => {
  try {
    const payload = { ...req.body };
    const existingUser = await User.findById(req.params.id).populate('adminRole');
    if (!existingUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const protectedSuperAdmin = isProtectedSuperAdminEmail(existingUser.email);
    if (protectedSuperAdmin) {
      if (payload.role && payload.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Protected super admin accounts must remain admin users',
        });
      }

      if (payload.adminRole) {
        const requestedRole = await AdminRole.findById(payload.adminRole);
        if (!requestedRole || requestedRole.slug !== 'super-admin') {
          return res.status(403).json({
            success: false,
            message: 'Protected super admin accounts must remain Super Admin',
          });
        }
      }
    }

    if (payload.role && payload.role !== 'admin') {
      payload.adminRole = null;
    }
    if (payload.role === 'admin' && !payload.adminRole) {
      const defaultAdminRole = await getDefaultAssignableAdminRole();
      if (defaultAdminRole) {
        payload.adminRole = defaultAdminRole._id;
      }
    }

    if (!protectedSuperAdmin && payload.adminRole) {
      const requestedRole = await AdminRole.findById(payload.adminRole);
      if (requestedRole?.slug === 'super-admin') {
        return res.status(403).json({
          success: false,
          message: 'Super Admin can only be assigned to protected seeded accounts',
        });
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true
    }).populate('adminRole');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(200).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Delete user
// @route   DELETE /api/v1/users/:id
// @access  Private/Admin
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('adminRole');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (req.user?.id === user.id) {
      return res.status(403).json({ success: false, message: 'You cannot delete your own account' });
    }

    if (user.role === 'admin' && isProtectedSuperAdminEmail(user.email)) {
      return res.status(403).json({
        success: false,
        message: 'Protected seeded Super Admin accounts cannot be deleted',
      });
    }

    await user.deleteOne();
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get current logged in user
// @route   GET /api/v1/users/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('adminRole');
    res.status(200).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update current logged in user
// @route   PUT /api/v1/users/me
// @access  Private
exports.updateMe = async (req, res) => {
  try {
    // Prevent updating password or role through this route
    if (req.body.password || req.body.role || req.body.isVerified) {
      return res.status(400).json({ success: false, message: 'Cannot update password, role, or verification status here' });
    }

    const user = await User.findByIdAndUpdate(req.user.id, req.body, {
      new: true,
      runValidators: true
    }).populate('adminRole');

    res.status(200).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
