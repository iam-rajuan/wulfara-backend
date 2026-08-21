const Supplier = require('./supplier.model');
const { generatePresignedUrl } = require('../../utils/s3');
const geocodeAddress = require('../../utils/geocode');
const { createNotification } = require('../../utils/notificationService');
const User = require('../users/user.model');
const Category = require('../categories/category.model');
const PricingPlan = require('../subscriptions/pricingPlan.model');
const { inferPlanTier } = require('../subscriptions/planTier');
const {
  getOnboardingRoute,
  hasCompanyInfo,
  hasIndustrySelection,
  deriveListingPeriod,
  isSupplierListed,
  syncSupplierLifecycle,
} = require('./supplierLifecycle');

const ADMIN_SAFE_USER_SELECT = 'name email role status isVerified';

const normalizeWebsiteUrl = (value = '') => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
};

const buildOnboardingPayload = (supplier) => {
  const nextStep = syncSupplierLifecycle(supplier);

  return {
    step: nextStep,
    nextRoute: getOnboardingRoute(nextStep),
    isComplete: nextStep === 'listed',
  };
};

const getSupplierForRequest = async (req, options = {}) => {
  const supplierId =
    options.supplierId ||
    req.query?.supplierId ||
    req.body?.supplierId;

  if (req.user.role === 'admin') {
    if (!supplierId) {
      return null;
    }

    return Supplier.findById(supplierId);
  }

  return Supplier.findOne({ user: req.user.id });
};

// @desc    Get all suppliers (with optional category filtering)
// @route   GET /api/v1/suppliers
// @access  Public
exports.getSuppliers = async (req, res) => {
  try {
    let query;
    const andConditions = [];

    // Copy req.query
    const reqQuery = { ...req.query };

    // Fields to exclude
    const removeFields = [
      'select',
      'sort',
      'page',
      'limit',
      'keyword',
      'lat',
      'lng',
      'distance',
      'supplierType',
      'listed',
      'eligibleForRfq',
    ];

    // Loop over removeFields and delete them from reqQuery
    removeFields.forEach(param => delete reqQuery[param]);

    if (req.query.supplierType) {
      if (typeof req.query.supplierType === 'string' && req.query.supplierType.includes(',')) {
        reqQuery.supplierType = { $in: req.query.supplierType.split(',').map(s => s.trim()) };
      } else if (Array.isArray(req.query.supplierType)) {
        reqQuery.supplierType = { $in: req.query.supplierType };
      } else {
        reqQuery.supplierType = req.query.supplierType;
      }
    }

    if (req.query.location) {
      reqQuery['location.formattedAddress'] = { $regex: req.query.location, $options: 'i' };
    }

    if (req.query.keyword) {
      andConditions.push({
        $or: [
        { companyName: { $regex: req.query.keyword, $options: 'i' } },
        { description: { $regex: req.query.keyword, $options: 'i' } }
      ],
      });
    }

    // Geospatial querying
    if (req.query.lat && req.query.lng && req.query.distance) {
      const lat = parseFloat(req.query.lat);
      const lng = parseFloat(req.query.lng);
      const distance = parseInt(req.query.distance, 10); // in kilometers
      
      const radius = distance / 6378.1; // Divide distance by radius of Earth in km

      reqQuery.location = {
        $geoWithin: { $centerSphere: [[lng, lat], radius] }
      };
    }

    // Only show listed suppliers to the public, unless admin is requesting
    if (!req.user || req.user.role !== 'admin') {
      andConditions.push({
        $or: [
          {
            isApproved: true,
            listingStatus: 'Approved',
            subscriptionStatus: 'active',
            paymentStatus: 'paid',
          },
          {
            onboardingStep: 'listed',
            onboardingCompletedAt: { $ne: null },
          },
        ],
      });
    }

    if (req.query.listed === 'true' || req.query.eligibleForRfq === 'true') {
      andConditions.push({
        $or: [
          {
            isApproved: true,
            listingStatus: 'Approved',
            subscriptionStatus: 'active',
            paymentStatus: 'paid',
          },
          {
            onboardingStep: 'listed',
            onboardingCompletedAt: { $ne: null },
          },
        ],
      });
    }

    if (andConditions.length > 0) {
      reqQuery.$and = andConditions;
    }

    query = Supplier.find(reqQuery).populate({
      path: 'categories',
      select: 'name slug parentCategory status'
    });

    if (req.user?.role === 'admin') {
      query = query.populate({
        path: 'user',
        select: ADMIN_SAFE_USER_SELECT
      });
    }

    const suppliers = await query;
    res.status(200).json({ success: true, count: suppliers.length, data: suppliers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single supplier
// @route   GET /api/v1/suppliers/:id
// @access  Public
exports.getSupplier = async (req, res) => {
  try {
    let query = Supplier.findById(req.params.id).populate({
      path: 'categories',
      select: 'name slug parentCategory status'
    });

    if (req.user?.role === 'admin') {
      query = query.populate({
        path: 'user',
        select: ADMIN_SAFE_USER_SELECT
      });
    }

    const supplier = await query;

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    
    const publiclyVisible = isSupplierListed(supplier);

    // If not listed yet, only admin or the supplier themselves can view it
    if (!publiclyVisible) {
        if (!req.user || (req.user.role !== 'admin' && req.user.id !== supplier.user.toString())) {
            return res.status(403).json({ success: false, message: 'Supplier profile is pending approval' });
        }
    }

    // Increment view count for the current month
    const currentDate = new Date();
    const monthKey = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
    
    // Only count views if it's not the supplier themselves viewing their own profile
    if (!req.user || req.user.id !== supplier.user.toString()) {
      await Supplier.findByIdAndUpdate(supplier._id, { $inc: { [`monthlyViews.${monthKey}`]: 1 } });
    }

    res.status(200).json({ success: true, data: supplier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create supplier profile
// @route   POST /api/v1/suppliers
// @access  Private (Supplier only)
exports.createSupplierProfile = async (req, res) => {
  try {
    // Add user to req.body
    req.body.user = req.user.id;
    req.body.website = normalizeWebsiteUrl(req.body.website);

    // Check if user already has a published profile
    const existingProfile = await Supplier.findOne({ user: req.user.id });
    if (existingProfile) {
      return res.status(400).json({ success: false, message: 'You already have a supplier profile' });
    }

    // Geocode address if provided
    if (req.body.address) {
      const geoResult = await geocodeAddress(req.body.address);
      if (geoResult) {
        req.body.location = {
          type: 'Point',
          coordinates: geoResult.coordinates,
          formattedAddress: geoResult.formattedAddress
        };
      } else {
        req.body.location = {
          type: 'Point',
          coordinates: [0, 0],
          formattedAddress: req.body.address
        };
      }
    }

    const supplier = await Supplier.create(req.body);
    syncSupplierLifecycle(supplier);
    await supplier.save();
    res.status(201).json({ success: true, data: supplier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update supplier profile
// @route   PUT /api/v1/suppliers/:id
// @access  Private (Supplier or Admin)
exports.updateSupplierProfile = async (req, res) => {
  try {
    let supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Make sure user is the profile owner or admin
    if (supplier.user.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to update this profile' });
    }

    // Don't allow regular users to modify protected lifecycle fields
    if (req.user.role !== 'admin') {
      [
        'isApproved',
        'listingStatus',
        'onboardingStep',
        'onboardingCompletedAt',
        'subscriptionStatus',
        'paymentStatus',
        'subscriptionPlan',
        'selectedPlan',
        'selectedBillingCycle',
        'selectedListingPeriod',
        'stripeCustomerId',
        'user',
      ].forEach((field) => {
        if (field in req.body) {
          delete req.body[field];
        }
      });
    }

    if ('website' in req.body) {
      req.body.website = normalizeWebsiteUrl(req.body.website);
    }

    // Geocode address if provided
    if (req.body.address) {
      const geoResult = await geocodeAddress(req.body.address);
      if (geoResult) {
        req.body.location = {
          type: 'Point',
          coordinates: geoResult.coordinates,
          formattedAddress: geoResult.formattedAddress
        };
      } else {
        req.body.location = {
          type: 'Point',
          coordinates: [0, 0],
          formattedAddress: req.body.address
        };
      }
    }

    supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    syncSupplierLifecycle(supplier);
    await supplier.save();

    res.status(200).json({ success: true, data: supplier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Delete supplier profile
// @route   DELETE /api/v1/suppliers/:id
// @access  Private (Supplier or Admin)
exports.deleteSupplierProfile = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }

    // Make sure user is the profile owner or admin
    if (supplier.user.toString() !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized to delete this profile' });
    }

    await supplier.deleteOne();

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get pre-signed URL for S3 upload
// @route   POST /api/v1/suppliers/upload-url
// @access  Private (Supplier only)
exports.getUploadUrl = async (req, res) => {
  try {
    const { folder, contentType } = req.body;
    
    // Ensure valid content type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!contentType || !allowedTypes.includes(contentType)) {
        return res.status(400).json({ success: false, message: 'Please provide a valid contentType (image/jpeg, image/png, image/webp, application/pdf)' });
    }
    
    // Ensure valid folder
    if (!folder || !['logos', 'galleries', 'documents'].includes(folder)) {
        return res.status(400).json({ success: false, message: 'Please provide a valid folder (logos, galleries, or documents)' });
    }

    const urlData = await generatePresignedUrl(`suppliers/${req.user.id}/${folder}`, contentType);

    res.status(200).json({ success: true, data: urlData });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const Rfq = require('../rfqs/rfq.model');

// @desc    Get dashboard analytics for the logged-in supplier
// @route   GET /api/v1/suppliers/dashboard
// @access  Private (Supplier only)
exports.getSupplierDashboard = async (req, res) => {
  try {
    const supplierProfile = await Supplier.findOne({ user: req.user.id });
    
    if (!supplierProfile) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    // Aggregate stats
    const totalRfqs = await Rfq.countDocuments({ supplier: supplierProfile._id });
    const pendingRfqs = await Rfq.countDocuments({ supplier: supplierProfile._id, status: 'pending' });

    // Profile completion calculation (basic)
    let completedFields = 0;
    const totalFields = 6;
    
    if (supplierProfile.companyName) completedFields++;
    if (supplierProfile.description) completedFields++;
    if (supplierProfile.contactEmail) completedFields++;
    if (supplierProfile.contactPhone) completedFields++;
    if (supplierProfile.logo && supplierProfile.logo !== 'no-logo.jpg') completedFields++;
    if (supplierProfile.categories && supplierProfile.categories.length > 0) completedFields++;

    const profileCompletionPercentage = Math.round((completedFields / totalFields) * 100);

    // Generate analytics data for the last 6 months
    const analytics = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const name = d.toLocaleString('default', { month: 'short' });
      analytics.push({
        name,
        views: supplierProfile.monthlyViews?.get(key) || 0
      });
    }

    const onboarding = buildOnboardingPayload(supplierProfile);
    await supplierProfile.save();

    const dashboardData = {
      totalRfqs,
      pendingRfqs,
      profileCompletion: `${profileCompletionPercentage}%`,
      subscriptionPlan: supplierProfile.subscriptionPlan,
      isApproved: supplierProfile.isApproved,
      subscriptionStatus: supplierProfile.subscriptionStatus,
      paymentStatus: supplierProfile.paymentStatus,
      analytics
    };

    res.status(200).json({ 
      success: true, 
      data: {
        profile: supplierProfile,
        stats: dashboardData,
        onboarding
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Review a supplier listing (Approve/Reject/Pending)
// @route   PUT /api/v1/suppliers/:id/review
// @access  Private (Admin only)
exports.reviewSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    
    if (req.body.listingStatus) {
      supplier.listingStatus = req.body.listingStatus;
      supplier.isApproved = req.body.listingStatus === 'Approved';
    } else if (req.body.isApproved !== undefined) {
      // Fallback for backwards compatibility
      supplier.isApproved = req.body.isApproved;
      supplier.listingStatus = req.body.isApproved ? 'Approved' : 'Pending';
    }

    syncSupplierLifecycle(supplier);
    await supplier.save();

    if (supplier.user) {
      await createNotification(
        req,
        supplier.user,
        'Profile Review Update',
        `Your supplier profile status has been updated to ${supplier.listingStatus}.`,
        'approval',
        supplier._id
      );
    }

    res.status(200).json({ success: true, data: supplier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Feature a supplier listing
// @route   PUT /api/v1/suppliers/:id/feature
// @access  Private (Admin only)
exports.featureSupplier = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    
    supplier.isFeatured = req.body.isFeatured;
    await supplier.save();

    res.status(200).json({ success: true, data: supplier });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get onboarding status for the current supplier or admin-assisted supplier
// @route   GET /api/v1/suppliers/onboarding
// @access  Private (Supplier/Admin)
exports.getOnboardingStatus = async (req, res) => {
  try {
    const supplier = await getSupplierForRequest(req);

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    let query = Supplier.findById(supplier._id)
      .populate('selectedPlan')
      .populate({ path: 'categories', select: 'name slug parentCategory status' });

    if (req.user.role === 'admin') {
      query = query.populate({ path: 'user', select: ADMIN_SAFE_USER_SELECT });
    }

    const populatedSupplier = await query;

    const onboarding = buildOnboardingPayload(populatedSupplier);
    await populatedSupplier.save();

    res.status(200).json({
      success: true,
      data: {
        supplier: populatedSupplier,
        onboarding,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Save supplier industry/category selection during onboarding
// @route   PUT /api/v1/suppliers/onboarding/industry
// @access  Private (Supplier/Admin)
exports.saveOnboardingIndustry = async (req, res) => {
  try {
    const supplier = await getSupplierForRequest(req);

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    const { categoryIds = [] } = req.body;
    if (!Array.isArray(categoryIds) || categoryIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please select at least one industry category' });
    }

    const categories = await Category.find({ _id: { $in: categoryIds }, status: 'Active' }).select('_id');
    if (categories.length !== categoryIds.length) {
      return res.status(400).json({ success: false, message: 'One or more selected categories are invalid or inactive' });
    }

    supplier.categories = categories.map((category) => category._id);
    const onboarding = buildOnboardingPayload(supplier);
    await supplier.save();

    res.status(200).json({
      success: true,
      data: {
        supplier,
        onboarding,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Save supplier company details during onboarding
// @route   PUT /api/v1/suppliers/onboarding/company-info
// @access  Private (Supplier/Admin)
exports.saveOnboardingCompanyInfo = async (req, res) => {
  try {
    const supplier = await getSupplierForRequest(req);

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    const {
      companyName,
      description,
      contactEmail,
      contactPhone,
      website,
      address,
      supplierType,
      coreProducts,
    } = req.body;

    if (!companyName || !description || !contactEmail || !contactPhone || !address) {
      return res.status(400).json({
        success: false,
        message: 'Company name, description, contact email, contact phone, and address are required',
      });
    }

    supplier.companyName = companyName;
    supplier.description = description;
    supplier.contactEmail = contactEmail.trim().toLowerCase();
    supplier.contactPhone = contactPhone;
    supplier.website = normalizeWebsiteUrl(website);
    if (supplierType) {
      supplier.supplierType = supplierType;
    }

    if (Array.isArray(coreProducts)) {
      supplier.coreProducts = coreProducts.filter(Boolean);
    } else if (typeof coreProducts === 'string') {
      supplier.coreProducts = coreProducts
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    const geoResult = await geocodeAddress(address);
    supplier.location = geoResult
      ? {
          type: 'Point',
          coordinates: geoResult.coordinates,
          formattedAddress: geoResult.formattedAddress,
        }
      : {
          type: 'Point',
          coordinates: [0, 0],
          formattedAddress: address,
        };

    const onboarding = buildOnboardingPayload(supplier);
    await supplier.save();

    res.status(200).json({
      success: true,
      data: {
        supplier,
        onboarding,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Save selected subscription plan during onboarding
// @route   PUT /api/v1/suppliers/onboarding/subscription
// @access  Private (Supplier/Admin)
exports.saveOnboardingSubscription = async (req, res) => {
  try {
    const supplier = await getSupplierForRequest(req);

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier profile not found' });
    }

    if (!hasIndustrySelection(supplier)) {
      return res.status(400).json({ success: false, message: 'Complete industry selection before choosing a subscription plan' });
    }

    if (!hasCompanyInfo(supplier)) {
      return res.status(400).json({ success: false, message: 'Complete company information before choosing a subscription plan' });
    }

    const { planId } = req.body;
    if (!planId) {
      return res.status(400).json({ success: false, message: 'Please select a subscription plan' });
    }

    const plan = await PricingPlan.findOne({ _id: planId, isActive: true });
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Selected pricing plan was not found or is inactive' });
    }

    const resolvedBillingCycle = plan.billingCycle || '';
    const resolvedListingPeriod = deriveListingPeriod(
      resolvedBillingCycle,
      supplier.selectedListingPeriod
    );

    supplier.selectedPlan = plan._id;
    supplier.selectedBillingCycle = resolvedBillingCycle;
    supplier.selectedListingPeriod = resolvedListingPeriod;
    supplier.subscriptionPlan = inferPlanTier(plan);
    supplier.subscriptionStatus = 'pending';
    supplier.paymentStatus = supplier.paymentStatus === 'paid' ? supplier.paymentStatus : 'unpaid';

    const onboarding = buildOnboardingPayload(supplier);
    await supplier.save();

    res.status(200).json({
      success: true,
      data: {
        supplier,
        plan,
        onboarding,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create a supplier account in admin-assisted mode
// @route   POST /api/v1/suppliers/admin-assisted
// @access  Private (Admin)
exports.createAdminAssistedSupplier = async (req, res) => {
  try {
    const { name, email, password, companyName, phone } = req.body;
    const normalizedEmail = email?.trim().toLowerCase();

    if (!name || !normalizedEmail || !password) {
      return res.status(400).json({ success: false, message: 'Name, email, and password are required' });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'A user with this email already exists' });
    }

    const user = await User.create({
      name,
      email: normalizedEmail,
      password,
      role: 'supplier',
      isVerified: true,
      status: 'Active',
    });

    const supplier = await Supplier.create({
      user: user._id,
      companyName: companyName || `${name} Company`,
      contactEmail: normalizedEmail,
      contactPhone: phone || '',
      description: 'Profile pending details. Please update your company description in settings.',
    });

    const onboarding = buildOnboardingPayload(supplier);
    await supplier.save();

    const hydratedSupplier = await Supplier.findById(supplier._id).populate({
      path: 'user',
      select: ADMIN_SAFE_USER_SELECT,
    });

    res.status(201).json({
      success: true,
      data: {
        supplier: hydratedSupplier,
        onboarding,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
