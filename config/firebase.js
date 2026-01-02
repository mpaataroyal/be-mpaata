const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // Adjust path as needed

// Check if app is already initialized to avoid errors
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

module.exports = { admin, db };