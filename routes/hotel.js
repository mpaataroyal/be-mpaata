// routes/hotel.js
const express = require('express');
const router = express.Router();
const { db, admin } = require('../server');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');

const HOTEL_DOC_ID = 'hotel_settings';

// GET /api/v1/hotel - Get hotel information (Public)
router.get('/', async (req, res) => {
  try {
    const hotelDoc = await db.collection('settings').doc(HOTEL_DOC_ID).get();

    if (!hotelDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Hotel information not found',
        data: null,
        error: { code: 'HOTEL_NOT_FOUND' }
      });
    }

    res.json({
      success: true,
      message: 'Hotel information retrieved successfully',
      data: hotelDoc.data(),
      error: null
    });
  } catch (error) {
    console.error('Get hotel error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve hotel information',
      data: null,
      error: { code: 'FETCH_FAILED' }
    });
  }
});

// PATCH /api/v1/hotel - Update hotel information (Admin only)
router.patch('/', verifyToken, requireRole('admin', 'super_admin'), auditLog, async (req, res) => {
  try {
    const updates = req.body;

    const allowedFields = [
      'name',
      'description',
      'address',
      'contact',
      'checkInTime',
      'checkOutTime',
      'policies',
      'amenities',
      'images',
      'socialMedia',
      'cancellationPolicy',
      'childPolicy',
      'petPolicy'
    ];

    const filteredUpdates = {};

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        filteredUpdates[key] = value;
      }
    }

    if (Object.keys(filteredUpdates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update',
        data: null,
        error: { code: 'NO_UPDATES' }
      });
    }

    // Validate time formats if provided
    if (filteredUpdates.checkInTime && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(filteredUpdates.checkInTime)) {
      return res.status(400).json({
        success: false,
        message: 'Check-in time must be in HH:MM format (e.g., 15:00)',
        data: null,
        error: { code: 'INVALID_TIME_FORMAT' }
      });
    }

    if (filteredUpdates.checkOutTime && !/^([01]\d|2[0-3]):([0-5]\d)$/.test(filteredUpdates.checkOutTime)) {
      return res.status(400).json({
        success: false,
        message: 'Check-out time must be in HH:MM format (e.g., 11:00)',
        data: null,
        error: { code: 'INVALID_TIME_FORMAT' }
      });
    }

    filteredUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    filteredUpdates.updatedBy = req.user.id;

    await db.collection('settings').doc(HOTEL_DOC_ID).set(filteredUpdates, { merge: true });

    const updatedHotel = await db.collection('settings').doc(HOTEL_DOC_ID).get();

    res.json({
      success: true,
      message: 'Hotel information updated successfully',
      data: updatedHotel.data(),
      error: null
    });
  } catch (error) {
    console.error('Update hotel error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update hotel information',
      data: null,
      error: { code: 'UPDATE_FAILED' }
    });
  }
});

// GET /api/v1/hotel/stats - Get hotel statistics (Admin only)
router.get('/stats', verifyToken, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    // Get total rooms
    const roomsSnapshot = await db.collection('rooms').get();
    const totalRooms = roomsSnapshot.size;
    const activeRooms = roomsSnapshot.docs.filter(doc => doc.data().isActive).length;

    // Get bookings stats
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const bookingsSnapshot = await db.collection('bookings')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startOfMonth))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(endOfMonth))
      .get();

    let monthlyRevenue = 0;
    let confirmedBookings = 0;
    let cancelledBookings = 0;

    bookingsSnapshot.forEach(doc => {
      const booking = doc.data();
      if (booking.status === 'confirmed') {
        confirmedBookings++;
        monthlyRevenue += booking.totalPrice || 0;
      } else if (booking.status === 'cancelled') {
        cancelledBookings++;
      }
    });

    // Get current occupancy
    const today = admin.firestore.Timestamp.fromDate(new Date());
    const activeBookingsSnapshot = await db.collection('bookings')
      .where('status', '==', 'confirmed')
      .where('checkIn', '<=', today)
      .where('checkOut', '>=', today)
      .get();

    const occupiedRooms = activeBookingsSnapshot.size;
    const occupancyRate = totalRooms > 0 ? ((occupiedRooms / totalRooms) * 100).toFixed(2) : 0;

    // Get total users
    const usersSnapshot = await db.collection('users').get();
    const totalUsers = usersSnapshot.size;

    res.json({
      success: true,
      message: 'Hotel statistics retrieved successfully',
      data: {
        rooms: {
          total: totalRooms,
          active: activeRooms,
          occupied: occupiedRooms,
          occupancyRate: parseFloat(occupancyRate)
        },
        bookings: {
          thisMonth: bookingsSnapshot.size,
          confirmed: confirmedBookings,
          cancelled: cancelledBookings
        },
        revenue: {
          thisMonth: monthlyRevenue
        },
        users: {
          total: totalUsers
        }
      },
      error: null
    });
  } catch (error) {
    console.error('Get hotel stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve hotel statistics',
      data: null,
      error: { code: 'FETCH_FAILED' }
    });
  }
});

module.exports = router;