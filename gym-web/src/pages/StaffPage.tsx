// Staff — real OWNER functionality: list gym staff, add by email, change
// role, deactivate/reactivate/remove. Backend enforces last-active-owner
// protection; its 400s are surfaced verbatim.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Drawer, Form, Input, Select, Tag, App as AntApp, Modal,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { useGymContext } from '../permissions';
import { listStaff, addStaff, updateStaff, StaffRow } from '../api';

const ASSIGNABLE_ROLES = ['OWNER', 'ADMIN', 'TRAINER', 'FRONT_DESK'];

export default function StaffPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listStaff(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load, tick]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (needle && !`${r.name} ${r.email}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, q, statusFilter]);

  const submitAdd = async () => {
    try {
      const v = await form.validateFields();
      await addStaff(ctx!.gymId, v);
      message.success('Staff member added');
      setAddOpen(false);
      form.resetFields();
      setTick((t) => t + 1);
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not add staff member');
    }
  };

  const patchStaff = async (row: StaffRow, patch: { gym_role?: string; status?: string }) => {
    try {
      await updateStaff(ctx!.gymId, row.id, patch);
      message.success('Staff updated');
      setTick((t) => t + 1);
    } catch (e: any) {
      message.error(e.message || 'Could not update staff member');
    }
  };

  const columns = useMemo(() => [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Email', dataIndex: 'email' },
    {
      title: 'Role', dataIndex: 'gym_role', width: 180,
      render: (role: string, row: StaffRow) => (
        <Select
          size="small"
          value={role}
          style={{ width: 140 }}
          options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r }))}
          onChange={(gym_role) => patchStaff(row, { gym_role })}
        />
      ),
    },
    {
      title: 'Status', dataIndex: 'status', width: 170,
      render: (status: string, row: StaffRow) => (
        <Tag
          style={{ cursor: 'pointer' }}
          color={status === 'ACTIVE' ? 'green' : status === 'INACTIVE' ? 'orange' : 'red'}
          onClick={() => {
            if (status === 'REMOVED') return;
            Modal.confirm({
              title: status === 'ACTIVE' ? 'Set this staff member to INACTIVE?' : 'Reactivate this staff member?',
              content: status === 'ACTIVE'
                ? 'They immediately lose access to this gym until reactivated.'
                : 'Their access is restored with the same role.',
              onOk: () => patchStaff(row, { status: status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
            });
          }}
        >
          {status}
        </Tag>
      ),
    },
    { title: 'Since', dataIndex: 'created_at', width: 130, render: (v: string) => String(v).slice(0, 10) },
  ], [ctx?.gymId]);

  return (
    <PageContainer
      title="Staff"
      subtitle="People with gym-scoped logins. Roles apply only inside this gym."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Staff' }]}
    >
      <DataTable<StaffRow>
        columns={columns}
        rows={filtered}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={load}
        emptyTitle="No staff members"
        emptyDescription={q || statusFilter
          ? 'No staff match the current search or filter.'
          : 'Add staff by their app account email.'}
        page={0}
        pageSize={filtered.length || 1}
        hasNext={false}
        onPageChange={() => {}}
        toolbar={
          <FilterBar
            searchPlaceholder="Search name or email…"
            q={q}
            onQ={setQ}
            filter={{
              placeholder: 'Status',
              value: statusFilter,
              onChange: setStatusFilter,
              options: ['ACTIVE', 'INACTIVE', 'REMOVED'].map((s) => ({ value: s, label: s })),
            }}
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
                Add staff
              </Button>
            }
          />
        }
      />

      <Drawer
        title="Add staff"
        width={420}
        open={addOpen}
        onClose={() => setAddOpen(false)}
        extra={<Button type="primary" onClick={submitAdd}>Add</Button>}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="email"
            label="App account email"
            rules={[
              { required: true, message: 'Email is required' },
              { type: 'email', message: 'Invalid email address' },
            ]}
          >
            <Input placeholder="staff@email.com" />
          </Form.Item>
          <Form.Item name="gym_role" label="Gym role" rules={[{ required: true, message: 'Role is required' }]}>
            <Select options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: r }))} />
          </Form.Item>
        </Form>
      </Drawer>
    </PageContainer>
  );
}
