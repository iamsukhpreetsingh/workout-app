// App shell: session restore → gym discovery → routing.
// - No gyms: the portal's empty state — the create-gym wizard IS the app
//   until a gym exists (a user without gyms may also just use the mobile
//   app; the portal has nothing to show them but the CTA).
// - Multiple gyms: a header switcher; the selected gym id is sent as a
//   selector header — the backend still resolves authorization itself.
// - Deactivated gym: selectable, but pages surface the warning + owner
//   reactivation instead of a dead end.
import React, { useCallback, useEffect, useState } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Select, Typography, Alert, Spin, Dropdown, App as AntApp, Empty, Button } from 'antd';
import {
  DashboardOutlined, SettingOutlined, PlusOutlined, LogoutOutlined, UserOutlined,
} from '@ant-design/icons';
import {
  UserProfile, GymMembershipEntry, getMyGyms, getSelectedGymId, setSelectedGymId,
  hasAccessToken, clearSession, logout,
} from './api';
import LoginPage from './pages/LoginPage';
import CreateGymWizard from './pages/CreateGymWizard';
import Dashboard from './pages/Dashboard';
import SettingsPage from './pages/SettingsPage';

const { Header, Sider, Content } = Layout;

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
  const current = mine.find((g) => g.id === gymId) || null;

  const switchGym = (id: string) => {
    setSelectedGymId(id);
    setGymId(id);
    navigate('/');
  };

  const signedOut = async () => {
    await logout();
    setUser(null);
    setGyms([]);
    navigate('/');
  };

  const menuItems = [
    { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
    { key: '/create-gym', icon: <PlusOutlined />, label: 'Create Gym' },
    { key: '/settings/profile', icon: <SettingOutlined />, label: 'Settings' },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 16, paddingInline: 16 }}>
        <Typography.Text strong style={{ color: '#fff', whiteSpace: 'nowrap' }}>
          Gym Portal
        </Typography.Text>
        <Select
          value={gymId ?? undefined}
          onChange={switchGym}
          style={{ minWidth: 200 }}
          placeholder="Select gym"
          options={mine.map((g) => ({
            value: g.id,
            label: `${g.name}${g.gym_status === 'INACTIVE' ? ' (deactivated)' : ''} — ${g.gym_role}`,
          }))}
        />
        <div style={{ flex: 1 }} />
        <Dropdown
          menu={{
            items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Log out', onClick: signedOut }],
          }}
        >
          <Typography.Text style={{ color: '#fff', cursor: 'pointer' }}>
            <UserOutlined /> {user?.name || 'Account'}
          </Typography.Text>
        </Dropdown>
      </Header>
      <Layout>
        <Sider width={200} theme="dark">
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={[location.pathname.startsWith('/settings') ? '/settings/profile' : location.pathname]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderInlineEnd: 0 }}
          />
        </Sider>
        <Content style={{ background: 'transparent' }}>
          {gyms === null ? (
            <div style={{ padding: 24 }}><Spin /></div>
          ) : mine.length === 0 ? (
            <Routes>
              <Route path="/create-gym" element={<CreateGymWizard onCreated={(id) => { refreshGyms(id).then(() => navigate('/')); }} />} />
              <Route path="*" element={<EmptyGym CTA={() => navigate('/create-gym')} />} />
            </Routes>
          ) : (
            <Routes>
              <Route path="/" element={current ? <Dashboard gymId={current.id} myRole={current.gym_role} /> : <EmptyGym CTA={() => navigate('/create-gym')} />} />
              <Route path="/create-gym" element={<CreateGymWizard onCreated={(id) => { refreshGyms(id).then(() => navigate('/')); }} />} />
              <Route path="/settings" element={<Navigate to="/settings/profile" replace />} />
              <Route path="/settings/:tab" element={
                current
                  ? <SettingsPage key={current.id} gymId={current.id} myRole={current.gym_role} />
                  : <Navigate to="/" replace />
              } />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </Content>
      </Layout>
    </Layout>
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
