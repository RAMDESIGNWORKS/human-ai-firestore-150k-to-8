import { useState, useEffect, useCallback } from 'react';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { getFunctions, httpsCallable } from 'firebase/functions';

// VAPID key from Firebase Console → Project Settings → Cloud Messaging
// Set this in your .env as REACT_APP_FIREBASE_VAPID_KEY
const VAPID_KEY = process.env.REACT_APP_FIREBASE_VAPID_KEY;

// ============================================================
// usePushNotifications
//
// Manages the full push notification lifecycle:
//   1. Check current permission state
//   2. Request permission (on user gesture — required by browsers)
//   3. Get FCM token
//   4. Save token to Firestore via Cloud Function
//   5. Handle foreground messages
//   6. Returns state for UI to render permission prompts
// ============================================================

export default function usePushNotifications(user) {
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [fcmToken, setFcmToken] = useState(null);
  const [foregroundMessage, setForegroundMessage] = useState(null);
  const [error, setError] = useState(null);

  const functions = getFunctions();
  const savePushToken = httpsCallable(functions, 'savePushToken');

  // --------------------------------------------------------
  // On mount: check existing permission, subscribe if granted
  // --------------------------------------------------------
  useEffect(() => {
    if (!user) return;
    if (permission === 'granted') {
      subscribeToFCM();
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // --------------------------------------------------------
  // Request permission — must be called from a user gesture
  // --------------------------------------------------------
  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      setError('Notifications are not supported in this browser.');
      return false;
    }

    // iOS Safari requires the user to explicitly add to home screen
    // for push notifications (iOS 16.4+)
    if (isIOS() && !isRunningAsPWA()) {
      setError('To receive notifications on iPhone, add this app to your home screen first.');
      return false;
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);

      if (result === 'granted') {
        await subscribeToFCM();
        return true;
      }
      return false;
    } catch (err) {
      setError('Could not enable notifications. Try again from browser settings.');
      return false;
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // --------------------------------------------------------
  // Subscribe to FCM and save token
  // --------------------------------------------------------
  const subscribeToFCM = useCallback(async () => {
    if (!VAPID_KEY) {
      console.warn('REACT_APP_FIREBASE_VAPID_KEY not set — push notifications disabled.');
      return;
    }

    try {
      const messaging = getMessaging();

      const token = await getToken(messaging, { vapidKey: VAPID_KEY });
      if (!token) return;

      setFcmToken(token);

      // Save token to Firestore (server-side via Cloud Function)
      await savePushToken({ token, platform: getPlatform() });

      // Listen for messages when app is in foreground
      const unsubscribe = onMessage(messaging, (payload) => {
        setForegroundMessage(payload);
        // Show in-app notification banner (not a system notification)
        // The service worker handles background/closed notifications
      });

      return unsubscribe;
    } catch (err) {
      // Common failure: service worker not registered, or VAPID key wrong
      console.error('FCM subscription failed:', err.message);
      setError(null); // Don't surface technical errors to user
    }
  }, [savePushToken]);

  // --------------------------------------------------------
  // Dismiss foreground message
  // --------------------------------------------------------
  const dismissForegroundMessage = useCallback(() => {
    setForegroundMessage(null);
  }, []);

  return {
    permission,           // 'default' | 'granted' | 'denied' | 'unsupported'
    fcmToken,
    foregroundMessage,
    error,
    requestPermission,
    dismissForegroundMessage,
    isSupported: permission !== 'unsupported',
    needsPrompt: permission === 'default',
    isDenied: permission === 'denied',
  };
}

// --------------------------------------------------------
// Helpers
// --------------------------------------------------------

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isRunningAsPWA() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

function getPlatform() {
  if (isIOS()) return isRunningAsPWA() ? 'ios-pwa' : 'ios-browser';
  if (/Android/.test(navigator.userAgent)) return 'android';
  if (/Mobi/.test(navigator.userAgent)) return 'mobile-other';
  return 'desktop';
}
