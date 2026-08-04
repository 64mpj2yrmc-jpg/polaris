// Firebase client SDK config for the Polaris frontend.
// Not used yet — this is scaffolding for Phase 2 (the dashboard reading
// /alerts in real time via onSnapshot, signed in anonymously). Nothing in
// index.html imports this yet.
//
// Get real values from: Firebase Console -> Project settings -> General ->
// "Your apps" -> Web app -> SDK setup and configuration -> Config.
// (Or run `firebase apps:sdkconfig web` from the CLI once the project and a
// web app exist.)
//
// These values are PUBLIC identifiers, not secrets — every Firebase web app
// ships them in client-side code. Firestore Security Rules (firestore.rules)
// are what actually protect your data, not keeping this file private.

export const firebaseConfig = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
