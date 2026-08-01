const Rfq = require('./rfq.model');
const Supplier = require('../suppliers/supplier.model');
const sendEmail = require('../../utils/sendEmail');
const { generatePresignedUrl } = require('../../utils/s3');

// @desc    Submit an RFQ to a supplier
// @route   POST /api/v1/rfqs
// @access  Public (Guest or Logged in Buyer)
exports.createRfq = async (req, res) => {
  try {
    const { supplierId } = req.body;

    // Check if supplier exists
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Temporarily disable approval check so you can test RFQ easily!
    /*
    if (!supplier.isApproved) {
      return res.status(400).json({ success: false, message: 'Cannot send RFQ to a pending supplier profile' });
    }
    */

    // If user is logged in, automatically attach their user ID
    if (req.user) {
      req.body.buyerUser = req.user.id;
    }

    req.body.supplier = supplierId;

    const rfq = await Rfq.create(req.body);

    // Send confirmation email
    try {
      const message = `Hello ${req.body.buyerName},<br><br>Your Request for Quotation (RFQ) for <strong>${req.body.subject}</strong> has been successfully submitted to ${supplier.companyName}.<br><br>We will notify you when they respond.<br><br>Best,<br>B2B Platform Team`;
      
      await sendEmail({
        email: req.body.buyerEmail,
        subject: 'RFQ Confirmation Received',
        html: message
      });
    } catch (err) {
      console.log('Error sending confirmation email:', err.message);
    }

    res.status(201).json({ success: true, data: rfq });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get RFQs for a specific supplier
// @route   GET /api/v1/rfqs/supplier
// @access  Private (Supplier only)
exports.getSupplierRfqs = async (req, res) => {
  try {
    // Find the supplier profile for the logged in user
    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
    }

    const rfqs = await Rfq.find({ supplier: supplierProfile._id }).sort('-createdAt');

    res.status(200).json({ success: true, count: rfqs.length, data: rfqs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update RFQ status
// @route   PUT /api/v1/rfqs/:id/status
// @access  Private (Supplier or Admin)
exports.updateRfqStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const rfq = await Rfq.findById(req.params.id);

    if (!rfq) {
      return res.status(404).json({ success: false, message: 'RFQ not found' });
    }

    // If not admin, verify it belongs to this supplier
    if (req.user.role !== 'admin') {
      const supplierProfile = await Supplier.findOne({ user: req.user.id });
      if (!supplierProfile) {
        return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
      }
      if (rfq.supplier.toString() !== supplierProfile._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to update this RFQ' });
      }
    }

    rfq.status = status;
    await rfq.save();

    res.status(200).json({ success: true, data: rfq });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single RFQ
// @route   GET /api/v1/rfqs/:id
// @access  Private (Buyer, Supplier, or Admin)
exports.getRfqById = async (req, res) => {
  try {
    const rfq = await Rfq.findById(req.params.id)
      .populate('buyerUser', 'name email role')
      .populate('supplier', 'companyName contactEmail contactPhone logo');

    if (!rfq) {
      return res.status(404).json({ success: false, message: 'RFQ not found' });
    }

    // Security check: Make sure user is allowed to view it
    if (req.user.role !== 'admin') {
      const isBuyer = rfq.buyerUser && rfq.buyerUser._id.toString() === req.user.id;
      
      let isSupplier = false;
      if (req.user.role === 'supplier') {
        const supplierProfile = await Supplier.findOne({ user: req.user.id });
        if (supplierProfile && rfq.supplier._id.toString() === supplierProfile._id.toString()) {
          isSupplier = true;
        }
      }

      if (!isBuyer && !isSupplier) {
        return res.status(403).json({ success: false, message: 'Not authorized to view this RFQ' });
      }
    }

    res.status(200).json({ success: true, data: rfq });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get RFQs sent by the logged-in buyer
// @route   GET /api/v1/rfqs/buyer
// @access  Private (Buyer/User)
exports.getBuyerRfqs = async (req, res) => {
  try {
    const rfqs = await Rfq.find({ buyerUser: req.user.id })
      .populate('supplier', 'companyName logo contactEmail contactPhone')
      .sort('-createdAt');

    res.status(200).json({ success: true, count: rfqs.length, data: rfqs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const Message = require('./message.model');

// @desc    Add a message/reply to an RFQ thread
// @route   POST /api/v1/rfqs/:id/messages
// @access  Private (Buyer or Supplier)
exports.addMessageToRfq = async (req, res) => {
  try {
    const rfq = await Rfq.findById(req.params.id);
    if (!rfq) {
      return res.status(404).json({ success: false, message: 'RFQ not found' });
    }

    const message = await Message.create({
      rfq: rfq._id,
      sender: req.user.id,
      text: req.body.text,
      attachments: req.body.attachments || []
    });

    // Automatically update RFQ status if the supplier is replying
    if (req.user.role === 'supplier' && rfq.status === 'pending') {
        rfq.status = 'responded';
        await rfq.save();
    }

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all messages for an RFQ thread
// @route   GET /api/v1/rfqs/:id/messages
// @access  Private (Buyer or Supplier)
exports.getRfqMessages = async (req, res) => {
  try {
    const messages = await Message.find({ rfq: req.params.id })
      .populate('sender', 'name role')
      .sort('createdAt');

    res.status(200).json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all RFQs across the platform (Admin only)
// @route   GET /api/v1/rfqs
// @access  Private (Admin only)
exports.getGlobalRfqs = async (req, res) => {
  try {
    const rfqs = await Rfq.find()
      .populate('buyerUser', 'name email')
      .populate('supplier', 'companyName')
      .sort('-createdAt');

    res.status(200).json({ success: true, count: rfqs.length, data: rfqs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get presigned URL for RFQ attachment upload
// @route   POST /api/v1/rfqs/upload-url
// @access  Private
exports.getUploadUrl = async (req, res) => {
  try {
    const { contentType } = req.body;
    if (!contentType) {
      return res.status(400).json({ success: false, message: 'Content type is required' });
    }
    
    // Group uploads by user id in the rfqs folder
    const urlData = await generatePresignedUrl(`rfqs/${req.user.id}`, contentType);
    
    res.status(200).json({ success: true, data: urlData });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
