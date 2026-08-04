// Firebase client SDK config for the Polaris frontend (Phase 2: reading
// /alerts live and updating their status). Loaded as a plain global via
// <script src="firebaseConfig.js"></script> in index.html, before the main
// Babel script -- kept in its own file so it's easy to swap per deployment,
// not because these values are secret (they aren't; every Firebase web app
// ships them in client-side code -- Firestore Security Rules are what
// actually protect your data, not keeping this file private).
//
// Get real values from: Firebase Console -> your project -> gear icon ->
// Project settings -> General -> "Your apps". If there's no web app listed
// yet, click "Add app" -> the </> (Web) icon -> give it any nickname, skip
// Firebase Hosting -> it'll show this exact object to copy.

window.POLARIS_FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
