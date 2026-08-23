import React, { useEffect, useState } from 'react';
import { Card, Table, Input, Select, Button, Drawer, Descriptions, Tag, Space, Switch, message, Typography, List } from 'antd';
import { api } from '../api';

export default function UsersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [role, setRole] = useState<string | undefined>();
  const [detail, setDetail] = useState<any>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async () => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (role) qs.set('role', role);
    setRows(await api(`/users?${qs}`));
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const open = async (id: string) => setDetail(await api(`/users/${id}`));

  const suspend = async (user: any, suspended: boolean) => {
    try {
      await api(`/users/${user.id}/suspend`, { method: 'PATCH', body: { suspended } });
      msg.success(suspended ? 'Suspended — blocked at next login' : 'Reactivated');
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  const forceLogout = async (id: string) => {
    const r = await api(`/users/${id}/force-logout`, { method: 'POST' });
    msg.success(`Revoked ${r.revoked} refresh token(s)`);
  };

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Users & Trainers</Typography.Title>
      <Space style={{ marginBottom: 16 }}>
        <Input.Search placeholder="Search name / email" value={q} onChange={(e) => setQ(e.target.value)} onSearch={load} style={{ width: 280 }} />
        <Select allowClear placeholder="Role" value={role} onChange={setRole} style={{ width: 120 }} options={[
          { value: 'user', label: 'user' }, { value: 'trainer', label: 'trainer' },
        ]} />
        <Button onClick={load}>Search</Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Email', dataIndex: 'email' },
          { title: 'Role', dataIndex: 'role', render: (r) => <Tag color={r === 'trainer' ? 'blue' : 'default'}>{r}</Tag> },
          { title: 'Status', dataIndex: 'is_suspended', render: (s) => (s ? <Tag color="red">suspended</Tag> : <Tag color="green">active</Tag>) },
          { title: 'Workouts', dataIndex: 'session_count' },
          { title: 'Clients (A/Ar)', render: (_: any, r: any) => (r.role === 'trainer' ? `${r.active_clients} / ${r.archived_clients}` : '—') },
          {
            title: 'Actions',
            render: (_: any, r: any) => (
              <Space>
                <Button size="small" onClick={() => open(r.id)}>Detail</Button>
              </Space>
            ),
          },
        ]}
      />
      <Drawer open={!!detail} onClose={() => setDetail(null)} width={480} title={detail?.name}>
        {detail && (
          <div>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="Email">{detail.email}</Descriptions.Item>
              <Descriptions.Item label="Role">{detail.role}</Descriptions.Item>
              <Descriptions.Item label="Created">{String(detail.created_at)?.slice(0, 10)}</Descriptions.Item>
              <Descriptions.Item label="Sessions logged">{detail.session_count}</Descriptions.Item>
              <Descriptions.Item label="Last workout">{detail.last_workout_at ? String(detail.last_workout_at).slice(0, 10) : '—'}</Descriptions.Item>
            </Descriptions>
            <Space direction="vertical" style={{ marginTop: 16, width: '100%' }}>
              <Space>
                <Switch checked={!detail.is_suspended} checkedChildren="active" unCheckedChildren="suspended" onChange={(v) => suspend(detail, !v)} />
                <span>Suspend / reactivate</span>
              </Space>
              <Button danger onClick={() => forceLogout(detail.id)}>Force logout (all devices)</Button>
            </Space>
            {detail.role === 'trainer' && (
              <Card size="small" title="Client roster" style={{ marginTop: 16 }}>
                <List
                  size="small"
                  dataSource={detail.clients || []}
                  renderItem={(c: any) => (
                    <List.Item>
                      <span>{c.name} ({c.email})</span>
                      <Tag color={c.status === 'active' ? 'green' : c.status === 'archived' ? 'orange' : 'default'}>{c.status}</Tag>
                    </List.Item>
                  )}
                />
              </Card>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
