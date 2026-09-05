// Invitation context — holds the one pending gym-invitation token and the
// app-wide deep-link wiring (Mobile M4).
//
// WHY a context instead of React Navigation linking config: the auth gate
// conditionally mounts AuthStack OR MainStack (the M1.1 rule — nothing
// async may reshape a navigator), so a URL cannot be mapped to one screen
// reliably across auth states. Instead, this provider listens for links,
// extracts the token, and AppContent renders the invitation gate as an
// overlay (the ViewChoiceScreen/intake-gate pattern) ABOVE whichever tree
// is mounted. Same UX in every auth state, zero navigator surgery.
//
// Delivery channels covered:
//   • cold start from an email/SMS link  → Linking.getInitialURL()
//   • warm start (app open/backgrounded) → Linking 'url' events
//   • app killed MID-FLOW               → the token persists in SecureStore
//     and hydrates on the next launch, so the invitation resumes instead
//     of silently vanishing
//   • no link at all (desk reads the code over the counter / WhatsApp) →
//     manual entry from the My Gym card calls openInvitation() directly
//
// Reset-password links (workouttracker://reset-password?…) are NOT touched
// here — they keep flowing through the NavigationContainer linking config.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { extractInvitationToken } from '../lib/gymInvites';

const PENDING_KEY = 'wt_pending_gym_invite';

const InvitationContext = createContext(null);

export function InvitationProvider({ children }) {
  const [token, setToken] = useState(null); // null = no invitation session
  const [resumed, setResumed] = useState(false); // hydrate finished?
  // Mirrors `token` for the once-registered link listeners (their closure
  // would otherwise see the first render's state forever).
  const tokenRef = useRef(null);
  const seenRef = useRef(null); // dedupe repeated opens of the same link

  const openInvitation = async (input) => {
    const t = extractInvitationToken(input);
    if (!t) return false;
    if (seenRef.current === t && tokenRef.current === t) return true; // already showing it
    seenRef.current = t;
    tokenRef.current = t;
    setToken(t);
    try {
      await SecureStore.setItemAsync(PENDING_KEY, t);
    } catch {
      // persistence is best-effort — the flow still works this session
    }
    return true;
  };

  const close = async () => {
    seenRef.current = null;
    tokenRef.current = null;
    setToken(null);
    try {
      await SecureStore.deleteItemAsync(PENDING_KEY);
    } catch {
      // ignore
    }
  };

  // Boot: resume a persisted invitation (app closed during the flow).
  useEffect(() => {
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(PENDING_KEY);
        if (saved && extractInvitationToken(saved)) setToken(saved);
      } catch {
        // ignore — no persisted invitation
      } finally {
        setResumed(true);
      }
    })();
  }, []);

  // Deep links — cold start, then warm-start events. Only invitation paths
  // are consumed; every other URL (reset-password) is ignored and left to
  // the NavigationContainer linking config.
  useEffect(() => {
    let cancelled = false;
    Linking.getInitialURL()
      .then((url) => {
        if (!cancelled && url) openInvitation(url);
      })
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) openInvitation(url);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <InvitationContext.Provider value={{ token, active: resumed && !!token, openInvitation, close }}>
      {children}
    </InvitationContext.Provider>
  );
}

export function useInvitation() {
  const ctx = useContext(InvitationContext);
  if (!ctx) throw new Error('useInvitation must be used inside InvitationProvider');
  return ctx;
}
