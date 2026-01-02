const express = require('express');
const router = express.Router();
// Ensure this points to where we initialized Firebase earlier
const { db, admin } = require('../config/firebase'); 
const { verifyToken, requireRole } = require('../middleware/auth');

// ==========================================
// 1. GET /api/v1/rooms 
// List all rooms with Dynamic Status
// ==========================================
router.get('/', async (req, res) => {
  try {
    const { status: filterStatus, type } = req.query;
    
    // 1. Fetch All Rooms
    let roomsQuery = db.collection('rooms');
    if (type) {
      roomsQuery = roomsQuery.where('type', '==', type);
    }
    const roomsSnapshot = await roomsQuery.get();
    const rooms = roomsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // 2. Fetch Active Bookings (Pending or Confirmed, Future or Current)
    const now = new Date();
    const bookingsSnapshot = await db.collection('bookings')
      .where('status', 'in', ['confirmed', 'pending'])
      .where('checkOut', '>', admin.firestore.Timestamp.fromDate(now))
      .get();

    // Group bookings by room
    const bookingsByRoom = {};
    bookingsSnapshot.forEach(doc => {
      const b = doc.data();
      if (!bookingsByRoom[b.roomId]) bookingsByRoom[b.roomId] = [];
      bookingsByRoom[b.roomId].push({
        checkIn: b.checkIn.toDate(),
        checkOut: b.checkOut.toDate(),
      });
    });

    // 3. Calculate Status per Room
    const processedRooms = rooms.map(room => {
      // If manually set to Maintenance, keep it
      if (room.status === 'Maintenance') {
        return { ...room, nextAvailable: null };
      }

      const roomBookings = bookingsByRoom[room.id] || [];
      // Sort by start time
      roomBookings.sort((a, b) => a.checkIn - b.checkIn);

      let calculatedStatus = 'Available';
      let nextAvailable = null;

      for (const booking of roomBookings) {
        if (now >= booking.checkIn && now < booking.checkOut) {
          calculatedStatus = 'Occupied';
          nextAvailable = booking.checkOut;
          // Logic could be expanded here to check for back-to-back bookings
          break; // Found the current active booking
        } else if (booking.checkIn > now) {
          // Future booking exists. 
          // If the gap between now and the future booking is small (e.g., < 2 hours), 
          // you might consider it 'Booked', but usually it's 'Available' until check-in.
          // For now, we leave it as Available unless currently occupied.
        }
      }

      return {
        ...room,
        status: calculatedStatus,
        nextAvailable: nextAvailable ? nextAvailable.toISOString() : null
      };
    });

    // 4. Apply Status Filter (in memory)
    const finalRooms = filterStatus 
      ? processedRooms.filter(r => r.status === filterStatus)
      : processedRooms;

    // Sort by room number
    finalRooms.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));

    res.json({
      success: true,
      count: finalRooms.length,
      data: finalRooms 
    });
  } catch (error) {
    console.error('Get rooms error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve rooms',
      error: error.message
    });
  }
});

// ==========================================
// 2. GET /api/v1/rooms/:id 
// Get single room details
// ==========================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const roomDoc = await db.collection('rooms').doc(id).get();
    
    if (!roomDoc.exists) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    const roomData = { id: roomDoc.id, ...roomDoc.data() };

    // Calculate Dynamic Status for Single Room
    const now = new Date();
    const bookingsSnapshot = await db.collection('bookings')
      .where('roomId', '==', id)
      .where('status', 'in', ['confirmed', 'pending'])
      .where('checkOut', '>', admin.firestore.Timestamp.fromDate(now))
      .orderBy('checkIn', 'asc') // Get earliest first
      .get();

    if (roomData.status !== 'Maintenance') {
      let calculatedStatus = 'Available';
      let nextAvailable = null;

      for (const doc of bookingsSnapshot.docs) {
        const b = doc.data();
        const checkIn = b.checkIn.toDate();
        const checkOut = b.checkOut.toDate();

        if (now >= checkIn && now < checkOut) {
          calculatedStatus = 'Occupied';
          nextAvailable = checkOut;
          break;
        }
      }
      
      roomData.status = calculatedStatus;
      roomData.nextAvailable = nextAvailable ? nextAvailable.toISOString() : null;
    }

    res.json({
      success: true,
      data: roomData
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. POST /api/v1/rooms 
// Create new room (Admin only)
// ==========================================
router.post('/', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { 
      roomNumber, 
      type, 
      price, 
      status, 
      amenities, 
      description 
    } = req.body;

    if (!roomNumber || !type || !price) {
      return res.status(400).json({
        success: false,
        message: 'Room Number, Type, and Price are required.'
      });
    }

    const existingRoom = await db.collection('rooms')
      .where('roomNumber', '==', roomNumber)
      .limit(1)
      .get();

    if (!existingRoom.empty) {
      return res.status(409).json({
        success: false,
        message: `Room ${roomNumber} already exists.`
      });
    }

    const roomData = {
      roomNumber,
      type,
      price: Number(price),
      status: status || 'Available', // Manual status usually just for Maintenance
      amenities: amenities || [],
      description: description || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid 
    };

    const roomRef = await db.collection('rooms').add(roomData);

    res.status(201).json({
      success: true,
      message: 'Room created successfully',
      data: { id: roomRef.id, ...roomData }
    });

  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. PUT /api/v1/rooms/:id 
// Update room (Admin only)
// ==========================================
router.put('/:id', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const { 
      roomNumber, 
      type, 
      price, 
      status, // Admin can set 'Maintenance' here
      amenities, 
      description 
    } = updates;

    const roomRef = db.collection('rooms').doc(id);
    const roomDoc = await roomRef.get();

    if (!roomDoc.exists) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    if (roomNumber && roomNumber !== roomDoc.data().roomNumber) {
        const duplicateCheck = await db.collection('rooms')
            .where('roomNumber', '==', roomNumber)
            .limit(1)
            .get();
        
        if (!duplicateCheck.empty) {
            return res.status(409).json({ success: false, message: `Room ${roomNumber} already exists.` });
        }
    }

    const cleanUpdates = {
      ...(roomNumber && { roomNumber }),
      ...(type && { type }),
      ...(price && { price: Number(price) }),
      ...(status && { status }),
      ...(amenities && { amenities }),
      ...(description && { description }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user.uid
    };

    await roomRef.update(cleanUpdates);

    res.json({
      success: true,
      message: 'Room updated successfully',
      data: { id, ...cleanUpdates }
    });

  } catch (error) {
    console.error('Update room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. DELETE /api/v1/rooms/:id 
// Delete room (Admin only)
// ==========================================
router.delete('/:id', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { id } = req.params;
    const roomRef = db.collection('rooms').doc(id);
    
    const roomDoc = await roomRef.get();
    if (!roomDoc.exists) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    await roomRef.delete();

    res.json({
      success: true,
      message: 'Room deleted successfully',
      data: { id }
    });

  } catch (error) {
    console.error('Delete room error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;