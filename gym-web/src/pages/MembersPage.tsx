// Members — real functionality: search (name/email/phone/member code),
// independent membership-status and app-connection filters, offset
// pagination, create-member drawer (no app account required), row click →
// member detail.
import React, { useCallback, useMemo, useState } from 'react';
import { Button, Drawer, Form, Input, Select, DatePicker, App as AntApp, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { usePagedList } from '../hooks/usePagedList';
import { useGymContext } from '../permissions';
import { listMembers, createMember, GymMember } from '../api';

export const MEMBER_STATUSES = ['ACTIVE', 'PENDING', 'FROZEN', 'EXPIRED', 'CANCELLED'];
const CONNECTIONS = ['CONNECTED', 'NOT_CONNECTED', 'INVITATION_PENDING'];
export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'];

// Shared member form fields (create drawer + edit drawer). Deliberately
// minimal profile data: no government IDs, no health information.
export function MemberFormFields({ form }: { form: any }) {
  return (
    <Form form={form} layout="vertical">
      <Form.Item name="first_name" label="First name" rules={[{ required: true, message: 'First name is required' }]}>
        <Input />
      </Form.Item>
      <Form.Item name="last_name" label="Last name">
        <Input />
      </Form.Item>
      <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Invalid email address' }]}>
        <Input />
      </Form.Item>
      <Form.Item name="phone" label="Phone" rules={[{ pattern: /^[+()\-.\s0-9]{6,20}$/, message: 'Invalid phone number' }]}>
        <Input />
      </Form.Item>
      <Form.Item name="date_of_birth" label="Date of birth">
        <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isAfter(dayjs(), 'day')} />
      </Form.Item>
      <Form.Item name="gender" label="Gender">
        <Select allowClear options={GENDERS.map((g) => ({ value: g, label: g }))} />
      </Form.Item>
      <Form.Item name="emergency_contact_name" label="Emergency contact name">
        <Input />
      </Form.Item>
      <Form.Item name="emergency_contact_phone" label="Emergency contact phone"
        rules={[{ pattern: /^[+()\-.\s0-9]{6,20}$/, message: 'Invalid phone number' }]}>
        <Input />
      </Form.Item>
      <Form.Item name="joined_at" label="Joined on">
        <DatePicker style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="notes" label="Notes">
        <Input.TextArea rows={2} />
      </Form.Item>
    </Form>
  );
}

// serialize form values → API payload
export function memberFormToPayload(v: any) {
  return {
    ...v,
    joined_at: v.joined_at ? v.joined_at.format('YYYY-MM-DD') : undefined,
    date_of_birth: v.date_of_birth ? v.date_of_birth.format('YYYY-MM-DD') : undefined,
  };
}

const CONNECTION_TAG: Record<string, { color: string; label: string }> = {
  CONNECTED: { color: 'blue', label: 'App connected' },
  NOT_CONNECTED: { color: 'default', label: 'No app' },
  INVITATION_PENDING: { color: 'gold', label: 'Invite pending' },
};

export function AppConnectionTag({ connection }: { connection: string }) {
  const c = CONNECTION_TAG[connection] || { color: 'default', label: connection };
  return <Tag color={c.color}>{c.label}</Tag>;
}

export default function MembersPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const fetcher = useCallback(
    (p: { q?: string; status?: string; connection?: string; limit: number; offset: number }) =>
      listMembers(ctx!.gymId, p),
    [ctx?.gymId]
  );
  const list = usePagedList<GymMember>(fetcher, 20);
  const canCreate = ctx!.permissions.includes('members.create');

  const columns = useMemo(() => [
    { title: 'Member ID', dataIndex: 'member_code', width: 120 },
    { title: 'Name', key: 'name', render: (_: any, m: GymMember) =>
      [m.first_name, m.last_name].filter(Boolean).join(' ') },
    { title: 'Phone', dataIndex: 'phone', render: (v: string) => v || '—' },
    { title: 'Email', dataIndex: 'email', render: (v: string) => v || '—' },
    { title: 'Membership', dataIndex: 'status', width: 120, render: (s: string) => <StatusBadge status={s} /> },
    { title: 'App', dataIndex: 'app_connection', width: 130, render: (c: string) => <AppConnectionTag connection={c} /> },
    { title: 'Joined', dataIndex: 'joined_at', width: 110 },
  ], []);

  const submitCreate = async () => {
    try {
      const v = await form.validateFields();
      await createMember(ctx!.gymId, memberFormToPayload(v));
      message.success('Member added');
      setCreateOpen(false);
      form.resetFields();
      list.reload();
    } catch (e: any) {
      if (e?.errorFields) return; // inline validation
      message.error(e.message || 'Could not add member');
    }
  };

  return (
    <PageContainer
      title="Members"
      subtitle="Everyone who trains at this gym — with or without an app account."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Members' }]}
    >
      <DataTable<GymMember>
        columns={columns}
        rows={list.rows}
        rowKey={(m) => m.id}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        emptyTitle="No members yet"
        emptyDescription={list.q || list.status
          ? 'No members match the current search or filters.'
          : 'Add your first member — an app account is not required.'}
        emptyAction={canCreate && !list.q && !list.status ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>Add member</Button>
        ) : undefined}
        page={list.page}
        pageSize={20}
        hasNext={list.hasNext}
        onPageChange={list.setPage}
        onRow={(m) => ({ style: { cursor: 'pointer' }, onClick: () => navigate(`/members/${m.id}`) })}
        toolbar={
          <FilterBar
            searchPlaceholder="Search name, email, phone or member ID…"
            q={list.q}
            onQ={list.setQ}
            filter={{
              placeholder: 'Membership',
              value: list.status,
              onChange: list.setStatus,
              options: MEMBER_STATUSES.map((s) => ({ value: s, label: s })),
            }}
            secondFilter={{
              placeholder: 'App connection',
              value: list.extra.connection,
              onChange: (v) => list.setExtra({ connection: v }),
              options: CONNECTIONS.map((c) => ({ value: c, label: c })),
            }}
            extra={canCreate && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                Add member
              </Button>
            )}
          />
        }
      />

      <Drawer
        title="Add member"
        width={440}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        extra={<Button type="primary" onClick={submitCreate}>Create member</Button>}
      >
        <MemberFormFields form={form} />
      </Drawer>
    </PageContainer>
  );
}
