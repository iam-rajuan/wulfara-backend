const Supplier = require('../suppliers/supplier.model');
const Payment = require('./payment.model');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
const PricingPlan = require('./pricingPlan.model');
const { inferPlanTier } = require('./planTier');
const { resolveAppOrigin } = require('../../utils/origins');
const {
  hasCompanyInfo,
  hasIndustrySelection,
  deriveListingPeriod,
  syncSupplierLifecycle,
} = require('../suppliers/supplierLifecycle');

const getSupplierForCheckout = async (req) => {
  if (req.user.role === 'admin' && req.body.supplierId) {
    return Supplier.findById(req.body.supplierId);
  }

  return Supplier.findOne({ user: req.user.id });
};

// @desc    Create a Stripe Checkout Session
// @route   POST /api/v1/subscriptions/checkout-session
// @access  Private (Supplier only)
exports.createCheckoutSession = async (req, res) => {
  try {
    const { planId } = req.body;
    
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Please provide planId' });
    }

    const supplierProfile = await getSupplierForCheckout(req);
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'You do not have a supplier profile' });
    }

    if (!hasIndustrySelection(supplierProfile) || !hasCompanyInfo(supplierProfile)) {
      return res.status(400).json({
        success: false,
        message: 'Complete industry and company information before starting checkout',
      });
    }

    const plan = await PricingPlan.findOne({
      _id: planId,
      isActive: true,
    });

    if (!plan) {
      return res.status(404).json({ success: false, message: 'Selected pricing plan was not found or is inactive' });
    }

    const price = plan.price;
    const resolvedBillingCycle = plan.billingCycle || '';
    const resolvedListingPeriod = deriveListingPeriod(
      resolvedBillingCycle,
      supplierProfile.selectedListingPeriod
    );

    supplierProfile.selectedPlan = plan._id;
    supplierProfile.selectedBillingCycle = resolvedBillingCycle;
    supplierProfile.selectedListingPeriod = resolvedListingPeriod;
    supplierProfile.subscriptionPlan = inferPlanTier(plan);
    supplierProfile.subscriptionStatus = 'pending';
    supplierProfile.paymentStatus = 'pending';
    syncSupplierLifecycle(supplierProfile);
    await supplierProfile.save();

    const appOrigin = resolveAppOrigin(req, process.env.DASHBOARD_ORIGIN);
    if (!appOrigin) {
      return res.status(500).json({
        success: false,
        message: 'DASHBOARD_ORIGIN must be configured before starting supplier checkout in production',
      });
    }

    const adminAssistedQuery =
      req.user.role === 'admin'
        ? `?session_id={CHECKOUT_SESSION_ID}&supplierId=${supplierProfile._id.toString()}&mode=admin_assisted`
        : '?session_id={CHECKOUT_SESSION_ID}';
    const cancelQuery =
      req.user.role === 'admin'
        ? `?cancelled=1&supplierId=${supplierProfile._id.toString()}&mode=admin_assisted`
        : '?cancelled=1';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `WULFARA ${plan.name} Plan - ${resolvedBillingCycle || 'One-Time Payment'}`,
              description: plan.description || 'B2B Marketplace Supplier Subscription'
            },
            unit_amount: Math.round(price * 100), // Stripe expects amounts in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment', // Use 'payment' for one-time or 'subscription' if using Stripe Billing
      success_url: `${appOrigin}/listed${adminAssistedQuery}`,
      cancel_url: `${appOrigin}/subscription${cancelQuery}`,
      client_reference_id: supplierProfile._id.toString(),
      metadata: {
        supplierId: supplierProfile._id.toString(),
        planId: plan._id.toString(),
        planName: plan.name,
        planTier: inferPlanTier(plan),
        billingCycle: resolvedBillingCycle,
        listingPeriod: resolvedListingPeriod,
      }
    });

    res.status(200).json({
      success: true,
      message: 'Checkout session created',
      paymentUrl: session.url,
      orderSummary: {
        planId: plan._id,
        planName: plan.name,
        billingCycle: resolvedBillingCycle,
        listingPeriod: resolvedListingPeriod,
        basePrice: price,
        totalDueToday: price,
      },
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
    const planId = session.metadata?.planId || null;
    const planTier = session.metadata?.planTier || null;
    const billingCycle = session.metadata?.billingCycle || '';
    const listingPeriod = session.metadata?.listingPeriod || '';

    try {
      const supplierProfile = await Supplier.findById(supplierId);
      if (supplierProfile) {
        const existingPayment = await Payment.findOne({ stripeSessionId: session.id });
        if (existingPayment) {
          return res.status(200).json({ received: true, duplicate: true });
        }

        const selectedPlan = planId ? await PricingPlan.findById(planId) : null;

        supplierProfile.subscriptionPlan = inferPlanTier(selectedPlan || planTier || planName);
        supplierProfile.selectedPlan = planId || supplierProfile.selectedPlan;
        supplierProfile.selectedBillingCycle = billingCycle || supplierProfile.selectedBillingCycle;
        supplierProfile.selectedListingPeriod = listingPeriod || supplierProfile.selectedListingPeriod;
        supplierProfile.subscriptionStatus = 'active';
        supplierProfile.paymentStatus = 'paid';
        supplierProfile.isApproved = true;
        supplierProfile.listingStatus = 'Approved';
        supplierProfile.stripeCustomerId = session.customer;
        syncSupplierLifecycle(supplierProfile);
        await supplierProfile.save();

        await Payment.create({
          supplier: supplierProfile._id,
          plan: planId,
          planName,
          billingCycle,
          listingPeriod,
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

// @desc    Get all active supplier subscriptions (Admin)
// @route   GET /api/v1/subscriptions/admin/active
// @access  Private/Admin
exports.getActiveSubscriptions = async (req, res) => {
  try {
    const suppliers = await Supplier.find({
      subscriptionStatus: 'active',
      paymentStatus: 'paid',
      isApproved: true,
      listingStatus: 'Approved',
    })
      .populate({ path: 'user', select: 'name email status isVerified' })
      .populate({ path: 'selectedPlan', select: 'name slug price billingCycle isActive' })
      .sort('-updatedAt');

    res.status(200).json({
      success: true,
      count: suppliers.length,
      data: suppliers,
    });
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
