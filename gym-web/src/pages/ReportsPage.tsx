// Reports — the business dashboard (Phase 15). Five KPI groups the owner
// wakes up for: Members, App adoption, Financial, Attendance, Trainer
// coverage, plus the per-branch split. Every number comes from ONE backend
// endpoint that aggregates in SQL on the gym's own calendar — this page is
// pure presentation. Requires reports.view (OWNER, ADMIN).
import React, { useCallback, useState } from 'react';
import {
  Card, Col, Row, Statistic, Alert, Button, Skeleton, Tooltip, Table,
  Typography, Tag,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import { useGymContext } from '../permissions';
import { getDashboard, GymDashboard, formatMoney } from '../api';

const HOUR_LABEL = (h: number) => `${String(h).padStart(2, '0')}:00`;

export default function ReportsPage() {
  const ctx = useGymContext();
  const gymId = ctx?.gymId ?? null;
  const [data, setData] = useState<GymDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!gymId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getDashboard(gymId));
    } catch (e: any) {
      setError(e.message || 'Could not load the dashboard');
    } finally {
      setLoading(false);
    }
  }, [gymId]);

  React.useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <PageContainer
        title="Reports"
        subtitle="The whole gym in one screen."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Reports' }]}
      >
        <Skeleton active paragraph={{ rows: 10 }} />
      </PageContainer>
    );
  }

  if (error || !data) {
    return (
      <PageContainer
        title="Reports"
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Reports' }]}
      >
        <Alert
          type="error"
          showIcon
          message="Could not load the dashboard"
          description={error}
          action={<Button icon={<ReloadOutlined />} onClick={load}>Retry</Button>}
        />
      </PageContainer>
    );
  }

  const cur = data.financial.currency;
  const peak = data.attendance.peak_hour;

  return (
    <PageContainer
      title="Reports"
      subtitle={`Business overview — as of ${data.as_of_local} gym time.`}
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Reports' }]}
      extra={<Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>}
    >
      {/* ── Members ─────────────────────────────────────────────────────── */}
      <Typography.Title level={5} style={{ marginBottom: 8 }}>Members</Typography.Title>
      <Row gutter={[16, 16]} style={{ marginBottom: 8 }}>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Total" value={data.members.total} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Active" value={data.members.active} valueStyle={{ color: '#16A34A' }} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Frozen" value={data.members.frozen} valueStyle={{ color: '#2563EB' }} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Expired" value={data.members.expired} valueStyle={{ color: '#D97706' }} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Cancelled" value={data.members.cancelled} valueStyle={{ color: '#DC2626' }} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Expiring ≤ 7 days" value={data.members.expiring_soon_7d} /></Card></Col>
      </Row>

      {/* ── App adoption ────────────────────────────────────────────────── */}
      <Typography.Title level={5} style={{ marginBottom: 8 }}>App adoption</Typography.Title>
      <Row gutter={[16, 16]} style={{ marginBottom: 8 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Total members" value={data.app_adoption.total} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Connected" value={data.app_adoption.connected} valueStyle={{ color: '#16A34A' }} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Not connected" value={data.app_adoption.not_connected} /></Card></Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Invitation pending" value={data.app_adoption.invitation_pending} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              included in “Not connected”
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      {/* ── Financial ───────────────────────────────────────────────────── */}
      <Typography.Title level={5} style={{ marginBottom: 8 }}>Financial</Typography.Title>
      <Row gutter={[16, 16]} style={{ marginBottom: 8 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Net collected (all time)" value={formatMoney(data.financial.collected_cents, cur)}
              valueStyle={{ color: '#16A34A' }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              this month: {formatMoney(data.financial.collected_month_cents, cur)}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Outstanding" value={formatMoney(data.financial.outstanding_cents, cur)} valueStyle={{ color: '#D97706' }} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Overdue" value={formatMoney(data.financial.overdue_cents, cur)} valueStyle={{ color: '#DC2626' }} /></Card></Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Open charges" value={data.financial.open_charges} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {data.financial.overdue_charges} past due · refunds {formatMoney(data.financial.refunded_cents, cur)}
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      {/* ── Attendance ──────────────────────────────────────────────────── */}
      <Typography.Title level={5} style={{ marginBottom: 8 }}>Attendance</Typography.Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Today's check-ins" value={data.attendance.today} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="This week" value={data.attendance.week} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="This month" value={data.attendance.month} /></Card></Col>
        <Col xs={12} md={4}>
          <Card size="small">
            <Statistic title={`Peak hour (${data.attendance.peak_window_days}d)`}
              value={peak === null ? '—' : HOUR_LABEL(peak)} />
          </Card>
        </Col>
        <Col xs={12} md={8}><Card size="small"><Statistic title={`Inactive ${data.attendance.inactive_window_days}+ days`} value={data.attendance.inactive_7d} valueStyle={{ color: '#D97706' }} /></Card></Col>
        <Col span={24}>
          <Card size="small" title={`Check-ins by hour · gym-local clock · last ${data.attendance.peak_window_days} days`}>
            <PeakHours hours={data.attendance.peak_hours} peak={peak} />
          </Card>
        </Col>
      </Row>

      {/* ── Trainers ────────────────────────────────────────────────────── */}
      <Typography.Title level={5} style={{ marginTop: 24, marginBottom: 8 }}>Trainers</Typography.Title>
      <Row gutter={[16, 16]} style={{ marginBottom: 8 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Total trainers" value={data.trainers.total} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Members per trainer" value={data.trainers.members_per_trainer} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Assigned members" value={data.trainers.assigned_members} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Unassigned members" value={data.trainers.unassigned_members} valueStyle={{ color: data.trainers.unassigned_members > 0 ? '#D97706' : undefined }} /></Card></Col>
      </Row>

      {/* ── Branches ────────────────────────────────────────────────────── */}
      {data.branches.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 24, marginBottom: 8 }}>Branches</Typography.Title>
          <Table
            size="small"
            rowKey="branch"
            dataSource={data.branches}
            pagination={false}
            columns={[
              { title: 'Branch', dataIndex: 'branch' },
              { title: 'Members', dataIndex: 'members', width: 140 },
              { title: 'Active', dataIndex: 'active', width: 140,
                render: (v: number) => <Tag color="green">{v}</Tag> },
              { title: 'Share', key: 'share',
                render: (_: any, r: { members: number }) =>
                  `${Math.round((r.members / Math.max(1, data.app_adoption.total)) * 100)}%` },
            ]}
          />
        </>
      )}
    </PageContainer>
  );
}

// Dependency-free 24-bucket strip: bar height is proportional to the
// hour's visits, the argmax hour is highlighted. Zeros render as a 2px
// stub so the grid still reads as a clock.
function PeakHours({ hours, peak }: { hours: { hour: number; visits: number }[]; peak: number | null }) {
  const max = Math.max(1, ...hours.map((h) => h.visits));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 96 }}>
      {hours.map(({ hour, visits }) => (
        <Tooltip key={hour} title={`${HOUR_LABEL(hour)} — ${visits} check-in${visits === 1 ? '' : 's'}`}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              height: Math.max(2, Math.round((visits / max) * 72)),
              background: hour === peak ? '#E8481F' : '#94A3B8',
              borderRadius: 2,
              margin: '0 auto',
              width: '80%',
            }} />
            <Typography.Text style={{ fontSize: 9 }} type={hour === peak ? undefined : 'secondary'}>
              {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
            </Typography.Text>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}
