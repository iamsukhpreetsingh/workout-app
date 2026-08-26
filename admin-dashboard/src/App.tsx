import React, { useEffect, useState } from 'react';
import { Layout, Menu, Button, Typography, message } from 'antd';
import {
  DatabaseOutlined,
  ApiOutlined,
  DashboardOutlined,
  TeamOutlined,
  SafetyOutlined,
  HeartOutlined,
  SoundOutlined,
  FlagOutlined,
  AuditOutlined,
  LogoutOutlined,
  SwapOutlined,
  FileTextOutlined,
  LineChartOutlined,
  ThunderboltOutlined,
  AppleOutlined,
  CloudSyncOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import { api, getProfile, logout, restoreProfile, AdminProfile } from './api';
import { ImpersonationProvider, ImpersonationBanner } from './impersonation';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import DatabasePage from './pages/DatabasePage';
import ApiExplorerPage from './pages/ApiExplorerPage';
import UsersPage from './pages/UsersPage';
import ContentPage from './pages/ContentPage';
import HealthPage from './pages/HealthPage';
import BroadcastPage from './pages/BroadcastPage';
import FlagsPage from './pages/FlagsPage';
import AuditPage from './pages/AuditPage';
import RelationshipsPage from './pages/RelationshipsPage';
import IntakePage from './pages/IntakePage';
import ProgressionPage from './pages/ProgressionPage';
import WorkoutsPage from './pages/WorkoutsPage';
import NutritionPage from './pages/NutritionPage';
import SyncHealthPage from './pages/SyncHealthPage';
import AnalyticsPage from './pages/AnalyticsPage';

const { Sider, Header, Content } = Layout;

export default function App() {
  const [profile, setProfile] = useState<AdminProfile | null | 'loading'>('loading');
  const [page, setPage] = useState<string>('overview');

  useEffect(() => {
    restoreProfile().then((p) => setProfile(p));
  }, []);

  if (profile === 'loading') return null;
  if (!profile) return <LoginPage onLogin={(p) => setProfile(p)} />;

  const p = profile as AdminProfile;
  const isSuper = p.role === 'super_admin';
  const isModerator = isSuper || p.role === 'content_moderator';
  const isSupport = isSuper || p.role === 'support' || isModerator;

  const items = [
    { key: 'overview', icon: <DashboardOutlined />, label: 'Dashboard' },
    { key: 'database', icon: <DatabaseOutlined />, label: 'Database' },
    { key: 'api', icon: <ApiOutlined />, label: 'API Explorer' },
    { key: 'users', icon: <TeamOutlined />, label: 'Users & Trainers' },
    isSupport ? { key: 'relationships', icon: <SwapOutlined />, label: 'Relationships' } : null,
    isSupport ? { key: 'intake', icon: <FileTextOutlined />, label: 'Intake Profiles' } : null,
    isSupport ? { key: 'progression', icon: <LineChartOutlined />, label: 'Progression' } : null,
    isSupport ? { key: 'workouts', icon: <ThunderboltOutlined />, label: 'Workouts' } : null,
    isSupport ? { key: 'nutrition', icon: <AppleOutlined />, label: 'Nutrition' } : null,
    isModerator ? { key: 'content', icon: <SafetyOutlined />, label: 'Content' } : null,
    { key: 'health', icon: <HeartOutlined />, label: 'System Health' },
    isSupport ? { key: 'sync', icon: <CloudSyncOutlined />, label: 'Sync & Restore' } : null,
    { key: 'analytics', icon: <BarChartOutlined />, label: 'Analytics' },
    isSupport ? { key: 'broadcast', icon: <SoundOutlined />, label: 'Broadcast' } : null,
    isSupport ? { key: 'flags', icon: <FlagOutlined />, label: 'Feature Flags' } : null,
    isSuper ? { key: 'audit', icon: <AuditOutlined />, label: 'Audit Log' } : null,
  ].filter(Boolean) as any[];

  return (
    <ImpersonationProvider>
      {/* fixed-position impersonation banner overlays the top when active */}
      <ImpersonationBanner />
      <Layout style={{ minHeight: '100vh' }}>
        <Sider theme="dark" width={220}>
          <div style={{ padding: 16, color: '#E8481F', fontWeight: 800, fontSize: 16 }}>
            🏋️ Workout Admin
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[page]}
            items={items}
            onClick={(e) => setPage(e.key)}
          />
          <div style={{ position: 'absolute', bottom: 12, width: 220, padding: '0 12px' }}>
            <div style={{ color: '#888', fontSize: 12, marginBottom: 2 }}>
              {p.name} · {p.role}
            </div>
            <Button
              size="small"
              icon={<LogoutOutlined />}
              onClick={async () => {
                await logout();
                setProfile(null);
              }}
            >
              Log out
            </Button>
          </div>
        </Sider>
        <Layout>
          <Content style={{ paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, overflow: 'auto' }} className="admin-content">
            {page === 'overview' && <OverviewPage />}
            {page === 'database' && <DatabasePage />}
            {page === 'api' && <ApiExplorerPage />}
            {page === 'users' && <UsersPage />}
            {page === 'relationships' && <RelationshipsPage />}
            {page === 'intake' && <IntakePage />}
            {page === 'progression' && <ProgressionPage />}
            {page === 'workouts' && <WorkoutsPage />}
            {page === 'nutrition' && <NutritionPage />}
            {page === 'content' && <ContentPage />}
            {page === 'health' && <HealthPage />}
            {page === 'sync' && <SyncHealthPage />}
            {page === 'analytics' && <AnalyticsPage />}
            {page === 'broadcast' && <BroadcastPage />}
            {page === 'flags' && <FlagsPage />}
            {page === 'audit' && <AuditPage />}
          </Content>
        </Layout>
      </Layout>
    </ImpersonationProvider>
  );
}
