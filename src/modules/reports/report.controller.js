const User = require('../users/user.model');
const Supplier = require('../suppliers/supplier.model');
const Rfq = require('../rfqs/rfq.model');
const Payment = require('../subscriptions/payment.model');

// @desc    Get master admin dashboard analytics
// @route   GET /api/v1/reports/dashboard
// @access  Private (Admin only)
exports.getDashboard = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalSuppliers = await Supplier.countDocuments();
    const totalRfqs = await Rfq.countDocuments();
    
    // Total revenue
    const payments = await Payment.find({ status: 'paid' });
    const totalRevenue = payments.reduce((acc, curr) => acc + curr.amount, 0);

    // New suppliers registered in the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const newSuppliers = await Supplier.countDocuments({ createdAt: { $gte: thirtyDaysAgo } });

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: `$${totalRevenue.toFixed(2)}`,
        totalUsers,
        totalSuppliers,
        newSuppliersLast30Days: newSuppliers,
        totalRfqs
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
