const User = require('../users/user.model');
const Supplier = require('../suppliers/supplier.model');
const generateToken = require('../../utils/generateToken');
const sendEmail = require('../../utils/sendEmail');
const crypto = require('crypto');
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
    
    // try {
    //   await sendEmail({ email: user.email, subject: 'Email Verification Code', html: message });
    // } catch (err) { console.log(err); }

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

    // 2. Find user by email. 
    // We explicitly select '+password' because it is set to 'select: false' in the User model by default for security.
    const user = await User.findOne({ email }).select('+password');
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    // 3. Verify password. 
    // Uses the matchPassword instance method defined in the User model (which uses bcrypt.compare)
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    // Check if verified
    if (!user.isVerified) {
      return res.status(401).json({ success: false, message: 'Please verify your email first' });
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

    // In a real app, this would be a link to the frontend reset password page. 
    // We will send the plain token for API testing purposes.
    const message = `You are receiving this email because you requested a password reset. Please use the following token to reset your password via the API: <br><strong>${resetToken}</strong>`;

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