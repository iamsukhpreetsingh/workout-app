// Gym dashboard — landing surface after creation. Leads with profile
// completion (the onboarding checklist the backend owns), shows the gym
// summary, and surfaces deactivated-gym state with self-service
// reactivation for owners.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Card, Col, Row, Progress, Tag, List, Alert, Button, Skeleton,
  Typography, Space, Descriptions, App as AntApp, Popconfirm, Badge, Statistic,
} from 'antd';
import {
  EnvironmentOutlined, PhoneOutlined, MailOutlined, GlobalOutlined,
  ClockCircleOutlined, ReloadOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Gym, fetchGymLogoBlobUrl, reactivateGym, getGym, getDashboard, formatMoney, listClasses, GymDashboard } from '../api';
import { listStaffNotifications, StaffNotification } from '../api/staffNotifications';
import {
  TeamOutlined, UserOutlined, DollarOutlined, WarningOutlined,
  RiseOutlined, CalendarOutlined, FieldTimeOutlined,
} from '@ant-design/icons';

const MISSING_LABELS: Record<string, string> = {
  logo: 'Logo', address: 'Address', phone: 'Phone', email: 'Email',
  website: 'Website', operating_hours: 'Operating hours', branding: 'Branding',
};

interface Props {
  gymId: string;
  myRole: string | null;
}

export default function Dashboard({ gymId, myRole }: Props) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [gym, setGym] = useState<Gym | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [recent, setRecent] = useState<StaffNotification[] | null>(null);
  const [kpi, setKpi] = useState<GymDashboard | null>(null);
  const [upcomingClasses, setUpcomingClasses] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await getGym(gymId);
      // Recent Activity (same source of truth as the Notification Center —
      // NOT a second activity system). Best-effort: dashboard never fails
      // because the notification list did.
      try { setRecent(await listStaffNotifications(gymId, { limit: 5 })); } catch { setRecent(null); }
      // KPI strip — one aggregated backend payload + a lightweight upcoming-
      // classes count. Best-effort: the dashboard renders without them.
      try { setKpi(await getDashboard(gymId)); } catch { setKpi(null); }
      try {
        const from = new Date().toISOString().slice(0, 10);
        const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
        const cls = await listClasses(gymId, { from, to, status: 'SCHEDULED', limit: 100 });
        setUpcomingClasses(Array.isArray(cls) ? cls.length : null);
      } catch { setUpcomingClasses(null); }
      setGym(g);
      setLogoUrl(await fetchGymLogoBlobUrl(gymId));
    } catch (e: any) {
      setError(e.message || 'Could not load your gym');
    } finally {
      setLoading(false);
    }
  }, [gymId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <Skeleton active paragraph={{ rows: 6 }} />
      </div>
    );
  }

  if (error || !gym) {
    return (
      <div style={{ padding: 24 }}>
        <Alert
          type="error"
          showIcon
          message="Could not load your gym"
          description={error}
          action={<Button icon={<ReloadOutlined />} onClick={load}>Retry</Button>}
        />
      </div>
    );
  }

  const inactive = gym.status === 'INACTIVE';
  const completion = gym.profile_completion || { percent: 0, missing: [] };
  const branding = gym.branding || {};
  const primary = branding.primary_color || '#E8481F';

  const reactivate = async () => {
    setReactivating(true);
    try {
      await reactivateGym(gymId);
      message.success('Gym reactivated');
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not reactivate');
    } finally {
      setReactivating(false);
    }
  };

  return (
    <div style={{ padding: 24 }}>
      {inactive && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="This gym is deactivated"
          description="Staff and members cannot access the gym while it is deactivated."
          action={myRole === 'OWNER' ? (
            <Popconfirm title="Reactivate this gym?" onConfirm={reactivate}>
              <Button type="primary" loading={reactivating}>Reactivate</Button>
            </Popconfirm>
          ) : undefined}
        />
      )}

      <Space align="center" style={{ marginBottom: 16 }}>
        {logoUrl
          ? <img src={logoUrl} alt="logo" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover' }} />
          : <div style={{
              width: 48, height: 48, borderRadius: 8, background: primary,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 700, fontSize: 20,
            }}>{gym.name.charAt(0).toUpperCase()}</div>}
        <Typography.Title level={3} style={{ margin: 0 }}>{gym.name}</Typography.Title>
        {inactive ? <Tag color="orange">Deactivated</Tag> : <Tag color="green">Active</Tag>}
        {myRole && <Tag>{myRole}</Tag>}
      </Space>

      {/* KPI strip — the numbers an owner checks first. Compact stat chips,
          responsive: 6-across on desktop, 2-across on phones. */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title="Members"
              value={kpi ? `${kpi.members.active}/${kpi.members.total}` : '—'}
              prefix={<TeamOutlined style={{ color: primary }} />}
              valueStyle={{ fontSize: 20 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>active / total</Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title="In gym today"
              value={kpi ? kpi.attendance.today : '—'}
              prefix={<UserOutlined style={{ color: primary }} />}
              valueStyle={{ fontSize: 20 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>visits so far</Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title="Due payments"
              value={kpi ? formatMoney(kpi.financial.outstanding_cents, kpi.financial.currency) : '—'}
              prefix={<DollarOutlined style={{ color: primary }} />}
              valueStyle={{ fontSize: 20 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {kpi ? `${kpi.financial.open_charges} open charge${kpi.financial.open_charges === 1 ? '' : 's'}` : ''}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title="Overdue"
              value={kpi ? formatMoney(kpi.financial.overdue_cents, kpi.financial.currency) : '—'}
              prefix={<WarningOutlined style={{ color: '#faad14' }} />}
              valueStyle={{ fontSize: 20, color: kpi && kpi.financial.overdue_cents > 0 ? '#faad14' : undefined }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {kpi ? `${kpi.financial.overdue_charges} charge${kpi.financial.overdue_charges === 1 ? '' : 's'}` : ''}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title="Revenue (month)"
              value={kpi ? formatMoney(kpi.financial.collected_month_cents, kpi.financial.currency) : '—'}
              prefix={<RiseOutlined style={{ color: '#16A34A' }} />}
              valueStyle={{ fontSize: 20 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>net collected</Typography.Text>
          </Card>
        </Col>
        <Col xs={12} sm={8} lg={4}>
          <Card size="small">
            <Statistic
              title="Classes (7d)"
              value={upcomingClasses ?? '—'}
              prefix={<CalendarOutlined style={{ color: primary }} />}
              valueStyle={{ fontSize: 20 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>scheduled ahead</Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <Card title="Profile completion" extra={
            <Button type="link" icon={<SettingOutlined />} onClick={() => navigate('/settings/profile')}>
              Complete profile
            </Button>
          }>
            <Progress
              type="dashboard"
              percent={completion.percent}
              strokeColor={completion.percent === 100 ? '#16A34A' : primary}
            />
            {completion.missing.length > 0 ? (
              <>
                <Typography.Text type="secondary">Missing:</Typography.Text>
                <List
                  size="small"
                  dataSource={completion.missing}
                  renderItem={(m) => (
                    <List.Item style={{ padding: '4px 0' }}>
                      <Typography.Text type="warning">• {MISSING_LABELS[m] || m}</Typography.Text>
                    </List.Item>
                  )}
                />
              </>
            ) : (
              <Typography.Text type="success">Everything is set up 🎉</Typography.Text>
            )}
          </Card>
        </Col>

        <Col xs={24} md={10}>
          <Card title="Gym summary">
            <Descriptions column={1} size="small">
              <Descriptions.Item label={<><EnvironmentOutlined /> Address</>}>
                {[gym.address_line1, gym.address_line2, gym.city, gym.state, gym.postal_code]
                  .filter(Boolean).join(', ') || <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label={<><PhoneOutlined /> Phone</>}>
                {gym.phone || <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label={<><MailOutlined /> Email</>}>
                {gym.email || <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label={<><GlobalOutlined /> Website</>}>
                {gym.website
                  ? <a href={gym.website} target="_blank" rel="noreferrer">{gym.website}</a>
                  : <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label={<><ClockCircleOutlined /> Hours</>}>
                {gym.operating_hours
                  ? Object.entries(gym.operating_hours)
                      .filter(([, h]) => !h.closed)
                      .map(([d, h]) => `${d} ${h.open}–${h.close}`).join(' · ') || 'Open never'
                  : <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Timezone">{gym.timezone}</Descriptions.Item>
              <Descriptions.Item label="Currency">{gym.currency}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>

        {/* compact Recent activity — sits beside the summary on desktop,
            stacks under it on phones */}
        <Col xs={24} md={6}>
          <Card
            size="small"
            title="Recent activity"
            styles={{ body: { paddingTop: 4 } }}
            extra={<Button size="small" type="link" onClick={() => navigate('/notifications')}>All</Button>}
          >
            {recent === null || recent.length === 0 ? (
              <Typography.Text type="secondary">You're all caught up.</Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={recent}
                renderItem={(n) => (
                  <List.Item style={{ cursor: 'pointer', padding: '6px 0' }}
                    onClick={() => navigate('/notifications')}>
                    <div style={{ width: '100%', minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {!n.is_read && <Badge status="processing" />}
                        <Typography.Text strong={!n.is_read} style={{ fontSize: 12.5 }} ellipsis>
                          {n.title}
                        </Typography.Text>
                      </div>
                      {n.member_name && (
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {n.member_name}
                        </Typography.Text>
                      )}
                      <Typography.Paragraph type="secondary" style={{ fontSize: 11, margin: 0 }}
                        ellipsis={{ rows: 2 }}>
                        {n.message}
                      </Typography.Paragraph>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>

        <Col span={24}>
          <Card>
            <Typography.Text type="secondary">
              Membership plans, payments and attendance arrive in the next phase of the Gym
              Management System — this dashboard grows with them.
            </Typography.Text>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
