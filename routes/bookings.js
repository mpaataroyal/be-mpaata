const express = require('express');
const router = express.Router();
const axios = require('axios');
const { db, admin } = require('../config/firebase'); 
const { verifyToken, requireRole } = require('../middleware/auth');

// ==========================================
// CONFIGURATION (RELWORX)
// ==========================================
const RELWORX_CONFIG = {
  API_KEY: process.env.RELWORX_API_KEY || 'a6d10c136873fd.e0jfX4fshl9u_YyDvkiiXA', 
  ACCOUNT_NO: 'REL0309E04069',
  BASE_URL: 'https://payments.relworx.com/api',
  CURRENCY: 'UGX'
};

// ==========================================
// HELPERS
// ==========================================

const formatPhoneNumber = (phone) => {
  if (!phone) return null;
  let cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  if (cleanPhone.startsWith('0')) return '+256' + cleanPhone.substring(1);
  if (!cleanPhone.startsWith('+')) return '+256' + cleanPhone;
  return cleanPhone;
};

// This matches the reference logic in payments.js
const generateReference = () => {
  return 'TX-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
};

const findOrCreateUser = async (name, phone, email) => {
  const formattedPhone = formatPhoneNumber(phone);
  if (formattedPhone) {
    const phoneQuery = await db.collection('users').where('phoneNumber', '==', formattedPhone).limit(1).get();
    if (!phoneQuery.empty) return phoneQuery.docs[0].id;
  }
  if (email) {
    const emailQuery = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!emailQuery.empty) return emailQuery.docs[0].id;
  }
  try {
    const userRecord = await admin.auth().createUser({
      displayName: name,
      phoneNumber: formattedPhone, 
      email: email || undefined,   
      emailVerified: true,
      disabled: false
    });
    await db.collection('users').doc(userRecord.uid).set({
      name: name,
      email: email || null,
      phoneNumber: formattedPhone,
      role: 'customer',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await admin.auth().setCustomUserClaims(userRecord.uid, { role: 'customer' });
    return userRecord.uid;
  } catch (error) {
    if (error.code === 'auth/phone-number-already-exists') {
      const user = await admin.auth().getUserByPhoneNumber(formattedPhone);
      return user.uid;
    }
    if (error.code === 'auth/email-already-exists') {
        const user = await admin.auth().getUserByEmail(email);
        return user.uid;
    }
    throw error;
  }
};

const calculateTotalPrice = (pricePerNight, checkIn, checkOut) => {
  if (!pricePerNight || !checkIn || !checkOut) return 0;
  const diffTime = checkOut.getTime() - checkIn.getTime();
  const diffNights = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
  return pricePerNight * (diffNights > 0 ? diffNights : 1); 
};

const checkAvailability = async (roomId, checkIn, checkOut, excludeBookingId = null) => {
  const snapshot = await db.collection('bookings')
    .where('roomId', '==', roomId)
    .where('status', 'in', ['confirmed', 'pending']) 
    .get();

  for (const doc of snapshot.docs) {
    if (excludeBookingId && doc.id === excludeBookingId) continue;
    const data = doc.data();
    const existingStart = data.checkIn.toDate().getTime();
    const existingEnd = data.checkOut.toDate().getTime();
    const newStart = checkIn.getTime();
    const newEnd = checkOut.getTime();
    if (newStart < existingEnd && newEnd > existingStart) return false; 
  }
  return true;
};

// ==========================================
// 0. GET /bookings/me (User's own bookings)
// ==========================================
router.get('/me', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    
    // Fetch bookings for specific user
    const snapshot = await db.collection('bookings')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();

    const bookings = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      
      let roomName = 'Unknown';
      if (data.roomId) {
        const roomSnap = await db.collection('rooms').doc(data.roomId).get();
        if (roomSnap.exists) roomName = roomSnap.data().roomNumber + ' - ' + roomSnap.data().type;
      }

      return {
        id: doc.id,
        ...data,
        checkIn: data.checkIn.toDate().toISOString(),
        checkOut: data.checkOut.toDate().toISOString(),
        roomName,
        // Guest info is the user themselves, but likely stored in data too
        guestName: data.guestName || 'Me', 
        guestPhone: data.guestPhone || 'N/A'
      };
    }));

    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Error fetching my bookings:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 1. GET /bookings (Admin/Manager: All bookings)
// ==========================================
router.get('/', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const snapshot = await db.collection('bookings').orderBy('createdAt', 'desc').get();

    const bookings = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      
      let roomName = 'Unknown';
      if (data.roomId) {
        const roomSnap = await db.collection('rooms').doc(data.roomId).get();
        if (roomSnap.exists) roomName = roomSnap.data().roomNumber + ' - ' + roomSnap.data().type;
      }

      let guestName = data.guestName;
      let guestPhone = data.guestPhone;
      if (data.userId) {
        const userSnap = await db.collection('users').doc(data.userId).get();
        if (userSnap.exists) {
            guestName = userSnap.data().name || userSnap.data().displayName;
            guestPhone = userSnap.data().phoneNumber;
        }
      }

      return {
        id: doc.id,
        ...data,
        checkIn: data.checkIn.toDate().toISOString(),
        checkOut: data.checkOut.toDate().toISOString(),
        roomName,
        guestName: guestName || 'Walk-in',
        guestPhone: guestPhone || 'N/A'
      };
    }));

    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. POST /bookings (Create & Charge)
// ==========================================
router.post('/', verifyToken, async (req, res) => {
  try {
    const { 
      roomId, checkIn, checkOut, 
      guestName, guestPhone, guestEmail, 
      guests, status,
      paymentMethod, paymentStatus, receivedBy, paymentPhone 
    } = req.body;

    const start = new Date(checkIn);
    const end = new Date(checkOut);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return res.status(400).json({ error: 'Invalid dates' });
    if (start >= end) return res.status(400).json({ error: 'Check-out must be after check-in' });
    
    if (paymentMethod === 'Cash' && !receivedBy) {
        return res.status(400).json({ error: 'Cash payment requires "receivedBy" staff.' });
    }

    const roomDoc = await db.collection('rooms').doc(roomId).get();
    if (!roomDoc.exists) return res.status(404).json({ error: 'Room not found' });
    
    const isAvailable = await checkAvailability(roomId, start, end);
    if (!isAvailable) return res.status(409).json({ error: 'Room is unavailable' });

    // Use logged-in user ID if guest info matches, or create/find user if admin is booking for someone
    // Note: If a user is booking for themselves, req.user.uid is usually the userId.
    // However, if admin creates booking, we findOrCreate based on form input.
    // Logic below handles creating a user record if it doesn't exist based on phone/email.
    const userId = await findOrCreateUser(guestName, guestPhone, guestEmail);
    
    const roomData = roomDoc.data();
    const totalPrice = calculateTotalPrice(roomData.price, start, end);

    const formattedPaymentPhone = paymentMethod === 'Mobile Money' ? formatPhoneNumber(paymentPhone) : null;

    // 1. Create Booking Object
    const newBooking = {
      roomId,
      userId: userId,
      guestName: guestName, 
      guestPhone: formatPhoneNumber(guestPhone),
      guestEmail: guestEmail || '',
      guests: Number(guests) || 1,
      checkIn: admin.firestore.Timestamp.fromDate(start),
      checkOut: admin.firestore.Timestamp.fromDate(end),
      totalPrice,
      status: status || 'pending',
      paymentStatus: paymentStatus || 'unpaid',
      paymentMethod: paymentMethod || 'Mobile Money',
      paymentPhone: formattedPaymentPhone,
      receivedBy: paymentMethod === 'Cash' ? receivedBy : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid
    };

    const docRef = await db.collection('bookings').add(newBooking);
    const bookingId = docRef.id;

    // 🟢 2. CREATE PAYMENT RECORD
    const myReference = generateReference();
    
    const paymentData = {
      bookingId: bookingId,
      userId: userId,
      amount: totalPrice,
      currency: RELWORX_CONFIG.CURRENCY,
      provider: paymentMethod, 
      phone: formattedPaymentPhone || formatPhoneNumber(guestPhone),
      status: paymentStatus || 'pending',
      
      // 🟢 STORE AS "customer_reference" so we can match it easily later
      customer_reference: myReference, 
      externalReference: null,
      
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('payments').add(paymentData);

    // 🟢 3. AUTO-INITIATE PAYMENT (Mobile Money)
    let paymentMessage = 'Booking created successfully.';

    if (paymentMethod === 'Mobile Money' && formattedPaymentPhone) {
      try {
        console.log(`[Relworx] Requesting payment: Ref=${myReference}, Phone=${formattedPaymentPhone}, Amount=${totalPrice}`);
        
        await axios.post(
          `${RELWORX_CONFIG.BASE_URL}/mobile-money/request-payment`,
          {
            account_no: RELWORX_CONFIG.ACCOUNT_NO,
            amount: totalPrice,
            currency: RELWORX_CONFIG.CURRENCY,
            msisdn: formattedPaymentPhone,
            // 🟢 Send OUR ID as "reference". Relworx will return this as "customer_reference"
            reference: myReference, 
            narration: `Booking ${bookingId.slice(0,6)}`
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${RELWORX_CONFIG.API_KEY}`,
              'Accept': 'application/vnd.relworx.v2'
            }
          }
        );
        
        paymentMessage = 'Booking created. Payment prompt sent to phone.';

      } catch (payError) {
        console.error('Auto-payment initiation failed:', payError.response?.data || payError.message);
        paymentMessage = 'Booking created, but payment prompt failed. Try manually.';
      }
    }

    res.status(201).json({ 
      success: true, 
      id: bookingId,
      message: paymentMessage 
    });

  } catch (error) {
    console.error('Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. PUT /bookings/:id (Update)
// ==========================================
router.put('/:id', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      roomId, checkIn, checkOut, 
      guestName, guestPhone, status, 
      paymentMethod, paymentStatus, receivedBy, paymentPhone 
    } = req.body;

    const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    let start, end;
    if (checkIn) {
      start = new Date(checkIn);
      updates.checkIn = admin.firestore.Timestamp.fromDate(start);
    }
    if (checkOut) {
      end = new Date(checkOut);
      updates.checkOut = admin.firestore.Timestamp.fromDate(end);
    }

    if (roomId || checkIn || checkOut) {
      if (checkIn && checkOut && roomId) {
          const isAvailable = await checkAvailability(roomId, start, end, id);
          if (!isAvailable) return res.status(409).json({ error: 'Room is unavailable' });
      }
    }

    if (guestName) updates.guestName = guestName;
    if (guestPhone) updates.guestPhone = formatPhoneNumber(guestPhone);
    if (status) updates.status = status;
    if (roomId) updates.roomId = roomId;
    
    if (paymentMethod) updates.paymentMethod = paymentMethod;
    if (paymentStatus) updates.paymentStatus = paymentStatus;
    if (receivedBy !== undefined) updates.receivedBy = receivedBy;
    if (paymentPhone) updates.paymentPhone = formatPhoneNumber(paymentPhone);

    await db.collection('bookings').doc(id).update(updates);

    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 4. Cancel
// ==========================================
router.post('/:id/cancel', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Optional: Add check to ensure user owns booking or is admin
    const bookingRef = db.collection('bookings').doc(id);
    const booking = await bookingRef.get();
    
    if (!booking.exists) return res.status(404).json({error: 'Booking not found'});
    
    // Allow if admin or if booking belongs to user
    if (req.user.role !== 'admin' && req.user.role !== 'manager' && booking.data().userId !== req.user.uid) {
        return res.status(403).json({error: 'Unauthorized'});
    }

    await bookingRef.update({
      status: 'cancelled',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;