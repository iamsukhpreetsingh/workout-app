import React, { useEffect, useState } from 'react';
import {
  Card, Table, Statistic, Row, Col, Typography, Progress,
} from 'antd';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList,
} from 'recharts';
import {
  getConversionFunnel, getCoachingAnalytics, getAnalyticsContentHealth,
  getFeatureAdoption,
  ConversionFunnel, CoachingAnalytics, AnalyticsContentHealth, FeatureAdoption,
} from '../api';

export default function AnalyticsPage() {
  const [funnel, setFunnel] = useState<ConversionFunnel | null>(null);
  const [coaching, setCoaching] = useState<CoachingAnalytics | null>(null);
  const [content, setContent] = useState<AnalyticsContentHealth | null>(null);
  const [adoption, setAdoption] = useState<FeatureAdoption | null>(null);

  useEffect(() => {
    getConversionFunnel().then(setFunnel).catch(() => {});
    getCoachingAnalytics().then(setCoaching).catch(() => {});
    getAnalyticsContentHealth().then(setContent).catch(() => {});
    getFeatureAdoption().then(setAdoption).catch(() => {});
  }, []);

  const funnelData = funnel ? [
    { stage: 'Signed up', count: funnel.signedUp },
    { stage: 'Completed intake', count: funnel.withCompletedIntake.count },
    { stage: 'First workout', count: funnel.withFirstWorkout.count },
    { stage: 'Both', count: funnel.throughBoth.count },
  ] : [];

  const adoptionBars = adoption ? [
    { name: `Custom progression formula (of ${adoption.progressionFormula.configuredUsers} configured)`, pct: adoption.progressionFormula.pctCustomAmongConfigured ?? 0 },
    { name: `Exercise swapped mid-session (of ${adoption.exerciseSubstitution.syncedExerciseRows} rows)`, pct: adoption.exerciseSubstitution.pctSwapped ?? 0 },
    { name: `Diet-plan users ever swapped a meal (of ${adoption.dietSwaps.dietPlanUsers})`, pct: adoption.dietSwaps.pctEverSwapped ?? 0 },
  ] : [];

  return (
    <div>
      <Typography.Title level={4}>Analytics</Typography.Title>

      <Card size="small" title={`Conversion funnel — users signed up in the last ${funnel?.windowDays ?? 90} days`}>
        {!funnel ? (
          <Typography.Text type="secondary">Loading…</Typography.Text>
        ) : (
          <Row gutter={16}>
            <Col span={16}>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={funnelData} layout="vertical" margin={{ left: 40 }}>
                  <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                  <XAxis type="number" stroke="#888" allowDecimals={false} />
                  <YAxis type="category" dataKey="stage" stroke="#888" width={120} />
                  <Tooltip />
                  <Bar dataKey="count" fill="#E8481F" barSize={22}>
                    <LabelList dataKey="count" position="right" fill="#ddd" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Col>
            <Col span={8}>
              <Statistic title="Intake completion" value={funnel.withCompletedIntake.pct ?? '—'} suffix={funnel.withCompletedIntake.pct != null ? '%' : ''} />
              <br /><br />
              <Statistic title="Activated (first workout)" value={funnel.withFirstWorkout.pct ?? '—'} suffix={funnel.withFirstWorkout.pct != null ? '%' : ''} />
              <br /><br />
              <Statistic title="Through both" value={funnel.throughBoth.pct ?? '—'} suffix={funnel.throughBoth.pct != null ? '%' : ''} />
            </Col>
          </Row>
        )}
      </Card>

      <Card size="small" title="Coaching load & adherence" style={{ marginTop: 16 }}>
        <Row gutter={[16, 16]}>
          <Col span={5}><Statistic title="Avg active clients / trainer" value={coaching?.trainers.avg_active_clients_per_trainer ?? '—'} /></Col>
          <Col span={4}><Statistic title="Max active clients" value={coaching?.trainers.max_active_clients ?? 0} /></Col>
          <Col span={5}><Statistic title="Avg archived share" value={coaching?.trainers.avg_archived_share != null ? `${Math.round(coaching.trainers.avg_archived_share * 100)}%` : '—'} /></Col>
          <Col span={5}><Statistic title="Trainers w/ no clients" value={coaching?.trainers.trainers_with_no_relationships ?? 0} /></Col>
          <Col span={5}><Statistic title="Time to first assignment" value={coaching?.timeToFirstAssignment.avgDays != null ? coaching.timeToFirstAssignment.avgDays : '—'} suffix="days" /></Col>
          <Col span={12}>
            <Card type="inner" size="small" title={`Diet adherence (30d)`}>
              {coaching?.dietAdherence30d.total
                ? <Progress percent={coaching.dietAdherence30d.rate ?? 0} format={() => `${coaching.dietAdherence30d.rate}%`} />
                : <Typography.Text type="secondary">No check-ins</Typography.Text>}
            </Card>
          </Col>
          <Col span={12}>
            <Card type="inner" size="small" title={`Supplement adherence (30d)`}>
              {coaching?.supplementAdherence30d.total
                ? <Progress percent={coaching.supplementAdherence30d.rate ?? 0} format={() => `${coaching.supplementAdherence30d.rate}%`} />
                : <Typography.Text type="secondary">No check-ins</Typography.Text>}
            </Card>
          </Col>
        </Row>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Card size="small" title="Content health — templates">
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {content?.templates.neverAssigned ?? '—'} of {content?.templates.total ?? '—'} templates never assigned
          </Typography.Paragraph>
          <Table<AnalyticsContentHealth['templates']['mostUsed'][number]>
            rowKey={(r) => `${r.id}:most`}
            size="small"
            pagination={false}
            dataSource={content?.templates.mostUsed || []}
            columns={[
              { title: 'Most used', dataIndex: 'name' },
              { title: 'Assigned', dataIndex: 'times_assigned', width: 80 },
            ]}
          />
          <Table<AnalyticsContentHealth['templates']['mostUsed'][number]>
            rowKey={(r) => `${r.id}:least`}
            size="small"
            pagination={false}
            dataSource={(content?.templates.leastUsed || []).slice(0, 5)}
            style={{ marginTop: 8 }}
            columns={[
              { title: 'Least used', dataIndex: 'name' },
              { title: 'Assigned', dataIndex: 'times_assigned', width: 80 },
            ]}
          />
        </Card>
        <Card size="small" title="Content health — catalog dishes">
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            {content?.dishes.total ?? '—'} catalog dishes tracked
          </Typography.Paragraph>
          <Table<AnalyticsContentHealth['dishes']['mostUsed'][number]>
            rowKey={(r) => `${r.id}:most`}
            size="small"
            pagination={false}
            dataSource={content?.dishes.mostUsed || []}
            columns={[
              { title: 'Most used', dataIndex: 'name' },
              { title: 'Plan uses', dataIndex: 'times_used_in_plans', width: 90 },
            ]}
          />
          <Table<AnalyticsContentHealth['dishes']['mostUsed'][number]>
            rowKey={(r) => `${r.id}:least`}
            size="small"
            pagination={false}
            dataSource={(content?.dishes.leastUsed || []).slice(0, 5)}
            style={{ marginTop: 8 }}
            columns={[
              { title: 'Least used', dataIndex: 'name' },
              { title: 'Plan uses', dataIndex: 'times_used_in_plans', width: 90 },
            ]}
          />
        </Card>
      </div>

      <Card size="small" title="Feature adoption" style={{ marginTop: 16 }}>
        {adoption ? (
          <>
            {adoptionBars.map((b) => (
              <div key={b.name} style={{ marginBottom: 12 }}>
                <Typography.Text>{b.name}</Typography.Text>
                <Progress percent={Math.round(b.pct * 10) / 10} />
              </div>
            ))}
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={adoptionBars.map((b) => ({ ...b, short: b.name.split(' (')[0] }))} layout="vertical" margin={{ left: 60 }}>
                <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                <XAxis type="number" domain={[0, 100]} stroke="#888" unit="%" />
                <YAxis type="category" dataKey="short" stroke="#888" width={260} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: any) => `${v}%`} />
                <Bar dataKey="pct" fill="#E8481F" barSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </>
        ) : (
          <Typography.Text type="secondary">Loading…</Typography.Text>
        )}
      </Card>
    </div>
  );
}
