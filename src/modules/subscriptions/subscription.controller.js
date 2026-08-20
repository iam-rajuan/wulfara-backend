const Supplier = require('../suppliers/supplier.model');
const Payment = require('./payment.model');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
const PricingPlan = require('./pricingPlan.model');

const getRequestOrigin = (req) => {
  const origin = req.get('origin');
  if (origin) {
    return origin.replace(/\/+$/, '');
  }

  const referer = req.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch (error) {
      return null;
    }
  }

  return null;
};

// @desc    Create a Stripe Checkout Session
// @route   POST /api/v1/subscriptions/checkout-session
// @access  Private (Supplier only)
exports.createCheckoutSession = async (req, res) => {
  try {
    const { planId, billingCycle } = req.body;
    
    if (!planId || !billingCycle) {
      return res.status(400).json({ success: false, message: 'Please provide planId and billingCycle' });
    }

    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
    }

    let plan;
    // Try by ID first (in case frontend passes ObjectId), fallback to finding by name (e.g. 'premium')
    try {
      plan = await PricingPlan.findById(planId);
    } catch(e) {
      plan = await PricingPlan.findOne({ name: new RegExp(planId, 'i') });
    }
    
    if (!plan) {
      plan = await PricingPlan.findOne({ name: new RegExp(planId, 'i') });
    }

    if (!plan) {
      // Create a fallback mock plan for development if not found
      plan = {
        _id: 'mock_plan_id_123',
        name: planId.charAt(0).toUpperCase() + planId.slice(1),
        price: planId === 'premium' ? 299 : (planId === 'pro' ? 129 : 49),
        description: 'B2B Marketplace Supplier Subscription'
      };
    }

    const price = plan.price; // Get the price directly from the plan document

    const appOrigin = getRequestOrigin(req) || 'http://localhost:5173';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `WULFARA ${plan.name} Plan - ${billingCycle}`,
              description: plan.description || 'B2B Marketplace Supplier Subscription'
            },
            unit_amount: Math.round(price * 100), // Stripe expects amounts in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment', // Use 'payment' for one-time or 'subscription' if using Stripe Billing
      success_url: `${appOrigin}/listed?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/subscription`,
      client_reference_id: supplierProfile._id.toString(),
      metadata: {
        supplierId: supplierProfile._id.toString(),
        planId: plan._id.toString(),
        planName: plan.name,
        billingCycle
      }
    });

    res.status(200).json({
      success: true,
      message: 'Checkout session created',
      paymentUrl: session.url
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Stripe Webhook Handler
// @route   POST /api/v1/subscriptions/webhook
// @access  Public
exports.stripeWebhook = async (req, res) => {
  const payload = req.body;
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';

  let event;

  try {
    // Only construct event if a secret is provided, otherwise trust payload (for dev fallback)
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
    } else {
      // Parse raw body for dev fallback if no secret is configured
      event = JSON.parse(payload.toString());
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const supplierId = session.client_reference_id || session.metadata.supplierId;
    const planName = session.metadata?.planName || 'premium';

    try {
      const supplierProfile = await Supplier.findById(supplierId);
      if (supplierProfile) {
        supplierProfile.subscriptionPlan = planName.toLowerCase();
        supplierProfile.stripeCustomerId = session.customer;
        await supplierProfile.save();

        await Payment.create({
          supplier: supplierProfile._id,
          amount: session.amount_total / 100,
          status: 'paid',
          stripeSessionId: session.id,
          // If invoice exists (in subscription mode), you can save invoiceUrl
        });
      }
    } catch (err) {
      console.error('Error upgrading supplier profile:', err);
    }
  }

  res.status(200).json({ received: true });
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

// @desc    Get all payments (Admin)
// @route   GET /api/v1/subscriptions/admin/payments
// @access  Private/Admin
exports.getAllPayments = async (req, res) => {
  try {
    const payments = await Payment.find().populate('supplier').sort('-createdAt');
    res.status(200).json({ success: true, count: payments.length, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


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

// @desc    Delete a pricing plan
// @route   DELETE /api/v1/subscriptions/plans/:id
// @access  Private (Admin only)
exports.deletePlan = async (req, res) => {
  try {
    const plan = await PricingPlan.findById(req.params.id);

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    await PricingPlan.findByIdAndDelete(req.params.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
