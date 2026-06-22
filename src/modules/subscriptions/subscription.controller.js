const Supplier = require('../suppliers/supplier.model');

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

    res.status(200).json({ 
        success: true, 
        message: 'Payment Successful! Your supplier profile has been upgraded to Premium.' 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
