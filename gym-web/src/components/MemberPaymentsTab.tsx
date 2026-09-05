// Member's Payments tab — charges (dues) + receipts, with record-payment,
// refund and receipt actions. Works identically for members with and
// without app accounts. Amounts shown are the SNAPSHOT amounts — plan
// price changes never rewrite this history.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Table, Tag, Modal, Form, Input, InputNumber, Select, DatePicker,
  Typography, App as AntApp, Descriptions, Space,
} from 'antd';
import { PlusOutlined, FileTextOutlined, RollbackOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatusBadge from './StatusBadge';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  getMemberBilling, createCharge, recordPayment, refundPayment, getReceipt,
  listGymPaymentProofs, approvePaymentProof, rejectPaymentProof, fetchProofScreenshotUrl,
  formatMoney, Charge, Payment, Receipt, PaymentProof,
} from '../api';

const METHODS = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'].map((m) => ({ value: m, label: m }));

export default function MemberPaymentsTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [charges, setCharges] = useState<Charge[] | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [proofs, setProofs] = useState<PaymentProof[] | null>(null);
  const [reviewing, setReviewing] = useState<PaymentProof | null>(null);
  const [shotUrl, setShotUrl] = useState<string | null>(null);
  const [error, setError] = useState<any>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [refundTarget, setRefundTarget] = useState<Payment | null>(null);
  const [form] = Form.useForm();
  const [chargeForm] = Form.useForm();
  const [refundForm] = Form.useForm();

  const canRecord = hasPermission(ctx, 'payments.record');
  const canManage = hasPermission(ctx, 'payments.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [b, pf] = await Promise.all([
        getMemberBilling(ctx!.gymId, memberId),
        listGymPaymentProofs(ctx!.gymId),
      ]);
      setCharges(b.charges);
      setPayments(b.payments);
      setProofs(pf.filter((p) => p.member_id === memberId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!charges) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const openBalances = charges.filter((c) => ['DUE', 'PARTIAL', 'OVERDUE'].includes(c.status));

  const showReceipt = async (p: Payment) => {
    try {
      setReceipt(await getReceipt(ctx!.gymId, memberId, p.id));
    } catch (e: any) {
      message.error(e.message || 'Could not load the receipt');
    }
  };

  const submitPay = async () => {
    try {
      const v = await form.validateFields();
      await recordPayment(ctx!.gymId, memberId, {
        charge_id: v.charge_id,
        amount_cents: Math.round(v.amount * 100),
        method: v.method,
        paid_on: v.paid_on ? v.paid_on.format('YYYY-MM-DD') : undefined,
        note: v.note || undefined,
      });
      message.success('Payment recorded — receipt generated');
      setPayOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not record the payment');
    }
  };

  const submitCharge = async () => {
    try {
      const v = await chargeForm.validateFields();
      await createCharge(ctx!.gymId, memberId, {
        description: v.description,
        amount_cents: Math.round(v.amount * 100),
        due_on: v.due_on ? v.due_on.format('YYYY-MM-DD') : undefined,
      });
      message.success('Charge created');
      setChargeOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not create the charge');
    }
  };

  const submitRefund = async () => {
    if (!refundTarget) return;
    try {
      const v = await refundForm.validateFields();
      await refundPayment(ctx!.gymId, memberId, refundTarget.id, {
        amount_cents: Math.round(v.amount * 100),
        reason: v.reason || undefined,
      });
      message.success('Refund recorded');
      setRefundTarget(null);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not record the refund');
    }
  };

  const doApproveProof = async (p: PaymentProof) => {
    try {
      await approvePaymentProof(ctx!.gymId, p.id);
      message.success('Payment approved — receipt generated');
      setReviewing(null);
      setShotUrl(null);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not approve');
    }
  };

  const doRejectProof = async (p: PaymentProof) => {
    try {
      await rejectPaymentProof(ctx!.gymId, p.id, 'Could not be verified');
      message.info('Proof rejected');
      setReviewing(null);
      setShotUrl(null);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not reject');
    }
  };

  const chargesCard = (
    <Card size="small" title="Dues & charges">
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={charges}
        locale={{ emptyText: 'No charges yet — membership sales and manual dues appear here.' }}
          scroll={{ x: 800 }}
        columns={[
          { title: 'Description', dataIndex: 'description' },
          { title: 'Amount', width: 110, render: (_: any, c: Charge) => formatMoney(c.amount_cents, c.currency) },
          { title: 'Period', key: 'period', width: 200, render: (_: any, c: Charge) =>
            c.period_start ? `${c.period_start} → ${c.period_end}` : '—' },
          { title: 'Due', dataIndex: 'due_on', width: 110 },
          { title: 'Status', dataIndex: 'status', width: 110, render: (s: string) => <StatusBadge status={s} /> },
          { title: 'Balance', dataIndex: 'outstanding_cents', width: 110, render: (v: number, c: Charge) =>
            v > 0 ? formatMoney(v, c.currency) : '—' },
        ]}
      />
      {canRecord && charges.length > 0 && (
        <Button
          type="primary"
          icon={<PlusOutlined />}
          style={{ marginTop: 12 }}
          disabled={openBalances.length === 0}
          onClick={() => {
            form.setFieldsValue({
              charge_id: openBalances[0].id,
              amount: openBalances[0].outstanding_cents / 100,
              method: 'CASH',
              paid_on: dayjs(),
            });
            setPayOpen(true);
          }}
        >
          Record payment
        </Button>
      )}
      {canRecord && openBalances.length === 0 && charges.length > 0 && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          Nothing outstanding — every charge is settled.
        </Typography.Text>
      )}
    </Card>
  );

  const paymentsCard = (
    <>
    {(proofs || []).length > 0 && (
      <Card size="small" title="Payment proofs" style={{ marginBottom: 16 }}>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          scroll={{ x: 820 }}
          dataSource={proofs || []}
          columns={[
            { title: 'Amount', dataIndex: 'amount_cents', width: 110, render: (v: number, p: PaymentProof) => formatMoney(v, p.currency) },
            { title: 'Method', dataIndex: 'method', width: 110 },
            { title: 'Transaction ID', dataIndex: 'transaction_id' },
            { title: 'Date', dataIndex: 'paid_on', width: 110 },
            { title: 'Status', dataIndex: 'status', width: 210, render: (st: string, p: PaymentProof) => {
              const color = st === 'PENDING_VERIFICATION' ? 'gold'
                : st === 'APPROVED' ? 'green' : st === 'REJECTED' ? 'red' : 'default';
              return (
                <Space size={4} wrap>
                  <Tag color={color}>{st === 'PENDING_VERIFICATION' ? 'PENDING VERIFICATION' : st}</Tag>
                  {st === 'REJECTED' && p.rejection_reason && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: p.rejection_reason }}>
                      {p.rejection_reason}
                    </Typography.Text>
                  )}
                </Space>
              );
            } },
            { title: '', key: 'go', width: 250, render: (_: any, p: PaymentProof) => (
              <Space size={4} wrap>
                {p.payment_id && (
                  <Button size="small" icon={<FileTextOutlined />} onClick={async () => {
                    try {
                      setReceipt(await getReceipt(ctx!.gymId, memberId, p.payment_id as string));
                    } catch (e: any) { message.error(e.message || 'Could not load receipt'); }
                  }}>Receipt</Button>
                )}
                {canManage && p.status === 'PENDING_VERIFICATION' && (
                  <>
                    <Button size="small" onClick={async () => { setReviewing(p); setShotUrl(await fetchProofScreenshotUrl(ctx!.gymId, p.id).catch(() => null)); }}>
                      Review
                    </Button>
                    <Button size="small" type="primary" onClick={() => doApproveProof(p)}>Approve</Button>
                    <Button size="small" danger onClick={() => doRejectProof(p)}>Reject</Button>
                  </>
                )}
              </Space>
            ) },
          ]}
        />
      </Card>
    )}
    <Card size="small" title="Receipts">
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={payments}
        locale={{ emptyText: 'No payments recorded yet.' }}
          scroll={{ x: 760 }}
        columns={[
          { title: 'Receipt #', dataIndex: 'receipt_number', width: 190 },
          { title: 'Amount', dataIndex: 'amount_cents', width: 110, render: (v: number, p: Payment) =>
            formatMoney(v, p.currency) },
          { title: 'Date', dataIndex: 'paid_on', width: 110 },
          { title: 'Method', dataIndex: 'method', width: 130 },
          { title: 'Status', dataIndex: 'status', width: 110, render: (s: string) => <StatusBadge status={s} /> },
          { title: '', key: 'actions', width: 200, render: (_: any, p: Payment) => (
            <Space>
              <Button size="small" icon={<FileTextOutlined />} onClick={() => showReceipt(p)}>Receipt</Button>
              {canManage && p.status !== 'REFUNDED' && (
                <Button size="small" danger icon={<RollbackOutlined />} onClick={() => {
                  refundForm.setFieldsValue({ amount: (p.amount_cents - p.refund_total) / 100 });
                  setRefundTarget(p);
                }}>Refund</Button>
              )}
            </Space>
          ) },
        ]}
      />
      {canManage && (
        <Button icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={() => {
          chargeForm.setFieldsValue({ due_on: dayjs() });
          setChargeOpen(true);
        }}>
          Add charge
        </Button>
      )}
    </Card>
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {chargesCard}
      {paymentsCard}

      <Modal title="Record payment" open={payOpen} onOk={submitPay} onCancel={() => setPayOpen(false)} okText="Record payment">
        <Form form={form} layout="vertical">
          <Form.Item name="charge_id" label="Charge" rules={[{ required: true, message: 'Pick a charge' }]}>
            <Select
              options={openBalances.map((c) => ({
                value: c.id,
                label: `${c.description} — ${formatMoney(c.outstanding_cents, c.currency)} outstanding`,
              }))}
              onChange={(id) => {
                const c = openBalances.find((x) => x.id === id);
                if (c) form.setFieldsValue({ amount: c.outstanding_cents / 100 });
              }}
            />
          </Form.Item>
          <Form.Item name="amount" label="Amount (₹)" rules={[{ required: true, message: 'Amount is required' }]}>
            <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="method" label="Method" rules={[{ required: true }]}>
            <Select options={METHODS} />
          </Form.Item>
          <Form.Item name="paid_on" label="Payment date" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item name="note" label="Note (optional)">
            <Input />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary">
          Receipts are immutable — a mistake is corrected with a refund, never by editing.
        </Typography.Text>
      </Modal>

      <Modal title="Add charge" open={chargeOpen} onOk={submitCharge} onCancel={() => setChargeOpen(false)} okText="Create charge">
        <Form form={chargeForm} layout="vertical">
          <Form.Item name="description" label="Description" rules={[{ required: true, message: 'Description is required' }]}>
            <Input placeholder="Personal training top-up" />
          </Form.Item>
          <Form.Item name="amount" label="Amount (₹)" rules={[{ required: true, message: 'Amount is required' }]}>
            <InputNumber min={0.01} precision={2} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="due_on" label="Due on">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`Refund ${refundTarget ? refundTarget.receipt_number : ''}`} open={!!refundTarget}
        onOk={submitRefund} onCancel={() => setRefundTarget(null)} okText="Record refund"
        okButtonProps={{ danger: true }}>
        <Form form={refundForm} layout="vertical">
          <Form.Item name="amount" label="Refund amount (₹)" rules={[{ required: true, message: 'Amount is required' }]}>
            <InputNumber
              min={0.01}
              precision={2}
              style={{ width: '100%' }}
              max={refundTarget ? (refundTarget.amount_cents - refundTarget.refund_total) / 100 : undefined}
            />
          </Form.Item>
          <Form.Item name="reason" label="Reason (optional)">
            <Input placeholder="wrong plan, cancellation…" />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary">
          The original receipt is never edited — the refund is a separate immutable record.
        </Typography.Text>
      </Modal>

      <Modal
        title={`Receipt ${receipt?.receipt_number || ''}`}
        open={!!receipt}
        onOk={() => setReceipt(null)}
        onCancel={() => setReceipt(null)}
        okText="Print"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        {receipt && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Gym">{receipt.gym.name}</Descriptions.Item>
            {receipt.gym.address && <Descriptions.Item label="Address">{receipt.gym.address}</Descriptions.Item>}
            <Descriptions.Item label="Member">
              {receipt.member.name} ({receipt.member.member_code})
              {!receipt.member.app_connected && <Tag style={{ marginLeft: 8 }}>Not connected</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="Plan">{receipt.plan}</Descriptions.Item>
            <Descriptions.Item label="Amount">
              {formatMoney(receipt.amount_cents, receipt.currency)}
            </Descriptions.Item>
            <Descriptions.Item label="Date">{receipt.date}</Descriptions.Item>
            <Descriptions.Item label="Method">{receipt.method}</Descriptions.Item>
            {receipt.covered_period && (
              <Descriptions.Item label="Covered period">
                {receipt.covered_period.from} → {receipt.covered_period.to}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Receipt #">{receipt.receipt_number}</Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </div>
  );
}
