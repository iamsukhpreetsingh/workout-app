// Gym Management platform shell.
//
// Structure per the Phase 3 spec: a desktop-first layout with a
// permission-filtered sidebar and one route per section. Nav visibility is
// driven by the SERVER-resolved permission list (GET /gym/:id/permissions) —
// the portal hides UI by role, the backend is the authority. Direct URL
// access to a section without its permission renders PermissionDenied.
import React, { useCallback, useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import {
  Layout, Menu, Select, Typography, Spin, Dropdown, App as AntApp, Button, Empty,
} from 'antd';
import {
  DashboardOutlined, TeamOutlined, IdcardOutlined, CreditCardOutlined,
  CheckSquareOutlined, UserOutlined, ThunderboltOutlined, AppleOutlined,
  CalendarOutlined, SoundOutlined, BarChartOutlined, SettingOutlined,
  PlusOutlined, LogoutOutlined, CrownOutlined,
} from '@ant-design/icons';
import {
  UserProfile, GymMembershipEntry, getMyGyms, getGymPermissions, getSelectedGymId,
  setSelectedGymId, hasAccessToken, clearSession, logout, GymPermissions,
} from './api';
import { GymContext, hasPermission } from './permissions';
import { PermissionDenied } from './components/States';
import LoginPage from './pages/LoginPage';
import CreateGymWizard from './pages/CreateGymWizard';
import Dashboard from './pages/Dashboard';
import SettingsPage from './pages/SettingsPage';
import MembersPage from './pages/MembersPage';
import MemberDetailPage from './pages/MemberDetailPage';
import StaffPage from './pages/StaffPage';
import TrainersPage from './pages/TrainersPage';
import PlaceholderPage from './pages/PlaceholderPage';

const { Header, Sider, Content } = Layout;

// Nav entries: rendered only when the caller holds ANY listed permission.
const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', icon: <DashboardOutlined />, perms: [] },
  { path: '/members', label: 'Members', icon: <TeamOutlined />, perms: ['members.view'] },
  { path: '/memberships', label: 'Memberships', icon: <IdcardOutlined />, perms: ['memberships.view'] },
  { path: '/payments', label: 'Payments', icon: <CreditCardOutlined />, perms: ['payments.manage'] },
  { path: '/attendance', label: 'Attendance', icon: <CheckSquareOutlined />, perms: ['attendance.manage', 'checkin.manage'] },
  { path: '/trainers', label: 'Trainers', icon: <UserOutlined />, perms: ['staff.manage'] },
  { path: '/workouts', label: 'Workouts', icon: <ThunderboltOutlined />, perms: ['content.manage', 'workouts.manage'] },
  { path: '/nutrition', label: 'Nutrition', icon: <AppleOutlined />, perms: ['content.manage', 'nutrition.manage'] },
  { path: '/classes', label: 'Classes', icon: <CalendarOutlined />, perms: ['content.manage'] },
  { path: '/communications', label: 'Communications', icon: <SoundOutlined />, perms: ['communications.manage'] },
  { path: '/reports', label: 'Reports', icon: <BarChartOutlined />, perms: ['reports.view'] },
  { path: '/staff', label: 'Staff', icon: <CrownOutlined />, perms: ['staff.manage'] },
  { path: '/settings/profile', label: 'Settings', icon: <SettingOutlined />, perms: ['settings.manage'] },
];

export default function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

function Shell() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [gyms, setGyms] = useState<GymMembershipEntry[] | null>(null);
  const [gymId, setGymId] = useState<string | null>(getSelectedGymId());
  const [perm, setPerm] = useState<GymPermissions | null>(null);
  const [permLoading, setPermLoading] = useState(false);
  const [booting, setBooting] = useState(hasAccessToken());

  const refreshGyms = useCallback(async (preferId?: string) => {
    const mine = await getMyGyms();
    setGyms(mine);
    const wanted = preferId || getSelectedGymId();
    const valid = mine.find((g) => g.id === wanted) || null;
    const chosen = valid ? valid.id : (mine[0]?.id ?? null);
    setSelectedGymId(chosen);
    setGymId(chosen);
    return { mine, chosen };
  }, []);

  // resolve the gym-scoped permission set whenever the selected gym changes
  useEffect(() => {
    if (!gymId) { setPerm(null); return; }
    let cancelled = false;
    setPermLoading(true);
    getGymPermissions(gymId)
      .then((p) => { if (!cancelled) setPerm(p); })
      .catch(() => { if (!cancelled) setPerm(null); })
      .finally(() => { if (!cancelled) setPermLoading(false); });
    return () => { cancelled = true; };
  }, [gymId]);

  useEffect(() => {
    if (!hasAccessToken()) { setBooting(false); return; }
    (async () => {
      try {
        await refreshGyms();
      } catch {
        clearSession();
      } finally {
        setBooting(false);
      }
    })();
  }, [refreshGyms]);

  if (booting) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!hasAccessToken()) {
    return (
      <LoginPage
        onLogin={async (u) => {
          setUser(u);
          const { chosen } = await refreshGyms();
          navigate(chosen ? '/' : '/create-gym');
        }}
      />
    );
  }

  const mine = gyms || [];
  const ctx = perm && perm.gymId === gymId
    ? { gymId: perm.gymId, role: perm.gymRole, permissions: perm.permissions }
    : null;

  const visibleNav = NAV_ITEMS.filter(
    (item) => item.perms.length === 0 || hasPermission(ctx, ...item.perms)
  );

  const switchGym = (id: string) => {
    setSelectedGymId(id);
    setGymId(id);
    setPerm(null);
    navigate('/');
  };

  const signedOut = async () => {
    await logout();
    setUser(null);
    setGyms([]);
    setPerm(null);
    // clear the gym selection too — a subsequent login must re-resolve
    // permissions, and keeping the id would suppress the effect refetch
    setSelectedGymId(null);
    setGymId(null);
    navigate('/');
  };

  const selectedKey = (() => {
    const match = NAV_ITEMS.filter((i) => i.path !== '/').find(
      (i) => location.pathname === i.path || location.pathname.startsWith(i.path === '/settings/profile' ? '/settings' : i.path + '/')
        || (i.path === '/members' && location.pathname.startsWith('/members/'))
        || (i.path === '/settings/profile' && location.pathname.startsWith('/settings'))
    );
    return match?.path || '/';
  })();

  const permGuard = (perms: string[], node: React.ReactNode) =>
    permLoading ? (
      <div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>
    ) : hasPermission(ctx, ...perms) ? (
      node
    ) : (
      <PermissionDenied permission={perms.join(' / ')} />
    );

  const guardedRoutes = (
    <Routes>
      <Route path="/" element={<Dashboard gymId={gymId!} myRole={ctx?.role || null} />} />

      <Route path="/members" element={permGuard(['members.view'], <MembersPage />)} />
      <Route path="/members/:id" element={permGuard(['members.view'], <MemberDetailPage />)} />
      <Route path="/members/:id/:tab" element={permGuard(['members.view'], <MemberDetailPage />)} />

      <Route path="/memberships" element={permGuard(['memberships.view'],
        <PlaceholderPage section="Memberships" title="Memberships" phase="Phase 1b"
          description="Membership plan sales, renewals, freeze/cancel and expiry tracking." />)} />
      <Route path="/memberships/plans" element={permGuard(['memberships.view'],
        <PlaceholderPage section="Membership plans" title="Membership plans" phase="Phase 1b"
          description="Define priced plans (duration, sessions, amount) that memberships are sold against." />)} />

      <Route path="/payments" element={permGuard(['payments.manage'],
        <PlaceholderPage section="Payments" title="Payments" phase="Phase 1b"
          description="Record payments against memberships, with history and totals per member." />)} />

      <Route path="/attendance" element={permGuard(['attendance.manage', 'checkin.manage'],
        <PlaceholderPage section="Attendance" title="Attendance" phase="Phase 1b"
          description="Front-desk check-in/check-out and the daily who-is-in view." />)} />

      <Route path="/trainers" element={permGuard(['staff.manage'], <TrainersPage />)} />
      <Route path="/staff" element={permGuard(['staff.manage'], <StaffPage />)} />

      <Route path="/workouts" element={permGuard(['content.manage', 'workouts.manage'],
        <PlaceholderPage section="Workouts" title="Workouts" phase="Phase 2"
          description="Gym workout templates assigned to members by gym trainers." />)} />
      <Route path="/nutrition" element={permGuard(['content.manage', 'nutrition.manage'],
        <PlaceholderPage section="Nutrition" title="Nutrition" phase="Phase 2"
          description="Gym nutrition plans assigned to members by gym trainers." />)} />
      <Route path="/classes" element={permGuard(['content.manage'],
        <PlaceholderPage section="Classes" title="Classes" phase="Phase 3"
          description="Class schedule, capacity and member bookings." />)} />

      <Route path="/communications" element={permGuard(['communications.manage'],
        <PlaceholderPage section="Communications" title="Communications" phase="Phase 3"
          description="Announcements and broadcasts to your members." />)} />
      <Route path="/reports" element={permGuard(['reports.view'],
        <PlaceholderPage section="Reports" title="Reports" phase="Phase 3"
          description="Revenue, attendance and membership reports." />)} />

      <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
      <Route path="/settings/:tab" element={permGuard(['settings.manage'],
        <SettingsPage gymId={gymId!} myRole={ctx?.role || null} />)} />

      <Route path="/create-gym" element={<CreateGymWizard onCreated={(id) => { refreshGyms(id).then(() => navigate('/')); }} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  return (
    <GymContext.Provider value={ctx}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', gap: 16, paddingInline: 16 }}>
          <Typography.Text strong style={{ color: '#fff', whiteSpace: 'nowrap', fontSize: 16, letterSpacing: 1 }}>
            {(perm?.gymName || 'GYM').toUpperCase()}
          </Typography.Text>
          <Select
            value={gymId ?? undefined}
            onChange={switchGym}
            style={{ minWidth: 180 }}
            placeholder="Select gym"
            options={mine.map((g) => ({
              value: g.id,
              label: `${g.name}${g.gym_status === 'INACTIVE' ? ' (deactivated)' : ''}`,
            }))}
          />
          <div style={{ flex: 1 }} />
          <Dropdown
            trigger={['click']}
            menu={{
              items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Log out', onClick: signedOut }],
            }}
          >
            <Typography.Text style={{ color: '#fff', cursor: 'pointer' }}>
              {user?.name || 'Account'} ({ctx?.role || '…'})
            </Typography.Text>
          </Dropdown>
        </Header>
        <Layout>
          <Sider width={200} theme="dark" breakpoint="lg" collapsedWidth="0">
            <Menu
              mode="inline"
              theme="dark"
              selectedKeys={[selectedKey]}
              items={visibleNav.map((i) => ({ key: i.path, icon: i.icon, label: i.label }))}
              onClick={({ key }) => navigate(key)}
              style={{ height: '100%', borderInlineEnd: 0, paddingTop: 8 }}
            />
          </Sider>
          <Content style={{ background: 'transparent', minWidth: 0 }}>
            {gyms === null ? (
              <div style={{ padding: 24 }}><Spin /></div>
            ) : mine.length === 0 ? (
              <Routes>
                <Route path="/create-gym" element={<CreateGymWizard onCreated={(id) => { refreshGyms(id).then(() => navigate('/')); }} />} />
                <Route path="*" element={<EmptyGym CTA={() => navigate('/create-gym')} />} />
              </Routes>
            ) : (
              guardedRoutes
            )}
          </Content>
        </Layout>
      </Layout>
    </GymContext.Provider>
  );
}

function EmptyGym({ CTA }: { CTA: () => void }) {
  return (
    <div style={{ padding: 48 }}>
      <Empty
        description={
          <>
            <Typography.Title level={4}>You don't have a gym yet</Typography.Title>
            <Typography.Text type="secondary">
              Create your gym to configure its profile, hours and branding.
              Your personal fitness account is not affected.
            </Typography.Text>
          </>
        }
        style={{ marginTop: 64 }}
      >
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={CTA}>
          Create your gym
        </Button>
      </Empty>
    </div>
  );
}
