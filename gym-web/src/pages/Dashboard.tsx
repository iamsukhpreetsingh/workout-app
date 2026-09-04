// Gym dashboard — landing surface after creation. Leads with profile
// completion (the onboarding checklist the backend owns), shows the gym
// summary, and surfaces deactivated-gym state with self-service
// reactivation for owners.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Card, Col, Row, Progress, Tag, List, Alert, Button, Skeleton,
  Typography, Space, Descriptions, App as AntApp, Popconfirm,
} from 'antd';
import {
  EnvironmentOutlined, PhoneOutlined, MailOutlined, GlobalOutlined,
  ClockCircleOutlined, ReloadOutlined, SettingOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { Gym, fetchGymLogoBlobUrl, reactivateGym, getGym } from '../api';

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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await getGym(gymId);
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

        <Col xs={24} md={16}>
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
