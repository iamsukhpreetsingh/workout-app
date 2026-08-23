import React, { useState } from 'react';
import { Card, Form, Input, Select, Button, Typography, message, Alert, Space } from 'antd';
import { api } from '../api';

export default function BroadcastPage() {
  const [audience, setAudience] = useState('users');
  const [userIds, setUserIds] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [msg, contextHolder] = message.useMessage();

  const computeAudience = async () => {
    try {
      const ids = audience === 'explicit' ? userIds.split(/[\s,]+/).filter(Boolean) : undefined;
      setPreview(await api('/broadcast/preview', { method: 'POST', body: { audience, userIds: ids } }));
    } catch (e: any) { msg.error(e.message); }
  };

  const send = async () => {
    try {
      const ids = audience === 'explicit' ? userIds.split(/[\s,]+/).filter(Boolean) : undefined;
      const r = await api('/broadcast/send', { method: 'POST', body: { audience, userIds: ids, title, body } });
      msg.success(`Sent to ${r.sent} recipients (audited)`);
      setPreview(null);
    } catch (e: any) { msg.error(e.message); }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      {contextHolder}
      <Typography.Title level={4}>Notification Broadcast</Typography.Title>
      <Typography.Paragraph type="secondary">
        Creates in-app notification rows (with push delivery) via the existing notification mechanism.
      </Typography.Paragraph>
      <Card>
        <Form layout="vertical">
          <Form.Item label="Audience">
            <Select value={audience} onChange={setAudience} options={[
              { value: 'users', label: 'All users' },
              { value: 'trainers', label: 'All trainers' },
              { value: 'users_without_trainer', label: 'Users with no active trainer' },
              { value: 'explicit', label: 'Explicit list of user IDs' },
            ]} />
          </Form.Item>
          {audience === 'explicit' && (
            <Form.Item label="User IDs (comma or newline separated)">
              <Input.TextArea rows={3} value={userIds} onChange={(e) => setUserIds(e.target.value)} placeholder="uuid, uuid, …" />
            </Form.Item>
          )}
          <Form.Item label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Scheduled maintenance" /></Form.Item>
          <Form.Item label="Body"><Input.TextArea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="We'll be offline tonight 2–3 AM." /></Form.Item>
          <Space>
            <Button onClick={computeAudience}>Compute audience</Button>
          </Space>
          {preview && (
            <Alert
              style={{ marginTop: 16 }}
              type={preview.count > 200 ? 'warning' : 'info'}
              message={<>This will notify <b>{preview.count}</b> recipients. Send?</>}
              description={<Button type="primary" danger disabled={!title || !body} onClick={send}>Confirm & send</Button>}
            />
          )}
        </Form>
      </Card>
    </div>
  );
}
