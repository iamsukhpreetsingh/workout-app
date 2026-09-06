// AdminLeadsPage — platform-wide visibility of every gym's QR leads.
// READ-ONLY by design: status changes and notes are gym operations and stay
// in the Gym Portal; the admin panel only observes (spec 10).
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Descriptions, Drawer, Input, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { api } from '../api';

const STATUS_COLOR: Record<string, string> = {
  NEW: 'blue', CONTACTED: 'gold', TRIAL_SCHEDULED: 'purple', TRIAL_COMPLETED: 'purple',
  JOINED: 'green', NOT_JOINED: 'red', NO_RESPONSE: 'default', FOLLOW_UP: 'orange', CLOSED: 'default',
};
const STATUSES = ['NEW', 'CONTACTED', 'TRIAL_SCHEDULED', 'TRIAL_COMPLETED', 'JOINED', 'NOT_JOINED', 'NO_RESPONSE', 'FOLLOW_UP', 'CLOSED'];
const TYPES = ['ENQUIRY', 'TRIAL', 'VISITOR', 'MEMBERSHIP_ENQUIRY', 'GENERAL_ENQUIRY'];

interface LeadRow {
  id: string; full_name: string; phone: string; email: string | null;
  enquiry_type: string; status: string; source: string; created_at: string;
  converted_member_id: string | null; gym_name: string; gym_id: string;
}

export default function AdminLeadsPage() {
  const [rows, setRows] = useState<LeadRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | undefined>();
  const [type, setType] = useState<string | undefined>();
  const [gyms, setGyms] = useState<{ id: string; name: string }[]>([]);
  const [gymId, setGymId] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<LeadRow | null>(null);

  useEffect(() => {
    // gym filter options — reuse the platform gyms list (first page is plenty)
    api<{ gyms: { id: string; name: string }[] }>('/gyms?limit=100')
      .then((b) => setGyms(b.gyms))
      .catch(() => {});
  }, []);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ limit: '25', offset: String(offset) });
      if (q.trim()) qs.set('q', q.trim());
      if (status) qs.set('status', status);
      if (type) qs.set('type', type);
      if (gymId) qs.set('gym_id', gymId);
      const body = await api<{ total: number; leads: LeadRow[] }>(`/leads?${qs}`);
      setRows(body.leads);
      setTotal(body.total);
    } catch (e: any) {
      setError(e.message || 'Unable to load leads. Try again.');
    } finally {
      setLoading(false);
    }
  }, [q, status, type, gymId]);

  useEffect(() => {
    const t = setTimeout(() => { setPage(0); load(0); }, 350);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input.Search placeholder="Search name, phone or email…" value={q}
          onChange={(e) => setQ(e.target.value)} allowClear style={{ width: 280 }} />
        <Select placeholder="Gym" allowClear style={{ minWidth: 200 }} value={gymId}
          onChange={setGymId} options={gyms.map((g) => ({ value: g.id, label: g.name }))} showSearch optionFilterProp="label" />
        <Select placeholder="Status" allowClear style={{ width: 150 }} value={status}
          onChange={setStatus} options={STATUSES.map((s) => ({ value: s, label: s }))} />
        <Select placeholder="Type" allowClear style={{ width: 170 }} value={type}
          onChange={setType} options={TYPES.map((t) => ({ value: t, label: t }))} />
      </Space>

      {error ? <Alert type="error" message={error} /> : (
        <Table
          rowKey="id" size="small" loading={loading}
          dataSource={rows || []}
          locale={{ emptyText: 'No leads found.' }}
          pagination={{ total, pageSize: 25, current: page + 1,
            onChange: (p) => { setPage(p - 1); load((p - 1) * 25); } }}
          onRow={(r) => ({ onClick: () => setDetail(r), style: { cursor: 'pointer' } })}
          columns={[
            { title: 'Lead', dataIndex: 'full_name' },
            { title: 'Phone', dataIndex: 'phone', width: 130 },
            { title: 'Gym', dataIndex: 'gym_name' },
            { title: 'Type', dataIndex: 'enquiry_type', width: 160 },
            { title: 'Source', dataIndex: 'source', width: 100 },
            { title: 'Submitted', dataIndex: 'created_at', width: 120,
              render: (v: string) => new Date(v).toLocaleDateString() },
            { title: 'Status', dataIndex: 'status', width: 130,
              render: (s: string) => <Tag color={STATUS_COLOR[s]}>{s}</Tag> },
          ]}
        />
      )}

      <Drawer title={detail?.full_name} width={420} open={!!detail} onClose={() => setDetail(null)}>
        {detail ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Phone">{detail.phone}</Descriptions.Item>
            {detail.email && <Descriptions.Item label="Email">{detail.email}</Descriptions.Item>}
            <Descriptions.Item label="Gym">{detail.gym_name}</Descriptions.Item>
            <Descriptions.Item label="Type">{detail.enquiry_type}</Descriptions.Item>
            <Descriptions.Item label="Source">{detail.source === 'GYM_QR' ? 'Gym QR' : detail.source}</Descriptions.Item>
            <Descriptions.Item label="Submitted">{new Date(detail.created_at).toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="Status"><Tag color={STATUS_COLOR[detail.status]}>{detail.status}</Tag></Descriptions.Item>
            {detail.converted_member_id && (
              <Descriptions.Item label="Converted">yes — member linked in the Gym Portal</Descriptions.Item>
            )}
          </Descriptions>
        ) : <Spin />}
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, fontSize: 12 }}>
          Lead follow-up (status changes, notes, conversion) is a gym operation and is
          managed in the Gym Portal by the gym's own staff.
        </Typography.Paragraph>
      </Drawer>
    </div>
  );
}
