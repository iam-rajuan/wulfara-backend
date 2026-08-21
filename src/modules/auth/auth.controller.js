const User = require('../users/user.model');
const Supplier = require('../suppliers/supplier.model');
const PendingRegistration = require('./pendingRegistration.model');
const generateToken = require('../../utils/generateToken');
const sendEmail = require('../../utils/sendEmail');
const crypto = require('crypto');
const { logger } = require('../../utils/logger');
const { resolveAppOrigin } = require('../../utils/origins');
const { syncSupplierLifecycle } = require('../suppliers/supplierLifecycle');
const { decorateUserWithAccess } = require('../adminRoles/adminRole.service');
// @desc     Register user
// @route    POST /api/v1/auth/register
// @access   Public
exports.register = async (req, res) => {
  try {
    // 1. Destructure user inputs from request body
    const { name, email, password, role, companyName, phone } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();

    // 2. Check if a user with this email already exists in the database
    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }
    // Generate a 6-digit verification code
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

    await PendingRegistration.findOneAndDelete({ email: normalizedEmail });

    await PendingRegistration.create({
      name,
      email: normalizedEmail,
      password,
      role: role || 'buyer',
      companyName,
      phone,
      verifyCode,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const message = `Your verification code is: <strong>${verifyCode}</strong>`;
    
    try {
      await sendEmail({ email: normalizedEmail, subject: 'Email Verification Code', html: message });
    } catch (err) {
      await PendingRegistration.findOneAndDelete({ email: normalizedEmail });
      throw err;
    }

    res.status(201).json({ 
      success: true, 
      message: 'Verification email sent. Please check your inbox for the code.',
      email: normalizedEmail
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc     Verify Email Code
// @route    POST /api/v1/auth/verify-email
// @access   Public
exports.verifyEmail = async (req, res) => {
  try {
    const { email, verifyCode } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();

    const pendingRegistration = await PendingRegistration.findOne({
      email: normalizedEmail,
      verifyCode,
      expiresAt: { $gt: new Date() },
    });

    if (!pendingRegistration) {
      return res.status(400).json({ success: false, message: 'Invalid or expired verification code' });
    }

    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
      await PendingRegistration.findByIdAndDelete(pendingRegistration._id);
      return res.status(400).json({ success: false, message: 'User already exists' });
    }

    const user = await User.create({
      name: pendingRegistration.name,
      email: pendingRegistration.email,
      password: pendingRegistration.password,
      role: pendingRegistration.role || 'buyer',
      isVerified: true,
    });

    if (user.role === 'supplier') {
      const supplier = await Supplier.create({
        user: user._id,
        companyName: pendingRegistration.companyName || `${pendingRegistration.name} Company`,
        contactEmail: pendingRegistration.email,
        contactPhone: pendingRegistration.phone || "",
        description: "Profile pending details. Please update your company description in settings."
      });
      syncSupplierLifecycle(supplier);
      await supplier.save();
    }

    await PendingRegistration.findByIdAndDelete(pendingRegistration._id);
    const token = generateToken(user._id);

    res.status(200).json({ success: true, message: 'Email verified successfully', token });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc     Resend Email Verification Code
// @route    POST /api/v1/auth/resend-verification
// @access   Public
exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();

    const pendingRegistration = await PendingRegistration.findOne({ email: normalizedEmail });
    if (!pendingRegistration) {
      return res.status(400).json({ success: false, message: 'No registration pending for this email. Please sign up again.' });
    }

    // Generate a new 6-digit verification code
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingRegistration.verifyCode = verifyCode;
    pendingRegistration.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pendingRegistration.save();

    const message = `Your verification code is: <strong>${verifyCode}</strong>`;
    
    try {
      await sendEmail({ email: normalizedEmail, subject: 'Email Verification Code', html: message });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Failed to send verification email' });
    }

    res.status(200).json({ 
      success: true, 
      message: 'Verification email sent. Please check your inbox for the code.',
      email: normalizedEmail
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc     Login user
// @route    POST /api/v1/auth/login
// @access   Public
exports.login = async (req, res) => {
  try {
    // 1. Extract email and password from request body
    const { email, password } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedPassword = typeof password === 'string' ? password.trim() : password;

    // 2. Find user by email. 
    // We explicitly select '+password' because it is set to 'select: false' in the User model by default for security.
    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    
    if (!user) {
      logger.warn({ email: normalizedEmail }, 'Login failed: user not found');
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    // 3. Verify password. 
    // Uses the matchPassword instance method defined in the User model (which uses bcrypt.compare)
    const isMatch = await user.matchPassword(normalizedPassword);
    if (!isMatch) {
      logger.warn({
        email: normalizedEmail,
        passwordLength: typeof password === 'string' ? password.length : 0,
        trimmedPasswordLength: typeof normalizedPassword === 'string' ? normalizedPassword.length : 0,
      }, 'Login failed: password mismatch');
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    // Check if verified
    if (!user.isVerified) {
      logger.warn({ email: normalizedEmail, role: user.role }, 'Login failed: email not verified');
      return res.status(401).json({ success: false, message: 'Please verify your email first' });
    }
    
    // Check if suspended
    if (user.status === 'Suspended') {
      logger.warn({ email: normalizedEmail, role: user.role }, 'Login failed: account suspended');
      return res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
    }
    // 4. Generate JWT Token and send response
    // Token contains the user._id as the payload
    const token = generateToken(user._id);
    res.status(200).json({ success: true, token });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc     Forgot Password
// @route    POST /api/v1/auth/forgot-password
// @access   Public
exports.forgotPassword = async (req, res) => {
  try {
    const normalizedEmail = req.body.email?.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(404).json({ success: false, message: 'There is no user with that email' });
    }

    // Generate token
    const resetToken = crypto.randomBytes(20).toString('hex');

    // Hash token and set to resetPasswordToken field
    user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.resetPasswordExpire = Date.now() + 10 * 60 * 1000; // 10 Minutes

    await user.save({ validateBeforeSave: false });

    const isDashboard = req.body.isDashboard;
    const preferredOrigin = isDashboard ? process.env.DASHBOARD_ORIGIN : process.env.WEBSITE_ORIGIN;
    const baseUrl = resolveAppOrigin(req, preferredOrigin);
    if (!baseUrl) {
      return res.status(500).json({
        success: false,
        message: `${isDashboard ? 'DASHBOARD_ORIGIN' : 'WEBSITE_ORIGIN'} must be configured before sending password reset emails in production`,
      });
    }
    const path = isDashboard ? 'new-password' : 'reset-password';
    const resetUrl = `${baseUrl}/${path}/${resetToken}`;
    const message = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1b2b3a;">
        <h2 style="color: #1b2b3a;">Password Reset Request</h2>
        <p>You are receiving this email because you requested a password reset for your Wulfara account.</p>
        <p>Please click the button below to reset your password:</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background-color:#dca12f;color:#1b2b3a;text-decoration:none;font-weight:bold;border-radius:6px;margin:16px 0;">Reset Password</a>
        <p style="font-size: 14px; color: #666;">Or copy and paste this link into your browser:</p>
        <p style="font-size: 14px; word-break: break-all;"><a href="${resetUrl}" style="color: #0052CC;">${resetUrl}</a></p>
      </div>
    `;

    try {
      await sendEmail({
        email: user.email,
        subject: 'Password Reset Token',
        html: message
      });
      res.status(200).json({ success: true, message: 'Password reset email sent' });
    } catch (error) {
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;
      await user.save({ validateBeforeSave: false });
      return res.status(500).json({ success: false, message: 'Email could not be sent' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc     Reset Password
// @route    PUT /api/v1/auth/reset-password/:resettoken
// @access   Public
exports.resetPassword = async (req, res) => {
  try {
    // Get hashed token
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.resettoken)
      .digest('hex');

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() }
    });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid token' });
    }
    // Set new password
    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();
    const token = generateToken(user._id);
    res.status(200).json({ success: true, token });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc     Get all users (Admin only)
// @route    GET /api/v1/auth/users
// @access   Private (Admin)
exports.getUsers = async (req, res) => {
  try {
    const users = await User.find().populate('adminRole');
    const decoratedUsers = await Promise.all(users.map((user) => decorateUserWithAccess(user)));
    res.status(200).json({ success: true, count: decoratedUsers.length, data: decoratedUsers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc     Update user status (Suspend/Activate)
// @route    PUT /api/v1/auth/users/:id/status
// @access   Private (Admin)
exports.updateUserStatus = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('adminRole');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    user.isActive = req.body.isActive !== undefined ? req.body.isActive : user.isActive;
    await user.save();

    res.status(200).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc     Get current logged in user
// @route    GET /api/v1/auth/me
// @access   Private
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('adminRole');
    res.status(200).json({ success: true, data: await decorateUserWithAccess(user) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
