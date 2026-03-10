import React, { useEffect, useState } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import ExecutiveAssistant from './components/ExecutiveAssistant';
import usePushNotifications from './hooks/usePushNotifications';
import { useAuthGuard } from './auth/AuthGuard';

const firebaseConfig = {
  apiKey:            process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain:        process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.REACT_APP_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
getFunctions(app);

// ============================================================
// PWA INSTALL BANNER
// Shown on Android Chrome when beforeinstallprompt fires.
// On iOS Safari: shows manual "Add to Home Screen" instructions instead.
// ============================================================
function InstallBanner({ onInstall, onDismiss, isIOS }) {
  return (
    <div className="pwa-install-banner">
      <img src="/icons/apple-touch-icon.png" alt="EA" />
      <div className="pwa-install-banner-text">
        <div className="pwa-install-banner-title">Add EA to Home Screen</div>
        <div className="pwa-install-banner-sub">
          {isIOS
            ? 'Tap Share → "Add to Home Screen"'
            : 'Install for the full native experience'}
        </div>
      </div>
      {!isIOS && (
        <button className="pwa-install-btn" onClick={onInstall}>
          Install
        </button>
      )}
      <button className="pwa-dismiss-btn" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

// ============================================================
// APP ROOT — Login handled by /purgatory.html
// ============================================================
export default function App() {
  const [user, setUser] = useState(undefined);

  // PWA install prompt state
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [isIOS] = useState(() =>
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  const [isStandalone] = useState(() =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );

  // Push notifications
  const pushNotifications = usePushNotifications(user || null);

  // Auth state — sets user; allowlist + redirect handled by useAuthGuard below.
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => setUser(u || null));
    return unsub;
  }, []);

  // Auth guard — no UID or non-allowlisted email → /purgatory.html
  useAuthGuard(user);

  // Capture beforeinstallprompt (Android Chrome)
  useEffect(() => {
    function handleInstallPrompt(e) {
      e.preventDefault();
      setInstallPrompt(e);
      // Show banner after 3s if not already installed
      if (!isStandalone) {
        setTimeout(() => setShowInstallBanner(true), 3000);
      }
    }
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
  }, [isStandalone]);

  // Show iOS install hint to logged-in users on mobile, once
  useEffect(() => {
    if (!user) return;
    if (isStandalone) return; // already installed
    if (!isIOS) return;
    const dismissed = localStorage.getItem('ea_ios_install_dismissed');
    if (dismissed) return;
    const t = setTimeout(() => setShowInstallBanner(true), 4000);
    return () => clearTimeout(t);
  }, [user, isIOS, isStandalone]);

  async function handleSignOut() {
    await signOut(auth);
  }

  async function handleInstall() {
    if (!installPrompt) return;
    setShowInstallBanner(false);
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setInstallPrompt(null);
  }

  function handleDismissBanner() {
    setShowInstallBanner(false);
    if (isIOS) localStorage.setItem('ea_ios_install_dismissed', '1');
  }

  // ---- LOADING ----
  if (user === undefined) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100dvh',
        backgroundColor: '#060d18', color: '#4a5568',
        fontFamily: "'Inter', sans-serif", fontSize: '14px',
      }}>
        Loading…
      </div>
    );
  }

  // ---- LOGGED OUT (redirect to purgatory.html is already in flight via useAuthGuard) ----
  if (!user) return null;

  // ---- LOGGED IN ----
  return (
    <div style={{ position: 'relative', height: '100dvh' }}>
      <ExecutiveAssistant user={user} pushNotifications={pushNotifications} onSignOut={handleSignOut} />

      {/* PWA install banner */}
      {showInstallBanner && (
        <InstallBanner
          onInstall={handleInstall}
          onDismiss={handleDismissBanner}
          isIOS={isIOS}
        />
      )}
    </div>
  );
}
