const jwt = require('jsonwebtoken');
const User = require('../modules/users/user.model');
const { getEffectivePermissions, isSuperAdminRole } = require('../modules/adminRoles/adminRole.service');

// Protect routes
exports.protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization) {
    if (req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else {
      token = req.headers.authorization;
    }
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).populate('adminRole');

    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authorized, user no longer exists' });
    }

    req.userPermissions = getEffectivePermissions(req.user);
    req.isSuperAdmin =
      req.user.role === 'admin'
        ? !req.user.adminRole || isSuperAdminRole(req.user.adminRole)
        : false;

    if (req.user.isActive === false) {
      return res.status(403).json({ success: false, message: 'Your account has been suspended. Please contact support.' });
    }

    next();
  } catch (err) {
    console.error('Token Verification Failed:', err.message);
    return res.status(401).json({ success: false, message: 'Not authorized to access this route' });
  }
};

// Grant access to specific roles
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: `User role ${req.user.role} is not authorized to access this route` });
    }
    next();
  };
};

exports.authorizePermissions = (...permissions) => {
  return (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admin users can access this route' });
    }

    if (req.isSuperAdmin) {
      return next();
    }

    const missingPermissions = permissions.filter(
      (permission) => !req.userPermissions.includes(permission)
    );

    if (missingPermissions.length > 0) {
      return res.status(403).json({
        success: false,
        message: `Missing required permission: ${missingPermissions[0]}`,
      });
    }

    next();
  };
};

exports.authorizeAdminPermissions = (...permissions) => {
  return (req, res, next) => {
    if (req.user.role !== 'admin') {
      return next();
    }

    return exports.authorizePermissions(...permissions)(req, res, next);
  };
};

// Optional auth for public routes that behave differently for admins
exports.protectOptional = async (req, res, next) => {
  let token;

  if (req.headers.authorization) {
    if (req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else {
      token = req.headers.authorization;
    }
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).populate('adminRole');
      req.userPermissions = getEffectivePermissions(req.user);
      req.isSuperAdmin =
        req.user?.role === 'admin'
          ? !req.user.adminRole || isSuperAdminRole(req.user.adminRole)
          : false;
    } catch (err) {
      // Ignore errors for optional auth
    }
  }
  next();
};
