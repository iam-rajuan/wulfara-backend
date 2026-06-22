const express = require('express');
const { register, verifyEmail, login, forgotPassword, resetPassword } = require('./auth.controller');

const router = express.Router();

router.post('/register', register);
router.post('/verify-email', verifyEmail);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.put('/reset-password/:resettoken', resetPassword);

module.exports = router;
