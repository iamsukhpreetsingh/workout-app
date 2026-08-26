import React, { useEffect, useState } from 'react';
import {
  Card, Table, Tag, Button, Statistic, Row, Col, message, Typography,
  Space, Modal,
} from 'antd';
import {
  getSyncOverview, getSyncFailing, getRestoreStats, getPhotoStorage,
  retryFailedSync, getDeliveryStats, getNotificationVolume,
  SyncOverview, SyncFailingRow, RestoreStats, PhotoStorageStats, DeliveryStats, NotificationVolume,
} from '../api';
import { getProfile } from '../api';

export default function SyncHealthPage() {
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [failing, setFailing] = useState<SyncFailingRow[]>([]);
  const [restore, setRestore] = useState<RestoreStats | null>(null);
  const [photos, setPhotos] = useState<PhotoStorageStats | null>(null);
  const [delivery, setDelivery] = useState<DeliveryStats | null>(null);
  const [volume, setVolume] = useState<NotificationVolume | null>(null);
  const [msg, contextHolder] = message.useMessage();
  const isSuper = getProfile()?.role === 'super_admin';

  const load = async () => {
    try {
      const [o, f, r, p, d, v] = await Promise.all([
        getSyncOverview(), getSyncFailing({ sort: 'attempts', limit: 100 }),
        getRestoreStats(), getPhotoStorage(), getDeliveryStats(), getNotificationVolume(30),
      ]);
      setOverview(o); setFailing(f || []); setRestore(r); setPhotos(p); setDelivery(d); setVolume(v);
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  // There is NO server-side retry: this sends a 'sync_retry_nudge' notification;
  // real retries happen on-device when each user next syncs.
  const nudge = () => {
    Modal.confirm({
      title: 'Retry failed sync — dry-run first',
      content: 'Computes how many users would receive a sync-retry nudge notification (no data is written).',
      okText: 'Run preview',
      onOk: async () => {
        try {
          const preview = await retryFailedSync(true);
          Modal.confirm({
            title: `Send nudge to ${preview.affectedUsers} user(s)?`,
            content: 'A "sync_retry_nudge" notification is sent; actual retries happen on-device when the app next syncs. Audited.',
            okText: 'Send nudges',
            onOk: async () => {
              try {
                const r = await retryFailedSync(false);
                msg.success(`Nudges sent: ${r.nudgesSent}${r.nudgesFailed ? `, failed: ${r.nudgesFailed}` : ''}`);
              } catch (e: any) { msg.error(e.message); }
            },
          });
        } catch (e: any) { msg.error(e.message); }
      },
    });
  };

  const entityTypeRows = Object.entries(overview?.byEntityType ?? {}).map(([entityType, v]) => ({
    entity_type: entityType, ...v,
  }));

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Sync & Restore</Typography.Title>

      <Row gutter={16}>
        <Col span={4}><Card><Statistic title="Reporting users" value={overview?.reportingUsers ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="Reporting (24h)" value={overview?.reportingUsersLast24h ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="Total pending items" value={overview?.totalPending ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic
          title="Total failed items" value={overview?.totalFailed ?? 0}
          valueStyle={(overview?.totalFailed ?? 0) > 0 ? { color: '#cf1322' } : undefined}
        /></Card></Col>
        <Col span={8}><Card><Statistic title="Push delivery OK / failed (all time)" value={`${delivery?.totals.delivered ?? 0} / ${delivery?.totals.failed ?? 0}`} /></Card></Col>
      </Row>

      <Card size="small" title={`Queue by entity type`} style={{ marginTop: 16 }}>
        <Table<{ entity_type: string; pending: number; failed: number }>
          rowKey="entity_type"
          size="small"
          pagination={false}
          dataSource={entityTypeRows}
          columns={[
            { title: 'Entity type', dataIndex: 'entity_type' },
            { title: 'Pending', dataIndex: 'pending' },
            { title: 'Failed', dataIndex: 'failed', render: (v) => (v ? <span style={{ color: '#cf1322' }}>{v}</span> : 0) },
          ]}
        />
      </Card>

      <Card
        size="small"
        title="Persistently failing sync items (last 7 days)"
        extra={
          isSuper && (
            <Button danger onClick={nudge} style={{ marginLeft: 12 }}>
              Retry failed sync (nudge)
            </Button>
          )
        }
        style={{ marginTop: 16 }}
      >
        <Table<SyncFailingRow>
          rowKey={(r) => `${r.user_id}:${r.entity_type}:${r.entity_id}`}
          size="small"
          dataSource={failing}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: 'User', dataIndex: 'user_email' },
            { title: 'Entity', render: (_: any, r) => <Tag>{r.entity_type}</Tag> },
            { title: 'Operation', dataIndex: 'operation', width: 110 },
            {
              title: 'Attempts', dataIndex: 'attempts',
              render: (a) => <Tag color={a >= 5 ? 'red' : a >= 3 ? 'orange' : 'default'}>{a}</Tag>,
              width: 90,
            },
            { title: 'Last error', dataIndex: 'last_error', ellipsis: true },
            { title: 'Reported', dataIndex: 'reported_at', render: (v) => String(v).slice(0, 19).replace('T', ' '), width: 150 },
          ]}
        />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Card size="small" title={`Restore runs (${restore?.windowDays ?? 30}d)`}>
          <Space size={24} style={{ marginBottom: 12 }}>
            <Statistic title="Total" value={restore?.totalRuns ?? 0} />
            <Statistic title="Succeeded" value={restore?.succeeded ?? 0} valueStyle={{ color: '#52c41a' }} />
            <Statistic title="Failed" value={restore?.failed ?? 0} valueStyle={(restore?.failed ?? 0) > 0 ? { color: '#cf1322' } : undefined} />
            <Statistic title="In progress" value={restore?.inProgress ?? 0} />
            <Statistic title="Avg success duration" value={restore?.avgSuccessDurationMs != null ? Math.round(restore.avgSuccessDurationMs / 100) / 10 : '—'} suffix="s" />
          </Space>
          <Table<RestoreStats['recentFailures'][number]>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={restore?.recentFailures || []}
            columns={[
              { title: 'User', dataIndex: 'user_email' },
              { title: 'Failed step', dataIndex: 'failed_step' },
              { title: 'Started', dataIndex: 'started_at', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
            ]}
          />
        </Card>
        <Card size="small" title="Progress-photo storage">
          <Space size={24} wrap>
            <Statistic title="Photos" value={photos?.total_photos ?? 0} />
            <Statistic title="Users with photos" value={photos?.users_with_photos ?? 0} />
            <Statistic title="Uploads last 7d" value={photos?.uploads_last_7d ?? 0} />
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 11, marginTop: 12 }}>
            {photos?.note}
          </Typography.Paragraph>
        </Card>
      </div>

      <Card size="small" title="Notification volume by day (30d)" style={{ marginTop: 16 }}>
        <Table<NotificationVolume['series'][number]>
          rowKey="date"
          size="small"
          pagination={{ pageSize: 10 }}
          dataSource={volume?.series ? [...volume.series].reverse() : []}
          columns={[
            { title: 'Date', dataIndex: 'date' },
            {
              title: 'By type',
              dataIndex: 'counts',
              render: (counts: Record<string, number>) => (
                <Space wrap size={4}>
                  {Object.entries(counts).filter(([, c]) => c > 0).map(([t, c]) => (
                    <Tag key={t}>{t}: {c}</Tag>
                  ))}
                  {!Object.values(counts).some((c) => c > 0) && <Typography.Text type="secondary">—</Typography.Text>}
                </Space>
              ),
            },
            { title: 'Total', dataIndex: 'total', width: 80 },
          ]}
        />
      </Card>
    </div>
  );
}
