const express = require('express');
const router = express.Router();
// 👇 UPDATED: Import db to clean up Firestore data when deleting
const { admin, db } = require('../config/firebase'); 
const { verifyToken, requireRole } = require('../middleware/auth');

// --- HELPER: Format Phone to E.164 (+256...) ---
const formatPhoneNumber = (phone) => {
  if (!phone) return null;
  let cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
  
  if (cleanPhone.startsWith('0')) {
    return '+256' + cleanPhone.substring(1);
  }
  if (!cleanPhone.startsWith('+')) {
    return '+256' + cleanPhone;
  }
  return cleanPhone;
};

// ==========================================
// 1. GET /api/v1/users 
// List all users + their roles
// ==========================================
router.get('/', verifyToken, requireRole(['admin', 'manager', 'receptionist']), async (req, res) => {
  try {
    const listUsersResult = await admin.auth().listUsers(1000);

    const users = listUsersResult.users.map((user) => ({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      phoneNumber: user.phoneNumber,
      role: user.customClaims ? user.customClaims.role : 'customer',
      lastSignInTime: user.metadata.lastSignInTime,
      creationTime: user.metadata.creationTime,
    }));

    res.json({
      success: true,
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 1b. GET /api/v1/users/:uid 
// Get a single user by UID
// ==========================================
router.get('/:uid', verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;

    // Allow users to get their own profile, or admins to get any profile
    if (req.user.uid !== uid && req.user.role !== 'admin' && req.user.role !== 'manager') {
      return res.status(403).json({ error: 'Unauthorized to view this profile' });
    }

    const userRecord = await admin.auth().getUser(uid);
    
    // Also fetch from Firestore for additional data if needed
    let firestoreData = {};
    if (db) {
      const doc = await db.collection('users').doc(uid).get();
      if (doc.exists) firestoreData = doc.data();
    }

    res.json({
      success: true,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        displayName: userRecord.displayName,
        phoneNumber: userRecord.phoneNumber,
        photoURL: userRecord.photoURL,
        role: userRecord.customClaims?.role || 'customer',
        ...firestoreData
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. POST /api/v1/users 
// Create a NEW user
// ==========================================
router.post('/', verifyToken, requireRole(['admin', 'manager']), async (req, res) => {
  try {
    const { email, password, phoneNumber, displayName, role } = req.body;

    const validRoles = ['admin', 'manager', 'receptionist', 'customer'];
    const assignedRole = validRoles.includes(role) ? role : 'customer';
    const formattedPhone = formatPhoneNumber(phoneNumber);

    // 1. Create User in Firebase Auth
    const userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      phoneNumber: formattedPhone,
      displayName: displayName,
      emailVerified: true 
    });

    // 2. Assign Role (Custom Claims)
    await admin.auth().setCustomUserClaims(userRecord.uid, { 
      role: assignedRole 
    });

    // 3. Create Shadow Document in Firestore (Recommended for consistency)
    if (db) {
      await db.collection('users').doc(userRecord.uid).set({
        email: email,
        name: displayName,
        role: assignedRole,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.status(201).json({
      success: true,
      message: `User created successfully as ${assignedRole}`,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
        phone: userRecord.phoneNumber,
        role: assignedRole
      }
    });

  } catch (error) {
    console.error('Create user error:', error);
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'Email already in use' });
    }
    if (error.code === 'auth/phone-number-already-exists') {
      return res.status(409).json({ error: 'Phone number already in use' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. PATCH /api/v1/users/:uid/role
// Update user role
// ==========================================
router.patch('/:uid/role', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { uid } = req.params;
    const { role } = req.body;

    if (!role || !['admin', 'manager', 'receptionist', 'customer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role provided' });
    }

    if (req.user.uid === uid) {
      return res.status(403).json({ error: 'You cannot change your own role.' });
    }

    const userRecord = await admin.auth().getUser(uid);
    const currentClaims = userRecord.customClaims || {};

    if (currentClaims.role === 'super_admin') {
      return res.status(403).json({ error: 'Cannot modify a Super Admin.' });
    }

    // Update Auth Claims
    await admin.auth().setCustomUserClaims(uid, {
      ...currentClaims,
      role: role
    });

    // Update Firestore Document
    if (db) {
       await db.collection('users').doc(uid).update({ role: role }).catch(() => {
         // Ignore error if doc doesn't exist
       });
    }

    res.json({
      success: true,
      message: `User ${userRecord.email} is now a ${role}`,
      data: { uid, role }
    });

  } catch (error) {
    console.error('Update role error:', error);
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'User not found' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3b. PUT /api/v1/users/:uid 
// Update user profile (e.g. Phone Number)
// ==========================================
router.put('/:uid', verifyToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const { phoneNumber, displayName } = req.body;

    // Ensure user is updating themselves or is an admin
    if (req.user.uid !== uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized to update this user' });
    }

    const updates = {};
    if (phoneNumber) updates.phoneNumber = formatPhoneNumber(phoneNumber);
    if (displayName) updates.displayName = displayName;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Update Auth
    await admin.auth().updateUser(uid, updates);

    // Update Firestore
    if (db) {
      const fsUpdates = {};
      if (updates.phoneNumber) fsUpdates.phoneNumber = updates.phoneNumber;
      if (updates.displayName) fsUpdates.name = updates.displayName; // Map displayName -> name for consistency
      
      await db.collection('users').doc(uid).set(fsUpdates, { merge: true });
    }

    res.json({
      success: true,
      message: 'User profile updated successfully',
      data: { uid, ...updates }
    });

  } catch (error) {
    console.error('Update user error:', error);
    if (error.code === 'auth/phone-number-already-exists') {
      return res.status(409).json({ error: 'Phone number already in use by another account' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 4. DELETE /api/v1/users/:uid 
// Delete a user (Auth + Firestore)
// ==========================================
router.delete('/:uid', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const { uid } = req.params;

    // 1. Prevent deleting yourself
    if (req.user.uid === uid) {
      return res.status(403).json({ 
        success: false, 
        message: 'You cannot delete your own account.' 
      });
    }

    // 2. Prevent deleting Super Admins
    const userRecord = await admin.auth().getUser(uid);
    const claims = userRecord.customClaims || {};
    
    if (claims.role === 'super_admin') {
      return res.status(403).json({ 
        success: false, 
        message: 'Cannot delete a Super Admin.' 
      });
    }

    // 3. Delete from Firebase Authentication
    await admin.auth().deleteUser(uid);

    // 4. Delete from Firestore (Shadow Document)
    if (db) {
      await db.collection('users').doc(uid).delete();
    }

    res.json({
      success: true,
      message: 'User deleted successfully from Auth and Database.',
      data: { uid }
    });

  } catch (error) {
    console.error('Delete user error:', error);
    if (error.code === 'auth/user-not-found') {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found.' 
      });
    }
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

module.exports = router;