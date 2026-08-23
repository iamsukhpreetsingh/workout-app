import React, { useEffect, useState } from 'react';
import { Table, Input, Typography, Tag } from 'antd';
import { api } from '../api';

export default function AuditPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');

  const load = async () => setRows(await api(`/audit-log${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <div>
      <Typography.Title level={4}>Audit Log</Typography.Title>
      <Typography.Paragraph type="secondary">Every write/delete performed through this dashboard, attributable to an admin account.</Typography.Paragraph>
      <Input.Search placeholder="Search action / table / admin" value={q} onChange={(e) => setQ(e.target.value)} onSearch={load} style={{ width: 320, marginBottom: 12 }} />
      <Table
        rowKey="id" size="small" dataSource={rows} pagination={{ pageSize: 20 }}
        columns={[
          { title: 'When', dataIndex: 'created_at', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
          { title: 'Admin', dataIndex: 'admin_name' },
          { title: 'Action', dataIndex: 'action', render: (a) => <Tag color={a.includes('delete') ? 'red' : a.includes('suspend') ? 'orange' : 'blue'}>{a}</Tag> },
          { title: 'Target', render: (_: any, r: any) => `${r.target_table || ''}${r.target_id ? ` · ${String(r.target_id).slice(0, 8)}` : ''}` },
          { title: 'Before', dataIndex: 'before_values', ellipsis: true, render: (v) => (v ? JSON.stringify(v).slice(0, 60) : '—') },
          { title: 'After', dataIndex: 'after_values', ellipsis: true, render: (v) => (v ? JSON.stringify(v).slice(0, 60) : '—') },
        ]}
      />
    </div>
  );
}
