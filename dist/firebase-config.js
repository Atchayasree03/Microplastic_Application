// ─── Firebase Configuration ───
// To enable cloud data persistence:
//   1. Create a project at https://console.firebase.google.com
//   2. Enable Firestore Database (start in Test mode)
//   3. Add a Web app and copy the config below
// Without Firebase the app still works using localStorage.

var FIREBASE_CONFIG = null;   // set to null → localStorage only

// UNCOMMENT and fill in your Firebase project details:
// var FIREBASE_CONFIG = {
//   apiKey:            "YOUR_API_KEY",
//   authDomain:        "your-project.firebaseapp.com",
//   projectId:         "your-project-id",
//   storageBucket:     "your-project.appspot.com",
//   messagingSenderId: "123456789",
//   appId:             "1:123456789:web:abcdef"
// };

// ─── Initialise ───
var db = null;
if (typeof firebase !== 'undefined' && FIREBASE_CONFIG) {
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    console.log('[Firebase] Initialized ✓');
    // Real-time sync Firestore → localStorage
    db.collection('sessions').orderBy('timestamp').onSnapshot(function (snap) {
      var sessions = [];
      snap.forEach(function (doc) { sessions.push(doc.data()); });
      localStorage.setItem('mp_sessions', JSON.stringify(sessions));
    });
    db.collection('zones').onSnapshot(function (snap) {
      var zones = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        d._firebaseId = doc.id;
        zones.push(d);
      });
      localStorage.setItem('mp_zones', JSON.stringify(zones));
    });
  } catch (e) {
    console.warn('[Firebase] Init failed, using localStorage:', e);
  }
} else {
  console.log('[Firebase] Not configured – using localStorage');
}

// ─── Helper: push to Firestore (fire-and-forget) ───
function fbSaveSession(session) {
  if (db) db.collection('sessions').add(session).catch(function (e) {
    console.warn('[Firebase] session save failed:', e);
  });
}
function fbSaveZones(zones) {
  if (!db) return;
  // Overwrite zones: delete all then re-add
  var batch = db.batch();
  db.collection('zones').get().then(function (snap) {
    snap.forEach(function (doc) { batch.delete(doc.ref); });
    zones.forEach(function (z) {
      var ref = db.collection('zones').doc();
      batch.set(ref, z);
    });
    return batch.commit();
  }).catch(function (e) { console.warn('[Firebase] zone save failed:', e); });
}
