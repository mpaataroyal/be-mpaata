const express = require('express');
const router = express.Router();
const axios = require('axios'); 
const { db, admin } = require('../config/firebase'); 
const { verifyToken, requireRole } = require('../middleware/auth');

// CONFIG
const RELWORX_CONFIG = {
  API_KEY: process.env.RELWORX_API_KEY || 'a6d10c136873fd.e0jfX4fshl9u_YyDvkiiXA', 
  ACCOUNT_NO: 'REL0309E04069',
  BASE_URL: 'https://payments.relworx.com/api', 
  CURRENCY: 'UGX'
};

const formatMsisdn = (phone) => {
  if (!phone) return null;
  let clean = phone.replace(/[\s\-\(\)]/g, '');
  if (clean.startsWith('0')) return `+256${clean.slice(1)}`;
  if (!clean.startsWith('+')) return `+256${clean}`;
  return clean;
};

const generateReference = () => {
  return 'TX-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
};

// ==========================================
// 0. GET /api/v1/payments/me (User's Own Payments)
// ==========================================
router.get('/me', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const snapshot = await db.collection('payments')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    const payments = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        guest: 'Me', // Since it's /me, the guest is the user
        date: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString()
      };
    });

    res.json({ success: true, payments });
  } catch (error) {
    console.error('Fetch My Payments Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 1. GET /api/v1/payments (List - Admin Only)
// ==========================================
router.get('/', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const snapshot = await db.collection('payments').orderBy('createdAt', 'desc').limit(100).get();
    
    const payments = await Promise.all(snapshot.docs.map(async (doc) => {
      const data = doc.data();
      let guestName = 'Unknown';
      if (data.userId) {
        const userSnap = await db.collection('users').doc(data.userId).get();
        if (userSnap.exists) guestName = userSnap.data().name || userSnap.data().displayName;
      }
      return {
        id: doc.id,
        ...data,
        guest: guestName,
        date: data.createdAt ? data.createdAt.toDate().toISOString() : new Date().toISOString()
      };
    }));

    res.json({ success: true, payments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. PUT /api/v1/payments/:id (Update Status)
// ==========================================
router.put('/:id', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; 

    if (!status) return res.status(400).json({ error: 'Status is required' });

    const paymentRef = db.collection('payments').doc(id);
    const paymentDoc = await paymentRef.get();
    
    if (!paymentDoc.exists) return res.status(404).json({ error: 'Payment not found' });

    // Update Payment
    await paymentRef.update({ 
      status, 
      updatedAt: admin.firestore.FieldValue.serverTimestamp() 
    });

    // Sync Booking Status
    const bookingId = paymentDoc.data().bookingId;
    if (bookingId) {
      let bookingUpdates = {};
      if (status === 'success' || status === 'paid') {
        bookingUpdates.paymentStatus = 'paid';
        bookingUpdates.status = 'confirmed'; // Auto-confirm
      } else if (status === 'failed') {
        bookingUpdates.paymentStatus = 'failed';
      }
      await db.collection('bookings').doc(bookingId).update(bookingUpdates);
    }

    res.json({ success: true, message: 'Payment status updated' });
  } catch (error) {
    console.error('Update Payment Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. POST /api/v1/payments/initiate (Retry/Start)
// ==========================================
router.post('/initiate', verifyToken, async (req, res) => {
  try {
    const { bookingId, phoneNumber, amount } = req.body;

    if (!bookingId || !phoneNumber || !amount) {
      return res.status(400).json({ error: 'Missing details' });
    }

    const formattedPhone = formatMsisdn(phoneNumber);
    const internalReference = generateReference();

    // 1. Create a NEW Payment Record (Audit Trail)
    const paymentData = {
      bookingId,
      userId: req.user.uid,
      amount: Number(amount),
      currency: RELWORX_CONFIG.CURRENCY,
      provider: 'mobile_money',
      phone: formattedPhone,
      status: 'pending',
      customer_reference: internalReference,
      externalReference: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const paymentDocRef = await db.collection('payments').add(paymentData);

    // 2. Call Relworx
    try {
      await axios.post(
        `${RELWORX_CONFIG.BASE_URL}/mobile-money/request-payment`,
        {
          account_no: RELWORX_CONFIG.ACCOUNT_NO,
          amount: amount,
          currency: RELWORX_CONFIG.CURRENCY,
          msisdn: formattedPhone,
          reference: internalReference,
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

      res.json({ success: true, message: 'Payment prompt sent' });

    } catch (apiError) {
      console.error('Relworx API Fail:', apiError.response?.data);
      await paymentDocRef.update({ status: 'failed', failureReason: 'API Call Failed' });
      return res.status(502).json({ error: 'Failed to trigger mobile money prompt' });
    }

  } catch (error) {
    console.error('Initiate Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 4. POST /webhook
// ==========================================
router.post('/webhook', async (req, res) => {
  try {
    const { status, customer_reference, provider_transaction_id, message } = req.body;

    if (!customer_reference) return res.status(400).send('Missing Ref');

    // Find by customer_reference
    const q = await db.collection('payments').where('customer_reference', '==', customer_reference).limit(1).get();
    
    if (q.empty) {
      console.log('Webhook: Ref not found', customer_reference);
      return res.status(200).send('OK'); // Return OK to stop retries even if not found
    }

    const doc = q.docs[0];
    const data = doc.data();

    if (status && status.toLowerCase() === 'success') {
      const batch = db.batch();
      
      batch.update(doc.ref, {
        status: 'success',
        externalReference: provider_transaction_id,
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Confirm Booking
      const bookingRef = db.collection('bookings').doc(data.bookingId);
      batch.update(bookingRef, {
        paymentStatus: 'paid',
        status: 'confirmed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await batch.commit();
    } else {
      await doc.ref.update({ status: 'failed', failureReason: message });
    }

    res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    res.status(500).send('Error');
  }
});

module.exports = router;