import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Button, Statistic, Row, Col, message, Typography, Space, Tabs, InputNumber, Switch, Modal } from 'antd';
import {
  api,
  getRelationships,
  getRelationshipsPendingCount,
  getPurgeRuns,
  extendPurge,
  forceRevoke,
  restoreRelationship,
  runPurgeJob,
  RelationshipRow,
  PendingCount,
  PurgeRun,
} from '../api';
import { getProfile } from '../api';

const STATUS_TABS = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
];

export default function RelationshipsPage() {
  const [rows, setRows] = useState<RelationshipRow[]>([]);
  const [counts, setCounts] = useState<PendingCount | null>(null);
  const [runs, setRuns] = useState<PurgeRun[]>([]);
  const [status, setStatus] = useState<string>('all');
  const [purgeSoon, setPurgeSoon] = useState(false);
  const [reactivation, setReactivation] = useState(false);
  const [msg, contextHolder] = message.useMessage();
  const isSuper = getProfile()?.role === 'super_admin';

  const load = async () => {
    try {
      const params: any = { limit: 200 };
      if (status !== 'all') params.status = status;
      if (purgeSoon) params.purgeWithinDays = 7;
      if (reactivation) params.reactivationAwaiting = true;
      const r = await getRelationships(params);
      setRows(r.relationships || []);
      setCounts(await getRelationshipsPendingCount());
      setRuns(await getPurgeRuns());
    } catch (e: any) {
      msg.error(e.message);
    }
  };
  useEffect(() => { load(); }, [status, purgeSoon, reactivation]); // eslint-disable-line

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    try {
      await fn();
      msg.success(okMsg);
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  const extendPurgeModal = (r: RelationshipRow) => {
    let days = 7;
    Modal.confirm({
      title: `Extend purge for ${r.client_name} → ${r.trainer_name}`,
      content: (
        <div style={{ marginTop: 12 }}>
          <Typography.Paragraph type="secondary">
            Currently purges {r.purge_at ? String(r.purge_at).slice(0, 10) : '—'} ({r.days_until_purge}d left). Adds a grace period before irreversible deletion.
          </Typography.Paragraph>
          <InputNumber min={1} defaultValue={7} onChange={(v) => { days = v || 7; }} addonAfter="days" />
        </div>
      ),
      okText: 'Extend',
      onOk: () => act(() => extendPurge(r.id, days), `Purge extended by ${days} days`),
    });
  };

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Relationships</Typography.Title>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}><Card><Statistic title="Pending" value={counts?.pending ?? 0} /></Card></Col>
        <Col span={5}><Card><Statistic title="Active" value={counts?.active ?? 0} /></Card></Col>
        <Col span={5}><Card><Statistic title="Archived" value={counts?.archived ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="Awaiting reactivation" value={counts?.reactivation_awaiting ?? 0} /></Card></Col>
        <Col span={5}><Card><Statistic title="Revoked" value={counts?.revoked ?? 0} /></Card></Col>
      </Row>

      <Space style={{ marginBottom: 12 }}>
        <Tabs
          activeKey={status}
          onChange={(k) => setStatus(k)}
          items={STATUS_TABS}
          style={{ marginBottom: -14 }}
        />
        <span style={{ marginLeft: 16 }}>
          Purge within 7 days <Switch checked={purgeSoon} onChange={setPurgeSoon} />
        </span>
        <span>
          Reactivation awaiting <Switch checked={reactivation} onChange={setReactivation} />
        </span>
      </Space>

      <Table<RelationshipRow>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 15, showSizeChanger: false }}
        columns={[
          { title: 'Trainer', render: (_: any, r) => <span>{r.trainer_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.trainer_email}</Typography.Text></span> },
          { title: 'Client', render: (_: any, r) => <span>{r.client_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.client_email}</Typography.Text></span> },
          {
            title: 'Status', dataIndex: 'status',
            render: (s: string, r) => (
              <Space direction="vertical" size={0}>
                <Tag color={s === 'active' ? 'green' : s === 'pending' ? 'blue' : s === 'archived' ? 'orange' : 'red'}>{s}</Tag>
                {r.restore_preference != null && s === 'pending' && <Tag color="purple">reactivation requested</Tag>}
              </Space>
            ),
          },
          { title: 'Created', dataIndex: 'created_at', render: (v) => String(v).slice(0, 10), width: 100 },
          {
            title: 'Purge countdown', dataIndex: 'days_until_purge',
            render: (d: number | null, r) =>
              r.purge_at == null || d == null ? '—' : <Tag color={d <= 3 ? 'red' : d <= 10 ? 'orange' : 'green'}>{d}d left</Tag>,
            width: 110,
          },
          ...(isSuper
            ? [{
                title: 'Actions',
                width: 260,
                render: (_: any, r: RelationshipRow) => (
                  <Space size={4}>
                    {r.status === 'archived' && r.purge_at && (
                      <Button size="small" onClick={() => extendPurgeModal(r)}>Extend purge</Button>
                    )}
                    <Button
                      size="small"
                      danger
                      disabled={r.status === 'revoked'}
                      onClick={() => Modal.confirm({
                        title: 'Force revoke this relationship?',
                        content: `${r.trainer_name} ↔ ${r.client_name} — immediately terminates access regardless of current status.`,
                        okText: 'Force revoke',
                        okButtonProps: { danger: true },
                        onOk: () => act(() => forceRevoke(r.id), 'Relationship revoked'),
                      })}
                    >
                      Force revoke
                    </Button>
                    <Button
                      size="small"
                      disabled={r.status !== 'archived'}
                      onClick={() => Modal.confirm({
                        title: 'Restore to active?',
                        content: `${r.trainer_name} ↔ ${r.client_name} — clears archive/purge state.`,
                        onOk: () => act(() => restoreRelationship(r.id), 'Relationship restored'),
                      })}
                    >
                      Restore
                    </Button>
                  </Space>
                ),
              }]
            : []),
        ]}
      />

      <Card
        size="small"
        title="Purge job runs"
        extra={isSuper && (
          <Button
            type="primary"
            danger
            onClick={() => Modal.confirm({
              title: 'Run the archive purge now?',
              content: 'Uses the exact daily-cron code path and permanently deletes expired archived relationships.',
              okText: 'Run purge',
              okButtonProps: { danger: true },
              onOk: () => act(runPurgeJob, 'Purge complete'),
            })}
          >
            Run purge now
          </Button>
        )}
        style={{ marginTop: 24 }}
      >
        <Table<PurgeRun>
          rowKey="id"
          size="small"
          dataSource={runs}
          pagination={{ pageSize: 5 }}
          columns={[
            { title: 'Ran at', dataIndex: 'ran_at', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
            { title: 'Rows purged', dataIndex: 'rows_purged' },
            { title: 'Relationships', dataIndex: 'relationships_purged' },
            { title: 'Errors', dataIndex: 'errors', ellipsis: true },
          ]}
        />
      </Card>
    </div>
  );
}
