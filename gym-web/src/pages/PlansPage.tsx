// Membership plans — real OWNER functionality: list, create, edit, archive.
// Plans belong to the gym and are independent of app Users. Editing a plan
// never rewrites history: existing memberships keep their assignment-time
// snapshot (see member_memberships).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Form, Input, InputNumber, Select, App as AntApp, Popconfirm } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { useGymContext } from '../permissions';
import { listPlans, createPlan, updatePlan, formatMoney, listBranches, Branch, MembershipPlan } from '../api';

const ACCESS_LEVELS = [
  { value: 'gym_only', label: 'Gym only' },
  { value: 'gym_classes', label: 'Gym + classes' },
  { value: 'all_access', label: 'All access' },
];
const DURATION_UNITS = [
  { value: 'day', label: 'day(s)' },
  { value: 'week', label: 'week(s)' },
  { value: 'month', label: 'month(s)' },
  { value: 'year', label: 'year(s)' },
];

function PlanForm({ form, branchOptions }: { form: any; branchOptions: Branch[] }) {
  return (
    <Form form={form} layout="vertical">
      <Form.Item name="name" label="Plan name" rules={[{ required: true, message: 'Name is required' }]}>
        <Input placeholder="Premium Monthly" />
      </Form.Item>
      <Form.Item name="description" label="Description">
        <Input.TextArea rows={2} placeholder="Gym + 4 PT sessions" />
      </Form.Item>
      <Form.Item label="Duration" required style={{ marginBottom: 0 }}>
        <Input.Group compact>
          <Form.Item name="duration_value" noStyle initialValue={1}
            rules={[{ required: true, message: 'Required' }]}>
            <InputNumber min={1} max={36} precision={0} style={{ width: 90 }} />
          </Form.Item>
          <Form.Item name="duration_unit" noStyle initialValue="month"
            rules={[{ required: true, message: 'Required' }]}>
            <Select options={DURATION_UNITS} style={{ width: 120 }} />
          </Form.Item>
        </Input.Group>
      </Form.Item>
      <Form.Item
        name="price"
        label="Price per term (₹)"
        rules={[
          { required: true, message: 'Price is required' },
          { type: 'number', min: 0, message: 'Price cannot be negative' },
        ]}
      >
        <InputNumber min={0} precision={2} style={{ width: '100%' }} placeholder="1500.00" />
      </Form.Item>
      <Form.Item name="access_level" label="Access level" initialValue="gym_only"
        rules={[{ required: true }]}>
        <Select options={ACCESS_LEVELS} />
      </Form.Item>
      <Form.Item name="included_pt_sessions" label="Included PT sessions" initialValue={0}
        rules={[{ required: true }]}>
        <InputNumber min={0} max={500} precision={0} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="status" label="Status" initialValue="DRAFT">
        <Select options={['DRAFT', 'ACTIVE', 'ARCHIVED'].map((s) => ({ value: s, label: s }))} />
      </Form.Item>
      {branchOptions.length > 0 && (
        <Form.Item
          name="branch_ids"
          label="Available at branches"
          extra="Leave empty to sell this plan at every branch."
        >
          <Select
            mode="multiple"
            allowClear
            placeholder="All branches"
            options={branchOptions.filter((b) => b.status === 'ACTIVE').map((b) => ({
              value: b.id, label: b.name,
            }))}
          />
        </Form.Item>
      )}
    </Form>
  );
}

export default function PlansPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<MembershipPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<MembershipPlan | null>(null);
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listPlans(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!ctx?.gymId) return;
    listBranches(ctx.gymId).then(setBranchOptions).catch(() => setBranchOptions([]));
  }, [ctx?.gymId]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (needle && !`${r.name} ${r.description || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, q, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({ duration_value: 1, duration_unit: 'month', access_level: 'gym_only', included_pt_sessions: 0, status: 'DRAFT' });
    setDrawerOpen(true);
  };

  const openEdit = (plan: MembershipPlan) => {
    setEditing(plan);
    form.setFieldsValue({
      name: plan.name, description: plan.description || undefined,
      duration_value: plan.duration_value, duration_unit: plan.duration_unit,
      price: plan.price_cents / 100, access_level: plan.access_level,
      included_pt_sessions: plan.included_pt_sessions, status: plan.status,
      branch_ids: plan.branch_ids || [],
    });
    setDrawerOpen(true);
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      const payload = {
        ...v,
        price_cents: Math.round((v.price ?? 0) * 100),
        currency: 'INR',
        branch_ids: v.branch_ids ?? [],
      };
      delete payload.price;
      if (editing) {
        await updatePlan(ctx!.gymId, editing.id, payload);
        message.success('Plan updated — existing memberships keep their original price');
      } else {
        await createPlan(ctx!.gymId, payload);
        message.success('Plan created');
      }
      setDrawerOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not save the plan');
    }
  };

  const setStatus = async (plan: MembershipPlan, status: string) => {
    try {
      await updatePlan(ctx!.gymId, plan.id, { status });
      message.success(status === 'ARCHIVED' ? 'Plan archived — existing memberships stay valid' : 'Plan updated');
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update the plan');
    }
  };

  const columns = useMemo(() => [
    { title: 'Plan', key: 'name', render: (_: any, p: MembershipPlan) => (
      <div>
        <div style={{ fontWeight: 600 }}>{p.name}</div>
        {p.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{p.description}</div>}
      </div>
    ) },
    { title: 'Price', key: 'price', render: (_: any, p: MembershipPlan) => {
      const per = p.duration_value > 1
        ? `${p.duration_value} ${p.duration_unit}s`
        : p.duration_unit === 'month' ? 'month' : p.duration_unit === 'day' ? 'day' : p.duration_unit === 'week' ? 'week' : 'year';
      return (
        <span style={{ fontWeight: 600 }}>
          {formatMoney(p.price_cents, p.currency)}<span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 400 }}>/{per}</span>
        </span>
      );
    } },
    { title: 'Access', dataIndex: 'access_level', render: (v: string) =>
      ACCESS_LEVELS.find((a) => a.value === v)?.label || v },
    { title: 'PT sessions', dataIndex: 'included_pt_sessions', width: 110, render: (v: number) => (v > 0 ? `${v}` : '—') },
    { title: 'Status', dataIndex: 'status', width: 120, render: (s: string) => <StatusBadge status={s === 'ACTIVE' ? 'ACTIVE' : s === 'ARCHIVED' ? 'EXPIRED' : 'PENDING'} /> },
    { title: '', key: 'actions', width: 240, render: (_: any, p: MembershipPlan) => (
      <span>
        <Button size="small" style={{ marginRight: 8 }} onClick={() => openEdit(p)}>Edit</Button>
        <Popconfirm
          title={p.status === 'ARCHIVED' ? 'Reactivate this plan?' : 'Archive this plan?'}
          description={p.status !== 'ARCHIVED' ? 'Existing memberships keep working; new assignments are blocked.' : undefined}
          disabled={p.status === 'DRAFT'}
          onConfirm={() => setStatus(p, p.status === 'ARCHIVED' ? 'ACTIVE' : 'ARCHIVED')}
        >
          <Button size="small" disabled={p.status === 'DRAFT'}>
            {p.status === 'ARCHIVED' ? 'Reactivate' : 'Archive'}
          </Button>
        </Popconfirm>
      </span>
    ) },
  ], [ctx?.gymId]);

  return (
    <PageContainer
      title="Membership Plans"
      subtitle="What you sell. Editing a plan never changes memberships already sold — those keep the price they were bought at."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Memberships', to: '/memberships' }, { label: 'Plans' }]}
    >
      <DataTable<MembershipPlan>
        columns={columns}
        rows={filtered}
        rowKey={(p) => p.id}
        loading={loading}
        error={error}
        onRetry={load}
        emptyTitle="No plans yet"
        emptyDescription={q || statusFilter
          ? 'No plans match the current search or filter.'
          : 'Create your first plan, e.g. Basic Monthly — ₹1,500 / month, gym only.'}
        page={0}
        pageSize={filtered.length || 1}
        hasNext={false}
        onPageChange={() => {}}
        toolbar={
          <FilterBar
            searchPlaceholder="Search plans…"
            q={q}
            onQ={setQ}
            filter={{
              placeholder: 'Status',
              value: statusFilter,
              onChange: setStatusFilter,
              options: ['DRAFT', 'ACTIVE', 'ARCHIVED'].map((s) => ({ value: s, label: s })),
            }}
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Create plan</Button>
            }
          />
        }
      />

      <Drawer
        title={editing ? `Edit ${editing.name}` : 'Create plan'}
        width={440}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" onClick={submit}>{editing ? 'Save' : 'Create plan'}</Button>}
      >
        <PlanForm form={form} branchOptions={branchOptions} />
      </Drawer>
    </PageContainer>
  );
}
