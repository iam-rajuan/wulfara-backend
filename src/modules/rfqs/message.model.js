const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  rfq: {
    type: mongoose.Schema.ObjectId,
    ref: 'Rfq',
    required: true
  },
  sender: {
    type: mongoose.Schema.ObjectId,
    ref: 'User',
    required: true
  },
  text: {
    type: String,
    required: [true, 'Please add message text']
  },
  attachments: {
    type: [String],
    default: []
  }
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
