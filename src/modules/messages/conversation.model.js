const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }],
  rfq: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Rfq',
    default: null
  },
  sourcingRequest: {
    type: String,
    default: null // Can store sourcing title if it's a general sourcing request
  },
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['active', 'archived', 'closed'],
    default: 'active'
  }
}, { timestamps: true });

module.exports = mongoose.model('Conversation', conversationSchema);
