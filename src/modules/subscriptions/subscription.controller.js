const Supplier = require('../suppliers/supplier.model');
const Payment = require('./payment.model');

// @desc    Simulate creating a Stripe Checkout Session
// @route   POST /api/v1/subscriptions/checkout-session
// @access  Private (Supplier only)
exports.createCheckoutSession = async (req, res) => {
  try {
    const supplierProfile = await Supplier.findOne({ user: req.user.id });

    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
    }

    if (supplierProfile.subscriptionPlan === 'premium') {
      return res.status(400).json({ success: false, message: 'You are already on the Premium plan' });
    }

    // In the future, this is where you would call stripe.checkout.sessions.create()
    // For now, we simulate returning a checkout URL
    const dummyCheckoutUrl = `http://localhost:5000/api/v1/subscriptions/simulate-payment?supplierId=${supplierProfile._id}`;

    res.status(200).json({
      success: true,
      message: 'Checkout session created. Navigate to paymentUrl to complete payment.',
      paymentUrl: dummyCheckoutUrl
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
// @desc    Simulate Stripe Webhook / Successful Payment
// @route   GET /api/v1/subscriptions/simulate-payment
// @access  Public (Simulating Webhook)
exports.simulateWebhook = async (req, res) => {
  try {
    const { supplierId } = req.query;

    if (!supplierId) {
      return res.status(400).json({ success: false, message: 'Missing supplierId' });
    }
    const supplierProfile = await Supplier.findById(supplierId);
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    // Upgrade the supplier to premium
    supplierProfile.subscriptionPlan = 'premium';
    // Simulate assigning a stripe customer ID
    supplierProfile.stripeCustomerId = `cus_dummy_${Math.random().toString(36).substring(7)}`;
    await supplierProfile.save();
    // Create a dummy payment record (invoice)
    await Payment.create({
      supplier: supplierProfile._id,
      amount: 49.99, // dummy premium price
      status: 'paid',
      invoiceUrl: `https://dummy-invoice.stripe.com/${Math.random().toString(36).substring(7)}`
    });

    res.status(200).json({
      success: true,
      message: 'Payment Successful! Your supplier profile has been upgraded to Premium.'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all invoices/payments for the logged-in supplier
// @route   GET /api/v1/subscriptions/invoices
// @access  Private (Supplier only)
exports.getInvoices = async (req, res) => {
  try {
    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    const payments = await Payment.find({ supplier: supplierProfile._id }).sort('-createdAt');

    res.status(200).json({ success: true, count: payments.length, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const PricingPlan = require('./pricingPlan.model');

// @desc    Get all active pricing plans
// @route   GET /api/v1/subscriptions/plans
// @access  Public
exports.getPlans = async (req, res) => {
  try {
    const plans = await PricingPlan.find({ isActive: true });
    res.status(200).json({ success: true, count: plans.length, data: plans });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single pricing plan
// @route   GET /api/v1/subscriptions/plans/:id
// @access  Public
exports.getPlan = async (req, res) => {
  try {
    const plan = await PricingPlan.findById(req.params.id);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }
    res.status(200).json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a new pricing plan
// @route   POST /api/v1/subscriptions/plans
// @access  Private (Admin only)
exports.createPlan = async (req, res) => {
  try {
    const plan = await PricingPlan.create(req.body);
    res.status(201).json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update a pricing plan
// @route   PUT /api/v1/subscriptions/plans/:id
// @access  Private (Admin only)
exports.updatePlan = async (req, res) => {
  try {
    const plan = await PricingPlan.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    res.status(200).json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
