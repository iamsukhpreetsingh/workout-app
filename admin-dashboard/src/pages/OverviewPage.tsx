import React, { useEffect, useState } from 'react';
import { Card, Col, Row, Statistic, Table, Typography } from 'antd';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api';

export default function OverviewPage() {
  const [data, setData] = useState<any>(null);
  const [retention, setRetention] = useState<any[]>([]);

  useEffect(() => {
    api('/analytics/overview').then(setData).catch(() => {});
    api('/analytics/retention').then(setRetention).catch(() => {});
  }, []);

  if (!data) return <Typography.Text type="secondary">Loading metrics…</Typography.Text>;

  const cards = [
    ['Total users', data.total_users],
    ['Total trainers', data.total_trainers],
    ['Active relationships', data.active_relationships],
    ['Workouts today', data.workouts_today],
    ['Workouts this week', data.workouts_week],
    ['DAU / WAU / MAU', `${data.dau} / ${data.wau} / ${data.mau}`],
  ];

  // cohort retention table: week columns across cohorts
  const weekCols = Array.from({ length: 13 }, (_, i) => i);
  const maxWeek = Math.min(
    8,
    ...[9, ...retention.map((r) => Object.keys(r.weeks).length)]
  );

  return (
    <div>
      <Row gutter={[16, 16]}>
        {cards.map(([label, value]) => (
          <Col key={label as string} span={8}>
            <Card><Statistic title={label as string} value={value as any} /></Card>
          </Col>
        ))}
      </Row>
      <Card title="New signups per week" style={{ marginTop: 16 }}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data.signups}>
            <CartesianGrid stroke="#333" strokeDasharray="3 3" />
            <XAxis dataKey="week" stroke="#888" />
            <YAxis stroke="#888" allowDecimals={false} />
            <Tooltip />
            <Line type="monotone" dataKey="c" stroke="#E8481F" strokeWidth={2} name="signups" />
          </LineChart>
        </ResponsiveContainer>
      </Card>
      <Card title="Retention cohorts (signup week → % still logging workouts)" style={{ marginTop: 16 }}>
        <Table
          size="small"
          pagination={false}
          rowKey="cohort_week"
          dataSource={retention}
          columns={[
            { title: 'Cohort week', dataIndex: 'cohort_week' },
            { title: 'Size', dataIndex: 'cohort_size', width: 70 },
            ...Array.from({ length: maxWeek + 1 }, (_, w) => ({
              title: `W${w}`,
              render: (_: any, r: any) => {
                const active = r.weeks[w];
                if (active == null) return '-';
                const pct = r.cohort_size ? Math.round((active / r.cohort_size) * 100) : 0;
                return <span style={{ color: pct >= 40 ? '#52c41a' : pct > 0 ? '#faad14' : '#666' }}>{pct}%</span>;
              },
            })),
          ]}
        />
      </Card>
    </div>
  );
}
