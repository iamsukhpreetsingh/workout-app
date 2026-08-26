import React, { useEffect, useState } from 'react';
import {
  Card, Table, Tag, Button, Statistic, Row, Col, message, Typography,
  Space, Input, Popconfirm,
} from 'antd';
import {
  api,
  getProgressionFormulas,
  getProgressionUsage,
  getProgressionOverrides,
  deleteProgressionOverride,
  ProgressionFormula,
  FormulaUsage,
  ProgressionOverride,
} from '../api';
import { getProfile } from '../api';

export default function ProgressionPage() {
  const [formulas, setFormulas] = useState<ProgressionFormula[]>([]);
  const [sourceFile, setSourceFile] = useState('');
  const [usage, setUsage] = useState<FormulaUsage | null>(null);
  const [overrides, setOverrides] = useState<ProgressionOverride[]>([]);
  const [totalOverrides, setTotalOverrides] = useState(0);
  const [page, setPage] = useState(1);
  const [trainerFilter, setTrainerFilter] = useState('');
  const [msg, contextHolder] = message.useMessage();
  const role = getProfile()?.role;
  const canClear = role === 'support' || role === 'super_admin';

  const load = async () => {
    try {
      const [f, u] = await Promise.all([getProgressionFormulas(), getProgressionUsage()]);
      setFormulas(f.formulas || []);
      setSourceFile(f.sourceFile);
      setUsage(u);
      await loadOverrides(1);
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const loadOverrides = async (p: number) => {
    try {
      const r = await getProgressionOverrides({ page: p, limit: 15, trainerId: trainerFilter || undefined });
      setOverrides(r.overrides || []);
      setTotalOverrides(r.total);
      setPage(p);
    } catch (e: any) { msg.error(e.message); }
  };

  const clearOverride = async (o: ProgressionOverride) => {
    try {
      await deleteProgressionOverride(o.id);
      msg.success(`Cleared override for ${o.client_name}`);
      loadOverrides(page);
    } catch (e: any) { msg.error(e.message); }
  };

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Progression Engine</Typography.Title>

      <Card size="small" title="Formulas (live from progressionFormulas.json)" extra={<Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>{sourceFile}</Typography.Text>}>
        <Table<ProgressionFormula>
          rowKey="key"
          size="small"
          dataSource={formulas}
          pagination={false}
          columns={[
            { title: 'Key', dataIndex: 'key', render: (k, f) => (
              <Space direction="vertical" size={0}>
                <span>{f.displayName}</span>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>{k}</Typography.Text>
              </Space>
            ) },
            { title: 'Description', dataIndex: 'description', ellipsis: true },
            {
              title: 'Params',
              render: (_: any, f) => (
                <Space wrap size={4}>
                  {(f.paramSchema || []).map((p) => <Tag key={p.key}>{p.key}</Tag>)}
                </Space>
              ),
            },
            {
              title: 'Users on formula',
              render: (_: any, f) => usage?.breakdown.find((b) => b.formula_key === f.key)?.users ?? 0,
              width: 140,
            },
          ]}
        />
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={6}><Card><Statistic title="Explicit settings rows" value={usage?.totals.explicitSettingsRows ?? 0} /></Card></Col>
        <Col span={6}><Card><Statistic title={`Implicit default (${usage?.totals.appDefaultKey ?? ''})`} value={usage?.totals.implicitDefaultUsers ?? 0} /></Card></Col>
        <Col span={6}><Card><Statistic title="Rows w/ unknown key" value={usage?.unknownRows ?? 0} valueStyle={(usage?.unknownRows ?? 0) > 0 ? { color: '#cf1322' } : undefined} /></Card></Col>
      </Row>

      <Card size="small" title="Formula usage breakdown" style={{ marginTop: 16 }}>
        <Table<NonNullable<FormulaUsage>['breakdown'][number]>
          rowKey="formula_key"
          size="small"
          dataSource={usage?.breakdown || []}
          pagination={false}
          columns={[
            { title: 'Formula key', dataIndex: 'formula_key' },
            {
              title: 'Known',
              dataIndex: 'known',
              render: (k) => (k ? <Tag color="green">known</Tag> : <Tag color="red">UNKNOWN</Tag>),
            },
            { title: 'Users', dataIndex: 'users' },
            { title: 'Last updated', dataIndex: 'last_updated', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
          ]}
        />
        {!!usage?.unknownKeys?.length && (
          <AlertLike unknownKeys={usage.unknownKeys} />
        )}
      </Card>

      <Card
        size="small"
        title="Trainer → client overrides"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <Input.Search
              placeholder="Trainer ID (uuid)"
              value={trainerFilter}
              onChange={(e) => setTrainerFilter(e.target.value)}
              onSearch={() => loadOverrides(1)}
              style={{ width: 300 }}
              allowClear
            />
            <Button onClick={() => loadOverrides(1)}>Filter</Button>
          </Space>
        }
      >
        <Table<ProgressionOverride>
          rowKey="id"
          size="small"
          dataSource={overrides}
          pagination={{
            current: page,
            pageSize: 15,
            total: totalOverrides,
            showSizeChanger: false,
            onChange: (p) => loadOverrides(p),
          }}
          columns={[
            { title: 'Trainer', render: (_: any, o) => <span>{o.trainer_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{o.trainer_email}</Typography.Text></span> },
            { title: 'Client', render: (_: any, o) => <span>{o.client_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{o.client_email}</Typography.Text></span> },
            { title: 'Formula', dataIndex: 'formula_key', render: (k) => <Tag color={usage?.unknownKeys.includes(k) ? 'red' : 'blue'}>{k}</Tag> },
            { title: 'Params', dataIndex: 'params', render: (p) => <code style={{ fontSize: 11 }}>{JSON.stringify(p)}</code>, ellipsis: true },
            { title: 'Updated', dataIndex: 'updated_at', render: (v) => String(v).slice(0, 19).replace('T', ' '), width: 150 },
            ...(canClear
              ? [{
                  title: 'Actions',
                  width: 100,
                  render: (_: any, o: ProgressionOverride) => (
                    <Popconfirm
                      title="Clear this override?"
                      description="The row is deleted entirely; the client falls back to their own settings or the app default."
                      okText="Clear"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => clearOverride(o)}
                    >
                      <Button size="small" danger>Clear</Button>
                    </Popconfirm>
                  ),
                }]
              : []),
          ]}
        />
      </Card>
    </div>
  );
}

function AlertLike({ unknownKeys }: { unknownKeys: string[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      <Tag color="red">Deleted/renamed keys still in DB: {unknownKeys.join(', ')}</Tag>
    </div>
  );
}
