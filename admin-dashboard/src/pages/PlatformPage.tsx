// PlatformPage — the platform control-center view over the GYM side of the
// business (the OverviewPage covers the trainer-app side): users, gyms,
// memberships, attendance, leads funnel and trainers, all from the single
// /admin/analytics/platform aggregate that reads the same tables the User
// App and Gym Portal write to.
import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, Typography } from 'antd';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api';

const fmt = (n: number) => (typeof n === 'number' ? n.toLocaleString() : '—');

export default function PlatformPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    api('/analytics/platform').then(setData).catch(() => setError(true));
  }, []);

  if (error) return <Typography.Text type="danger">Unable to load platform metrics. Try again.</Typography.Text>;
  if (!data) return <Typography.Text type="secondary">Loading metrics…</Typography.Text>;

  const kpiRows: [string, { title: string; value: any; sub?: string }[]][] = [
    ['Users', [
      { title: 'Total users', value: fmt(data.users.total) },
      { title: 'New (30d)', value: fmt(data.users.new_month) },
      { title: 'New (7d)', value: fmt(data.users.new_week) },
      { title: 'Suspended', value: fmt(data.users.suspended) },
    ]],
    ['Gyms', [
      { title: 'Total gyms', value: fmt(data.gyms.total) },
      { title: 'Active', value: fmt(data.gyms.active) },
      { title: 'Deactivated', value: fmt(data.gyms.inactive) },
      { title: 'Suspended', value: fmt(data.gyms.suspended) },
      { title: 'New (30d)', value: fmt(data.gyms.new_month) },
    ]],
    ['Memberships', [
      { title: 'Total terms', value: fmt(data.memberships.total) },
      { title: 'Active', value: fmt(data.memberships.active) },
      { title: 'Upcoming', value: fmt(data.memberships.upcoming) },
      { title: 'Frozen', value: fmt(data.memberships.frozen) },
      { title: 'Expired', value: fmt(data.memberships.expired) },
      { title: 'Cancelled', value: fmt(data.memberships.cancelled) },
    ]],
    ['Attendance', [
      { title: 'Today', value: fmt(data.attendance.today) },
      { title: 'This week', value: fmt(data.attendance.week) },
      { title: 'This month', value: fmt(data.attendance.month) },
      { title: 'Gyms active today', value: fmt(data.attendance.gyms_active_today) },
    ]],
    ['Leads', [
      { title: 'Total leads', value: fmt(data.leads.total) },
      { title: 'New (7d)', value: fmt(data.leads.new_week) },
      { title: 'Awaiting contact', value: fmt(data.leads.status_new) },
      { title: 'Joined', value: fmt(data.leads.status_joined) },
      { title: 'Conversion', value: `${data.leads.conversion_pct}%` },
      { title: 'Via QR', value: fmt(data.leads.via_qr) },
    ]],
    ['Trainers', [
      { title: 'Gym trainers (active)', value: fmt(data.trainers.gym_trainers_active) },
      { title: 'Gym assignments', value: fmt(data.trainers.gym_assignments_active) },
      { title: 'Independent connections', value: fmt(data.trainers.independent_connections) },
    ]],
  ];

  return (
    <div>
      {kpiRows.map(([section, cards]) => (
        <Card key={section as string} size="small" title={section as string} style={{ marginBottom: 16 }}>
          <Row gutter={[12, 12]}>
            {cards.map((c) => (
              <Col key={c.title} xs={12} sm={8} lg={4}>
                <Statistic title={c.title} value={c.value as any}
                  valueStyle={{ fontSize: 20 }} />
                {c.sub && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.sub}</Typography.Text>}
              </Col>
            ))}
          </Row>
        </Card>
      ))}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="Gyms created per month" size="small">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={data.gymTrend.map((r: any) => ({ ...r, month: String(r.month).slice(0, 7) }))}>
                <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                <XAxis dataKey="month" stroke="#888" />
                <YAxis stroke="#888" allowDecimals={false} />
                <Tooltip />
                <Area type="monotone" dataKey="c" stroke="#E8481F" fill="#E8481F22" strokeWidth={2} name="gyms" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="Leads per week" size="small">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data.leadTrend.map((r: any) => ({ ...r, week: String(r.week).slice(0, 10) }))}>
                <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                <XAxis dataKey="week" stroke="#888" />
                <YAxis stroke="#888" allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="c" stroke="#1677ff" strokeWidth={2} name="leads" />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
