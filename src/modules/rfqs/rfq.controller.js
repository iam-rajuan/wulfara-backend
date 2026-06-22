const Rfq = require('./rfq.model');
const Supplier = require('../suppliers/supplier.model');

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
// @access  Private (Supplier only)
exports.updateRfqStatus = async (req, res) => {
  try {
    const { status } = req.body;

    // Find the supplier profile for the logged in user
    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
    }

    const rfq = await Rfq.findById(req.params.id);

    if (!rfq) {
      return res.status(404).json({ success: false, message: 'RFQ not found' });
    }

    // Ensure the RFQ belongs to this supplier
    if (rfq.supplier.toString() !== supplierProfile._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this RFQ' });
    }

    rfq.status = status;
    await rfq.save();

    res.status(200).json({ success: true, data: rfq });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
