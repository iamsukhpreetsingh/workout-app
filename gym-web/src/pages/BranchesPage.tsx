// Branches (Phase 16) — the gym's subdivisions: name, address, phone,
// hours, timezone, status. Branches are never deleted; they are CLOSED
// (INACTIVE) which blocks NEW check-ins only — members, staff links and
// all history are preserved. Requires branches.manage (OWNER, ADMIN).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Drawer, Form, Input, App as AntApp, Popconfirm, Tag, Tooltip,
  Table, Alert,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import StatusBadge from '../components/StatusBadge';
import { useGymContext } from '../permissions';
import {
  listBranches, createBranch, updateBranch, closeBranch, reopenBranch, Branch,
} from '../api';

function BranchForm({ form }: { form: any }) {
  return (
    <Form form={form} layout="vertical">
      <Form.Item name="name" label="Branch name" rules={[{ required: true, message: 'Name is required' }]}>
        <Input placeholder="Mohali" />
      </Form.Item>
      <Form.Item name="timezone" label="Timezone" initialValue="UTC"
        rules={[{ required: true, message: 'Timezone is required' }]}>
        <Input placeholder="Asia/Kolkata" />
      </Form.Item>
      <Form.Item name="phone" label="Phone">
        <Input placeholder="+91 172 000 0000" />
      </Form.Item>
      <Form.Item name="email" label="Email">
        <Input placeholder="mohali@irontemple.test" />
      </Form.Item>
      <Form.Item name="address_line1" label="Address line 1">
        <Input placeholder="SCO 12, Sector 60" />
      </Form.Item>
      <Form.Item name="address_line2" label="Address line 2">
        <Input />
      </Form.Item>
      <Form.Item label="City / State / PIN" style={{ marginBottom: 0 }}>
        <Input.Group compact>
          <Form.Item name="city" noStyle><Input style={{ width: '40%' }} placeholder="City" /></Form.Item>
          <Form.Item name="state" noStyle><Input style={{ width: '35%' }} placeholder="State" /></Form.Item>
          <Form.Item name="postal_code" noStyle><Input style={{ width: '25%' }} placeholder="PIN" /></Form.Item>
        </Input.Group>
      </Form.Item>
    </Form>
  );
}

export default function BranchesPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listBranches(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ timezone: 'UTC' });
    setDrawerOpen(true);
  };

  const openEdit = (b: Branch) => {
    setEditing(b);
    form.setFieldsValue({
      name: b.name, timezone: b.timezone, phone: b.phone || undefined, email: b.email || undefined,
      address_line1: b.address_line1 || undefined, address_line2: b.address_line2 || undefined,
      city: b.city || undefined, state: b.state || undefined, postal_code: b.postal_code || undefined,
    });
    setDrawerOpen(true);
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      if (editing) {
        await updateBranch(ctx!.gymId, editing.id, v);
        message.success('Branch updated — member labels follow a rename');
      } else {
        await createBranch(ctx!.gymId, v);
        message.success('Branch created');
      }
      setDrawerOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not save the branch');
    }
  };

  const toggleStatus = async (b: Branch) => {
    try {
      if (b.status === 'ACTIVE') {
        await closeBranch(ctx!.gymId, b.id);
        message.success(`"${b.name}" closed — new check-ins are blocked, history kept`);
      } else {
        await reopenBranch(ctx!.gymId, b.id);
        message.success(`"${b.name}" reopened`);
      }
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update the branch');
    }
  };

  const columns = useMemo(() => [
    { title: 'Branch', key: 'name', render: (_: any, b: Branch) => (
      <div>
        <div style={{ fontWeight: 600 }}>
          {b.name} {b.status === 'INACTIVE' && <Tag color="red">closed</Tag>}
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
          {[b.address_line1, b.city, b.state].filter(Boolean).join(', ') || 'No address set'}
        </div>
      </div>
    ) },
    { title: 'Phone', dataIndex: 'phone', render: (v: string) => v || '—' },
    { title: 'Timezone', dataIndex: 'timezone', width: 150 },
    { title: 'Members', dataIndex: 'members', width: 100, render: (v: number) => v ?? 0 },
    { title: 'Active', dataIndex: 'active_members', width: 90, render: (v: number) => v ?? 0 },
    { title: "Today's check-ins", dataIndex: 'checkins_today', width: 140, render: (v: number) => v ?? 0 },
    { title: 'Status', dataIndex: 'status', width: 110,
      render: (s: string) => <StatusBadge status={s === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED'} /> },
    { title: '', key: 'actions', width: 220, render: (_: any, b: Branch) => (
      <span>
        <Button size="small" style={{ marginRight: 8 }} onClick={() => openEdit(b)}>Edit</Button>
        {b.status === 'ACTIVE' ? (
          <Popconfirm
            title={`Close "${b.name}"?`}
            description="New check-ins will be blocked. Members, staff links and history are kept."
            onConfirm={() => toggleStatus(b)}
          >
            <Button size="small" danger>Close</Button>
          </Popconfirm>
        ) : (
          <Tooltip title="Reopen for check-ins">
            <Button size="small" onClick={() => toggleStatus(b)}>Reopen</Button>
          </Tooltip>
        )}
      </span>
    ) },
  ], [ctx?.gymId]);

  return (
    <PageContainer
      title="Branches"
      subtitle="Your gym's locations. Closing a branch blocks new check-ins — history is never lost."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Branches' }]}
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>New branch</Button>}
    >
      {error ? (
        <Alert
          type="error"
          showIcon
          message="Could not load branches"
          description={error?.message}
          action={<Button icon={<ReloadOutlined />} onClick={load}>Retry</Button>}
        />
      ) : (
        <Table<Branch>
          columns={columns as any}
          dataSource={rows}
          rowKey={(b) => b.id}
          loading={loading}
          pagination={false}
          locale={{ emptyText: 'No branches yet — a gym without branches works exactly as before. Add one when you open a second location.' }}
        />
      )}

      <Drawer
        title={editing ? `Edit ${editing.name}` : 'New branch'}
        width={420}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Button type="primary" onClick={submit}>{editing ? 'Save' : 'Create'}</Button>
        }
      >
        <BranchForm form={form} />
      </Drawer>
    </PageContainer>
  );
}
