// middleware/auth.js
const { admin } = require('../config/firebase');
// const admin = require('firebase-admin');

// Get Firestore instance (will be initialized in server.js)
let db;
const setDb = (database) => {
  db = database;
};

// Verify JWT token
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized: No token provided' 
      });
    }

    const token = authHeader.split('Bearer ')[1];

    // ⭐️ MAGIC HAPPENS HERE: 
    // verifyIdToken() takes the "customClaims" and merges them 
    // into the top level of the returned object.
    const decodedToken = await admin.auth().verifyIdToken(token);

    req.user = decodedToken; 
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized: Invalid token',
      error: error.code 
    });
  }
};


// Role-based access control middleware
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // 🔍 DEBUGGING: Uncomment this line to see exactly what your token holds
    // console.log("User Token Claims:", req.user);

    // 1. Standard Check (This is how verifyIdToken usually works)
    let userRole = req.user.role;

    // 2. Safety Fallback (In case you accidentally nested it double deep)
    if (!userRole && req.user.customClaims) {
      userRole = req.user.customClaims.role;
    }

    // Default to 'customer' if no role is found
    userRole = userRole || 'customer';

    const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

    if (rolesArray.includes(userRole)) {
      next();
    } else {
      res.status(403).json({ 
        success: false, 
        message: `Forbidden: You need one of these roles: ${rolesArray.join(', ')}`,
        currentRole: userRole 
      });
    }
  };
};

// Check if user is resource owner or admin
const isOwnerOrAdmin = (req, res, next) => {
    // Super admin and admin can access any resource
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
      return next();
    }else {
      return res.status(403).json({
        success: false,
        message: 'You can only access your own resources',
        data: null,
        error: { code: 'FORBIDDEN' }
      });
    }
  };

// Log admin actions for audit trail
const auditLog = async (req, res, next) => {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'super_admin')) {
    try {
      const { db } = require('../server');
      const admin = require('firebase-admin');
      
      await db.collection('audit_logs').add({
        userId: req.user.id,
        role: req.user.role,
        action: `${req.method} ${req.originalUrl}`,
        body: req.method !== 'GET' ? req.body : undefined,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent'),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('Audit log error:', error);
      // Don't fail the request if audit logging fails
    }
  }
  next();
};

// Optional: Check if user owns a booking
const isBookingOwner = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const { db } = require('../server');

    // Admins can access any booking
    if (req.user.role === 'admin' || req.user.role === 'super_admin') {
      return next();
    }

    const bookingDoc = await db.collection('bookings').doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
        data: null,
        error: { code: 'BOOKING_NOT_FOUND' }
      });
    }

    const booking = bookingDoc.data();

    if (booking.userId !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You can only access your own bookings',
        data: null,
        error: { code: 'FORBIDDEN' }
      });
    }

    // Attach booking to request for use in route handler
    req.booking = { id: bookingId, ...booking };
    next();
  } catch (error) {
    console.error('Booking ownership check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify booking ownership',
      data: null,
      error: { code: 'VERIFICATION_FAILED' }
    });
  }
};

// Validate request body fields
const validateFields = (requiredFields) => {
  return (req, res, next) => {
    const missingFields = [];
    
    for (const field of requiredFields) {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
        missingFields.push(field);
      }
    }

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
        data: null,
        error: { 
          code: 'VALIDATION_ERROR',
          missingFields 
        }
      });
    }

    next();
  };
};

module.exports = {
  verifyToken,
  requireRole,
  isOwnerOrAdmin,
  auditLog,
  isBookingOwner,
  validateFields,
  setDb
};