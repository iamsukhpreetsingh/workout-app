import React, { useEffect, useMemo, useState } from 'react';
import {
  Card, Table, Input, Button, Modal, Form, Select, InputNumber, Switch, DatePicker, Space, Tag, Typography, message,
} from 'antd';
import { api } from '../api';

// ── The FIRST auto-discovery surface. Everything here is generated from
// GET /admin/schema at runtime — a brand-new table added by a future
// migration appears on next page load with zero frontend changes.

interface ColumnMeta { name: string; data_type: string; nullable: boolean; default: string | null; sensitive: boolean }
interface TableMeta { name: string; columns: ColumnMeta[]; primaryKey: string[]; foreignKeys: any[]; customModule: string | null; roles: { read: string; write: string | null } }

export default function DatabasePage() {
  const [schema, setSchema] = useState<TableMeta[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<TableMeta | null>(null);

  useEffect(() => { api('/schema').then(setSchema).catch(() => {}); }, []);

  const grouped = useMemo(() => {
    const f = filter.toLowerCase();
    const tables = schema.filter((t) => !f || t.name.includes(f));
    const groups: Record<string, TableMeta[]> = {};
    for (const t of tables) {
      const prefix = t.name.includes('_') ? t.name.split('_')[0] : 'other';
      (groups[prefix] = groups[prefix] || []).push(t);
    }
    return groups;
  }, [schema, filter]);

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 64px)' }}>
      <Card size="small" title={`Tables (${schema.length})`} style={{ width: 300, overflow: 'auto' }}>
        <Input.Search placeholder="Filter tables" value={filter} onChange={(e) => setFilter(e.target.value)} size="small" style={{ marginBottom: 8 }} />
        {Object.entries(grouped).map(([prefix, tables]) => (
          <div key={prefix} style={{ marginBottom: 10 }}>
            <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>{prefix}_</Typography.Text>
            {tables.map((t) => (
              <div
                key={t.name}
                onClick={() => setSelected(t)}
                style={{
                  padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
                  background: selected?.name === t.name ? '#E8481F22' : undefined,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span>{t.name}</span>
                <Space size={4}>
                  {t.customModule && <Tag color="blue" style={{ fontSize: 10 }}>{t.customModule}</Tag>}
                  <Tag style={{ fontSize: 10 }}>R:{t.roles.read}</Tag>
                  {t.roles.write && <Tag style={{ fontSize: 10 }}>W:{t.roles.write}</Tag>}
                </Space>
              </div>
            ))}
          </div>
        ))}
      </Card>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {selected ? <GenericGrid table={selected} /> : <Card><Typography.Text type="secondary">Pick a table — the grid is generated from its live column list.</Typography.Text></Card>}
      </div>
    </div>
  );
}

function GenericGrid({ table }: { table: TableMeta }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<string>('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [msg, contextHolder] = message.useMessage();

  const load = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (sort) qs.set('sort', sort);
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      const data = await api(`/data/${table.name}?${qs}`);
      setRows(data.rows);
      setTotal(data.total);
    } catch (e: any) { msg.error(e.message); }
    setLoading(false);
  };

  useEffect(() => { load(); }, [table.name, page, sort]); // eslint-disable-line

  const columns = [
    ...table.columns.map((c) => ({
      title: c.name + (c.sensitive ? ' 🔒' : ''),
      dataIndex: c.name,
      sorter: true,
      ellipsis: true,
      render: (v: any) =>
        v === null || v === undefined ? <span style={{ color: '#666' }}>NULL</span>
        : typeof v === 'object' ? JSON.stringify(v).slice(0, 60)
        : typeof v === 'boolean' ? String(v)
        : String(v).slice(0, 80),
    })),
    {
      title: '',
      render: (_: any, row: any) => (
        <Button size="small" onClick={() => setEditing(row)}>Edit</Button>
      ),
    },
  ];

  const pk = table.primaryKey[0] || 'id';

  return (
    <Card
      size="small"
      title={`${table.name} — ${total} rows`}
      extra={
        <Space>
          <Input.Search
            placeholder={`Search by ${pk}`}
            size="small"
            style={{ width: 220 }}
            onSearch={(v) => { setFilters({ [pk]: v }); setPage(1); load(); }}
          />
          <Button size="small" onClick={load}>Refresh</Button>
        </Space>
      }
    >
      {contextHolder}
      <Table
        size="small"
        loading={loading}
        rowKey={(r) => String(r[pk])}
        dataSource={rows}
        columns={columns}
        pagination={{ current: page, pageSize: 25, total, onChange: setPage, showSizeChanger: false }}
        onChange={(_pag, _fil, sorter: any) => sorter?.field && setSort(`${sorter.order === 'descend' ? '-' : ''}${sorter.field}`)}
      />
      <RowEditor
        table={table}
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }}
      />
    </Card>
  );
}

// generic row editor: input type derived from the column's live data type;
// FK columns become searchable dropdowns fed from the referenced table;
// sensitive columns are read-only; PK columns are read-only.
function RowEditor({ table, row, onClose, onSaved }: { table: TableMeta; row: any; onClose: () => void; onSaved: () => void }) {
  const [form] = Form.useForm();
  const [msg, contextHolder] = message.useMessage();
  const [fkOptions, setFkOptions] = useState<Record<string, any[]>>({});

  useEffect(() => {
    if (!row) return;
    const init: any = {};
    for (const c of table.columns) {
      const v = row[c.name];
      if (v != null && ['timestamp with time zone', 'date'].includes(c.data_type)) {
        init[c.name] = undefined; // timestamps edited as ISO text for simplicity
      }
    }
    form.setFieldsValue({ ...row, ...init });
    // preload FK dropdown options from referenced tables
    (async () => {
      const opts: Record<string, any[]> = {};
      for (const fk of table.foreignKeys) {
        try {
          const data = await api(`/data/${fk.ref_table}?pageSize=100`);
          opts[fk.column] = data.rows;
        } catch { opts[fk.column] = []; }
      }
      setFkOptions(opts);
    })();
  }, [row, table, form]);

  if (!row) return null;
  const pk = table.primaryKey[0] || 'id';

  const save = async (values: any) => {
    try {
      await api(`/data/${table.name}/${row[pk]}`, { method: 'PATCH', body: values });
      msg.success('Saved (audited)');
      onSaved();
    } catch (e: any) { msg.error(e.message); }
  };

  const fieldFor = (c: ColumnMeta) => {
    if (c.sensitive) return <Input disabled placeholder="masked" />;
    if (table.primaryKey.includes(c.name)) return <Input disabled />;
    const fk = table.foreignKeys.find((f: any) => f.column === c.name);
    if (fk) {
      const opts = (fkOptions[c.name] || []).map((r) => ({ value: String(r.id), label: `${r.id?.slice(0, 8)}… ${r.name || r.email || ''}` }));
      return <Select showSearch options={opts} allowClear optionFilterProp="label" />;
    }
    if (c.data_type === 'boolean') return <Switch />;
    if (['integer', 'numeric', 'real', 'double precision', 'bigint', 'smallint'].includes(c.data_type)) return <InputNumber style={{ width: '100%' }} />;
    if (Array.isArray(row[c.name])) return <Input placeholder='["a","b"] (JSON array)' />;
    return <Input />;
  };

  return (
    <Modal
      open
      title={`Edit ${table.name} · ${String(row[pk]).slice(0, 8)}`}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnClose
    >
      {contextHolder}
      <Form form={form} layout="vertical" onFinish={save}>
        {table.columns.map((c) => (
          <Form.Item key={c.name} name={c.name} label={`${c.name} (${c.data_type}${c.nullable ? '' : ' · required'})`} valuePropName={c.data_type === 'boolean' ? 'checked' : 'value'}>
            {fieldFor(c)}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
}
