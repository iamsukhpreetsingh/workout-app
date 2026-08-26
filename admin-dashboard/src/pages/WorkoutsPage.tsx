import React, { useEffect, useState } from 'react';
import {
  Card, Table, Tag, Button, Statistic, message, Typography,
  Space, Tabs, Input, Alert, Descriptions,
} from 'antd';
import {
  api,
  getExercises, getCustomExercises, getTemplates,
  getSubstitutionsAudit, getSupersetIntegrity, getWorkoutContentHealth,
  ExerciseRow, CustomExerciseRow, CustomExerciseDuplicate,
  TemplateRow, SubstitutionTotals, SupersetIntegrity, ContentHealth,
} from '../api';

export default function WorkoutsPage() {
  return (
    <div>
      <Typography.Title level={4}>Workout Content</Typography.Title>
      <Tabs
        items={[
          { key: 'exercises', label: 'Exercises library', children: <ExercisesTab /> },
          { key: 'custom', label: 'Custom exercises', children: <CustomExercisesTab /> },
          { key: 'templates', label: 'Templates', children: <TemplatesTab /> },
          { key: 'subs', label: 'Substitution audit', children: <SubstitutionsTab /> },
          { key: 'supersets', label: 'Superset integrity', children: <SupersetTab /> },
          { key: 'health', label: 'Content health', children: <ContentHealthTab /> },
        ]}
      />
    </div>
  );
}

// ─────────────────────────── Exercises library ───────────────────────────
function ExercisesTab() {
  const [rows, setRows] = useState<ExerciseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [bodyPart, setBodyPart] = useState('');
  const [equipment, setEquipment] = useState('');
  const [editing, setEditing] = useState<ExerciseRow | null>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async (p = page) => {
    try {
      const r = await getExercises({ q: q || undefined, bodyPart: bodyPart || undefined, equipment: equipment || undefined, page: p, pageSize: 15 });
      setRows(r.exercises || []);
      setTotal(r.total);
      setPage(p);
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(1); }, []); // eslint-disable-line

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api(`/workout/exercises/${editing.id}`, {
        method: 'PATCH',
        body: { name: editing.name, muscle_group: editing.muscle_group },
      });
      msg.success('Exercise updated (audited)');
      setEditing(null);
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)} onSearch={() => load(1)} style={{ width: 240 }} allowClear />
        <Input placeholder="Body part" value={bodyPart} onChange={(e) => setBodyPart(e.target.value)} onPressEnter={() => load(1)} style={{ width: 140 }} allowClear />
        <Input placeholder="Equipment" value={equipment} onChange={(e) => setEquipment(e.target.value)} onPressEnter={() => load(1)} style={{ width: 140 }} allowClear />
        <Button onClick={() => load(1)}>Filter</Button>
      </Space>
      <Table<ExerciseRow>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ current: page, pageSize: 15, total, showSizeChanger: false, onChange: (p) => load(p) }}
        columns={[
          {
            title: 'Name', dataIndex: 'name',
            render: (n: string, r) => (
              <Space size={6}>
                <span>{n}</span>
                {!r.is_official && <Tag>unofficial</Tag>}
              </Space>
            ),
          },
          { title: 'Category', dataIndex: 'category', render: (v) => v || '—' },
          { title: 'Body part', dataIndex: 'body_part', render: (v) => v ? <Tag>{v}</Tag> : '—' },
          { title: 'Equipment', dataIndex: 'equipment', render: (v) => v || '—' },
          { title: 'Muscle group', dataIndex: 'muscle_group', render: (v) => v || '—' },
          {
            title: 'Actions', width: 90,
            render: (_: any, r) => <Button size="small" onClick={() => setEditing({ ...r })}>Edit</Button>,
          },
        ]}
      />
      <Modalish editing={editing} setEditing={setEditing} onSave={saveEdit} />
    </>
  );
}

function Modalish({ editing, setEditing, onSave }: {
  editing: ExerciseRow | null;
  setEditing: (r: ExerciseRow | null) => void;
  onSave: () => void;
}) {
  if (!editing) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <Card title={`Edit exercise`} style={{ width: 420 }} extra={<Button type="text" onClick={() => setEditing(null)}>×</Button>}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input addonBefore="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <Input addonBefore="Muscle" value={editing.muscle_group ?? ''} onChange={(e) => setEditing({ ...editing, muscle_group: e.target.value })} />
          <Button type="primary" onClick={onSave}>Save</Button>
        </Space>
      </Card>
    </div>
  );
}

// ─────────────────────────── Custom exercises ───────────────────────────
function CustomExercisesTab() {
  const [rows, setRows] = useState<CustomExerciseRow[]>([]);
  const [dupes, setDupes] = useState<CustomExerciseDuplicate[]>([]);
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState('');
  const [msg, contextHolder] = message.useMessage();

  const dupeNames = new Set(dupes.flatMap((d) => d.owners.map((o) => o.id)));

  const load = async () => {
    try {
      const r = await getCustomExercises({ q: q || undefined, userId: userId || undefined, pageSize: 100 });
      setRows(r.exercises || []);
      setDupes(r.potential_duplicates || []);
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <>
      {contextHolder}
      {!!dupes.length && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          message={`${dupes.length} duplicate-name clusters detected across all users`}
        />
      )}
      <Space style={{ marginBottom: 12 }}>
        <Input.Search placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)} onSearch={load} style={{ width: 220 }} allowClear />
        <Input.Search placeholder="User ID (uuid)" value={userId} onChange={(e) => setUserId(e.target.value)} onSearch={load} style={{ width: 320 }} allowClear />
      </Space>
      <Table<CustomExerciseRow>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 15 }}
        rowClassName={(r) => (dupeNames.has(r.id) ? '' : '')}
        columns={[
          {
            title: 'Name', dataIndex: 'name',
            render: (n: string, r) => (
              <Space size={6}>
                <span style={dupeNames.has(r.id) ? { color: '#ffa940', fontWeight: 600 } : undefined}>{n}</span>
                {dupeNames.has(r.id) && <Tag color="orange">possible dup</Tag>}
              </Space>
            ),
          },
          { title: 'Owner', render: (_: any, r) => <span>{r.owner_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.owner_email}</Typography.Text></span> },
          { title: 'Muscle group', dataIndex: 'muscle_group', render: (v) => v || '—' },
          { title: 'Equipment', dataIndex: 'equipment', render: (v) => v || '—' },
          { title: 'Created', dataIndex: 'created_at', render: (v) => String(v).slice(0, 10) },
        ]}
      />
      <Card size="small" title="Duplicate clusters (normalized name)" style={{ marginTop: 16 }}>
        <Table<CustomExerciseDuplicate>
          rowKey="normalized_name"
          size="small"
          dataSource={dupes}
          pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Normalized name', dataIndex: 'normalized_name' },
            { title: 'Occurrences', dataIndex: 'occurrences' },
            {
              title: 'Owners',
              dataIndex: 'owners',
              render: (owners: CustomExerciseDuplicate['owners']) => owners.map((o) => `${o.owner_name} (${o.owner_email})`).join(', '),
            },
          ]}
        />
      </Card>
    </>
  );
}

// ─────────────────────────── Templates ──────────────────────────────────
function TemplatesTab() {
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [minEx, setMinEx] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async (p = 1) => {
    try {
      const n = parseInt(minEx, 10);
      const r = await getTemplates({
        q: q || undefined, tag: tag || undefined,
        minExercises: Number.isFinite(n) ? n : undefined,
        page: p, pageSize: 15,
      });
      setRows(r.templates || []);
      setPage(p);
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search placeholder="Search template name" value={q} onChange={(e) => setQ(e.target.value)} onSearch={() => load(1)} style={{ width: 220 }} allowClear />
        <Input placeholder="Tag" value={tag} onChange={(e) => setTag(e.target.value)} onPressEnter={() => load(1)} style={{ width: 120 }} allowClear />
        <Input placeholder="Min exercises" value={minEx} onChange={(e) => setMinEx(e.target.value)} onPressEnter={() => load(1)} style={{ width: 130 }} allowClear />
        <Button onClick={() => load(1)}>Filter</Button>
      </Space>
      <Table<TemplateRow>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ current: page, pageSize: 15, onChange: (p) => load(p), showSizeChanger: false }}
        columns={[
          { title: 'Template', dataIndex: 'name' },
          { title: 'Trainer', render: (_: any, r) => <span>{r.trainer_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.trainer_email}</Typography.Text></span> },
          { title: 'Tags', dataIndex: 'tags', render: (t: string[] | null) => (t?.length ? t.map((x, i) => <Tag key={i}>{x}</Tag>) : '—') },
          { title: 'Exercises', dataIndex: 'exercise_count', width: 100 },
          { title: 'Times assigned', dataIndex: 'reuse_count', width: 120 },
          { title: 'Created', dataIndex: 'created_at', render: (v) => String(v).slice(0, 10) },
        ]}
      />

      {/* Assigned-plan drill-in is available via GET /workout/assigned-plans/:id;
          open one by ID for inspection. */}
      <Card size="small" title="Assigned plan drill-in" style={{ marginTop: 16 }}>
        <AssignedPlanLookup onLoaded={setDetail} />
        {detail && (
          <Descriptions column={1} size="small" bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label="Plan">{String(detail.name)}</Descriptions.Item>
            <Descriptions.Item label="Client">{detail.client_name} ({detail.client_email})</Descriptions.Item>
            <Descriptions.Item label="Trainer">{detail.trainer_name}</Descriptions.Item>
            <Descriptions.Item label="Exercises">
              {(detail.exercises || []).map((e: any) => (
                <div key={e.id}>
                  {e.order_index}. {e.exercise_name}
                  {e.alternatives?.length ? ` (+${e.alternatives.length} alternatives)` : ''}
                </div>
              ))}
            </Descriptions.Item>
            <Descriptions.Item label="Source template">
              {detail.template_lineage?.length ? detail.template_lineage[0].name : '—'}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>
    </>
  );
}

function AssignedPlanLookup({ onLoaded }: { onLoaded: (d: any) => void }) {
  const [id, setId] = useState('');
  const [msg, contextHolder] = message.useMessage();
  return (
    <>
      {contextHolder}
      <Space>
        <Input placeholder="Assigned plan ID (uuid)" value={id} onChange={(e) => setId(e.target.value)} style={{ width: 320 }} />
        <Button
          type="primary"
          onClick={async () => {
            try { onLoaded(await api(`/workout/assigned-plans/${id}`)); }
            catch (e: any) { msg.error(e.message); }
          }}
        >
          Load
        </Button>
      </Space>
    </>
  );
}

// ─────────────────────────── Substitutions audit ────────────────────────
function SubstitutionsTab() {
  const [totals, setTotals] = useState<SubstitutionTotals | null>(null);
  const [pairs, setPairs] = useState<any[]>([]);
  const [minCount, setMinCount] = useState('2');
  const [msg, contextHolder] = message.useMessage();

  const load = async (mc?: string) => {
    try {
      const n = parseInt(mc ?? minCount, 10);
      const r = await getSubstitutionsAudit(Number.isFinite(n) && n > 0 ? n : 1);
      setTotals(r.totals);
      setPairs(r.pairs || []);
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const maxUsed = Math.max(1, ...pairs.map((p) => p.times_used));

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }}>
        <Statistic title="Substitutions" value={totals?.substitutions ?? 0} />
        <Statistic title="Sessions affected" value={totals?.affected_sessions ?? 0} />
        <Statistic title="Clients substituting" value={totals?.clients_substituting ?? 0} />
        <Input value={minCount} onChange={(e) => setMinCount(e.target.value)} addonBefore="min count" style={{ width: 180 }} />
        <Button onClick={() => load()}>Apply</Button>
      </Space>
      <Table
        rowKey={(r: any) => `${r.original}|${r.swapped_to}`}
        size="small"
        dataSource={pairs}
        pagination={{ pageSize: 15 }}
        columns={[
          { title: 'Original', dataIndex: 'original' },
          { title: 'Swapped to', dataIndex: 'swapped_to' },
          {
            title: 'Times used', dataIndex: 'times_used',
            render: (v: number) => (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ background: '#E8481F', height: 10, width: `${Math.max(3, (v / maxUsed) * 200)}px`, borderRadius: 2 }} />
                {v}
              </div>
            ),
          },
          { title: 'Distinct clients', dataIndex: 'distinct_clients', width: 130 },
          { title: 'Last used', dataIndex: 'last_substituted_at', render: (v) => String(v).slice(0, 10) },
        ]}
      />
    </>
  );
}

// ─────────────────────────── Superset integrity ─────────────────────────
function SupersetTab() {
  const [data, setData] = useState<SupersetIntegrity | null>(null);
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    getSupersetIntegrity().then(setData).catch((e) => msg.error(e.message));
  }, []); // eslint-disable-line

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }}>
        <Statistic title="Orphaned superset rows" value={data?.total_orphans ?? 0} valueStyle={(data?.total_orphans ?? 0) > 0 ? { color: '#cf1322' } : undefined} />
        <Statistic title="Parents affected" value={data?.parents_affected ?? 0} />
      </Space>
      <Table<SupersetIntegrity['groups'][number]>
        rowKey={(g) => `${g.parent_type}:${g.parent_id}`}
        size="small"
        dataSource={data?.groups || []}
        pagination={{ pageSize: 15 }}
        columns={[
          { title: 'Parent', dataIndex: 'parent_name' },
          {
            title: 'Type', dataIndex: 'parent_type',
            render: (t) => <Tag color={t === 'template' ? 'blue' : 'purple'}>{t}</Tag>,
          },
          {
            title: 'Orphaned exercises',
            dataIndex: 'orphaned_exercises',
            render: (list: SupersetIntegrity['groups'][number]['orphaned_exercises']) =>
              list.map((e) => <Tag key={e.exercise_row_id} color="red">#{e.order_index} {e.exercise_name}</Tag>),
          },
        ]}
      />
    </>
  );
}

// ─────────────────────────── Content health ─────────────────────────────
function ContentHealthTab() {
  const [health, setHealth] = useState<ContentHealth | null>(null);
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    getWorkoutContentHealth().then(setHealth).catch((e) => msg.error(e.message));
  }, []); // eslint-disable-line

  const cols = [
    { title: 'Template', dataIndex: 'name' },
    { title: 'Trainer', dataIndex: 'trainer_name' },
    { title: 'Reuses', dataIndex: 'reuse_count', width: 90 },
  ];

  return (
    <>
      {contextHolder}
      <div style={{ marginBottom: 16 }}>
        <Statistic title="Most-used vs least-used templates (top 5 each)" value={undefined as any} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card size="small" title="Most used (top 5)">
          <Table size="small" rowKey="id" pagination={false} dataSource={health?.most_used || []} columns={cols} />
        </Card>
        <Card size="small" title="Least used (dead-content candidates)">
          <Table size="small" rowKey="id" pagination={false} dataSource={health?.least_used || []} columns={cols} />
        </Card>
      </div>
    </>
  );
}
