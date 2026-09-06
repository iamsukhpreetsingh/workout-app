// GymsPage — platform-wide gym management: searchable/filterable list,
// detail drawer (staff roster + live counts), and the platform lifecycle
// lever (suspend/reactivate, super_admin only, always confirmed).
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Descriptions, Drawer, Input, Popconfirm,
  Select, Space, Spin, Table, Tag, Typography,
} from 'antd';
import { api } from '../api';

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'green', INACTIVE: 'orange', SUSPENDED: 'red',
};

interface GymRow {
  id: string; name: string; slug: string; status: string; city: string | null;
  timezone: string; currency: string; created_at: string;
  members: number; leads: number; active_memberships: number;
  owner_name: string | null; owner_email: string | null;
}

interface GymDetail {
  gym: GymRow & { address_line1?: string; phone?: string | null; email?: string | null };
  counts: Record<string, number>;
  staff: { id: string; gym_role: string; status: string; created_at: string; name: string; email: string }[];
}

export default function GymsPage({ profile }: { profile: { role: string } }) {
  const { message } = AntApp.useApp();
  const isSuper = profile?.role === 'super_admin';

  const [rows, setRows] = useState<GymRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '25', offset: String(offset) });
      if (q.trim()) qs.set('q', q.trim());
      if (status) qs.set('status', status);
      const body = await api<{ total: number; gyms: GymRow[] }>(`/gyms?${qs}`);
      setRows(body.gyms);
      setTotal(body.total);
    } catch (e: any) {
      setError(e.message || 'Unable to load gyms. Try again.');
    } finally {
      setLoading(false);
    }
  }, [q, status]);

  useEffect(() => {
    const t = setTimeout(() => { setPage(0); load(0); }, 350);
    return () => clearTimeout(t);
  }, [load]);

  const lifecycle = async (gym: GymRow, action: 'suspend' | 'reactivate') => {
    if (busy) return;
    setBusy(true);
    try {
      const body = action === 'suspend'
        ? { reason: `Suspended from admin panel by ${profile.role}` }
        : undefined;
      await api(`/gyms/${gym.id}/${action}`, { method: 'PATCH', body });
      message.success(action === 'suspend' ? `${gym.name} suspended` : `${gym.name} reactivated`);
      load(page * 25);
    } catch (e: any) {
      message.error(e.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search
          placeholder="Search name, city or owner email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          allowClear
          style={{ width: 320 }}
        />
        <Select
          placeholder="Status" allowClear style={{ width: 160 }}
          value={status} onChange={setStatus}
          options={['ACTIVE', 'INACTIVE', 'SUSPENDED'].map((s) => ({ value: s, label: s }))}
        />
      </Space>

      {error ? <Alert type="error" message={error} /> : (
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows || []}
          locale={{ emptyText: 'No gyms found.' }}
          pagination={{
            total, pageSize: 25, current: page + 1,
            onChange: (p) => { setPage(p - 1); load((p - 1) * 25); },
          }}
          columns={[
            { title: 'Gym', dataIndex: 'name', render: (v: string, r: GymRow) => (
              <a onClick={() => setOpenId(r.id)}>{v}</a>
            ) },
            { title: 'City', dataIndex: 'city', render: (v: string) => v || '—' },
            { title: 'Owner', dataIndex: 'owner_name', render: (v: string, r: GymRow) => (
              v ? <Typography.Text>{v}<Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>{r.owner_email}</Typography.Text></Typography.Text>
                : <Typography.Text type="secondary">—</Typography.Text>
            ) },
            { title: 'Members', dataIndex: 'members', width: 90, render: (v: number) => v.toLocaleString() },
            { title: 'Active terms', dataIndex: 'active_memberships', width: 110, render: (v: number) => v.toLocaleString() },
            { title: 'Leads', dataIndex: 'leads', width: 80 },
            { title: 'Created', dataIndex: 'created_at', width: 120,
              render: (v: string) => new Date(v).toLocaleDateString() },
            { title: 'Status', dataIndex: 'status', width: 110,
              render: (s: string) => <Tag color={STATUS_COLOR[s]}>{s}</Tag> },
            { title: '', key: 'actions', width: 160, render: (_: any, r: GymRow) => isSuper && (
              r.status === 'SUSPENDED' ? (
                <Popconfirm title={`Reactivate ${r.name}?`} description="Lifts the platform suspension — the gym operates immediately."
                  onConfirm={() => lifecycle(r, 'reactivate')}>
                  <Button size="small">Reactivate</Button>
                </Popconfirm>
              ) : (
                <Popconfirm title={`Suspend ${r.name}?`}
                  description="All gym-portal and app operations for this gym will immediately answer 403. Owner-deactivated state is preserved."
                  okButtonProps={{ danger: true }} okText="Suspend Gym">
                  <Button size="small" danger>Suspend</Button>
                </Popconfirm>
              )
            ) },
          ]}
        />
      )}

      <GymDetailDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function GymDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<GymDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) { setDetail(null); return; }
    setLoading(true);
    api<GymDetail>(`/gyms/${id}`)
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <Drawer title={detail?.gym.name || 'Gym details'} width={520} open={!!id} onClose={onClose} destroyOnClose>
      {loading || !detail ? <Spin /> : (
        <>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Status">
              <Tag color={STATUS_COLOR[detail.gym.status]}>{detail.gym.status}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Owner">
              {detail.staff.find((s) => s.gym_role === 'OWNER')?.name || '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Contact">
              {[detail.gym.phone, detail.gym.email].filter(Boolean).join(' · ') || '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Location">
              {[detail.gym.city].filter(Boolean).join(', ') || '—'} · {detail.gym.timezone}
            </Descriptions.Item>
            <Descriptions.Item label="Currency">{detail.gym.currency}</Descriptions.Item>
            <Descriptions.Item label="Created">{new Date(detail.gym.created_at).toLocaleDateString()}</Descriptions.Item>
          </Descriptions>

          <Card size="small" title="Live counts" style={{ marginTop: 16 }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="Members">{detail.counts.members.toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Active members">{detail.counts.members_active.toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Active terms">{detail.counts.memberships_active.toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Attendance (30d)">{detail.counts.attendance_30d.toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="Leads">{detail.counts.leads.toLocaleString()} ({detail.counts.leads_new} new)</Descriptions.Item>
              <Descriptions.Item label="Branches / classes">{detail.counts.branches_active} / {detail.counts.classes_scheduled}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card size="small" title={`Staff (${detail.staff.length})`} style={{ marginTop: 16 }}>
            <Table
              rowKey="id" size="small" pagination={false}
              dataSource={detail.staff}
              columns={[
                { title: 'Name', dataIndex: 'name' },
                { title: 'Email', dataIndex: 'email' },
                { title: 'Role', dataIndex: 'gym_role', width: 110 },
                { title: 'Status', dataIndex: 'status', width: 100,
                  render: (s: string) => <Tag color={s === 'ACTIVE' ? 'green' : 'orange'}>{s}</Tag> },
              ]}
            />
          </Card>
        </>
      )}
    </Drawer>
  );
}
