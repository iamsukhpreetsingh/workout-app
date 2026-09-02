// Member's Membership tab — the full lifecycle (Phase 7):
//   Activate(=assign) · Freeze · Resume · Renew · Change Plan · Cancel · Extend
// Every action preserves history: the timeline below the cards is the
// append-only lifecycle record (assigned → frozen → resumed → renewed → …).
// Prices shown are the SNAPSHOTTED amounts the member actually signed up at.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Table, Tag, Modal, Form, Input, InputNumber, Select, DatePicker, App as AntApp,
  Typography, Card, Descriptions, Space, Popconfirm, Empty, Timeline,
} from 'antd';
import {
  PlusOutlined, RedoOutlined, StopOutlined, PauseCircleOutlined,
  PlayCircleOutlined, CalendarOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatusBadge from './StatusBadge';
import { ErrorState, EmptyState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  listMemberMemberships, listPlans, assignMembership, cancelMembership, renewMembership,
  freezeMembership, resumeMembership, extendMembership, listMembershipEvents,
  formatMoney, MemberMembership, MembershipPlan, MembershipEvent,
} from '../api';

const EVENT_LABELS: Record<string, string> = {
  assigned: 'Membership assigned',
  plan_changed: 'Plan changed',
  frozen: 'Frozen',
  resumed: 'Resumed',
  freeze_cancelled: 'Freeze cancelled',
  extended: 'Extended',
  renewed: 'Renewed',
  cancelled: 'Cancelled',
  expired: 'Expired',
  term_started: 'New term started',
};

export default function MemberMembershipTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message, modal } = AntApp.useApp();
  const [terms, setTerms] = useState<MemberMembership[] | null>(null);
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [events, setEvents] = useState<MembershipEvent[]>([]);
  const [error, setError] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);
  const [form] = Form.useForm();
  const [freezeForm] = Form.useForm();
  const [extendForm] = Form.useForm();
  const canManage = hasPermission(ctx, 'memberships.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, ev] = await Promise.all([
        listMemberMemberships(ctx!.gymId, memberId),
        listMembershipEvents(ctx!.gymId, memberId),
      ]);
      setTerms(t);
      setEvents(ev);
      if (canManage) {
        setPlans(await listPlans(ctx!.gymId, 'ACTIVE'));
      }
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId, canManage]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!terms) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const active = terms.find((t) => t.status === 'ACTIVE');
  const frozen = terms.find((t) => t.status === 'FROZEN');
  const upcoming = terms.find((t) => t.status === 'UPCOMING');
  const current = active || frozen;
  const openFreezeStart = events.find((e) => e.event === 'frozen')?.details?.starts_on;

  const submitAssign = async () => {
    try {
      const v = await form.validateFields();
      await assignMembership(ctx!.gymId, memberId, {
        plan_id: v.plan_id,
        starts_on: v.starts_on ? v.starts_on.format('YYYY-MM-DD') : undefined,
        replace_active: !!current,
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

  const submitFreeze = async () => {
    if (!current) return;
    try {
      const v = await freezeForm.validateFields();
      await freezeMembership(ctx!.gymId, memberId, current.id, {
        starts_on: v.starts_on ? v.starts_on.format('YYYY-MM-DD') : undefined,
        reason: v.reason || undefined,
      });
      message.success('Membership frozen — the expiry will move by the frozen days on resume');
      setFreezeOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not freeze the membership');
    }
  };

  const doResume = (cancel = false) => {
    if (!frozen) return;
    modal.confirm({
      title: cancel ? 'Cancel this freeze?' : 'Resume this membership?',
      content: 'The expiry moves forward by the exact number of frozen days. The resume day itself is not frozen.',
      okText: cancel ? 'Cancel freeze' : 'Resume',
      onOk: async () => {
        try {
          const r = await resumeMembership(ctx!.gymId, memberId, frozen.id, { cancel });
          message.success(`Resumed — ${r.frozen_days} frozen day(s) added to the expiry`);
          load();
        } catch (e: any) {
          message.error(e.message || 'Could not resume');
        }
      },
    });
  };

  const submitExtend = async () => {
    if (!active) return;
    try {
      const v = await extendForm.validateFields();
      await extendMembership(ctx!.gymId, memberId, active.id, v.days);
      message.success(`Extended by ${v.days} days`);
      setExtendOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not extend');
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
      {current && (
        <Card size="small" title="Current membership" extra={<StatusBadge status={current.status} />}>
          <Descriptions size="small" column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label="Plan">{current.plan_name}</Descriptions.Item>
            <Descriptions.Item label="Price">
              {formatMoney(current.price_cents, current.currency)}
              <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                (locked at signup)
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="Start">{current.starts_on}</Descriptions.Item>
            <Descriptions.Item label="Expiry">{current.ends_on}</Descriptions.Item>
            {current.status === 'FROZEN' && openFreezeStart && (
              <Descriptions.Item label="Frozen since">{String(openFreezeStart).slice(0, 10)}</Descriptions.Item>
            )}
          </Descriptions>
          {canManage && (
            <Space style={{ marginTop: 12 }} wrap>
              {current.status === 'ACTIVE' && (
                <>
                  <Button icon={<PauseCircleOutlined />} onClick={() => {
                    freezeForm.setFieldsValue({ starts_on: dayjs() });
                    setFreezeOpen(true);
                  }}>Freeze</Button>
                  <Button icon={<CalendarOutlined />} onClick={() => {
                    extendForm.setFieldsValue({ days: 7 });
                    setExtendOpen(true);
                  }}>Extend</Button>
                </>
              )}
              {current.status === 'FROZEN' && (
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => doResume(false)}>Resume</Button>
              )}
              <Button icon={<RedoOutlined />} onClick={() => doRenew(current)}>Renew</Button>
              <Button icon={<PlusOutlined />} onClick={() => { form.resetFields(); setAssignOpen(true); }}>
                Change plan
              </Button>
              <Popconfirm title="Cancel this membership?" okButtonProps={{ danger: true }}
                onConfirm={() => doCancel(current)}>
                <Button danger icon={<StopOutlined />}>Cancel</Button>
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

      {!current && !upcoming && (
        <Empty
          description={
            <Typography.Text type="secondary">
              {canManage ? 'No membership yet — assign a plan to this member.' : 'This member has no active membership.'}
            </Typography.Text>
          }
        >
          {canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setAssignOpen(true); }}>
              Assign plan
            </Button>
          )}
        </Empty>
      )}

      <Card size="small" title="History & lifecycle timeline">
        {terms.length === 0 ? (
          <EmptyState title="No membership history" description="Assigned terms will appear here." />
        ) : (
          <>
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
            {events.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <Typography.Text type="secondary" strong>Lifecycle timeline</Typography.Text>
                <Timeline
                  style={{ marginTop: 12 }}
                  items={events.slice(0, 20).map((e) => ({
                    color: ['cancelled', 'expired'].includes(e.event) ? 'red'
                      : e.event === 'frozen' ? 'gold' : 'green',
                    children: (
                      <>
                        <Typography.Text strong>{EVENT_LABELS[e.event] || e.event}</Typography.Text>
                        <Typography.Text type="secondary"> · {e.occurred_on} · {e.plan_name}</Typography.Text>
                        {e.event === 'resumed' && e.details?.frozen_days != null && (
                          <Typography.Text type="secondary"> · {e.details.frozen_days} day(s) added to expiry</Typography.Text>
                        )}
                        {e.event === 'extended' && e.details?.days != null && (
                          <Typography.Text type="secondary"> · +{e.details.days} days</Typography.Text>
                        )}
                      </>
                    ),
                  }))}
                />
              </div>
            )}
          </>
        )}
      </Card>

      <Modal
        title="Assign plan"
        open={assignOpen}
        onOk={submitAssign}
        onCancel={() => setAssignOpen(false)}
        okText={current ? 'Replace & assign' : 'Assign'}
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
          {current && (
            <Typography.Paragraph type="warning" style={{ marginBottom: 0 }}>
              Replacing the current <b>{current.plan_name}</b> term — it is kept in history as CANCELLED.
            </Typography.Paragraph>
          )}
        </Form>
      </Modal>

      <Modal
        title="Freeze membership"
        open={freezeOpen}
        onOk={submitFreeze}
        onCancel={() => setFreezeOpen(false)}
        okText="Freeze"
      >
        <Form form={freezeForm} layout="vertical">
          <Form.Item name="starts_on" label="Freeze starts" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isAfter(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item name="reason" label="Reason (optional)">
            <Input placeholder="injury, travel…" />
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          The term pauses while frozen. When you resume, the expiry moves forward by the exact
          number of frozen days.
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="Extend membership"
        open={extendOpen}
        onOk={submitExtend}
        onCancel={() => setExtendOpen(false)}
        okText="Extend"
      >
        <Form form={extendForm} layout="vertical">
          <Form.Item name="days" label="Days to add" rules={[{ required: true }]}>
            <InputNumber min={1} max={365} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
