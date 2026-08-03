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

    // --- 12 Month Chart Data ---
    const getLast12Months = () => {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const data = [];
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        data.push({
          name: months[d.getMonth()],
          month: d.getMonth(),
          year: d.getFullYear(),
          revenue: 0,
          users: 0,
          suppliers: 0,
          rfqs: 0
        });
      }
      return data;
    };

    const chartData = getLast12Months();
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const recentPayments = await Payment.find({ status: 'paid', createdAt: { $gte: twelveMonthsAgo } });
    const recentUsers = await User.find({ createdAt: { $gte: twelveMonthsAgo } });
    const recentSuppliers = await Supplier.find({ createdAt: { $gte: twelveMonthsAgo } });
    const recentRfqs = await Rfq.find({ createdAt: { $gte: twelveMonthsAgo } });

    const populateData = (items, key, valueField = null) => {
      items.forEach(item => {
        const d = new Date(item.createdAt || item.updatedAt);
        const m = d.getMonth();
        const y = d.getFullYear();
        const target = chartData.find(c => c.month === m && c.year === y);
        if (target) {
          if (valueField) target[key] += (item[valueField] || 0);
          else target[key] += 1;
        }
      });
    };

    populateData(recentPayments, 'revenue', 'amount');
    populateData(recentUsers, 'users');
    populateData(recentSuppliers, 'suppliers');
    populateData(recentRfqs, 'rfqs');

    res.status(200).json({
      success: true,
      data: {
        totalRevenue: totalRevenue, // Send as raw number instead of string for better frontend formatting
        totalUsers,
        totalSuppliers,
        newSuppliersLast30Days: newSuppliers,
        totalRfqs,
        chartData
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
