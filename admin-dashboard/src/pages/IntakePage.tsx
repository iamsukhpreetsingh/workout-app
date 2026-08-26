import React, { useEffect, useState } from 'react';
import {
  Card, Table, Tag, Button, Statistic, Row, Col, message, Typography,
  Space, Drawer, Alert, Descriptions, Modal, Input, Form,
} from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import {
  api, getIntakeProfiles, getIntakeProfileDetail, flagIntakeProfile,
  getIntakeCompletionStats, IntakeProfileMeta, IntakeCompletionStats,
} from '../api';

function Presence({ yes }: { yes: boolean }) {
  return yes
    ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
    : <CloseCircleOutlined style={{ color: '#555' }} />;
}

export default function IntakePage() {
  const [rows, setRows] = useState<IntakeProfileMeta[]>([]);
  const [stats, setStats] = useState<IntakeCompletionStats | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [flagTarget, setFlagTarget] = useState<IntakeProfileMeta | null>(null);
  const [form] = Form.useForm();
  const [msg, contextHolder] = message.useMessage();

  const load = async () => {
    try {
      const r = await getIntakeProfiles({ limit: 200 });
      setRows(r.profiles || []);
      setStats(await getIntakeCompletionStats());
    } catch (e: any) { msg.error(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  // Fetching full health data — audit-logged server-side on every call.
  const openDetail = async (id: string) => {
    setLoadingDetail(true);
    try {
      setDetail(await getIntakeProfileDetail(id));
    } catch (e: any) { msg.error(e.message); }
    setLoadingDetail(false);
  };

  const submitFlag = async (v: any) => {
    if (!flagTarget) return;
    try {
      await flagIntakeProfile(flagTarget.id, v.reason);
      msg.success('Flagged for review');
      setFlagTarget(null);
      form.resetFields();
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  const renderArray = (v: any) => {
    if (v == null) return '—';
    if (!Array.isArray(v)) return String(v);
    if (!v.length) return <Typography.Text type="secondary">(empty)</Typography.Text>;
    return <Space wrap size={4}>{v.map((x: any, i: number) => <Tag key={i}>{String(x)}</Tag>)}</Space>;
  };

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Intake Profiles</Typography.Title>
      <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        message="Health data below is sensitive. The list shows metadata only; opening a profile's full detail is audit-logged server-side."
      />

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={5}><Card><Statistic title="Completion rate (trained clients)" value={stats?.completion_rate_pct ?? '—'} suffix={stats ? '%' : ''} /></Card></Col>
        <Col span={5}><Card><Statistic title="Clients w/ active trainer" value={stats?.clients_with_active_trainer ?? 0} /></Card></Col>
        <Col span={5}><Card><Statistic title="Total profiles" value={stats?.total_profiles ?? 0} /></Card></Col>
        <Col span={4}><Card><Statistic title="Completed" value={stats?.completed_profiles ?? 0} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col span={5}><Card><Statistic title="Incomplete" value={stats?.incomplete_profiles ?? 0} valueStyle={(stats?.incomplete_profiles ?? 0) > 0 ? { color: '#faad14' } : undefined} /></Card></Col>
      </Row>

      <Table<IntakeProfileMeta>
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={{ pageSize: 15 }}
        columns={[
          { title: 'Client', render: (_: any, r) => <span>{r.client_name}<br /><Typography.Text type="secondary" style={{ fontSize: 11 }}>{r.client_email}</Typography.Text></span> },
          {
            title: 'Trainer(s)', dataIndex: 'trainers',
            render: (t: IntakeProfileMeta['trainers'], r) =>
              r.has_trainer && t?.length
                ? t.map((tr, i) => <Tag key={i} color="blue">{tr.name}</Tag>)
                : <Tag>none</Tag>,
          },
          { title: 'Completed', dataIndex: 'completed_at', render: (v) => v ? String(v).slice(0, 10) : <Tag color="orange">incomplete</Tag>, width: 110 },
          { title: 'Allergens', dataIndex: 'has_allergens', render: (v) => <Presence yes={!!v} />, align: 'center' as const },
          { title: 'Goals', dataIndex: 'has_goals', render: (v) => <Presence yes={!!v} />, align: 'center' as const },
          { title: 'Injuries', dataIndex: 'has_injuries', render: (v) => <Presence yes={!!v} />, align: 'center' as const },
          { title: 'Medical', dataIndex: 'has_medical', render: (v) => <Presence yes={!!v} />, align: 'center' as const },
          {
            title: 'Flagged',
            render: (_: any, r) => r.flagged_at
              ? <span><Tag color="red">flagged</Tag><br /><Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>{r.flag_reason}</Typography.Text></span>
              : '—',
          },
          {
            title: 'Actions',
            width: 170,
            render: (_: any, r) => (
              <Space size={4}>
                <Button size="small" loading={loadingDetail} onClick={() => openDetail(r.id)}>View</Button>
                <Button size="small" danger onClick={() => { setFlagTarget(r); form.resetFields(); }}>Flag</Button>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={560}
        title={`Intake profile — ${detail?.client_name ?? ''}`}
      >
        {detail && (
          <>
            <Alert
              type="warning"
              showIcon
              message="This view was audit-logged"
              description="Full intake health data was disclosed to your admin account just now. Never edit or share these disclosures — flag for review instead."
              style={{ marginBottom: 16 }}
            />
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="Client">{detail.client_name} ({detail.client_email})</Descriptions.Item>
              <Descriptions.Item label="Completed at">{detail.completed_at ? String(detail.completed_at).slice(0, 19).replace('T', ' ') : '—'}</Descriptions.Item>
              <Descriptions.Item label="Allergens">{renderArray(detail.allergens)}</Descriptions.Item>
              <Descriptions.Item label="Goals">{renderArray(detail.goals)}</Descriptions.Item>
              <Descriptions.Item label="Injuries">{renderArray(detail.injuries)}</Descriptions.Item>
              <Descriptions.Item label="Medical conditions">{renderArray(detail.medical_conditions)}</Descriptions.Item>
            </Descriptions>
          </>
        )}
      </Drawer>

      <Modal
        open={!!flagTarget}
        title={`Flag ${flagTarget?.client_name}'s intake profile for review`}
        onCancel={() => setFlagTarget(null)}
        onOk={() => form.submit()}
        okText="Flag for review"
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={submitFlag}>
          <Form.Item name="reason" label="Reason" rules={[{ required: true, message: 'A reason is required' }]}>
            <Input.TextArea rows={3} placeholder="e.g. client reports a new severe allergy not reflected here" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
