// Members — real functionality: search, status filter, offset pagination,
// create-member modal, row click → member detail.
import React, { useCallback, useMemo, useState } from 'react';
import { Button, Drawer, Form, Input, Select, DatePicker, App as AntApp } from 'antd';
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

const MEMBER_STATUSES = ['ACTIVE', 'PENDING', 'FROZEN', 'EXPIRED', 'CANCELLED'];

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
      <Form.Item name="status" label="Status" initialValue="ACTIVE">
        <Select options={MEMBER_STATUSES.map((s) => ({ value: s, label: s }))} />
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

export default function MembersPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const fetcher = useCallback(
    (p: { q?: string; status?: string; limit: number; offset: number }) =>
      listMembers(ctx!.gymId, p),
    [ctx?.gymId]
  );
  const list = usePagedList<GymMember>(fetcher, 20);

  const canCreate = ctx!.permissions.includes('members.create');

  const columns = useMemo(() => [
    { title: 'Code', dataIndex: 'member_code', width: 110 },
    { title: 'Name', key: 'name', render: (_: any, m: GymMember) =>
      [m.first_name, m.last_name].filter(Boolean).join(' ') },
    { title: 'Email', dataIndex: 'email', render: (v: string) => v || '—' },
    { title: 'Phone', dataIndex: 'phone', render: (v: string) => v || '—' },
    { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusBadge status={s} /> },
    { title: 'Joined', dataIndex: 'joined_at', width: 120 },
    { title: 'App', dataIndex: 'app_user_id', width: 90,
      render: (v: string | null) => (v ? 'Linked' : '—') },
  ], []);

  const submitCreate = async () => {
    try {
      const v = await form.validateFields();
      await createMember(ctx!.gymId, {
        ...v,
        joined_at: v.joined_at ? v.joined_at.format('YYYY-MM-DD') : undefined,
      });
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
          ? 'No members match the current search or filter.'
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
            searchPlaceholder="Search name, email, code, phone…"
            q={list.q}
            onQ={list.setQ}
            status={list.status}
            onStatus={list.setStatus}
            statusOptions={MEMBER_STATUSES.map((s) => ({ value: s, label: s }))}
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
        width={420}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        extra={<Button type="primary" onClick={submitCreate}>Add member</Button>}
      >
        <MemberFormFields form={form} />
      </Drawer>
    </PageContainer>
  );
}
