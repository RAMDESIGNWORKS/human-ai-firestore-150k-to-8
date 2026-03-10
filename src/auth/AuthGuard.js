import { useEffect } from 'react';
import { getAuth, signOut } from 'firebase/auth';

// ============================================================
// ALLOWED USERS — single source of truth for this project.
// Matches Firestore rules and is enforced here client-side
// as a first layer; Cloud Functions enforce server-side.
// ============================================================
export const ALLOWED_EMAILS = [
  'admin@ramdesignworks.com',
  'r0dmac522@gmail.com',
  'r0dger@hotmail.com',
];

/**
 * Auth guard hook — call once at the root of the app.
 *
 * Rules:
 *  - user === undefined  → auth state still loading; do nothing yet
 *  - user === null       → not signed in → /purgatory.html
 *  - user not in allowlist → sign out → /purgatory.html
 *  - user in allowlist   → authorized; app continues
 *
 * @param {object|null|undefined} user - Firebase Auth user object, null, or undefined (loading)
 */
export function useAuthGuard(user) {
  const auth = getAuth();

  useEffect(() => {
    // Auth state is still initializing — do not redirect yet.
    if (user === undefined) return;

    // No Firebase UID — not signed in.
    if (!user || !user.uid) {
      window.location.replace('/purgatory.html');
      return;
    }

    // Signed in but email is not on the allowlist — boot them immediately.
    if (!ALLOWED_EMAILS.includes(user.email?.toLowerCase())) {
      signOut(auth).finally(() => {
        window.location.replace('/purgatory.html');
      });
    }
  }, [user, auth]);
}
