// ===== Firebase Configuration =====
// Replace these placeholder values with your actual Firebase project config.
// Find them in: Firebase Console → Project Settings → Your apps → SDK setup
// IMPORTANT: These values are safe to expose in client-side code.
// Security is enforced by Firestore Security Rules (firestore.rules), NOT by hiding these keys.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey:            "AIzaSyAlVOL4oPiYAmCP4VWkrY8-iwlWHyl7ESg",
  authDomain:        "romantech-4293f.firebaseapp.com",
  projectId:         "romantech-4293f",
  storageBucket:     "romantech-4293f.firebasestorage.app",
  messagingSenderId: "892337409820",
  appId:             "1:892337409820:web:24e4d21bc3b0ad5a92f4d9"
};

const app = initializeApp(firebaseConfig);

export const db   = getFirestore(app);
export const auth = getAuth(app);
