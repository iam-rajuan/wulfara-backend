const express = require('express');
const {
  register,
  login,
  getMe,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  getUsers,
  updateUserStatus
} = require('./auth.controller');

const router = express.Router();
const { protect, authorize, authorizePermissions } = require('../../middlewares/auth');

/**
 * ==========================================
 * Public Authentication Routes
 * ==========================================
 * These routes do not require any tokens.
 */
router.post('/register', register); // Register a new buyer or supplier
router.post('/login', login); // Authenticate user and get JWT token
router.post('/forgot-password', forgotPassword); // Send password reset email
router.put('/reset-password/:resettoken', resetPassword); // Reset password using email token
router.post('/verify-email', verifyEmail); // Verify user email (FUTURE USE)
router.post('/resend-verification', resendVerification); // Resend verification code

/**
 * ==========================================
 * Protected Authentication Routes
 * ==========================================
 * These routes require a valid JWT token.
 */
router.get('/me', protect, getMe); // Get current logged-in user's profile

/**
 * ==========================================
 * Admin User Management Routes
 * ==========================================
 * These routes require a valid JWT token AND 'admin' role.
 */
router.get('/users', protect, authorize('admin'), authorizePermissions('users.read'), getUsers); // List all users in the system
router.put('/users/:id/status', protect, authorize('admin'), authorizePermissions('users.manage'), updateUserStatus); // Suspend or activate a user account

module.exports = router;
