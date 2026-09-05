// Gym context — the member's gym foundation state (Mobile M1).
//
// Server-authoritative, like every gym surface: the backend resolves the
// caller's gym_members rows from the JWT (/gym/my/*), so the client never
// sends a gymId and can never reach another gym's data. This provider is
// the SINGLE owner of that snapshot — the gym home screen (GymMain, pushed
// from MyGymCard) and MyGymCard both consume it instead of fetching
// independently.
//
// What it exposes (only what the foundation screens actually need):
//   gym            the active gym row (gym + gymMember + membership term)
//   gymMember      { id, member_code, status, joined_at }
//   membership     { plan_name, status, starts_on, ends_on }
//   attendance     { visits7, visits30, lastVisit } — derived READ-ONLY summary
//   notificationsUnread  from the existing notification store (no new fetch)
//   memberships    EVERY gym row — the layer is multi-gym safe; activeGymId
//                  picks the row the screens show, setActiveGymId switches.
//
// Lifecycle contract:
//   - the FIRST load after login shows the loading state (memberships null);
//     every reload() after that is a BACKGROUND refresh — the previous
//     snapshot stays on screen until the fresh one swaps in, so hasGym
//     never flickers and screens never lose their content mid-focus
//   - a standalone user resolves to memberships [] → hasGym false →
//     MyGymCard renders nothing and the gym home screen is unreachable;
//     the core app looks exactly as before
//   - logout / session loss resets everything — no gym data survives a
//     session (reset is explicit here because no central store reset exists)
//   - network failures surface as { error } for the screen's LoadError;
//     they NEVER log the user out (the api() refresh contract handles that).
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { useNotifications } from './NotificationContext';
import { fetchMyGymMemberships, fetchMyGymAttendanceHistory } from '../lib/gymApi';
import { resolveActiveMembershipRow, summarizeAttendance } from '../lib/gymState';

const GymContext = createContext(null);

export function GymProvider({ children }) {
  const { authStatus, user } = useAuth();
  const { unreadCount } = useNotifications();
  // memberships === null → initial load in progress; [] → resolved, no gym
  const [memberships, setMemberships] = useState(null);
  const [histories, setHistories] = useState([]);
  const [error, setError] = useState(null);
  const [activeGymId, setActiveGymId] = useState(null);
  const [tick, setTick] = useState(0);
  // Which user the current snapshot belongs to. reload() (tick) must be a
  // BACKGROUND refresh — the M1.1 bug: every focus refetch reset
  // memberships to null, which flipped hasGym off and tore the consuming
  // screens down mid-render. Now only the first load of a session does.
  const snapshotUidRef = useRef(null);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !user) {
      // logout / auth loss — clear everything, nothing survives the session
      snapshotUidRef.current = null;
      setMemberships(null);
      setHistories([]);
      setError(null);
      setActiveGymId(null);
      return;
    }
    const uid = user.id || user.email || 'me';
    const isFirstLoad = snapshotUidRef.current !== uid;
    snapshotUidRef.current = uid;
    let mounted = true;
    if (isFirstLoad) {
      // first load of this session — screens show their loading state
      setMemberships(null);
      setHistories([]);
    }
    setError(null);
    (async () => {
      try {
        // Both endpoints resolve the caller from the JWT; a standalone user
        // gets [] from each. One round-trip pair covers the whole foundation.
        const [rows, perGymHistory] = await Promise.all([
          fetchMyGymMemberships(),
          fetchMyGymAttendanceHistory(),
        ]);
        if (!mounted) return;
        const list = Array.isArray(rows) ? rows : [];
        setMemberships(list);
        setHistories(Array.isArray(perGymHistory) ? perGymHistory : []);
        // keep the user's explicit selection when it is still valid,
        // otherwise fall back to the derived active row
        setActiveGymId((prev) => {
          const kept = prev && list.some((r) => r && r.gym_id === prev) ? prev : null;
          return kept || (resolveActiveMembershipRow(list) || {}).gym_id || null;
        });
      } catch (e) {
        console.warn('[GymContext] load failed:', e?.message || e);
        if (!mounted) return;
        setError(e);
        if (isFirstLoad) {
          setMemberships([]); // first load failed: resolved-with-error → LoadError + retry
          setHistories([]);
        }
        // background refresh failure: keep the previous snapshot on screen
      }
    })();
    return () => {
      mounted = false;
    };
  }, [authStatus, user, tick]);

  const activeRow = useMemo(
    () => resolveActiveMembershipRow(memberships || [], activeGymId),
    [memberships, activeGymId]
  );

  const attendance = useMemo(() => {
    const entry = (histories || []).find((h) => h && h.gym_id === (activeRow || {}).gym_id);
    return summarizeAttendance(entry ? entry.history : null);
  }, [histories, activeRow]);

  const value = useMemo(
    () => ({
      loading: memberships === null,
      error,
      reload,
      hasGym: !!memberships && memberships.length > 0,
      memberships: memberships || [],
      activeGymId,
      setActiveGymId,
      gym: activeRow,
      gymMember: activeRow
        ? {
            id: activeRow.id,
            member_code: activeRow.member_code,
            status: activeRow.status,
            joined_at: activeRow.joined_at,
          }
        : null,
      membership: activeRow
        ? {
            plan_name: activeRow.plan_name,
            status: activeRow.membership_status,
            starts_on: activeRow.starts_on,
            ends_on: activeRow.ends_on,
            // M5 member home — server-provided context for the FROZEN and
            // EXPIRED displays (open freeze row + which term row is shown).
            // The status itself stays server-decided; nothing is derived here.
            membership_id: activeRow.membership_id,
            freeze_starts_on: activeRow.freeze_starts_on,
            freeze_reason: activeRow.freeze_reason,
          }
        : null,
      attendance,
      notificationsUnread: unreadCount,
    }),
    [memberships, error, reload, activeRow, attendance, unreadCount, activeGymId]
  );

  return <GymContext.Provider value={value}>{children}</GymContext.Provider>;
}

export function useGym() {
  const ctx = useContext(GymContext);
  if (!ctx) {
    throw new Error('useGym must be used inside GymProvider');
  }
  return ctx;
}
