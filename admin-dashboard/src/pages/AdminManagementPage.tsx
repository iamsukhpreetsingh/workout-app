import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Collapse, Descriptions, Drawer, Form, Input, InputNumber,
  Modal, Popconfirm, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag,
  Typography, message,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  api, getProfile, resetUserPassword,
  getMgmtFormulas, setMgmtFormulaParams, resetMgmtFormulaParams, previewMgmtFormula,
  getMgmtExercises, createMgmtExercise, patchMgmtExercise, getMgmtExerciseUsage, archiveMgmtExercise,
  getMgmtUsers, getMgmtUserOverview, getMgmtUserDomainData,
  MgmtFormula, MgmtFormulaPreview, MgmtExercise, MgmtExerciseUsage,
  MgmtUser, MgmtUserOverview, MgmtUserDomain,
} from '../api';

const PAGE_SIZE = 15;

export default function AdminManagementPage() {
  const isSuper = getProfile()?.role === 'super_admin';
  return (
    <div>
      <Typography.Title level={4}>Admin Management</Typography.Title>
      {!isSuper && (
        <Alert
          type="info" showIcon style={{ marginBottom: 12 }}
          message="Read-only view — mutations (global formula params, exercise create/edit/archive) require super_admin."
        />
      )}
      <Tabs
        items={[
          { key: 'formulas', label: 'Progression Formulas', children: <FormulasTab isSuper={isSuper} /> },
          { key: 'exercises', label: 'Exercise Library', children: <ExercisesTab isSuper={isSuper} /> },
          { key: 'users', label: 'Users', children: <UsersTab /> },
        ]}
      />
    </div>
  );
}

// ─────────────────────── Progression Formulas ───────────────────────────
function FormulasTab({ isSuper }: { isSuper: boolean }) {
  const [rows, setRows] = useState<MgmtFormula[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MgmtFormula | null>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async () => {
    setLoading(true);
    try {
      const r = await getMgmtFormulas();
      setRows(r.formulas || []);
    } catch (e: any) { msg.error(e.message); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <>
      {contextHolder}
      <Table<MgmtFormula>
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: 'Formula', dataIndex: 'displayName', width: 200 },
          {
            title: 'Description', dataIndex: 'description',
            render: (d: string) => (
              <Typography.Text type="secondary" ellipsis={{ tooltip: d }} style={{ maxWidth: 360 }}>
                {d}
              </Typography.Text>
            ),
          },
          { title: 'Users configured', dataIndex: 'usersConfigured', width: 130 },
          {
            title: 'Override status', dataIndex: 'hasGlobalOverride', width: 150,
            render: (v: boolean) => (v ? <Tag color="orange">Global override</Tag> : <Tag>Defaults</Tag>),
          },
          {
            title: 'Updated', dataIndex: 'updatedAt', width: 160,
            render: (v: string | null, r) => (
              <span>
                {v ? String(v).slice(0, 10) : '—'}
                {r.updatedBy ? <><br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>by {r.updatedBy}</Typography.Text></> : null}
              </span>
            ),
          },
          {
            title: 'Actions', width: 170,
            render: (_: any, r) => (
              <Space>
                <Button size="small" disabled={!isSuper} onClick={() => setEditing(r)}>Edit</Button>
                {isSuper && r.hasGlobalOverride && (
                  <Popconfirm
                    title={`Reset "${r.displayName}" to built-in defaults?`}
                    description="The global override is deleted; all users without a specific setting fall back to schema defaults."
                    okText="Reset"
                    okButtonProps={{ danger: true }}
                    onConfirm={async () => {
                      try {
                        await resetMgmtFormulaParams(r.key);
                        msg.success('Reset to built-in defaults');
                        load();
                      } catch (e: any) { msg.error(e.message); }
                    }}
                  >
                    <Button size="small" danger ghost>Reset to defaults</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <FormulaEditModal
          key={editing.key}
          formula={editing}
          isSuper={isSuper}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </>
  );
}

function FormulaEditModal({ formula, isSuper, onClose, onSaved }: {
  formula: MgmtFormula;
  isSuper: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [preview, setPreview] = useState<MgmtFormulaPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [msg, contextHolder] = message.useMessage();

  const initialValues = useMemo(() => {
    const vals: Record<string, number | boolean> = {};
    formula.paramSchema.forEach((s) => {
      vals[s.key] =
        formula.globalParams && s.key in formula.globalParams
          ? (formula.globalParams[s.key] as number | boolean)
          : s.default;
    });
    return vals;
  }, [formula]);

  const runPreview = async () => {
    try {
      setPreviewing(true);
      const values = await form.validateFields();
      setPreview(await previewMgmtFormula(formula.key, values));
    } catch (e: any) { if (e?.message) msg.error(e.message); }
    setPreviewing(false);
  };

  // Show the side-by-side block immediately with the prefilled values.
  useEffect(() => { runPreview(); }, []); // eslint-disable-line

  const save = async () => {
    let values: Record<string, number | boolean>;
    try { values = await form.validateFields(); } catch { return; }
    Modal.confirm({
      title: `Save GLOBAL parameters for "${formula.displayName}"?`,
      content: 'These values become the global default for this formula.',
      okText: 'Save global params',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await setMgmtFormulaParams(formula.key, values);
          msg.success('Global parameters saved');
          onSaved();
        } catch (e: any) { msg.error(e.message); }
      },
    });
  };

  return (
    <Modal
      open
      title={`Edit global params — ${formula.displayName}`}
      onCancel={onClose}
      width={720}
      footer={[
        <Button key="cancel" onClick={onClose}>Cancel</Button>,
        <Button key="save" type="primary" danger disabled={!isSuper} onClick={save}>
          Save global params
        </Button>,
      ]}
    >
      {contextHolder}
      <Alert
        type="warning" showIcon style={{ marginBottom: 16 }}
        message="This formula is GLOBAL — changes affect all users who don't have a specific trainer/user setting."
      />
      <Form form={form} layout="vertical" initialValues={initialValues}>
        {formula.paramSchema.map((s) => (
          <Form.Item
            key={s.key}
            name={s.key}
            label={
              <Space size={6}>
                {s.label}
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  ({s.type}{formula.globalParams && s.key in formula.globalParams ? ', overridden' : `, default ${String(s.default)}`})
                </Typography.Text>
              </Space>
            }
            valuePropName={s.type === 'boolean' ? 'checked' : undefined}
          >
            {s.type === 'boolean' ? (
              <Switch disabled={!isSuper} />
            ) : (
              <InputNumber
                style={{ width: 180 }}
                min={s.min}
                max={s.max}
                disabled={!isSuper}
              />
            )}
          </Form.Item>
        ))}
      </Form>
      <Card
        size="small"
        title="Preview — effective params"
        extra={<Button size="small" onClick={runPreview} loading={previewing}>Re-run preview</Button>}
      >
        {!preview ? (
          <Spin size="small" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Card type="inner" size="small" title="Current effective">
              <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(preview.currentEffective, null, 2)}</pre>
            </Card>
            <Card type="inner" size="small" title="Proposed effective">
              <pre style={{ margin: 0, fontSize: 12 }}>{JSON.stringify(preview.proposedEffective, null, 2)}</pre>
            </Card>
          </div>
        )}
      </Card>
    </Modal>
  );
}

// ─────────────────────────── Exercise Library ───────────────────────────
function ExercisesTab({ isSuper }: { isSuper: boolean }) {
  const [rows, setRows] = useState<MgmtExercise[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [bodyPart, setBodyPart] = useState<string | undefined>();
  const [bodyParts, setBodyParts] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MgmtExercise | null>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async (p = page) => {
    setLoading(true);
    try {
      const r = await getMgmtExercises({
        q: q || undefined,
        body_part: bodyPart || undefined,
        archived: showArchived ? undefined : false, // off → active only; on → include archived
        page: p,
        pageSize: PAGE_SIZE,
      });
      setRows(r.exercises || []);
      setTotal(r.total);
      setPage(p);
    } catch (e: any) { msg.error(e.message); }
    setLoading(false);
  };

  // Derive body-part filter options from a wide sample of the data.
  useEffect(() => {
    getMgmtExercises({ pageSize: 200 })
      .then((r) => {
        const set = new Set<string>();
        (r.exercises || []).forEach((e) => { if (e.body_part) set.add(e.body_part); });
        setBodyParts([...set].sort());
      })
      .catch(() => {});
  }, []);

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)}
          onSearch={() => load(1)} style={{ width: 240 }} allowClear
        />
        <Select
          allowClear placeholder="Body part" value={bodyPart}
          onChange={(v) => { setBodyPart(v); }}
          options={bodyParts.map((b) => ({ value: b, label: b }))}
          style={{ width: 150 }}
        />
        <span>
          <Switch checked={showArchived} onChange={(v) => setShowArchived(v)} />{' '}
          <Typography.Text type="secondary">Show archived</Typography.Text>
        </span>
        <Button onClick={() => load(1)} loading={loading}>Filter</Button>
        {isSuper && <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>Add Exercise</Button>}
      </Space>
      <Table<MgmtExercise>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        rowClassName={(r) => (r.is_archived ? 'mgmt-archived-row' : '')}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: (p) => load(p) }}
        columns={[
          {
            title: 'Name', dataIndex: 'name',
            render: (n: string, r) => (
              <Space size={6}>
                <span style={r.is_archived ? { textDecoration: 'line-through', color: '#999' } : undefined}>{n}</span>
                {r.is_archived && <Tag color="red">archived</Tag>}
              </Space>
            ),
          },
          { title: 'Category', dataIndex: 'category', render: (v) => v || '—' },
          { title: 'Body part', dataIndex: 'body_part', render: (v) => (v ? <Tag>{v}</Tag> : '—') },
          { title: 'Equipment', dataIndex: 'equipment', render: (v) => v || '—' },
          { title: 'Muscle group', dataIndex: 'muscle_group', render: (v) => v || '—' },
          { title: 'Target', dataIndex: 'target', render: (v) => v || '—' },
          { title: 'Updated', dataIndex: 'updated_at', width: 100, render: (v) => String(v).slice(0, 10) },
          {
            title: 'Actions', width: 240,
            render: (_: any, r) => (
              <Space>
                {isSuper && !r.is_archived && <Button size="small" onClick={() => setEditing(r)}>Edit</Button>}
                {isSuper && !r.is_archived && (
                  <Popconfirm
                    title={`Archive "${r.name}"?`}
                    description={<ArchiveUsageContent id={r.id} />}
                    okText="Archive"
                    okButtonProps={{ danger: true }}
                    onConfirm={async () => {
                      try {
                        await archiveMgmtExercise(r.id);
                        msg.success('Archived (soft) — history preserved');
                        load();
                      } catch (e: any) { msg.error(e.message); }
                    }}
                  >
                    <Button size="small" danger ghost>Archive</Button>
                  </Popconfirm>
                )}
                {isSuper && r.is_archived && (
                  <Popconfirm
                    title={`Restore "${r.name}"?`}
                    okText="Restore"
                    onConfirm={async () => {
                      try {
                        await archiveMgmtExercise(r.id, true);
                        msg.success('Restored');
                        load();
                      } catch (e: any) { msg.error(e.message); }
                    }}
                  >
                    <Button size="small">Restore</Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      {adding && (
        <ExerciseModal
          mode="create"
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(1); }}
        />
      )}
      {editing && (
        <ExerciseModal
          key={editing.id}
          mode="edit"
          exercise={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </>
  );
}

// Fetches and shows usage counts inside the Archive Popconfirm.
function ArchiveUsageContent({ id }: { id: string }) {
  const [usage, setUsage] = useState<MgmtExerciseUsage['usage'] | null>(null);
  useEffect(() => {
    getMgmtExerciseUsage(id)
      .then((r) => setUsage(r.usage))
      .catch(() => setUsage(null));
  }, [id]);
  if (!usage) return <Spin size="small" />;
  return (
    <span>
      Used in {usage.workout_templates} templates, {usage.assigned_plans} plans,{' '}
      {usage.historical_session_records} historical records. History is preserved.
    </span>
  );
}

function ExerciseModal({ mode, exercise, onClose, onSaved }: {
  mode: 'create' | 'edit';
  exercise?: MgmtExercise;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [msg, contextHolder] = message.useMessage();

  const save = async () => {
    let values: any;
    try { values = await form.validateFields(); } catch { return; }
    setSaving(true);
    try {
      if (mode === 'create') {
        await createMgmtExercise(values);
        msg.success('Exercise created');
      } else if (exercise) {
        await patchMgmtExercise(exercise.id, values);
        msg.success('Exercise updated');
      }
      onSaved();
    } catch (e: any) { msg.error(e.message); }
    setSaving(false);
  };

  return (
    <Modal
      open
      title={mode === 'create' ? 'Add Exercise' : `Edit — ${exercise?.name}`}
      onCancel={onClose}
      onOk={save}
      confirmLoading={saving}
      okText={mode === 'create' ? 'Create' : 'Save'}
      destroyOnClose
    >
      {contextHolder}
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={
          mode === 'edit' && exercise
            ? {
                body_part: exercise.body_part ?? undefined,
                equipment: exercise.equipment ?? undefined,
                category: exercise.category ?? undefined,
                muscle_group: exercise.muscle_group ?? undefined,
                target: exercise.target ?? undefined,
              }
            : {}
        }
      >
        {mode === 'create' && (
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
            <Input placeholder="Official exercise name" />
          </Form.Item>
        )}
        <Form.Item name="body_part" label="Body part"><Input /></Form.Item>
        <Form.Item name="equipment" label="Equipment"><Input /></Form.Item>
        <Form.Item name="category" label="Category"><Input /></Form.Item>
        <Form.Item name="muscle_group" label="Muscle group"><Input /></Form.Item>
        <Form.Item name="target" label="Target"><Input /></Form.Item>
        {mode === 'create' && (
          <Form.Item name="attribution" label="Attribution"><Input placeholder="Source / credit" /></Form.Item>
        )}
      </Form>
    </Modal>
  );
}

// ─────────────────────────────── Users ──────────────────────────────────
const USER_DOMAINS: { key: MgmtUserDomain; label: string }[] = [
  { key: 'workouts', label: 'Workouts' },
  { key: 'custom-exercises', label: 'Custom Exercises' },
  { key: 'diets', label: 'Diets' },
  { key: 'dishes', label: 'Dishes' },
  { key: 'recipes', label: 'Recipes' },
  { key: 'supplements', label: 'Supplements' },
  { key: 'nutrition', label: 'Nutrition logs' },
  { key: 'progression', label: 'Progression' },
  { key: 'analytics', label: 'Analytics' },
];

function UsersTab() {
  const [rows, setRows] = useState<MgmtUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState<'active' | 'suspended' | undefined>();
  const [role, setRole] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [msg, contextHolder] = message.useMessage();

  // Debounce search input by 400ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400);
    return () => clearTimeout(t);
  }, [q]);

  const load = async (p = 1) => {
    setLoading(true);
    try {
      const r = await getMgmtUsers({
        q: debouncedQ || undefined,
        status,
        role: role || undefined,
        page: p,
        pageSize: PAGE_SIZE,
      });
      setRows(r.users || []);
      setTotal(r.total);
      setPage(r.page || p);
    } catch (e: any) { msg.error(e.message); }
    setLoading(false);
  };
  useEffect(() => { load(1); }, [debouncedQ, status, role]); // eslint-disable-line

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="Search name / email" value={q} onChange={(e) => setQ(e.target.value)}
          style={{ width: 280 }} allowClear
        />
        <Select
          allowClear placeholder="Status" value={status} style={{ width: 130 }}
          onChange={(v) => setStatus(v)}
          options={[{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }]}
        />
        <Select
          allowClear placeholder="Role" value={role} style={{ width: 120 }}
          onChange={(v) => setRole(v)}
          options={[{ value: 'user', label: 'user' }, { value: 'trainer', label: 'trainer' }]}
        />
      </Space>
      {tempPassword && (
        <Alert
          type="success" closable style={{ marginBottom: 12 }}
          onClose={() => setTempPassword(null)}
          message={`Temporary password for ${tempPassword.email} — shown ONCE`}
          description={
            <Input.Search
              readOnly value={tempPassword.password} enterButton="Copy"
              onSearch={() =>
                navigator.clipboard?.writeText(tempPassword.password).then(() => msg.success('Copied')).catch(() => {})
              }
              style={{ maxWidth: 420 }}
            />
          }
        />
      )}
      <Table<MgmtUser>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={rows}
        onRow={(r) => ({ onClick: () => setSelectedId(r.id), style: { cursor: 'pointer' } })}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, showSizeChanger: false, onChange: (p) => load(p) }}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          { title: 'Email', dataIndex: 'email' },
          { title: 'Role', dataIndex: 'role', render: (r: string) => <Tag color={r === 'trainer' ? 'blue' : 'default'}>{r}</Tag> },
          { title: 'Status', dataIndex: 'is_suspended', width: 110, render: (s: boolean) => (s ? <Tag color="red">suspended</Tag> : <Tag color="green">active</Tag>) },
          { title: 'Created', dataIndex: 'created_at', width: 110, render: (v) => String(v).slice(0, 10) },
        ]}
      />
      {selectedId && (
        <UserDrawer
          userId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => load(page)}
          onTempPassword={setTempPassword}
        />
      )}
    </>
  );
}

function UserDrawer({ userId, onClose, onChanged, onTempPassword }: {
  userId: string;
  onClose: () => void;
  onChanged: () => void;
  onTempPassword: (tp: { email: string; password: string } | null) => void;
}) {
  const [overview, setOverview] = useState<MgmtUserOverview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [activePanels, setActivePanels] = useState<string[]>([]);
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(new Set());
  const [suspending, setSuspending] = useState(false);
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    setOverview(null);
    setLoadErr(null);
    setActivePanels([]);
    setOpenedPanels(new Set());
    getMgmtUserOverview(userId)
      .then(setOverview)
      .catch((e: any) => setLoadErr(e.message));
  }, [userId]);

  const suspend = async (suspended: boolean) => {
    try {
      setSuspending(true);
      await api(`/users/${userId}/suspend`, { method: 'PATCH', body: { suspended } });
      msg.success(suspended ? 'Suspended — blocked at next login' : 'Reactivated');
      const o = await getMgmtUserOverview(userId);
      setOverview(o);
      onChanged();
    } catch (e: any) { msg.error(e.message); }
    setSuspending(false);
  };

  // Same pattern as UsersPage: one-time temp password surfaced via callback.
  const doPasswordReset = () => {
    if (!overview) return;
    Modal.confirm({
      title: `Reset ${overview.profile.name}'s password?`,
      content: 'A temporary password is generated, set on the account, and ALL their sessions are revoked. The password is returned exactly once — relay it manually and securely.',
      okText: 'Reset password',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const r = await resetUserPassword(userId);
          onTempPassword({ email: r.user.email, password: r.tempPassword });
          msg.success(`Password reset (${r.revokedRefreshTokens} session(s) revoked)`);
        } catch (e: any) { msg.error(e.message); }
      },
    });
  };

  const counts = overview?.counts;

  return (
    <Drawer
      open
      width={Math.min(720, window.innerWidth * 0.9)}
      onClose={onClose}
      title={overview ? `${overview.profile.name} (${overview.profile.email})` : 'Loading user…'}
      footer={
        overview && (
          <Space>
            <Switch
              checked={!overview.profile.is_suspended}
              checkedChildren="active"
              unCheckedChildren="suspended"
              loading={suspending}
              onChange={(v) => suspend(!v)}
            />
            <span>Suspend / reactivate</span>
            <Button danger ghost onClick={doPasswordReset}>Reset password</Button>
          </Space>
        )
      }
    >
      {contextHolder}
      {loadErr && <Alert type="error" showIcon message={loadErr} />}
      {!overview && !loadErr && <Spin />}
      {overview && counts && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 8 }}>
            <Statistic
              title="Status"
              value={overview.profile.is_suspended ? 'suspended' : 'active'}
              valueStyle={overview.profile.is_suspended ? { color: '#cf1322' } : { color: '#3f8600' }}
            />
            <Statistic title="Joined" value={String(overview.profile.created_at).slice(0, 10)} />
            <Statistic title="Last active" value={overview.profile.last_active ? String(overview.profile.last_active).slice(0, 10) : '—'} />
            <Statistic title="Role" value={overview.profile.role} />
            {overview.activeTrainer && (
              <Statistic
                title="Active trainer"
                value={overview.activeTrainer.name}
                suffix={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{overview.activeTrainer.email}</Typography.Text>}
              />
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginBottom: 16 }}>
            {(Object.entries(counts) as [string, number][]).map(([k, v]) => (
              <Card key={k} size="small">
                <Statistic title={k.replace(/([A-Z])/g, ' $1').toLowerCase()} value={v} valueStyle={{ fontSize: 18 }} />
              </Card>
            ))}
          </div>
          <Collapse
            activeKey={activePanels}
            onChange={(keys) => {
              const arr = Array.isArray(keys) ? keys : [keys];
              setActivePanels(arr);
              setOpenedPanels((prev) => {
                const next = new Set(prev);
                arr.forEach((k) => next.add(k));
                return next;
              });
            }}
            items={USER_DOMAINS.map((d) => ({
              key: d.key,
              label: d.label,
              children: openedPanels.has(d.key) ? (
                <UserDomainPanel userId={userId} domain={d.key} />
              ) : (
                <Spin size="small" />
              ),
            }))}
          />
        </>
      )}
    </Drawer>
  );
}

// Lazy-loaded per-domain table with its own server-side pagination.
function UserDomainPanel({ userId, domain }: { userId: string; domain: MgmtUserDomain }) {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = async (p = 1) => {
    setLoading(true);
    try {
      const r = await getMgmtUserDomainData(userId, domain, p, 10);
      setItems(r.items || []);
      setTotal(r.total);
      setPage(r.page || p);
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  };
  useEffect(() => { load(1); }, [userId, domain]); // eslint-disable-line

  if (err) return <Alert type="error" showIcon message={err} />;

  const cols = items.length
    ? Object.keys(items[0]).slice(0, 8).map((k) => ({
        title: k,
        dataIndex: k,
        ellipsis: true,
        render: (v: any) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
      }))
    : [];

  return (
    <Table
      rowKey={(_, i) => String(i)}
      size="small"
      loading={loading}
      dataSource={items}
      columns={cols}
      locale={{ emptyText: 'No records' }}
      pagination={{ current: page, pageSize: 10, total, showSizeChanger: false, onChange: (p) => load(p) }}
    />
  );
}
