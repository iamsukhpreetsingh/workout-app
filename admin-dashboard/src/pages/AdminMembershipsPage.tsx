// Platform-wide membership terms (read-only). A user account is NOT a
// membership: these are gym-scoped terms and historical states
// (EXPIRED/CANCELLED/LEFT members' history) stay visible, never hidden.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { api } from '../api';

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'green', UPCOMING: 'blue', FROZEN: 'gold', EXPIRED: 'default', CANCELLED: 'red',
};
const STATUSES = ['ACTIVE', 'UPCOMING', 'FROZEN', 'EXPIRED', 'CANCELLED'];

interface Row {
  id: string; plan_name: string; status: string; starts_on: string; ends_on: string;
  price_cents: number; currency: string; created_at: string;
  member_name: string; member_code: string; gym_name: string; gym_id: string;
}

export default function AdminMembershipsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | undefined>();
  const [gymId, setGymId] = useState<string | undefined>();
  const [gyms, setGyms] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<{ gyms: { id: string; name: string }[] }>('/gyms?limit=100')
      .then((b) => setGyms(b.gyms)).catch(() => {});
  }, []);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '25', offset: String(offset) });
      if (q.trim()) qs.set('q', q.trim());
      if (status) qs.set('status', status);
      if (gymId) qs.set('gym_id', gymId);
      const body = await api<{ total: number; memberships: Row[] }>(`/memberships?${qs}`);
      setRows(body.memberships);
      setTotal(body.total);
    } catch (e: any) {
      setError(e.message || 'Unable to load memberships. Try again.');
    } finally {
      setLoading(false);
    }
  }, [q, status, gymId]);

  useEffect(() => {
    const t = setTimeout(() => { setPage(0); load(0); }, 350);
    return () => clearTimeout(t);
  }, [load]);

  const money = (r: Row) => `${(r.price_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${r.currency}`;

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder="Search member, code or plan…" value={q}
          onChange={(e) => setQ(e.target.value)} allowClear style={{ width: 280 }} />
        <Select placeholder="Gym" allowClear style={{ minWidth: 200 }} value={gymId}
          onChange={setGymId} options={gyms.map((g) => ({ value: g.id, label: g.name }))}
          showSearch optionFilterProp="label" />
        <Select placeholder="Status" allowClear style={{ width: 140 }} value={status}
          onChange={setStatus} options={STATUSES.map((s) => ({ value: s, label: s }))} />
      </Space>
      {error ? <Alert type="error" message={error} /> : (
        <Table
          rowKey="id" size="small" loading={loading}
          dataSource={rows || []}
          locale={{ emptyText: 'No membership terms found.' }}
          pagination={{ total, pageSize: 25, current: page + 1,
            onChange: (p) => { setPage(p - 1); load((p - 1) * 25); } }}
          columns={[
            { title: 'Member', dataIndex: 'member_name', render: (v: string, r: Row) => (
              <>{v} <Typography.Text type="secondary">({r.member_code})</Typography.Text></>
            ) },
            { title: 'Gym', dataIndex: 'gym_name' },
            { title: 'Plan', dataIndex: 'plan_name' },
            { title: 'Term', width: 200, render: (_: any, r: Row) => `${r.starts_on} → ${r.ends_on}` },
            { title: 'Price', width: 130, render: (_: any, r: Row) => money(r) },
            { title: 'Status', dataIndex: 'status', width: 110,
              render: (s: string) => <Tag color={STATUS_COLOR[s]}>{s}</Tag> },
          ]}
        />
      )}
    </div>
  );
}
