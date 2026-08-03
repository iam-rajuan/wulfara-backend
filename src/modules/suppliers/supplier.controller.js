const Supplier = require('./supplier.model');
const { generatePresignedUrl } = require('../../utils/s3');
const geocodeAddress = require('../../utils/geocode');
const { createNotification } = require('../../utils/notificationService');

// @desc    Get all suppliers (with optional category filtering)
// @route   GET /api/v1/suppliers
// @access  Public
exports.getSuppliers = async (req, res) => {
  try {
    let query;

    // Copy req.query
    const reqQuery = { ...req.query };

    // Fields to exclude
    const removeFields = ['select', 'sort', 'page', 'limit', 'keyword', 'lat', 'lng', 'distance', 'supplierType'];

    // Loop over removeFields and delete them from reqQuery
    removeFields.forEach(param => delete reqQuery[param]);

    if (req.query.supplierType) {
      reqQuery.supplierType = req.query.supplierType;
    }

    if (req.query.keyword) {
      reqQuery.$or = [
        { companyName: { $regex: req.query.keyword, $options: 'i' } },
        { description: { $regex: req.query.keyword, $options: 'i' } }
      ];
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

    // Only show approved suppliers to public, unless admin is requesting
    if (!req.user || req.user.role !== 'admin') {
      reqQuery.isApproved = true;
    }

    query = Supplier.find(reqQuery).populate({
      path: 'categories',
      select: 'name slug'
    });

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
    const supplier = await Supplier.findById(req.params.id).populate({
      path: 'categories',
      select: 'name slug'
    });

    if (!supplier) {
      return res.status(404).json({ success: false, message: 'Supplier not found' });
    }
    
    // If not approved, only admin or the supplier themselves can view it
    if (!supplier.isApproved) {
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

    // Don't allow regular users to approve their own profiles
    if (req.user.role !== 'admin' && req.body.isApproved) {
      delete req.body.isApproved;
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

    const dashboardData = {
      totalRfqs,
      pendingRfqs,
      profileCompletion: `${profileCompletionPercentage}%`,
      subscriptionPlan: supplierProfile.subscriptionPlan,
      isApproved: supplierProfile.isApproved,
      analytics
    };

    res.status(200).json({ 
      success: true, 
      data: {
        profile: supplierProfile,
        stats: dashboardData
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
