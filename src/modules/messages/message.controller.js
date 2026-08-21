const Conversation = require('./conversation.model');
const ChatMessage = require('./message.model');
const User = require('../users/user.model');
const Rfq = require('../rfqs/rfq.model');
const { createNotification } = require('../../utils/notificationService');

// @desc    Get user conversations
// @route   GET /api/v1/messages/conversations
// @access  Private
exports.getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id
    })
      .populate('participants', 'name role avatar')
      .populate('lastMessage')
      .populate('rfq', 'rfqNumber title status')
      .sort({ lastMessageAt: -1 });

    res.status(200).json({ success: true, count: conversations.length, data: conversations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get messages for a conversation
// @route   GET /api/v1/messages/conversations/:id
// @access  Private
exports.getMessages = async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);

    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Conversation not found' });
    }

    // Verify user is a participant
    if (!conversation.participants.includes(req.user.id)) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this conversation' });
    }

    const messages = await ChatMessage.find({ conversation: req.params.id })
      .populate('sender', 'name role avatar')
      .sort({ createdAt: 1 });

    // Mark as read
    await ChatMessage.updateMany(
      { conversation: req.params.id, sender: { $ne: req.user.id }, isRead: false },
      { $set: { isRead: true } }
    );

    res.status(200).json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Send a message
// @route   POST /api/v1/messages/conversations/:id
// @access  Private
exports.sendMessage = async (req, res) => {
  try {
    const { text, isFile, fileName, fileUrl } = req.body;
    let conversationId = req.params.id;

    let conversation = null;
    if (conversationId && conversationId.match(/^[0-9a-fA-F]{24}$/)) {
      conversation = await Conversation.findById(conversationId);
    }

    if (!conversation) {
      // If it's a new conversation, body should contain recipientId and optionally rfqId
      const { recipientId, rfqId } = req.body;
      if (!recipientId) {
        return res.status(400).json({ success: false, message: 'Recipient ID or existing conversation ID is required' });
      }

      conversation = await Conversation.create({
        participants: [req.user.id, recipientId],
        rfq: rfqId || null
      });
      conversationId = conversation._id;
    } else {
      // Verify participant
      if (!conversation.participants.includes(req.user.id)) {
        return res.status(403).json({ success: false, message: 'Not authorized to send messages in this conversation' });
      }
    }

    const message = await ChatMessage.create({
      conversation: conversationId,
      sender: req.user.id,
      text,
      isFile,
      fileName,
      fileUrl
    });

    conversation.lastMessage = message._id;
    conversation.lastMessageAt = message.createdAt;
    await conversation.save();

    await message.populate('sender', 'name role avatar');

    // Notify the other participants in the conversation
    const recipientIds = conversation.participants.filter(p => p.toString() !== req.user.id.toString());
    for (const recipientId of recipientIds) {
      await createNotification(
        req,
        recipientId,
        'New Message',
        `You have received a new message from ${message.sender.name || 'a user'}.`,
        'message',
        conversation._id
      );
    }

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
