// Workouts — gym-owned content (Phase 11): create/edit/archive with an
// ordered exercise editor (stored by name — catalog-independent), versioned
// originals, direct-assignment counts and save counts.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Checkbox, Drawer, Form, Input, InputNumber, Select, Tag, App as AntApp, Popconfirm,
  Space, Typography,
} from 'antd';
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { useGymContext, hasPermission } from '../permissions';
import {
  listWorkouts, createWorkout, updateWorkout, getWorkout, WorkoutRow,
} from '../api';

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'].map((v) => ({ value: v, label: v }));
const GOALS = ['strength', 'fat_loss', 'endurance', 'mobility', 'general'].map((v) => ({ value: v, label: v }));

export default function WorkoutsPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<WorkoutRow[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<WorkoutRow | null>(null);
  const [form] = Form.useForm();
  const canManage = hasPermission(ctx, 'content.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await listWorkouts(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (needle && !`${r.title} ${r.description || ''} ${(r.tags || []).join(' ')}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, q, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ difficulty: 'beginner', goal: 'general', status: 'DRAFT', exercises: [{}] });
    setDrawerOpen(true);
  };

  const openEdit = async (w: WorkoutRow) => {
    try {
      const full = await getWorkout(ctx!.gymId, w.id);
      setEditing(full);
      form.setFieldsValue({
        title: full.title, description: full.description || undefined,
        difficulty: full.difficulty, goal: full.goal,
        estimated_duration_minutes: full.estimated_duration_minutes ?? undefined,
        tags: full.tags || [], status: full.status,
        exercises: (full.exercises || []).map((e: any) => ({ ...e })),
      });
      setDrawerOpen(true);
    } catch (e: any) {
      message.error(e.message || 'Could not load the workout');
    }
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      if (editing) {
        const updated = await updateWorkout(ctx!.gymId, editing.id, v);
        message.success(`Saved — now version ${updated.version}. Member saves keep their snapshot until they update.`);
      } else {
        await createWorkout(ctx!.gymId, v);
        message.success('Workout created');
      }
      setDrawerOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not save the workout');
    }
  };

  const setStatus = async (w: WorkoutRow, status: string) => {
    try {
      await updateWorkout(ctx!.gymId, w.id, { status });
      message.success(status === 'ARCHIVED'
        ? 'Archived — existing assignments remain; new assignments are blocked'
        : 'Workout updated');
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update');
    }
  };

  const columns = [
    { title: 'Workout', key: 'title', render: (_: any, w: WorkoutRow) => (
      <div>
        <Space size={6}>
          <ThunderboltOutlined style={{ color: '#E8481F' }} />
          <Typography.Text strong>{w.title}</Typography.Text>
          {w.recommended && <Tag color="gold">Recommended</Tag>}
        </Space>
        {w.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{w.description}</div>}
      </div>
    ) },
    { title: 'Difficulty', dataIndex: 'difficulty', width: 110 },
    { title: 'Goal', dataIndex: 'goal', width: 100 },
    { title: 'Exercises', dataIndex: 'exercise_count', width: 100 },
    { title: '~Minutes', dataIndex: 'estimated_duration_minutes', width: 90, render: (v: number) => v || '—' },
    { title: 'Tags', dataIndex: 'tags', render: (tags: string[]) =>
      (tags || []).map((t) => <Tag key={t}>{t}</Tag>) },
    { title: 'Assigned', dataIndex: 'assigned_count', width: 90 },
    { title: 'Saves', dataIndex: 'saves_count', width: 80 },
    { title: 'Ver.', dataIndex: 'version', width: 60 },
    { title: 'Status', dataIndex: 'status', width: 110, render: (s: string) => <StatusBadge status={s} /> },
    ...(canManage ? [{
      title: '', key: 'actions', width: 170, render: (_: any, w: WorkoutRow) => (
        <span>
          <Button size="small" style={{ marginRight: 8 }} onClick={() => openEdit(w)}>Edit</Button>
          <Popconfirm
            title={w.status === 'ARCHIVED' ? 'Restore this workout?' : 'Archive this workout?'}
            description={w.status !== 'ARCHIVED' ? 'Existing assignments remain; new assignments are blocked.' : undefined}
            onConfirm={() => setStatus(w, w.status === 'ARCHIVED' ? 'PUBLISHED' : 'ARCHIVED')}>
            <Button size="small" danger={w.status !== 'ARCHIVED'}>
              {w.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
            </Button>
          </Popconfirm>
        </span>
      ),
    }] : []),
  ];

  return (
    <PageContainer
      title="Workouts"
      subtitle="Gym-owned training content — separate from personal and trainer workouts. Versioned: member saves keep their snapshot."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Workouts' }]}
    >
      <DataTable<WorkoutRow>
        columns={columns as any}
        rows={filtered}
        rowKey={(w) => w.id}
        loading={rows === null}
        error={error}
        onRetry={load}
        emptyTitle="No workouts yet"
        emptyDescription={q || statusFilter
          ? 'No workouts match the current search or filter.'
          : 'Create your first workout, e.g. Beginner Strength — squats, bench, plank.'}
        emptyAction={canManage && !q && !statusFilter ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Create workout</Button>
        ) : undefined}
        page={0}
        pageSize={filtered.length || 1}
        hasNext={false}
        onPageChange={() => {}}
        onRow={(w) => ({ style: { cursor: canManage ? 'pointer' : 'default' },
          onClick: () => { if (canManage) openEdit(w); } })}
        toolbar={
          <FilterBar
            searchPlaceholder="Search workouts…"
            q={q}
            onQ={setQ}
            filter={{
              placeholder: 'Status',
              value: statusFilter,
              onChange: setStatusFilter,
              options: ['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => ({ value: s, label: s })),
            }}
            extra={canManage && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Create workout</Button>
            )}
          />
        }
      />

      <Drawer
        title={editing ? `${editing.title} (v${editing.version})` : 'Create workout'}
        width={560}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" onClick={submit}>{editing ? 'Save' : 'Create'}</Button>}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="Title" rules={[{ required: true, message: 'Title is required' }]}>
            <Input placeholder="Beginner Strength" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Space wrap>
            <Form.Item name="difficulty" label="Difficulty" initialValue="beginner" rules={[{ required: true }]}>
              <Select options={DIFFICULTIES} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="goal" label="Goal" initialValue="general" rules={[{ required: true }]}>
              <Select options={GOALS} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="estimated_duration_minutes" label="Duration (min)">
              <InputNumber min={1} max={600} precision={0} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item name="status" label="Status" initialValue="DRAFT" rules={[{ required: true }]}>
              <Select options={['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => ({ value: s, label: s }))} style={{ width: 130 }} />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label="Tags">
            <Select mode="tags" placeholder="strength, full-body…" />
          </Form.Item>
          <Form.Item name="recommended" label="Recommend to all eligible members" valuePropName="checked">
            <Checkbox>General recommendation (visible to all app-connected members with an active membership)</Checkbox>
          </Form.Item>

          <Typography.Title level={5}>Exercises (by name — catalog-independent)</Typography.Title>
          <Form.List name="exercises">
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" wrap style={{ display: 'flex', marginBottom: 4 }}>
                    <Form.Item name={[field.name, 'exercise_name']}
                      rules={[{ required: true, message: 'Name required' }]} noStyle>
                      <Input placeholder="Exercise name" style={{ width: 200 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'sets']} noStyle>
                      <InputNumber min={1} max={50} placeholder="sets" style={{ width: 70 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'reps']} noStyle>
                      <Input placeholder="reps (8-12)" style={{ width: 90 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'duration_minutes']} noStyle>
                      <InputNumber min={1} max={300} placeholder="min" style={{ width: 70 }} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'notes']} noStyle>
                      <Input placeholder="notes" style={{ width: 140 }} />
                    </Form.Item>
                    <Button type="text" danger icon={<DeleteOutlined />}
                      onClick={() => remove(field.name)} />
                  </Space>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => add()}>
                  Add exercise
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Drawer>
    </PageContainer>
  );
}
