const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase'); 
const { verifyToken, requireRole } = require('../middleware/auth');
const { DateTime, Interval } = require('luxon');

// Helper: Initialize Chart Buckets (Map for O(1) lookup)
const initChartMap = (range) => {
  const map = new Map();
  const now = DateTime.now();
  const data = [];

  if (range === '1y') {
    // Last 12 months
    for (let i = 11; i >= 0; i--) {
      const dt = now.minus({ months: i });
      const key = dt.toFormat('yyyy-MM'); // Key: 2025-12
      const entry = {
        name: dt.toFormat('MMM yyyy'),    // Display: Dec 2025
        key: key,
        revenue: 0,
        bookings: 0
      };
      map.set(key, entry);
      data.push(entry);
    }
  } else {
    // Last 7 or 30 days
    const days = range === '30d' ? 30 : 7;
    for (let i = days - 1; i >= 0; i--) {
      const dt = now.minus({ days: i });
      const key = dt.toISODate();         // Key: 2025-12-18
      const entry = {
        name: dt.toFormat('MMM dd'),      // Display: Dec 18
        key: key,
        revenue: 0,
        bookings: 0
      };
      map.set(key, entry);
      data.push(entry);
    }
  }
  return { map, array: data };
};

router.get('/stats', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { range = '7d' } = req.query; 
    const now = DateTime.now();

    // 1. Fetch Data
    const [bookingsSnap, paymentsSnap, roomsSnap, usersSnap] = await Promise.all([
      db.collection('bookings').get(),
      db.collection('payments').get(),
      db.collection('rooms').get(),
      db.collection('users').get()
    ]);

    // 2. Prepare Chart Structure
    const { map: chartMap, array: chartArray } = initChartMap(range);
    
    let totalRevenue = 0;
    let activeBookingsCount = 0;
    const recentBookings = [];

    // 3. Process Bookings
    bookingsSnap.forEach(doc => {
      const b = { id: doc.id, ...doc.data() };
      
      // Safety: Fallback to now() if createdAt is missing
      const rawDate = b.createdAt ? b.createdAt.toDate() : new Date();
      const bookingDate = DateTime.fromJSDate(rawDate);
      
      const checkIn = b.checkIn ? DateTime.fromJSDate(b.checkIn.toDate()) : now;
      const checkOut = b.checkOut ? DateTime.fromJSDate(b.checkOut.toDate()) : now;

      // --- CHART AGGREGATION ---
      // Determine the key for this booking based on selected range
      const matchKey = range === '1y' 
        ? bookingDate.toFormat('yyyy-MM') 
        : bookingDate.toISODate();

      // If this booking falls into one of our chart buckets
      if (chartMap.has(matchKey)) {
        const entry = chartMap.get(matchKey);
        
        // Increment Booking Count
        entry.bookings += 1;

        // Increment Revenue (only if valid)
        if (b.paymentStatus === 'paid' || b.status === 'confirmed') {
          const amount = Number(b.totalPrice) || 0;
          entry.revenue += amount;
        }
      }

      // --- TOTAL METRICS ---
      if (b.paymentStatus === 'paid' || b.status === 'confirmed') {
        totalRevenue += (Number(b.totalPrice) || 0);
      }

      // --- ACTIVE BOOKINGS ---
      const stayInterval = Interval.fromDateTimes(checkIn, checkOut);
      if (stayInterval.contains(now) && b.status !== 'cancelled') {
        activeBookingsCount++;
      }

      // --- RECENT LIST ---
      if (recentBookings.length < 5) {
        recentBookings.push({
          key: b.id,
          id: b.id,
          guest: b.guestName,
          amount: b.totalPrice,
          status: b.status
        });
      }
    });

    // 4. Payment Methods (All Time)
    const paymentMethods = {};
    paymentsSnap.forEach(doc => {
      const p = doc.data();
      let method = p.provider || p.method || 'Cash';
      // Normalize
      if (method.toLowerCase().includes('mobile')) method = 'Mobile Money';
      else if (method.toLowerCase().includes('visa') || method.toLowerCase().includes('card')) method = 'Visa';
      else method = 'Cash';
      
      paymentMethods[method] = (paymentMethods[method] || 0) + 1;
    });

    const paymentChartData = Object.keys(paymentMethods).map(key => ({
      name: key,
      value: paymentMethods[key]
    }));

    res.json({
      success: true,
      stats: {
        range,
        revenue: {
          total: totalRevenue,
          chart: chartArray // This is the array Recharts needs
        },
        bookings: {
          active: activeBookingsCount,
          recent: recentBookings
        },
        rooms: {
          total: roomsSnap.size,
          available: Math.max(0, roomsSnap.size - activeBookingsCount)
        },
        users: {
          total: usersSnap.size
        },
        payments: {
          breakdown: paymentChartData
        }
      }
    });

  } catch (error) {
    console.error('Dashboard Stats Error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;