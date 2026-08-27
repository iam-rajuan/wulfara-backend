const User = require('./user.model');
const { syncSupplierLifecycle } = require('../suppliers/supplierLifecycle');
const { decorateUserWithAccess, getDefaultAssignableAdminRole } = require('../adminRoles/adminRole.service');
const AdminRole = require('../adminRoles/adminRole.model');
const { isProtectedSuperAdminEmail } = require('../../utils/superAdminConfig');
const { generatePresignedUrl } = require('../../utils/s3');
const sendEmail = require('../../utils/sendEmail');

// @desc    Get all users
// @route   GET /api/v1/users
// @access  Private/Admin
exports.getUsers = async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).populate('adminRole');
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

    // Cascade delete supplier profile if user is a supplier
    if (user.role === 'supplier') {
      await Supplier.deleteOne({ user: user._id });
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

    if (Object.prototype.hasOwnProperty.call(req.body, 'email')) {
      return res.status(400).json({
        success: false,
        message: 'Email address is locked. Use the email change OTP flow to update it.',
      });
    }

    const existingUser = await User.findById(req.user.id).populate('adminRole');
    if (!existingUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
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

// @desc    Request OTP for email change
// @route   POST /api/v1/users/me/email-change/request
// @access  Private
exports.requestEmailChangeOtp = async (req, res) => {
  try {
    const nextEmail = req.body?.email?.trim().toLowerCase();

    if (!nextEmail) {
      return res.status(400).json({ success: false, message: 'Please provide a new email address' });
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!emailPattern.test(nextEmail)) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
    }

    const user = await User.findById(req.user.id).populate('adminRole');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.email === nextEmail) {
      return res.status(400).json({ success: false, message: 'This is already your current email address' });
    }

    const existingUser = await User.findOne({ email: nextEmail });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'That email address is already in use' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    user.pendingEmail = nextEmail;
    user.emailChangeCode = otpCode;
    user.emailChangeExpires = new Date(Date.now() + 10 * 60 * 1000);
    await user.save({ validateBeforeSave: false });

    const message = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1b2b3a;">
        <h2 style="color: #1b2b3a;">Confirm your new email address</h2>
        <p>Use the verification code below to confirm your Wulfara email change request.</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; margin: 24px 0;">${otpCode}</p>
        <p>This code will expire in 10 minutes.</p>
      </div>
    `;

    await sendEmail({
      email: nextEmail,
      subject: 'Wulfara Email Change Verification Code',
      html: message,
    });

    res.status(200).json({
      success: true,
      message: 'Verification code sent to the new email address',
      data: {
        email: nextEmail,
        expiresAt: user.emailChangeExpires,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Verify OTP and change email
// @route   POST /api/v1/users/me/email-change/verify
// @access  Private
exports.verifyEmailChangeOtp = async (req, res) => {
  try {
    const otpCode = req.body?.otp?.trim();

    if (!otpCode) {
      return res.status(400).json({ success: false, message: 'Please provide the verification code' });
    }

    const user = await User.findById(req.user.id).populate('adminRole');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.pendingEmail || !user.emailChangeCode || !user.emailChangeExpires) {
      return res.status(400).json({ success: false, message: 'No email change request is pending' });
    }

    if (user.emailChangeExpires.getTime() <= Date.now()) {
      user.pendingEmail = '';
      user.emailChangeCode = '';
      user.emailChangeExpires = null;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json({ success: false, message: 'Verification code has expired. Request a new one.' });
    }

    if (user.emailChangeCode !== otpCode) {
      return res.status(400).json({ success: false, message: 'Invalid verification code' });
    }

    const nextEmail = user.pendingEmail.trim().toLowerCase();

    const existingUser = await User.findOne({ email: nextEmail, _id: { $ne: user._id } });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'That email address is already in use' });
    }

    user.email = nextEmail;
    user.pendingEmail = '';
    user.emailChangeCode = '';
    user.emailChangeExpires = null;
    user.isVerified = true;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Email address updated successfully',
      data: await decorateUserWithAccess(user),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get pre-signed URL for S3 upload for user avatar
// @route   POST /api/v1/users/upload-url
// @access  Private
exports.getUploadUrl = async (req, res) => {
  try {
    const { contentType } = req.body;
    
    // Ensure valid content type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!contentType || !allowedTypes.includes(contentType)) {
        return res.status(400).json({ success: false, message: 'Please provide a valid contentType (image/jpeg, image/png, image/webp)' });
    }
    
    const urlData = await generatePresignedUrl('avatars', contentType);

    res.status(200).json({
      success: true,
      data: urlData
    });
  } catch (error) {
    console.error('S3 Presign Error:', error);
    res.status(500).json({ success: false, message: 'Error generating upload URL' });
  }
};
