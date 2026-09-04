// MemberAssignmentsSection — Phase 13 UNIFIED assignment management for ONE
// member and ONE content type (WORKOUT | NUTRITION). Both member tabs render
// this component with their contentType fixed.
//
// Features (per the Phase 13 spec):
//  - direct assignment with content + start date (default: today) +
//    optional end date (inclusive) + notes
//  - window-aware status: SCHEDULED / ACTIVE / EXPIRED / ENDED (computed
//    server-side in the gym's timezone)
//  - version stamps + a "v{n} available" hint when the gym edited the
//    content after it was assigned (content_updated)
//  - end-early with history kept; edit window/notes while physically ACTIVE
//    (extending a past ends_on revives an EXPIRED assignment)
//  - permissions: OWNER/ADMIN via members.manage, TRAINER via
//    assignments.manage (roster-scoped server-side)
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Table, Tag, Modal, Select, Input, DatePicker, Typography,
  App as AntApp, Empty, Popconfirm, Space,
} from 'antd';
import { PlusOutlined, StopOutlined, EditOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  listMemberAssignments, listAssignableWorkouts, listAssignableNutrition,
  assignContent, updateAssignment, endAssignment,
  ContentAssignment, ContentType, WorkoutRow, NutritionItem,
} from '../api';

const EFFECTIVE_COLOR: Record<string, string> = {
  SCHEDULED: 'blue',
  ACTIVE: 'green',
  EXPIRED: 'orange',
  ENDED: 'default',
};

const d = (v?: string | null) => (v ? String(v).slice(0, 10) : '');

interface Props {
  memberId: string;
  contentType: ContentType;
}

export default function MemberAssignmentsSection({ memberId, contentType }: Props) {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [assignments, setAssignments] = useState<ContentAssignment[] | null>(null);
  const [assignable, setAssignable] = useState<(WorkoutRow | NutritionItem)[]>([]);
  const [error, setError] = useState<any>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // assign-modal state
  const [picked, setPicked] = useState<string | undefined>();
  const [start, setStart] = useState<Dayjs | null>(dayjs());
  const [end, setEnd] = useState<Dayjs | null>(null);
  const [notes, setNotes] = useState('');
  // edit-modal state
  const [editing, setEditing] = useState<ContentAssignment | null>(null);
  const [editStart, setEditStart] = useState<Dayjs | null>(null);
  const [editEnd, setEditEnd] = useState<Dayjs | null>(null);
  const [editNotes, setEditNotes] = useState('');

  const isWorkout = contentType === 'WORKOUT';
  const canManage = hasPermission(ctx, 'members.manage', 'assignments.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const a = await listMemberAssignments(ctx!.gymId, memberId, contentType);
      setAssignments(a);
      if (canManage) {
        setAssignable(isWorkout
          ? await listAssignableWorkouts(ctx!.gymId)
          : await listAssignableNutrition(ctx!.gymId));
      }
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId, contentType, canManage, isWorkout]);

  useEffect(() => { load(); }, [load]);

  const options = useMemo(() => assignable.map((x: any) => ({
    value: x.id,
    label: isWorkout
      ? `${x.title} — ${x.difficulty}${x.estimated_duration_minutes ? ` · ${x.estimated_duration_minutes} min` : ''}`
      : `${String(x.kind).replace(/_/g, ' ')} — ${x.title}`,
  })), [assignable, isWorkout]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!assignments) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const noun = isWorkout ? 'workout' : 'nutrition item';
  const title = isWorkout ? 'Assigned gym workouts' : 'Assigned gym nutrition';

  const openAssign = () => {
    setPicked(undefined); setStart(dayjs()); setEnd(null); setNotes('');
    setAssignOpen(true);
  };

  const doAssign = async () => {
    if (!picked) { message.warning(`Pick a ${noun}`); return; }
    if (start && end && end.isBefore(start)) {
      message.warning('End date must be on or after the start date'); return;
    }
    setSaving(true);
    try {
      await assignContent(ctx!.gymId, {
        member_id: memberId,
        content_type: contentType,
        ...(isWorkout ? { workout_id: picked } : { item_id: picked }),
        starts_on: start ? start.format('YYYY-MM-DD') : undefined,
        ends_on: end ? end.format('YYYY-MM-DD') : null,
        notes: notes.trim() || null,
      });
      message.success(`${isWorkout ? 'Workout' : 'Nutrition item'} assigned`);
      setAssignOpen(false);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not assign');
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (a: ContentAssignment) => {
    setEditing(a);
    setEditStart(a.starts_on ? dayjs(a.starts_on) : null);
    setEditEnd(a.ends_on ? dayjs(a.ends_on) : null);
    setEditNotes(a.notes || '');
  };

  const doEdit = async () => {
    if (!editing) return;
    if (editStart && editEnd && editEnd.isBefore(editStart)) {
      message.warning('End date must be on or after the start date'); return;
    }
    setSaving(true);
    try {
      await updateAssignment(ctx!.gymId, editing.id, {
        starts_on: editStart ? editStart.format('YYYY-MM-DD') : undefined,
        ends_on: editEnd ? editEnd.format('YYYY-MM-DD') : null,
        notes: editNotes.trim() || null,
      });
      message.success('Assignment updated');
      setEditing(null);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update');
    } finally {
      setSaving(false);
    }
  };

  const doEnd = async (a: ContentAssignment) => {
    try {
      await endAssignment(ctx!.gymId, a.id);
      message.success('Assignment ended');
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not end');
    }
  };

  const columns: any[] = [
    {
      title: isWorkout ? 'Workout' : 'Item',
      key: 'content',
      render: (_: any, a: ContentAssignment) => (
        <Space size={6}>
          {!isWorkout && a.item_kind && (
            <Tag color={a.item_kind === 'RECIPE' ? 'orange' : a.item_kind === 'MEAL_PLAN' ? 'blue' : 'purple'}>
              {a.item_kind.replace(/_/g, ' ')}
            </Tag>
          )}
          <Typography.Text strong>{a.content_title}</Typography.Text>
        </Space>
      ),
    },
    ...(isWorkout ? [
      { title: 'Difficulty', dataIndex: 'difficulty', width: 110 },
      { title: 'Goal', dataIndex: 'goal', width: 100 },
    ] : []),
    {
      title: 'Window', key: 'window', width: 190,
      render: (_: any, a: ContentAssignment) => {
        const s = d(a.starts_on);
        const e = d(a.ends_on);
        return <Typography.Text type="secondary">{e ? `${s} → ${e}` : `from ${s}`}</Typography.Text>;
      },
    },
    {
      title: 'Notes', dataIndex: 'notes', ellipsis: true, width: 200,
      render: (v: string | null) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: 'Ver.', key: 'ver', width: 130,
      render: (_: any, a: ContentAssignment) => (
        <Space size={4}>
          <Tag>v{a.assigned_version}</Tag>
          {a.content_updated && a.effective_status !== 'ENDED' && (
            <Tag color="gold" title="The gym updated this content after assigning it">
              v{isWorkout ? a.workout_version : a.item_version} available
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Assigned', dataIndex: 'created_at', width: 110,
      render: (v: string) => d(v),
    },
    {
      title: 'Status', key: 'status', width: 170,
      render: (_: any, a: ContentAssignment) => (
        <Space size={4}>
          <Tag color={EFFECTIVE_COLOR[a.effective_status]}>{a.effective_status}</Tag>
          {a.end_reason && <Tag>{a.end_reason.replace(/_/g, ' ')}</Tag>}
        </Space>
      ),
    },
    ...(canManage ? [{
      title: '', key: 'go', width: 150,
      render: (_: any, a: ContentAssignment) => a.status === 'ACTIVE' ? (
        <Space size={4}>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(a)}>Edit</Button>
          <Popconfirm title="End this assignment?" okButtonProps={{ danger: true }}
            onConfirm={() => doEnd(a)}>
            <Button size="small" danger icon={<StopOutlined />}>End</Button>
          </Popconfirm>
        </Space>
      ) : null,
    }] : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title={title}>
        {assignments.length === 0 ? (
          <Empty description={<Typography.Text type="secondary">
            {canManage ? `Nothing assigned yet — pick a published ${noun}.` : `No gym ${isWorkout ? 'workouts' : 'nutrition'} assigned.`}
          </Typography.Text>}>
            {canManage && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openAssign}>
                Assign {noun}
              </Button>
            )}
          </Empty>
        ) : (
          <Table rowKey="id" size="small" pagination={false}
            dataSource={assignments} columns={columns} scroll={{ x: 900 }} />
        )}
        {canManage && assignments.length > 0 && (
          <Button icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={openAssign}>
            Assign another {noun}
          </Button>
        )}
      </Card>

      <Modal title={`Assign ${noun}`} open={assignOpen} confirmLoading={saving}
        onOk={doAssign} onCancel={() => setAssignOpen(false)} okText="Assign">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Select
            style={{ width: '100%' }}
            placeholder={`Select a published ${noun}`}
            value={picked}
            onChange={setPicked}
            options={options}
          />
          <Space>
            <DatePicker placeholder="Start date" value={start} onChange={setStart} />
            <DatePicker placeholder="End date (optional)" value={end} onChange={setEnd}
              disabledDate={(cur) => (start ? cur.isBefore(start, 'day') : false)} />
          </Space>
          <Input.TextArea rows={2} maxLength={1000} showCount value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes for the member / trainer (e.g. Start with 3 sessions/week.)" />
          {!start && (
            <Typography.Text type="secondary">
              Leave the start date empty to start today (gym timezone).
            </Typography.Text>
          )}
          {options.length === 0 && (
            <Typography.Text type="secondary">
              No published {isWorkout ? 'workouts' : 'items'} — create one first.
            </Typography.Text>
          )}
        </div>
      </Modal>

      <Modal title="Edit assignment" open={!!editing} confirmLoading={saving}
        onOk={doEdit} onCancel={() => setEditing(null)} okText="Save">
        <Typography.Text type="secondary">
          {editing?.content_title} — editing the window revives an EXPIRED assignment when the end date moves into the future.
        </Typography.Text>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
          <Space>
            <DatePicker placeholder="Start date" value={editStart} onChange={setEditStart} />
            <DatePicker placeholder="End date (optional)" value={editEnd} onChange={setEditEnd}
              disabledDate={(cur) => (editStart ? cur.isBefore(editStart, 'day') : false)} />
          </Space>
          <Input.TextArea rows={2} maxLength={1000} showCount value={editNotes}
            onChange={(e) => setEditNotes(e.target.value)}
            placeholder="Notes for the member / trainer" />
        </div>
      </Modal>
    </div>
  );
}
