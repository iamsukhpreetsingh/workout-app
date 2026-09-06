// useStaffNotifications — unread-count polling for the header bell.
// The backend has no realtime bus yet, so the bell polls every 45s and
// exposes refresh() so screens can bump the badge immediately after actions
// (approve/reject/etc.). Poll failure is silent — the badge is a nicety,
// never a blocker (spec: notification failure must not break the portal).
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStaffUnreadCount } from '../api/staffNotifications';

const POLL_MS = 45_000;

export default function useStaffNotifications(gymId: string | null | undefined, enabled: boolean) {
  const [unread, setUnread] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!gymId || !enabled) { setUnread(0); return; }
    try {
      const { count } = await getStaffUnreadCount(gymId);
      setUnread(count || 0);
    } catch {
      /* keep the last known count */
    }
  }, [gymId, enabled]);

  useEffect(() => {
    if (!gymId || !enabled) { setUnread(0); return; }
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [gymId, enabled, refresh]);

  return { unread, refresh };
}
