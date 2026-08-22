const User = require('../users/user.model');
const Supplier = require('../suppliers/supplier.model');
const Rfq = require('../rfqs/rfq.model');
const Payment = require('../subscriptions/payment.model');

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const getLast12Months = () => {
  const data = [];
  const now = new Date();

  for (let i = 11; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    data.push({
      name: MONTH_LABELS[date.getMonth()],
      month: date.getMonth(),
      year: date.getFullYear(),
      revenue: 0,
      users: 0,
      suppliers: 0,
      rfqs: 0,
    });
  }

  return data;
};

const populateMonthlySeries = (series, items, key, valueField = null) => {
  items.forEach((item) => {
    const date = new Date(item.createdAt || item.updatedAt);
    const month = date.getMonth();
    const year = date.getFullYear();
    const target = series.find((entry) => entry.month === month && entry.year === year);

    if (!target) {
      return;
    }

    if (valueField) {
      target[key] += item[valueField] || 0;
      return;
    }

    target[key] += 1;
  });
};

const formatRfqDisplayId = (rfq) => {
  const rawId = String(rfq?._id || '').slice(-6).toUpperCase();
  return rawId ? `#RFQ-${rawId}` : 'RFQ';
};

const getListingStatusBadge = (status = '') => {
  switch (status) {
    case 'Approved':
      return 'success';
    case 'Rejected':
      return 'danger';
    case 'Hidden':
    case 'Suspended':
      return 'muted';
    case 'Pending':
    default:
      return 'warning';
  }
};

const getRfqStatusBadge = (status = '') => {
  switch (status) {
    case 'responded':
    case 'reviewed':
      return 'warning';
    case 'closed':
    case 'resolved':
      return 'muted';
    case 'disputed':
      return 'danger';
    case 'pending':
    default:
      return 'info';
  }
};

const titleCase = (value = '') =>
  value
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

// @desc    Get master admin dashboard analytics
// @route   GET /api/v1/reports/dashboard
// @access  Private (Admin only)
exports.getDashboard = async (req, res) => {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const previousThirtyDaysAgo = new Date(thirtyDaysAgo);
    previousThirtyDaysAgo.setDate(previousThirtyDaysAgo.getDate() - 30);

    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalSuppliers,
      totalRfqs,
      pendingListings,
      activeSubscriptions,
      newSuppliersLast30Days,
      newUsersLast30Days,
      previousUsersLast30Days,
      unverifiedSupplierAccounts,
      payments,
      recentPayments,
      recentUsers,
      recentSuppliers,
      recentRfqsForChart,
      latestSuppliers,
      latestRfqs,
    ] = await Promise.all([
      User.countDocuments(),
      Supplier.countDocuments(),
      Rfq.countDocuments(),
      Supplier.countDocuments({ listingStatus: 'Pending' }),
      Supplier.countDocuments({ subscriptionStatus: 'active' }),
      Supplier.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
      User.countDocuments({ createdAt: { $gte: previousThirtyDaysAgo, $lt: thirtyDaysAgo } }),
      User.countDocuments({ role: 'supplier', isVerified: false }),
      Payment.find({ status: 'paid' }),
      Payment.find({ status: 'paid', createdAt: { $gte: twelveMonthsAgo } }),
      User.find({ createdAt: { $gte: twelveMonthsAgo } }).select('createdAt'),
      Supplier.find({ createdAt: { $gte: twelveMonthsAgo } }).select('createdAt'),
      Rfq.find({ createdAt: { $gte: twelveMonthsAgo } }).select('createdAt'),
      Supplier.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .populate({ path: 'categories', select: 'name' })
        .populate({ path: 'selectedPlan', select: 'name' })
        .select('companyName categories selectedPlan subscriptionPlan listingStatus createdAt'),
      Rfq.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .populate({ path: 'supplier', select: 'categories companyName', populate: { path: 'categories', select: 'name' } })
        .populate({ path: 'buyerUser', select: 'name' })
        .select('buyerName buyerUser subject status createdAt supplier'),
    ]);

    const totalRevenue = payments.reduce((sum, payment) => sum + (payment.amount || 0), 0);
    const revenueSeries = getLast12Months();

    populateMonthlySeries(revenueSeries, recentPayments, 'revenue', 'amount');
    populateMonthlySeries(revenueSeries, recentUsers, 'users');
    populateMonthlySeries(revenueSeries, recentSuppliers, 'suppliers');
    populateMonthlySeries(revenueSeries, recentRfqsForChart, 'rfqs');

    const userGrowthDelta = newUsersLast30Days - previousUsersLast30Days;
    const userGrowthPercent =
      previousUsersLast30Days > 0
        ? Math.round((userGrowthDelta / previousUsersLast30Days) * 100)
        : newUsersLast30Days > 0
          ? 100
          : 0;

    const recentSupplierListings = latestSuppliers.map((supplier) => ({
      id: supplier._id,
      company: supplier.companyName,
      category: supplier.categories?.[0]?.name || 'Uncategorized',
      plan: supplier.selectedPlan?.name || titleCase(supplier.subscriptionPlan || 'Free'),
      status: supplier.listingStatus || 'Pending',
      statusTone: getListingStatusBadge(supplier.listingStatus),
      createdAt: supplier.createdAt,
    }));

    const recentRfqs = latestRfqs.map((rfq) => ({
      id: rfq._id,
      displayId: formatRfqDisplayId(rfq),
      buyer: rfq.buyerUser?.name || rfq.buyerName || 'Buyer',
      category: rfq.supplier?.categories?.[0]?.name || 'General',
      status: titleCase(rfq.status || 'pending'),
      statusTone: getRfqStatusBadge(rfq.status),
      createdAt: rfq.createdAt,
      subject: rfq.subject || '',
    }));

    const priorityActions = [
      {
        key: 'pending-listings',
        title: 'Review Pending Listings',
        count: pendingListings,
        tone: 'warning',
      },
      {
        key: 'verify-suppliers',
        title: 'Verify Supplier Accounts',
        count: unverifiedSupplierAccounts,
        tone: 'info',
      },
    ];

    res.status(200).json({
      success: true,
      data: {
        totalRevenue,
        totalUsers,
        totalSuppliers,
        totalRfqs,
        pendingListings,
        activeSubscriptions,
        newSuppliersLast30Days,
        newUsersLast30Days,
        previousUsersLast30Days,
        userGrowthDelta,
        userGrowthPercent,
        unverifiedSupplierAccounts,
        chartData: revenueSeries,
        recentSupplierListings,
        recentRfqs,
        priorityActions,
        supportTicketsAvailable: false,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
