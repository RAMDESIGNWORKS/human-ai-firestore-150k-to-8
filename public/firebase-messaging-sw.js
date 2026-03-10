// ============================================================
// FIREBASE MESSAGING SERVICE WORKER
// Required by Firebase Cloud Messaging for background notifications
// Must live at /public/firebase-messaging-sw.js (served from root)
// ============================================================

// Firebase versions must match what's used in the main app
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// Firebase config — these are public/safe to expose in service workers
// Replace with your actual Firebase project config
firebase.initializeApp({
  apiKey:            'AIzaSyA_Ady_SFEFaW1DZNwX-9aUQ-DhOO7oVoU',
  authDomain:        'ramdesignworks-exec-staff.firebaseapp.com',
  projectId:         'ramdesignworks-exec-staff',
  storageBucket:     'ramdesignworks-exec-staff.firebasestorage.app',
  messagingSenderId: '347930374163',
  appId:             '1:347930374163:web:17c8e015df86c78504cfe6',
});

const messaging = firebase.messaging();

// Handle background messages (app is closed or in background)
messaging.onBackgroundMessage(payload => {
  const { title, body, icon, tag, data } = payload.notification || {};

  const notificationTitle = title || 'EA Reminder';
  const notificationOptions = {
    body: body || '',
    icon: icon || '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: tag || 'ea-notification',
    data: {
      url: data?.url || '/',
      sessionId: data?.sessionId || null,
      type: data?.type || 'general',
    },
    requireInteraction: data?.requireInteraction === 'true',
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});
