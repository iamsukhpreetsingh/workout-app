// Nutrition — gym-owned content (Phase 12): recipes, meal plans and diet
// recommendations with versioned originals, direct-assignment counts and
// save counts. Mirrors the Workouts page.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Checkbox, Drawer, Form, Input, InputNumber, Select, Tag, App as AntApp,
  Popconfirm, Space, Typography,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { useGymContext, hasPermission } from '../permissions';
import { listNutrition, createNutritionItem, updateNutritionItem, NutritionItem } from '../api';

const KINDS = ['RECIPE', 'MEAL_PLAN', 'DIET_RECOMMENDATION'];
const KIND_COLORS: Record<string, string> = {
  RECIPE: 'orange', MEAL_PLAN: 'blue', DIET_RECOMMENDATION: 'purple',
};

export default function NutritionPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<NutritionItem[] | null>(null);
  const [error, setError] = useState<any>(null);
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<NutritionItem | null>(null);
  const [form] = Form.useForm();
  const canManage = hasPermission(ctx, 'content.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await listNutrition(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (kindFilter && r.kind !== kindFilter) return false;
      if (statusFilter && r.status !== statusFilter) return false;
      if (needle && !`${r.title} ${r.description || ''} ${(r.tags || []).join(' ')}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows, q, kindFilter, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ kind: 'MEAL_PLAN', status: 'DRAFT', content: { entries: [''] } });
    setDrawerOpen(true);
  };

  const openEdit = (item: NutritionItem) => {
    setEditing(item);
    form.setFieldsValue({
      kind: item.kind, title: item.title, description: item.description || undefined,
      targets: {
        calories: item.targets?.calories ?? undefined,
        protein_g: item.targets?.protein_g ?? undefined,
        carbs_g: item.targets?.carbs_g ?? undefined,
        fat_g: item.targets?.fat_g ?? undefined,
      },
      tags: item.tags || [], status: item.status,
      recommended: item.recommended,
      content: { entries: (item.content?.entries || []).length ? item.content.entries : [''] },
    });
    setDrawerOpen(true);
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      const payload = {
        ...v,
        content: { entries: (v.content?.entries || []).filter((e: string) => e && e.trim()) },
      };
      if (editing) {
        const updated = await updateNutritionItem(ctx!.gymId, editing.id, payload);
        message.success(`Saved — now version ${updated.version}. Member saves keep their snapshot until they update.`);
      } else {
        await createNutritionItem(ctx!.gymId, payload);
        message.success('Created');
      }
      setDrawerOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not save');
    }
  };

  const setStatus = async (item: NutritionItem, status: string) => {
    try {
      await updateNutritionItem(ctx!.gymId, item.id, { status });
      message.success(status === 'ARCHIVED'
        ? 'Archived — existing assignments remain; new assignments are blocked'
        : 'Updated');
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update');
    }
  };

  const columns = [
    { title: 'Item', key: 'title', render: (_: any, n: NutritionItem) => (
      <div>
        <Space size={6}>
          <Tag color={KIND_COLORS[n.kind]}>{n.kind.replace(/_/g, ' ')}</Tag>
          <Typography.Text strong>{n.title}</Typography.Text>
          {n.recommended && <Tag color="gold">Recommended</Tag>}
        </Space>
        {n.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{n.description}</div>}
      </div>
    ) },
    { title: 'Targets', key: 'targets', render: (_: any, n: NutritionItem) => {
      const t = n.targets;
      if (!t || !Object.keys(t).length) return '—';
      return Object.entries(t).map(([k, v]) => `${k.replace('_g', 'g')}: ${v}`).join(' · ');
    } },
    { title: 'Entries', key: 'entries', width: 80, render: (_: any, n: NutritionItem) =>
      (n.content?.entries || []).length },
    { title: 'Tags', dataIndex: 'tags', render: (tags: string[]) =>
      (tags || []).map((t) => <Tag key={t}>{t}</Tag>) },
    { title: 'Assigned', dataIndex: 'assigned_count', width: 90 },
    { title: 'Saves', dataIndex: 'saves_count', width: 80 },
    { title: 'Ver.', dataIndex: 'version', width: 60 },
    { title: 'Status', dataIndex: 'status', width: 110, render: (s: string) => <StatusBadge status={s} /> },
    ...(canManage ? [{
      title: '', key: 'actions', width: 170, render: (_: any, n: NutritionItem) => (
        <span>
          <Button size="small" style={{ marginRight: 8 }} onClick={() => openEdit(n)}>Edit</Button>
          <Popconfirm
            title={n.status === 'ARCHIVED' ? 'Restore this item?' : 'Archive this item?'}
            onConfirm={() => setStatus(n, n.status === 'ARCHIVED' ? 'PUBLISHED' : 'ARCHIVED')}>
            <Button size="small" danger={n.status !== 'ARCHIVED'}>
              {n.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
            </Button>
          </Popconfirm>
        </span>
      ),
    }] : []),
  ];

  return (
    <PageContainer
      title="Nutrition"
      subtitle="Gym-owned recipes, meal plans and diet recommendations — versioned; member saves keep their snapshot."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Nutrition' }]}
    >
      <DataTable<NutritionItem>
        columns={columns as any}
        rows={filtered}
        rowKey={(n) => n.id}
        loading={rows === null}
        error={error}
        onRetry={load}
        emptyTitle="No nutrition content yet"
        emptyDescription={q || kindFilter || statusFilter
          ? 'No items match the current filters.'
          : 'Create a meal plan, recipe or diet recommendation.'}
        emptyAction={canManage && !q ? (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Create item</Button>
        ) : undefined}
        page={0}
        pageSize={filtered.length || 1}
        hasNext={false}
        onPageChange={() => {}}
        onRow={(n) => ({ style: { cursor: canManage ? 'pointer' : 'default' },
          onClick: () => { if (canManage) openEdit(n); } })}
        toolbar={
          <FilterBar
            searchPlaceholder="Search nutrition content…"
            q={q}
            onQ={setQ}
            filter={{
              placeholder: 'Kind',
              value: kindFilter,
              onChange: setKindFilter,
              options: KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') })),
            }}
            secondFilter={{
              placeholder: 'Status',
              value: statusFilter,
              onChange: setStatusFilter,
              options: ['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => ({ value: s, label: s })),
            }}
            extra={canManage && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>Create item</Button>
            )}
          />
        }
      />

      <Drawer
        title={editing ? `${editing.title} (v${editing.version})` : 'Create nutrition item'}
        width={560}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={<Button type="primary" onClick={submit}>{editing ? 'Save' : 'Create'}</Button>}
      >
        <Form form={form} layout="vertical">
          <Space wrap>
            <Form.Item name="kind" label="Kind" initialValue="MEAL_PLAN" rules={[{ required: true }]}>
              <Select options={KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))} style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="status" label="Status" initialValue="DRAFT" rules={[{ required: true }]}>
              <Select options={['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => ({ value: s, label: s }))} style={{ width: 130 }} />
            </Form.Item>
          </Space>
          <Form.Item name="title" label="Title" rules={[{ required: true, message: 'Title is required' }]}>
            <Input placeholder="Muscle Gain Plan" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Typography.Title level={5}>Nutrition targets (optional)</Typography.Title>
          <Space wrap>
            <Form.Item name={['targets', 'calories']} label="kcal">
              <InputNumber min={0} max={100000} style={{ width: 100 }} />
            </Form.Item>
            <Form.Item name={['targets', 'protein_g']} label="Protein g">
              <InputNumber min={0} max={100000} style={{ width: 90 }} />
            </Form.Item>
            <Form.Item name={['targets', 'carbs_g']} label="Carbs g">
              <InputNumber min={0} max={100000} style={{ width: 90 }} />
            </Form.Item>
            <Form.Item name={['targets', 'fat_g']} label="Fat g">
              <InputNumber min={0} max={100000} style={{ width: 90 }} />
            </Form.Item>
          </Space>
          <Typography.Title level={5}>Entries (lines shown to members)</Typography.Title>
          <Form.List name={['content', 'entries']}>
            {(fields, { add, remove }) => (
              <>
                {fields.map((field) => (
                  <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                    <Form.Item name={[field.name]} noStyle>
                      <Input placeholder="Day 1 breakfast: oatmeal, 6 eggs…" style={{ width: '80%' }} />
                    </Form.Item>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                  </Space>
                ))}
                <Button type="dashed" icon={<PlusOutlined />} block onClick={() => add('')}>
                  Add entry
                </Button>
              </>
            )}
          </Form.List>
          <Form.Item name="tags" label="Tags">
            <Select mode="tags" placeholder="high-protein, cut…" />
          </Form.Item>
          <Form.Item name="recommended" valuePropName="checked">
            <Checkbox>Recommend to all eligible app-connected members</Checkbox>
          </Form.Item>
        </Form>
      </Drawer>
    </PageContainer>
  );
}
