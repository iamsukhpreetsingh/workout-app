// Member's Workouts tab — gym workouts assigned to this member (works with
// or without an app account). Version-aware: shows which version each
// assignment points at.
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Table, Tag, Modal, Select, Typography, App as AntApp, Empty, Popconfirm, Space } from 'antd';
import { PlusOutlined, StopOutlined } from '@ant-design/icons';
import StatusBadge from './StatusBadge';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  listMemberWorkoutAssignments, listAssignableWorkouts, assignWorkout, endWorkoutAssignment,
  WorkoutAssignment, WorkoutRow,
} from '../api';

export default function MemberWorkoutsTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [assignments, setAssignments] = useState<WorkoutAssignment[] | null>(null);
  const [workouts, setWorkouts] = useState<WorkoutRow[]>([]);
  const [error, setError] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [picked, setPicked] = useState<string | undefined>();
  const canManage = hasPermission(ctx, 'members.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const a = await listMemberWorkoutAssignments(ctx!.gymId, memberId);
      setAssignments(a);
      if (canManage) setWorkouts(await listAssignableWorkouts(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId, canManage]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!assignments) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const doAssign = async () => {
    if (!picked) { message.warning('Pick a workout'); return; }
    try {
      await assignWorkout(ctx!.gymId, memberId, picked);
      message.success('Workout assigned');
      setAssignOpen(false);
      setPicked(undefined);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not assign');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title="Assigned gym workouts">
        {assignments.length === 0 ? (
          <Empty description={<Typography.Text type="secondary">
            {canManage ? 'Nothing assigned yet — pick a published workout.' : 'No gym workouts assigned.'}
          </Typography.Text>}>
            {canManage && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setAssignOpen(true)}>
                Assign workout
              </Button>
            )}
          </Empty>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={assignments}
            columns={[
              { title: 'Workout', dataIndex: 'workout_title' },
              { title: 'Difficulty', dataIndex: 'difficulty', width: 110 },
              { title: 'Goal', dataIndex: 'goal', width: 100 },
              { title: 'Version', dataIndex: 'workout_version', width: 80, render: (v: number) => <Tag>v{v}</Tag> },
              { title: 'Assigned', dataIndex: 'created_at', width: 120, render: (v: string) => String(v).slice(0, 10) },
              { title: 'Status', key: 'status', width: 170, render: (_: any, a: WorkoutAssignment) => (
                <Space>
                  <StatusBadge status={a.status === 'ACTIVE' ? 'ACTIVE' : 'EXPIRED'} />
                  {a.end_reason && <Tag>{a.end_reason.replace(/_/g, ' ')}</Tag>}
                </Space>
              ) },
              ...(canManage ? [{
                title: '', key: 'go', width: 110, render: (_: any, a: WorkoutAssignment) =>
                  a.status === 'ACTIVE' ? (
                    <Popconfirm title="End this assignment?" okButtonProps={{ danger: true }}
                      onConfirm={async () => {
                        try {
                          await endWorkoutAssignment(ctx!.gymId, memberId, a.id);
                          message.success('Assignment ended');
                          load();
                        } catch (e: any) { message.error(e.message || 'Could not end'); }
                      }}>
                      <Button size="small" danger icon={<StopOutlined />}>End</Button>
                    </Popconfirm>
                  ) : null,
              }] : []),
            ]}
          />
        )}
        {canManage && assignments.length > 0 && (
          <Button icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={() => setAssignOpen(true)}>
            Assign another workout
          </Button>
        )}
      </Card>

      <Modal title="Assign workout" open={assignOpen} onOk={doAssign} onCancel={() => setAssignOpen(false)} okText="Assign">
        <Select
          style={{ width: '100%' }}
          placeholder="Select a published workout"
          value={picked}
          onChange={setPicked}
          options={workouts.map((w) => ({
            value: w.id,
            label: `${w.title} — ${w.difficulty}${w.estimated_duration_minutes ? ` · ${w.estimated_duration_minutes} min` : ''}`,
          }))}
        />
        {workouts.length === 0 && (
          <Typography.Text type="secondary">No published workouts — create one first.</Typography.Text>
        )}
      </Modal>
    </div>
  );
}
