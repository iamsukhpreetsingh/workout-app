// Member's Membership tab — real plan terms. Assign (works with or without
// an app account), plan change (replaces the ACTIVE term, old one kept as
// CANCELLED history), cancel, renew. Prices shown are the SNAPSHOTTED
// amounts the member actually signed up at.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Table, Tag, Modal, Form, InputNumber, Select, DatePicker, App as AntApp,
  Typography, Card, Descriptions, Space, Popconfirm, Empty,
} from 'antd';
import { PlusOutlined, RedoOutlined, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatusBadge from './StatusBadge';
import { ErrorState, EmptyState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  listMemberMemberships, listPlans, assignMembership, cancelMembership, renewMembership,
  formatMoney, MemberMembership, MembershipPlan,
} from '../api';

export default function MemberMembershipTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message, modal } = AntApp.useApp();
  const [terms, setTerms] = useState<MemberMembership[] | null>(null);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [error, setError] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [form] = Form.useForm();
  const canManage = hasPermission(ctx, 'memberships.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, p] = await Promise.all([
        listMemberMemberships(ctx!.gymId, memberId),
        canManage ? listPlans(ctx!.gymId, 'ACTIVE') : Promise.resolve([]),
      ]);
      setTerms(t);
      setPlans(p);
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId, canManage]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!terms) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const active = terms.find((t) => t.status === 'ACTIVE');
  const upcoming = terms.find((t) => t.status === 'UPCOMING');

  const submitAssign = async () => {
    try {
      const v = await form.validateFields();
      await assignMembership(ctx!.gymId, memberId, {
        plan_id: v.plan_id,
        starts_on: v.starts_on ? v.starts_on.format('YYYY-MM-DD') : undefined,
        replace_active: !!active,
        cancel_reason: 'plan_change',
      });
      message.success('Membership assigned');
      setAssignOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not assign the membership');
    }
  };

  const doRenew = (term: MemberMembership) => {
    modal.confirm({
      title: `Renew ${term.plan_name}?`,
      content: term.ends_on >= new Date().toISOString().slice(0, 10)
        ? 'The renewal starts the day after the current term ends and uses the plan\u2019s current price.'
        : 'The renewal starts today and uses the plan\u2019s current price.',
      okText: 'Renew',
      onOk: async () => {
        try {
          await renewMembership(ctx!.gymId, memberId, term.id);
          message.success('Membership renewed');
          load();
        } catch (e: any) {
          message.error(e.message || 'Could not renew');
        }
      },
    });
  };

  const doCancel = (term: MemberMembership) => {
    modal.confirm({
      title: 'Cancel this membership?',
      content: 'It stays in the member\u2019s history as CANCELLED.',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await cancelMembership(ctx!.gymId, memberId, term.id);
          message.success('Membership cancelled');
          load();
        } catch (e: any) {
          message.error(e.message || 'Could not cancel');
        }
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {active && (
        <Card size="small" title="Current membership" extra={<StatusBadge status={active.status} />}>
          <Descriptions size="small" column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label="Plan">{active.plan_name}</Descriptions.Item>
            <Descriptions.Item label="Price">
              {formatMoney(active.price_cents, active.currency)}
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                (locked at signup)
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Term">{active.starts_on} → {active.ends_on}</Descriptions.Item>
          </Descriptions>
          {canManage && (
            <Space style={{ marginTop: 12 }} wrap>
              <Button icon={<PlusOutlined />} onClick={() => { form.resetFields(); setAssignOpen(true); }}>
                Change plan
              </Button>
              <Button icon={<RedoOutlined />} onClick={() => doRenew(active)}>Renew</Button>
              <Popconfirm title="Cancel this membership?" okButtonProps={{ danger: true }}
                onConfirm={() => doCancel(active)}>
                <Button danger icon={<StopOutlined />}>Cancel membership</Button>
              </Popconfirm>
            </Space>
          )}
        </Card>
      )}

      {upcoming && (
        <Card size="small" title="Scheduled renewal" extra={<StatusBadge status={upcoming.status} />}>
          <Descriptions size="small" column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label="Plan">{upcoming.plan_name}</Descriptions.Item>
            <Descriptions.Item label="Price (current plan price)">{formatMoney(upcoming.price_cents, upcoming.currency)}</Descriptions.Item>
            <Descriptions.Item label="Starts">{upcoming.starts_on} → {upcoming.ends_on}</Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {!active && !upcoming && (
        <Empty
          description={
            <Typography.Text type="secondary">
              {canManage ? 'No membership yet — assign a plan to this member.' : 'This member has no active membership.'}
            </Typography.Text>
          }
        >
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />}
              onClick={() => { form.resetFields(); setAssignOpen(true); }}>
              Assign plan
            </Button>
          )}
        </Empty>
      )}

      <Card size="small" title="History">
        {terms.length === 0 ? (
          <EmptyState title="No membership history" description="Assigned terms will appear here." />
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={terms}
            columns={[
              { title: 'Plan', dataIndex: 'plan_name' },
              { title: 'Price', width: 120, render: (_: any, m: MemberMembership) => formatMoney(m.price_cents, m.currency) },
              { title: 'Term', key: 'term', render: (_: any, m: MemberMembership) => `${m.starts_on} → ${m.ends_on}` },
              { title: 'Status', dataIndex: 'status', width: 120, render: (s: string) => <StatusBadge status={s} /> },
              { title: 'Note', dataIndex: 'cancel_reason', render: (v: string) =>
                v ? <Tag>{v.replace(/_/g, ' ')}</Tag> : null },
            ]}
          />
        )}
      </Card>

      <Modal
        title="Assign plan"
        open={assignOpen}
        onOk={submitAssign}
        onCancel={() => setAssignOpen(false)}
        okText={active ? 'Replace & assign' : 'Assign'}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="plan_id" label="Plan" rules={[{ required: true, message: 'Pick a plan' }]}>
            <Select
              placeholder="Select a plan"
              options={plans.map((p) => ({
                value: p.id,
                label: `${p.name} — ${formatMoney(p.price_cents, p.currency)}` +
                  (p.included_pt_sessions > 0 ? ` · ${p.included_pt_sessions} PT` : ''),
              }))}
            />
          </Form.Item>
          <Form.Item name="starts_on" label="Starts on">
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          {active && (
            <Typography.Paragraph type="warning" style={{ marginBottom: 0 }}>
              Replacing the current <b>{active.plan_name}</b> term — it is kept in history as CANCELLED.
            </Typography.Paragraph>
          )}
        </Form>
      </Modal>
    </div>
  );
}
