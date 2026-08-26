// Impersonation session state: a support/super_admin can open a short-lived
// read-only token "as" an end user for debugging. While active, a persistent
// orange banner is shown across the whole app until Exit is pressed or the
// 15-minute server-side TTL lapses.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Button, Space, Typography } from 'antd';

export interface ImpersonatedUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface ImpersonationSession {
  token: string;
  user: ImpersonatedUser;
  startedAt: number;
  expiresInSeconds: number;
}

interface ImpersonationCtx {
  session: ImpersonationSession | null;
  start: (s: Omit<ImpersonationSession, 'startedAt'>) => void;
  stop: () => void;
}

const Ctx = createContext<ImpersonationCtx>({
  session: null,
  start: () => {},
  stop: () => {},
});

export function ImpersonationProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<ImpersonationSession | null>(null);

  const start = useCallback((s: Omit<ImpersonationSession, 'startedAt'>) => {
    setSession({ ...s, startedAt: Date.now() });
  }, []);
  const stop = useCallback(() => setSession(null), []);

  const value = useMemo(() => ({ session, start, stop }), [session, start, stop]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useImpersonation() {
  return useContext(Ctx);
}

function minutesLeft(session: ImpersonationSession) {
  const elapsed = (Date.now() - session.startedAt) / 1000;
  return Math.max(0, Math.ceil((session.expiresInSeconds - elapsed) / 60));
}

export function ImpersonationBanner() {
  const { session, stop } = useImpersonation();
  const [mins, setMins] = useState(0);

  useEffect(() => {
    if (!session) return;
    const tick = () => {
      const left = minutesLeft(session);
      setMins(left);
      if (left <= 0) stop();
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, [session, stop]);

  if (!session) return null;

  return (
    <>
      {/* reserves layout space so the fixed bar never covers page content */}
      <div style={{ height: 36 }} />
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          background: '#d46b08',
          color: '#fff',
          padding: '6px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          minHeight: 36,
        }}
      >
      <Space>
        <span>
          You are viewing as <b>{session.user.name}</b> ({session.user.email}) — read-only
          session, expires in {mins} min
        </span>
        <Button
          size="small"
          onClick={() => navigator.clipboard?.writeText(session.token).catch(() => {})}
        >
          Copy token
        </Button>
        <Button size="small" danger onClick={stop}>
          Exit
        </Button>
      </Space>
      </div>
    </>
  );
}
