import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Button, Statistic, Row, Col, message, Typography, Space } from 'antd';
import { api } from '../api';

export default function HealthPage() {
  const [sync, setSync] = useState<any>(null);
  const [purge, setPurge] = useState<any>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async () => {
    setSync(await api('/health/sync-queue').catch(() => null));
    setPurge(await api('/health/purge').catch(() => null));
  };
  useEffect(() => { load(); }, []);

  const runPurge = async () => {
    try {
      const r = await api('/health/run-purge', { method: 'POST' });
      msg.success(`Purge complete: ${JSON.stringify(r)}`);
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  const okCount = sync?.pushCounts?.find((c: any) => c.success)?.c || 0;
  const failCount = sync?.pushCounts?.find((c: any) => !c.success)?.c || 0;

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>System Health</Typography.Title>
      <Row gutter={16}>
        <Col span={6}><Card><Statistic title="Push sends OK (7d)" value={okCount} /></Card></Col>
        <Col span={6}><Card><Statistic title="Push failures (7d)" value={failCount} valueStyle={failCount ? { color: '#cf1322' } : undefined} /></Card></Col>
        <Col span={6}><Card><Statistic title="Archived relationships" value={purge?.archived?.length ?? 0} /></Card></Col>
        <Col span={6}><Card><Button danger type="primary" block onClick={runPurge}>Run purge job now</Button><Typography.Text type="secondary" style={{ fontSize: 11 }}>Same code path as the daily cron</Typography.Text></Card></Col>
      </Row>

      <Card size="small" title="Persistently failing deliveries (last 7 days)" style={{ marginTop: 16 }}>
        <Table size="small" rowKey="id" dataSource={sync?.failing || []} pagination={{ pageSize: 8 }}
          columns={[
            { title: 'When', dataIndex: 'created_at', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
            { title: 'Token', dataIndex: 'token', render: (t) => String(t || '').slice(0, 18) + '…' },
            { title: 'Error', dataIndex: 'error_detail', ellipsis: true },
          ]} />
      </Card>

      <Card size="small" title="Archived relationships awaiting purge" style={{ marginTop: 16 }}>
        <Table size="small" rowKey="id" dataSource={purge?.archived || []} pagination={{ pageSize: 8 }}
          columns={[
            { title: 'Client', dataIndex: 'client_name' },
            { title: 'Archived', dataIndex: 'archived_at', render: (v) => String(v).slice(0, 10) },
            { title: 'Purges', dataIndex: 'purge_at', render: (v) => String(v).slice(0, 10) },
            { title: 'Days left', dataIndex: 'days_remaining', render: (d) => <Tag color={d <= 3 ? 'red' : d <= 10 ? 'orange' : 'green'}>{d}d</Tag> },
          ]} />
      </Card>

      <Card size="small" title="Purge job runs" style={{ marginTop: 16 }}>
        <Table size="small" rowKey="id" dataSource={purge?.runs || []} pagination={{ pageSize: 5 }}
          columns={[
            { title: 'Ran at', dataIndex: 'ran_at', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
            { title: 'Rows purged', dataIndex: 'rows_purged' },
            { title: 'Relationships', dataIndex: 'relationships_purged' },
            { title: 'Errors', dataIndex: 'errors', ellipsis: true },
          ]} />
      </Card>
    </div>
  );
}
