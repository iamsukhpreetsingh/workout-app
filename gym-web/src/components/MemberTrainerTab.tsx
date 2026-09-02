// Member's Trainer tab — real gym trainer assignments (Phase 8). Works for
// members with or without an app account; reassignment keeps the previous
// trainer in history as ENDED.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Descriptions, Select, Modal, Table, Tag, Typography, App as AntApp, Empty, Space,
} from 'antd';
import { PlusOutlined, StopOutlined } from '@ant-design/icons';
import StatusBadge from './StatusBadge';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  getMemberTrainerAssignments, listAssignableTrainers, assignTrainer, endTrainerAssignment,
  TrainerAssignment, TrainerOption,
} from '../api';

export default function MemberTrainerTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message, modal } = AntApp.useApp();
  const [assignments, setAssignments] = useState<TrainerAssignment[] | null>(null);
  const [trainers, setTrainers] = useState<TrainerOption[]>([]);
  const [error, setError] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [picked, setPicked] = useState<string | undefined>();
  const canManage = hasPermission(ctx, 'members.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const a = await getMemberTrainerAssignments(ctx!.gymId, memberId);
      setAssignments(a);
      if (canManage) setTrainers(await listAssignableTrainers(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId, canManage]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!assignments) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const current = assignments.find((a) => a.status === 'ACTIVE');

  const doAssign = async () => {
    if (!picked) { message.warning('Pick a trainer'); return; }
    try {
      await assignTrainer(ctx!.gymId, memberId, picked);
      message.success('Trainer assigned');
      setAssignOpen(false);
      setPicked(undefined);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not assign the trainer');
    }
  };

  const doEnd = (a: TrainerAssignment) => {
    modal.confirm({
      title: `End ${a.trainer_name}'s assignment?`,
      content: 'It stays in the member\u2019s history as ENDED.',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await endTrainerAssignment(ctx!.gymId, memberId, a.id);
          message.success('Assignment ended');
          load();
        } catch (e: any) {
          message.error(e.message || 'Could not end the assignment');
        }
      },
    });
  };

  const currentCard = current ? (
    <Card size="small" title="Assigned trainer" extra={<StatusBadge status="ACTIVE" />}>
      <Descriptions size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="Trainer">{current.trainer_name}</Descriptions.Item>
        <Descriptions.Item label="Since">{current.starts_on}</Descriptions.Item>
      </Descriptions>
      {canManage && (
        <Space style={{ marginTop: 12 }} wrap>
          <Button icon={<PlusOutlined />} onClick={() => setAssignOpen(true)}>Change trainer</Button>
          <Button danger icon={<StopOutlined />} onClick={() => doEnd(current)}>Unassign</Button>
        </Space>
      )}
    </Card>
  ) : (
    <Empty
      description={<Typography.Text type="secondary">
        {canManage ? 'No trainer assigned — pick a gym trainer for this member.' : 'No trainer assigned.'}
      </Typography.Text>}
    >
      {canManage && (
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAssignOpen(true)}>
          Assign trainer
        </Button>
      )}
    </Empty>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {currentCard}

      <Card size="small" title="Assignment history">
        {assignments.length === 0 ? (
          <Typography.Text type="secondary">No trainer assignments yet.</Typography.Text>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={assignments}
            columns={[
              { title: 'Trainer', dataIndex: 'trainer_name' },
              { title: 'Period', key: 'period', render: (_: any, a: TrainerAssignment) =>
                `${a.starts_on} → ${a.status === 'ACTIVE' ? 'now' : (a.ended_on || '—')}` },
              { title: 'Status', dataIndex: 'status', width: 110, render: (s: string) =>
                <StatusBadge status={s === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED'} /> },
              { title: 'Note', dataIndex: 'end_reason', render: (v: string) =>
                v ? <Tag>{v.replace(/_/g, ' ')}</Tag> : null },
            ]}
          />
        )}
      </Card>

      <Modal
        title="Assign trainer"
        open={assignOpen}
        onOk={doAssign}
        onCancel={() => setAssignOpen(false)}
        okText={current ? 'Replace' : 'Assign'}
      >
        {current && (
          <Typography.Paragraph type="warning">
            Replacing <b>{current.trainer_name}</b> — the current assignment is kept in history as ENDED.
          </Typography.Paragraph>
        )}
        <Select
          style={{ width: '100%' }}
          placeholder="Select a gym trainer"
          value={picked}
          onChange={setPicked}
          options={trainers.map((t) => ({ value: t.trainer_staff_id, label: `${t.name} (${t.email})` }))}
        />
        {trainers.length === 0 && (
          <Typography.Text type="secondary">
            No ACTIVE trainers at this gym yet — add staff with the TRAINER role first.
          </Typography.Text>
        )}
      </Modal>
    </div>
  );
}
