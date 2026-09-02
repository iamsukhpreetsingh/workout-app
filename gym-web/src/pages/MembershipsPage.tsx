// Memberships — every plan term across the gym's members: who holds what,
// until when, and at what price. Members without app accounts appear here
// exactly like everyone else. Manage individual terms from the member page.
import React, { useCallback } from 'react';
import { Button, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { usePagedList } from '../hooks/usePagedList';
import { useGymContext } from '../permissions';
import { listGymMemberships, formatMoney, MemberMembership } from '../api';

const STATUSES = ['ACTIVE', 'FROZEN', 'UPCOMING', 'CANCELLED', 'EXPIRED'];

export default function MembershipsPage() {
  const ctx = useGymContext();
  const navigate = useNavigate();

  const fetcher = useCallback(
    (p: { q?: string; status?: string; limit: number; offset: number }) =>
      listGymMemberships(ctx!.gymId, p),
    [ctx?.gymId]
  );
  const list = usePagedList<MemberMembership>(fetcher, 20);

  const columns = [
    { title: 'Member', key: 'member', render: (_: any, m: MemberMembership) =>
      [m.first_name, m.last_name].filter(Boolean).join(' ') || m.member_code },
    { title: 'Member ID', dataIndex: 'member_code', width: 120 },
    { title: 'Plan', dataIndex: 'plan_name' },
    { title: 'Price', key: 'price', width: 130, render: (_: any, m: MemberMembership) =>
      formatMoney(m.price_cents, m.currency) },
    { title: 'Starts', dataIndex: 'starts_on', width: 110 },
    { title: 'Ends', dataIndex: 'ends_on', width: 110 },
    { title: 'Status', dataIndex: 'status', width: 120, render: (s: string) => <StatusBadge status={s} /> },
    { title: '', key: 'go', width: 80, render: (_: any, m: MemberMembership) => (
      <Button type="link" size="small" onClick={() => navigate(`/members/${m.member_id}`)}>Open</Button>
    ) },
  ];

  return (
    <PageContainer
      title="Memberships"
      subtitle="Current and historical plan terms for every member — with or without an app account."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Memberships' }]}
      extra={
        ctx!.permissions.includes('plans.manage') && (
          <Space>
            <Typography.Text type="secondary">Plans:</Typography.Text>
            <Button onClick={() => navigate('/memberships/plans')}>Manage plans</Button>
          </Space>
        )
      }
    >
      <DataTable<MemberMembership>
        columns={columns}
        rows={list.rows}
        rowKey={(m) => m.id}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        emptyTitle="No memberships yet"
        emptyDescription={list.q || list.status
          ? 'No memberships match the current search or filter.'
          : 'Assign a plan to a member from their Membership tab.'}
        page={list.page}
        pageSize={20}
        hasNext={list.hasNext}
        onPageChange={list.setPage}
        onRow={(m) => ({ style: { cursor: 'pointer' }, onClick: () => navigate(`/members/${m.member_id}`) })}
        toolbar={
          <FilterBar
            searchPlaceholder="Search member or plan…"
            q={list.q}
            onQ={list.setQ}
            filter={{
              placeholder: 'Status',
              value: list.status,
              onChange: list.setStatus,
              options: STATUSES.map((s) => ({ value: s, label: s })),
            }}
          />
        }
      />
    </PageContainer>
  );
}
