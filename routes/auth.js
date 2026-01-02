// routes/auth.js
const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { db } = require('../config/firebase');
const { verifyToken, isOwnerOrAdmin } = require('../middleware/auth');

// POST /api/v1/auth/google - Google OAuth login/sync
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        success: false,
        message: 'ID token is required',
        data: null,
        error: { code: 'MISSING_TOKEN' }
      });
    }

    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;

    // Check if user exists in Firestore
    const usersRef = db.collection('users');
    const userQuery = await usersRef.where('email', '==', email).limit(1).get();

    let userId;
    let userData;

    if (userQuery.empty) {
      // Create new user
      const newUser = {
        firebaseUid: uid,
        email,
        name: name || email.split('@')[0],
        photoUrl: picture || null,
        role: 'customer', // Default role
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      const userDoc = await usersRef.add(newUser);
      userId = userDoc.id;
      userData = { ...newUser, id: userId };
    } else {
      // Update existing user
      const userDoc = userQuery.docs[0];
      userId = userDoc.id;
      userData = { id: userId, ...userDoc.data() };

      // Update user info
      await usersRef.doc(userId).update({
        name: name || userData.name,
        photoUrl: picture || userData.photoUrl,
        firebaseUid: uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({
      success: true,
      message: 'Authentication successful',
      data: {
        user: {
          id: userId,
          email: userData.email,
          name: userData.name,
          role: userData.role,
          photoUrl: userData.photoUrl
        }
      },
      error: null
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(401).json({
      success: false,
      message: 'Authentication failed',
      data: null,
      error: { code: 'AUTH_FAILED', details: error.message }
    });
  }
});

// POST /api/v1/auth/logout - Logout
router.post('/logout', verifyToken, async (req, res) => {
  try {
    // You can add additional cleanup here if needed
    // For example, invalidating sessions, clearing cache, etc.

    res.json({
      success: true,
      message: 'Logged out successfully',
      data: null,
      error: null
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed',
      data: null,
      error: { code: 'LOGOUT_FAILED' }
    });
  }
});


module.exports = router;