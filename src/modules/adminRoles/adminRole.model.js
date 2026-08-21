const mongoose = require('mongoose');

const adminRoleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a role name'],
      trim: true,
    },
    slug: {
      type: String,
      required: [true, 'Please add a role slug'],
      trim: true,
      lowercase: true,
      unique: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AdminRole', adminRoleSchema);
