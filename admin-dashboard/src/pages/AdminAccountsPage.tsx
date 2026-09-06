// AdminAccountsPage — super_admin management of panel accounts. Fills the
// previously-unused backend endpoints (GET/POST/PATCH /admin/admins). Only
// super_admin can reach it (menu is role-gated and the backend enforces it).
import React, { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Modal, Select, Switch, Table, Tag, Typography } from 'antd';
import { api } from '../api';

const ROLES = ['super_admin', 'support', 'content_moderator', 'analyst', 'read_only'];
const ROLE_COLOR: Record<string, string> = {
  super_admin: 'red', support: 'blue', content_moderator: 'purple', analyst: 'green', read_only: 'default',
};

interface AdminRow {
  id: string; email: string; name: string; role: string;
  is_active: boolean; created_at: string; last_login_at: string | null;
}

export default function AdminAccountsPage({ currentEmail }: { currentEmail: string }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    try { setRows(await api<AdminRow[]>('/admins')); }
    catch { setRows([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async (values: any) => {
    setBusy(true);
    try {
      await api('/admins', { method: 'POST', body: values });
      message.success('Admin account created');
      setCreateOpen(false);
      form.resetFields();
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not create admin');
    } finally {
      setBusy(false);
    }
  };

  const update = async (admin: AdminRow, patch: any) => {
    try {
      await api(`/admins/${admin.id}`, { method: 'PATCH', body: patch });
      message.success('Updated');
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update admin');
      load();
    }
  };

  return (
    <Card
      title="Admin accounts"
      extra={<Button type="primary" onClick={() => setCreateOpen(true)}>New admin</Button>}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Roles (least → most privileged): read_only → analyst → content_moderator → support → super_admin.
        Deactivating an account blocks its next login immediately; existing sessions keep working until expiry.
      </Typography.Paragraph>
      <Table
        rowKey="id" size="small" loading={!rows}
        dataSource={rows || []}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Email', dataIndex: 'email' },
          { title: 'Role', dataIndex: 'role', width: 170,
            render: (role: string, r: AdminRow) => (
              r.email === currentEmail ? <Tag color={ROLE_COLOR[role]}>{role}</Tag> : (
                <Select size="small" value={role} style={{ width: 150 }}
                  onChange={(v) => update(r, { role: v })}
                  options={ROLES.map((x) => ({ value: x, label: x }))} />
              )
            ) },
          { title: 'Active', dataIndex: 'is_active', width: 90,
            render: (active: boolean, r: AdminRow) => (
              r.email === currentEmail ? (active ? <Tag color="green">you</Tag> : <Tag>inactive</Tag>) : (
                <Switch checked={active} onChange={(v) => update(r, { is_active: v })} />
              )
            ) },
          { title: 'Last login', dataIndex: 'last_login_at', width: 160,
            render: (v: string | null) => (v ? new Date(v).toLocaleString() : '—') },
          { title: 'Created', dataIndex: 'created_at', width: 120,
            render: (v: string) => new Date(v).toLocaleDateString() },
        ]}
      />
      <Modal
        title="Create admin account"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={busy}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item name="password" label="Temporary password" rules={[
            { required: true }, { min: 10, message: 'At least 10 characters.' },
          ]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true }]} initialValue="analyst">
            <Select options={ROLES.map((r) => ({ value: r, label: r }))} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
