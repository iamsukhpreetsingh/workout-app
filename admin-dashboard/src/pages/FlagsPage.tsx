import React, { useEffect, useState } from 'react';
import { Card, Table, Switch, InputNumber, Button, Input, Modal, Form, message, Typography } from 'antd';
import { api } from '../api';

export default function FlagsPage() {
  const [flags, setFlags] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm();
  const [msg, contextHolder] = message.useMessage();

  const load = async () => setFlags(await api('/flags'));
  useEffect(() => { load(); }, []);

  const update = async (key: string, patch: any) => {
    try {
      const flag = flags.find((f) => f.key === key) || {};
      await api(`/flags/${key}`, { method: 'PUT', body: { ...flag, ...patch } });
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  const create = async (v: any) => {
    try {
      await api(`/flags/${v.key}`, { method: 'PUT', body: v });
      msg.success('Flag created');
      setCreating(false);
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Feature Flags</Typography.Title>
      <Button type="primary" style={{ marginBottom: 12 }} onClick={() => setCreating(true)}>New flag</Button>
      <Table
        rowKey="key" size="small" dataSource={flags}
        columns={[
          { title: 'Key', dataIndex: 'key' },
          { title: 'Description', dataIndex: 'description', ellipsis: true },
          { title: 'Enabled', dataIndex: 'enabled', render: (v, r: any) => <Switch checked={v} onChange={(nv) => update(r.key, { enabled: nv })} /> },
          { title: 'Rollout %', dataIndex: 'rollout_percentage', render: (v, r: any) => (
            <InputNumber min={0} max={100} value={v} onChange={(nv) => update(r.key, { rollout_percentage: nv })} />
          ) },
          { title: 'Updated', dataIndex: 'updated_at', render: (v) => String(v).slice(0, 19).replace('T', ' ') },
        ]}
      />
      <Modal open={creating} title="New feature flag" onCancel={() => setCreating(false)} onOk={() => form.submit()} destroyOnClose>
        <Form form={form} layout="vertical" onFinish={create}>
          <Form.Item name="key" label="Key" rules={[{ required: true }]}><Input placeholder="new_module_x" /></Form.Item>
          <Form.Item name="description" label="Description"><Input /></Form.Item>
          <Form.Item name="enabled" label="Enabled" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="rollout_percentage" label="Rollout % (optional)"><InputNumber min={0} max={100} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
