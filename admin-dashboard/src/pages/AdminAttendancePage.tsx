// Platform-wide attendance visibility (read-only): every check-in across all
// gyms, filterable by gym and date range. The check-in workflow itself stays
// in the Gym Portal / mobile app.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, DatePicker, Input, Select, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api';

interface Row {
  id: string; local_date: string; check_in_at: string; source: string;
  member_name: string; member_code: string; gym_name: string; gym_id: string;
}

const SOURCES: Record<string, string> = {
  QR_CHECK_IN: 'Member QR', FRONT_DESK: 'Front desk', ADMIN_MANUAL: 'Manual',
  WORKOUT_COMPLETION: 'Workout', BRANCH_QR: 'Branch QR',
};

export default function AdminAttendancePage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [gymId, setGymId] = useState<string | undefined>();
  const [from, setFrom] = useState<dayjs.Dayjs | null>(null);
  const [to, setTo] = useState<dayjs.Dayjs | null>(null);
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
      if (gymId) qs.set('gym_id', gymId);
      if (from) qs.set('from', from.format('YYYY-MM-DD'));
      if (to) qs.set('to', to.format('YYYY-MM-DD'));
      const body = await api<{ total: number; attendance: Row[] }>(`/attendance?${qs}`);
      setRows(body.attendance);
      setTotal(body.total);
    } catch (e: any) {
      setError(e.message || 'Unable to load attendance. Try again.');
    } finally {
      setLoading(false);
    }
  }, [gymId, from, to]);

  useEffect(() => {
    const t = setTimeout(() => { setPage(0); load(0); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Select placeholder="Gym" allowClear style={{ minWidth: 220 }} value={gymId}
          onChange={setGymId} options={gyms.map((g) => ({ value: g.id, label: g.name }))}
          showSearch optionFilterProp="label" />
        <DatePicker placeholder="From" value={from} onChange={setFrom} />
        <DatePicker placeholder="To" value={to} onChange={setTo} />
      </Space>
      {error ? <Alert type="error" message={error} /> : (
        <Table
          rowKey="id" size="small" loading={loading}
          dataSource={rows || []}
          locale={{ emptyText: 'No check-ins found for this filter.' }}
          pagination={{ total, pageSize: 25, current: page + 1,
            onChange: (p) => { setPage(p - 1); load((p - 1) * 25); } }}
          columns={[
            { title: 'Member', dataIndex: 'member_name', render: (v: string, r: Row) => (
              <>{v} <Typography.Text type="secondary">({r.member_code})</Typography.Text></>
            ) },
            { title: 'Gym', dataIndex: 'gym_name' },
            { title: 'Date', dataIndex: 'local_date', width: 120 },
            { title: 'Checked in at', dataIndex: 'check_in_at', width: 180,
              render: (v: string) => new Date(v).toLocaleString() },
            { title: 'Source', dataIndex: 'source', width: 130,
              render: (s: string) => SOURCES[s] || s },
          ]}
        />
      )}
    </div>
  );
}
