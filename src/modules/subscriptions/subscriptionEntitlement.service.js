const Subscription = require('./subscription.model');
const Supplier = require('../suppliers/supplier.model');
const { syncSupplierLifecycle } = require('../suppliers/supplierLifecycle');

const ENDABLE_STATUSES = [
  'pending_checkout',
  'incomplete',
  'active',
  'trialing',
  'past_due',
  'payment_failed',
  'requires_action',
  'unpaid',
];

let expirationScheduler = null;

const expireSupplierForEndedSubscription = async (subscription) => {
  const supplier = await Supplier.findById(subscription.supplier);
  if (!supplier) {
    return;
  }

  subscription.status = subscription.billingCycleType === 'annual'
    ? 'expired'
    : subscription.cancelAtPeriodEnd
      ? 'canceled'
      : 'completed';
  subscription.nextPaymentDate = null;
  await subscription.save();

  supplier.subscriptionStatus = subscription.status === 'canceled' ? 'cancelled' : 'inactive';
  supplier.paymentStatus = subscription.status === 'canceled' ? 'cancelled' : 'unpaid';
  supplier.isApproved = false;
  supplier.listingStatus = 'Hidden';
  if (supplier.featuredHeroPlacement?.enabled) {
    supplier.featuredHeroPlacement.enabled = false;
  }
  syncSupplierLifecycle(supplier);
  await supplier.save();
};

const expireElapsedSubscriptions = async ({ supplierId } = {}) => {
  const now = new Date();
  const query = {
    status: { $in: ENDABLE_STATUSES },
    subscriptionEndDate: { $ne: null, $lte: now },
  };

  if (supplierId) {
    query.supplier = supplierId;
  }

  const subscriptions = await Subscription.find(query);
  await Promise.all(subscriptions.map(expireSupplierForEndedSubscription));
  return subscriptions.length;
};

const isSupplierEntitled = (supplier) =>
  Boolean(
    supplier &&
      supplier.subscriptionStatus === 'active' &&
      supplier.paymentStatus === 'paid' &&
      supplier.isApproved === true &&
      supplier.listingStatus === 'Approved'
  );

const evaluateSupplierEntitlement = async (supplierOrId) => {
  const supplierId = supplierOrId?._id || supplierOrId;
  if (!supplierId) {
    return { active: false, supplier: null };
  }

  await expireElapsedSubscriptions({ supplierId });
  const supplier = await Supplier.findById(supplierId);

  return {
    active: isSupplierEntitled(supplier),
    supplier,
  };
};

const requireActiveSupplierEntitlement = async (req, res, next) => {
  try {
    if (req.user?.role === 'admin') {
      return next();
    }

    if (req.user?.role !== 'supplier') {
      return next();
    }

    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    const entitlement = await evaluateSupplierEntitlement(supplierProfile._id);
    if (!entitlement.active) {
      return res.status(403).json({
        success: false,
        message: 'An active subscription is required to use this supplier feature.',
      });
    }

    req.supplierProfile = entitlement.supplier;
    return next();
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const startSubscriptionExpirationScheduler = ({
  intervalMs = Number(process.env.SUBSCRIPTION_EXPIRATION_INTERVAL_MS || 15 * 60 * 1000),
} = {}) => {
  if (expirationScheduler || process.env.NODE_ENV === 'test') {
    return expirationScheduler;
  }

  const runExpiration = () => {
    expireElapsedSubscriptions().catch((error) => {
      console.error('Subscription expiration scheduler failed:', error.message);
    });
  };

  runExpiration();
  expirationScheduler = setInterval(runExpiration, intervalMs);
  if (typeof expirationScheduler.unref === 'function') {
    expirationScheduler.unref();
  }
  return expirationScheduler;
};

const stopSubscriptionExpirationScheduler = () => {
  if (!expirationScheduler) {
    return;
  }

  clearInterval(expirationScheduler);
  expirationScheduler = null;
};

module.exports = {
  evaluateSupplierEntitlement,
  expireElapsedSubscriptions,
  expireSupplierForEndedSubscription,
  isSupplierEntitled,
  requireActiveSupplierEntitlement,
  startSubscriptionExpirationScheduler,
  stopSubscriptionExpirationScheduler,
};
