// routes/availability.js
const express = require('express');
const router = express.Router();
const { db, admin } = require('../server');

// POST /api/v1/availability - Check room availability
router.post('/', async (req, res) => {
  try {
    const { checkIn, checkOut, guests } = req.body;

    // Validation
    if (!checkIn || !checkOut) {
      return res.status(400).json({
        success: false,
        message: 'Check-in and check-out dates are required',
        data: null,
        error: { code: 'VALIDATION_ERROR' }
      });
    }

    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Validate dates
    if (checkInDate < today) {
      return res.status(400).json({
        success: false,
        message: 'Check-in date cannot be in the past',
        data: null,
        error: { code: 'INVALID_CHECKIN' }
      });
    }

    if (checkOutDate <= checkInDate) {
      return res.status(400).json({
        success: false,
        message: 'Check-out date must be after check-in date',
        data: null,
        error: { code: 'INVALID_CHECKOUT' }
      });
    }

    // Get all active rooms
    const roomsSnapshot = await db.collection('rooms')
      .where('isActive', '==', true)
      .get();

    if (roomsSnapshot.empty) {
      return res.json({
        success: true,
        message: 'No rooms available',
        data: [],
        error: null
      });
    }

    const roomIds = roomsSnapshot.docs.map(doc => doc.id);

    // Get all confirmed bookings that overlap with requested dates
    const bookingsSnapshot = await db.collection('bookings')
      .where('status', '==', 'confirmed')
      .where('roomId', 'in', roomIds)
      .get();

    const bookedRoomIds = new Set();

    bookingsSnapshot.forEach(doc => {
      const booking = doc.data();
      const bookingCheckIn = booking.checkIn.toDate();
      const bookingCheckOut = booking.checkOut.toDate();

      // Check for date overlap
      if (
        (checkInDate >= bookingCheckIn && checkInDate < bookingCheckOut) ||
        (checkOutDate > bookingCheckIn && checkOutDate <= bookingCheckOut) ||
        (checkInDate <= bookingCheckIn && checkOutDate >= bookingCheckOut)
      ) {
        bookedRoomIds.add(booking.roomId);
      }
    });

    // Calculate nights and filter available rooms
    const nights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
    const availableRooms = [];

    roomsSnapshot.forEach(doc => {
      const roomData = doc.data();
      
      // Check if room is available and meets capacity requirements
      if (!bookedRoomIds.has(doc.id) && (!guests || roomData.capacity >= guests)) {
        availableRooms.push({
          id: doc.id,
          ...roomData,
          totalPrice: roomData.pricePerNight * nights,
          pricePerNight: roomData.pricePerNight,
          nights
        });
      }
    });

    res.json({
      success: true,
      message: `Found ${availableRooms.length} available room(s)`,
      data: {
        rooms: availableRooms,
        searchCriteria: {
          checkIn,
          checkOut,
          guests,
          nights
        }
      },
      error: null
    });
  } catch (error) {
    console.error('Check availability error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check availability',
      data: null,
      error: { code: 'AVAILABILITY_CHECK_FAILED' }
    });
  }
});

module.exports = router;