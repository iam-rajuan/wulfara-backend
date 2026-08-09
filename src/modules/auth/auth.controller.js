const User = require('../users/user.model');
const Supplier = require('../suppliers/supplier.model');
const generateToken = require('../../utils/generateToken');
const sendEmail = require('../../utils/sendEmail');
const crypto = require('crypto');
const { logger } = require('../../utils/logger');
// @desc     Register user
// @route    POST /api/v1/auth/register
// @access   Public
exports.register = async (req, res) => {
  try {
    // 1. Destructure user inputs from request body
    const { name, email, password, role, companyName, phone } = req.body;

    // 2. Check if a user with this email already exists in the database
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ success: false, message: 'User already exists' });
    }
    // Generate a 6-digit verification code
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Create the new user.
    // Note: Password will be automatically hashed by the pre-save hook in the User model.
    const user = await User.create({
      name,
      email,
      password,
      role: role || 'buyer',
      isVerified: false, 
      verifyCode 
    });

    // 4. If the user is a supplier, create a supplier profile
    if (user.role === 'supplier') {
      if (!companyName) {
        // We could return 400 here, but let's be safe and rollback user creation or just provide a fallback
        // For simplicity and since validation is on frontend, let's assume it's provided.
      }
      await Supplier.create({
        user: user._id,
        companyName: companyName || name + " Company",
        contactEmail: email,
        contactPhone: phone || "",
        description: "Profile pending details. Please update your company description in settings."
      });
    }

    // Send verification email (Mocked in console for development)
    const message = `Your verification code is: <strong>${verifyCode}</strong>`;
    console.log(`[Email Mock] To: ${user.email} | Subject: Email Verification Code | Body: ${message}`);
    
    try {
      await sendEmail({ email: user.email, subject: 'Email Verification Code', html: message });
    } catch (err) { console.log(err); }

    res.status(201).json({ 
      success: true, 
      message: 'Verification email sent. Please check your inbox (or server console) for the code.',
      email: user.email // Useful for frontend to know which email to verify
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

    const user = await User.findOne({ email, verifyCode });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid verification code' });
    }

    user.isVerified = true;
    user.verifyCode = undefined;
    await user.save();

    res.status(200).json({ success: true, message: 'Email verified successfully' });
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
    const user = await User.findOne({ email: req.body.email });

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
    const baseUrl = isDashboard ? (process.env.DASHBOARD_URL || 'http://localhost:5173') : (process.env.FRONTEND_URL || 'http://localhost:3000');
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
    const users = await User.find();
    res.status(200).json({ success: true, count: users.length, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc     Update user status (Suspend/Activate)
// @route    PUT /api/v1/auth/users/:id/status
// @access   Private (Admin)
exports.updateUserStatus = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    user.isActive = req.body.isActive !== undefined ? req.body.isActive : user.isActive;
    await user.save();

    res.status(200).json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc     Get current logged in user
// @route    GET /api/v1/auth/me
// @access   Private
exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
