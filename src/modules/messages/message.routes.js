const express = require('express');
const { getConversations, getMessages, sendMessage } = require('./message.controller');
const { protect } = require('../../middlewares/auth');

const router = express.Router();

router.use(protect); // All message routes require authentication

router.route('/conversations')
  .get(getConversations);

router.route('/conversations/:id')
  .get(getMessages)
  .post(sendMessage);

module.exports = router;
