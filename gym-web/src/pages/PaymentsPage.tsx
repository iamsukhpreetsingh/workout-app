// Payments — the financial dashboard (OWNER/ADMIN): summary cards plus the
// payment ledger. Financial reports are deliberately hidden from FRONT_DESK
// (they record payments from the member page instead).
import React, { useCallback, useState } from 'react';
import { Card, Col, Row, Statistic, Button } from 'antd';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { usePagedList } from '../hooks/usePagedList';
import { useGymContext } from '../permissions';
import { listGymPayments, formatMoney, Payment } from '../api';

const METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'];

export default function PaymentsPage() {
  const ctx = useGymContext();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<any>(null);
  const [summaryError, setSummaryError] = useState<any>(null);

  const loadSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      const { getBillingSummary } = await import('../api');
      setSummary(await getBillingSummary(ctx!.gymId));
    } catch (e: any) {
      setSummaryError(e);
    }
  }, [ctx?.gymId]);

  React.useEffect(() => { loadSummary(); }, [loadSummary]);

  const fetcher = useCallback(
    (p: { q?: string; limit: number; offset: number; method?: string }) =>
      listGymPayments(ctx!.gymId, p),
    [ctx?.gymId]
  );
  const list = usePagedList<Payment>(fetcher, 20);
  // the paged list supports one status-style select — use it for method
  const methodFilter = list.extra.method;

  const columns = [
    { title: 'Receipt #', dataIndex: 'receipt_number', width: 170 },
    { title: 'Member', key: 'member', render: (_: any, p: Payment) =>
      [p.first_name, p.last_name].filter(Boolean).join(' ') || p.member_code },
    { title: 'Amount', dataIndex: 'amount_cents', width: 120, render: (v: number, p: Payment) =>
      formatMoney(v, p.currency) },
    { title: 'Date', dataIndex: 'paid_on', width: 110 },
    { title: 'Method', dataIndex: 'method', width: 130 },
    { title: 'Membership', dataIndex: 'plan_name', render: (v: string) => v || '—' },
    { title: 'Period', key: 'period', width: 200, render: (_: any, p: Payment) =>
      p.period_start ? `${p.period_start} → ${p.period_end}` : '—' },
    { title: 'Status', dataIndex: 'status', width: 110, render: (s: string) => <StatusBadge status={s} /> },
    { title: '', key: 'go', width: 80, render: (_: any, p: Payment) => (
      <Button type="link" size="small" onClick={() => navigate(`/members/${p.member_id}`)}>Open</Button>
    ) },
  ];

  return (
    <PageContainer
      title="Payments"
      subtitle="Money in, money owed. Receipts are immutable — corrections happen through refunds."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Payments' }]}
    >
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Revenue this month"
              value={summary ? formatMoney(summary.revenue_this_month, 'INR') : '…'}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Collected"
              value={summary ? formatMoney(summary.collected_total, 'INR') : '…'}
              valueStyle={{ color: '#16A34A' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Due" value={summary ? formatMoney(summary.due, 'INR') : '…'}
              valueStyle={{ color: '#D97706' }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Overdue" value={summary ? formatMoney(summary.overdue, 'INR') : '…'}
              valueStyle={{ color: '#DC2626' }} />
          </Card>
        </Col>
      </Row>
      {summaryError && (
        <Button style={{ marginBottom: 16 }} onClick={loadSummary}>Retry summary</Button>
      )}

      <DataTable<Payment>
        columns={columns}
        rows={list.rows}
        rowKey={(p) => p.id}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        emptyTitle="No payments recorded"
        emptyDescription={list.q
          ? 'No payments match the current search.'
          : 'Record a payment from a member\u2019s Payments tab.'}
        page={list.page}
        pageSize={20}
        hasNext={list.hasNext}
        onPageChange={list.setPage}
        toolbar={
          <FilterBar
            searchPlaceholder="Search member or receipt…"
            q={list.q}
            onQ={list.setQ}
            filter={{
              placeholder: 'Method',
              value: methodFilter,
              onChange: (v) => list.setExtra({ method: v }),
              options: METHODS.map((m) => ({ value: m, label: m })),
            }}
          />
        }
      />
    </PageContainer>
  );
}
