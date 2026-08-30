import React, { useEffect, useState } from 'react';
import {
  Card, Table, Tag, message, Typography, Tabs, Input, Modal,
} from 'antd';
import {
  getMealCatalog, getRecipes, getTagVocabulary, getAllergenConsistency,
  getGlobalFoods, saveGlobalFood, verifyGlobalFood, deleteGlobalFood,
  MealCatalogItem, RecipeRow, TagVocabRow, AllergenConsistency, GlobalFood,
} from '../api';

export default function NutritionPage() {
  return (
    <div>
      <Typography.Title level={4}>Nutrition Content</Typography.Title>
      <Tabs
        items={[
          { key: 'foods', label: 'Global foods', children: <GlobalFoodsTab /> },
          { key: 'catalog', label: 'Meal catalog', children: <MealCatalogTab /> },
          { key: 'recipes', label: 'Recipes', children: <RecipesTab /> },
          { key: 'tags', label: 'Tag vocabulary', children: <TagVocabTab /> },
          { key: 'allergens', label: 'Allergen consistency', children: <AllergenTab /> },
        ]}
      />
    </div>
  );
}

const macroCols = [
  { title: 'Calories', dataIndex: 'calories', width: 90 },
  { title: 'Protein g', dataIndex: 'protein_g', width: 90 },
  { title: 'Carbs g', dataIndex: 'carbs_g', width: 90 },
  { title: 'Fat g', dataIndex: 'fat_g', width: 90 },
];

// ─────────────────────────── Meal catalog ───────────────────────────────
function MealCatalogTab() {
  const [rows, setRows] = useState<MealCatalogItem[]>([]);
  const [q, setQ] = useState('');
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    getMealCatalog().then(setRows).catch((e) => msg.error(e.message));
  }, []); // eslint-disable-line

  const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())) : rows;

  return (
    <>
      {contextHolder}
      <Input.Search
        placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ width: 240, marginBottom: 12 }} allowClear
      />
      <Table<MealCatalogItem>
        rowKey="id"
        size="small"
        dataSource={filtered}
        pagination={{ pageSize: 15 }}
        columns={[
          { title: 'Dish', dataIndex: 'name' },
          { title: 'Trainer', render: (_: any, r) => r.trainer_name },
          ...macroCols,
          { title: 'Tags', dataIndex: 'tags', render: (t: string[] | null) => t?.length ? t.map((x, i) => <Tag key={i}>{x}</Tag>) : '—' },
          { title: 'Allergens', dataIndex: 'allergens', render: (a: string[] | null) => a?.length ? a.map((x, i) => <Tag key={i} color="orange">{x}</Tag>) : '—' },
          { title: 'Plan uses', dataIndex: 'plan_usage_count', width: 100 },
        ]}
      />
    </>
  );
}

// ─────────────────────────── Recipes ────────────────────────────────────
function RecipesTab() {
  const [rows, setRows] = useState<RecipeRow[]>([]);
  const [q, setQ] = useState('');
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    getRecipes().then(setRows).catch((e) => msg.error(e.message));
  }, []); // eslint-disable-line

  const filtered = q ? rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())) : rows;

  return (
    <>
      {contextHolder}
      <Input.Search
        placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ width: 240, marginBottom: 12 }} allowClear
      />
      <Table<RecipeRow>
        rowKey="id"
        size="small"
        dataSource={filtered}
        pagination={{ pageSize: 15 }}
        columns={[
          { title: 'Recipe', dataIndex: 'name' },
          {
            title: 'Author',
            render: (_: any, r) => (
              <span>
                {r.author_name} <Tag>{r.author_role}</Tag><br />
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.author_email}</Typography.Text>
              </span>
            ),
          },
          ...macroCols,
          { title: 'Allergens', dataIndex: 'allergens', render: (a: string[] | null) => a?.length ? a.map((x, i) => <Tag key={i} color="orange">{x}</Tag>) : '—' },
          { title: 'Created', dataIndex: 'created_at', render: (v) => String(v).slice(0, 10) },
        ]}
      />
    </>
  );
}

// ─────────────────────────── Tag vocabulary ─────────────────────────────
function TagVocabTab() {
  const [rows, setRows] = useState<TagVocabRow[]>([]);
  const [q, setQ] = useState('');
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    getTagVocabulary().then(setRows).catch((e) => msg.error(e.message));
  }, []); // eslint-disable-line

  const filtered = q ? rows.filter((r) => r.tag.toLowerCase().includes(q.toLowerCase())) : rows;

  return (
    <>
      {contextHolder}
      <Input.Search
        placeholder="Search tag" value={q} onChange={(e) => setQ(e.target.value)}
        style={{ width: 240, marginBottom: 12 }} allowClear
      />
      <Table<TagVocabRow>
        rowKey={(r) => `${r.source_table}:${r.tag}`}
        size="small"
        dataSource={filtered}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'Tag', dataIndex: 'tag', render: (t) => <Tag color="blue">{t}</Tag> },
          { title: 'Source table', dataIndex: 'source_table' },
          { title: 'Usage count', dataIndex: 'usage_count', width: 130 },
        ]}
      />
    </>
  );
}

// ───────────────────── Allergen consistency (sensitive) ─────────────────
function AllergenTab() {
  const [data, setData] = useState<AllergenConsistency | null>(null);
  const [msg, contextHolder] = message.useMessage();

  useEffect(() => {
    getAllergenConsistency().then(setData).catch((e) => msg.error(e.message));
  }, []); // eslint-disable-line

  return (
    <>
      {contextHolder}
      <Typography.Paragraph type="secondary">
        Allergen matching in the app is an exact case-insensitive intersection — spelling drift here silently breaks conflict warnings. Contains client health data.
      </Typography.Paragraph>

      <Card size="small" title={`Unmatched values (${data?.unmatched?.length ?? 0})`} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(data?.unmatched || []).map((u) => (
            <Tag key={u.value} color="red" style={{ fontSize: 13 }}>
              {u.value} ({u.count}) · only in {u.sources.join(',')}
              {u.nearMatches.length ? ` · near: ${u.nearMatches.join(', ')}` : ''}
            </Tag>
          ))}
          {data && !data.unmatched.length && <Tag color="green">No unmatched values — vocabulary is consistent</Tag>}
        </div>
      </Card>

      <Card size="small" title="Near-duplicate clusters (case / plural / substring)" style={{ marginBottom: 16 }}>
        <Table<AllergenConsistency['nearDuplicateClusters'][number]>
          rowKey={(g) => `${g.source_table}:${g.values.join('|')}`}
          size="small"
          pagination={false}
          dataSource={data?.nearDuplicateClusters || []}
          columns={[
            { title: 'Source', dataIndex: 'source_table' },
            {
              title: 'Cluster values',
              dataIndex: 'values',
              render: (vals: string[]) => vals.map((v, i) => <Tag key={i} color="volcano">{v}</Tag>),
            },
          ]}
        />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card size="small" title="Meal catalog allergen values">
          <Table<AllergenConsistency['mealCatalogValues'][number]>
            rowKey="allergen"
            size="small"
            pagination={{ pageSize: 8 }}
            dataSource={data?.mealCatalogValues || []}
            columns={[
              { title: 'Allergen', dataIndex: 'allergen' },
              { title: 'Count', dataIndex: 'count', width: 80 },
            ]}
          />
        </Card>
        <Card size="small" title="Client intake allergen values">
          <Table<AllergenConsistency['intakeValues'][number]>
            rowKey="allergen"
            size="small"
            pagination={{ pageSize: 8 }}
            dataSource={data?.intakeValues || []}
            columns={[
              { title: 'Allergen', dataIndex: 'allergen' },
              { title: 'Count', dataIndex: 'count', width: 80 },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

// ─────────────────────────── Global foods ───────────────────────────────
// The shared food database powering the log-first nutrition search: curated
// seed rows (verified), cached Open Food Facts results (unverified until a
// staff member promotes them), and admin-added entries.
function GlobalFoodsTab() {
  const [rows, setRows] = useState<GlobalFood[]>([]);
  const [q, setQ] = useState('');
  const [msg, contextHolder] = message.useMessage();

  const reload = (query = '') =>
    getGlobalFoods(query).then(setRows).catch((e) => msg.error(e.message));

  useEffect(() => { reload(); }, []); // eslint-disable-line

  const modal = () => {
    let name = '', calories = '', protein = '', carbs = '', fat = '';
    Modal.info({
      title: 'Add global food (per 100 g)',
      content: (
        <div style={{ display: 'grid', gap: 8 }}>
          <Input placeholder="Name" onChange={(e) => (name = e.target.value)} />
          <Input placeholder="Calories" onChange={(e) => (calories = e.target.value)} />
          <Input placeholder="Protein g" onChange={(e) => (protein = e.target.value)} />
          <Input placeholder="Carbs g" onChange={(e) => (carbs = e.target.value)} />
          <Input placeholder="Fat g" onChange={(e) => (fat = e.target.value)} />
        </div>
      ),
      onOk: async () => {
        try {
          await saveGlobalFood({
            name,
            calories: calories ? Number(calories) : null,
            protein_g: protein ? Number(protein) : null,
            carbs_g: carbs ? Number(carbs) : null,
            fat_g: fat ? Number(fat) : null,
          });
          message.success('Food added');
          reload(q);
        } catch (e: any) {
          message.error(e.message);
        }
      },
    });
  };

  return (
    <>
      {contextHolder}
      <Input.Search
        placeholder="Search name" value={q} onChange={(e) => setQ(e.target.value)}
        onSearch={(v) => reload(v)} style={{ width: 240, marginRight: 12 }} allowClear
      />
      <a onClick={modal} style={{ marginRight: 12 }}>+ Add food</a>
      <Table<GlobalFood>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 15 }}
        columns={[
          {
            title: 'Food', dataIndex: 'name',
            render: (_: any, r) => (
              <>
                {r.name} {r.brand ? <Tag>{r.brand}</Tag> : null}{' '}
                {r.verified ? <Tag color="green">verified</Tag> : <Tag color="orange">unverified</Tag>}{' '}
                <Tag>{r.source}</Tag>
              </>
            ),
          },
          ...macroCols,
          { title: 'Used', dataIndex: 'usage_count', width: 70 },
          {
            title: 'Actions', width: 150,
            render: (_: any, r) => (
              <>
                {!r.verified && (
                  <a
                    style={{ marginRight: 12 }}
                    onClick={async () => {
                      try { await verifyGlobalFood(r.id); reload(q); } catch (e: any) { msg.error(e.message); }
                    }}
                  >
                    Verify
                  </a>
                )}
                <a
                  style={{ color: '#cf1322' }}
                  onClick={async () => {
                    try { await deleteGlobalFood(r.id); reload(q); } catch (e: any) { msg.error(e.message); }
                  }}
                >
                  Delete
                </a>
              </>
            ),
          },
        ]}
      />
    </>
  );
}
