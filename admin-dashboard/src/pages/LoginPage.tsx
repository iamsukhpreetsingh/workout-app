import React, { useState } from 'react';
import { Card, Form, Input, Button, Typography, message } from 'antd';
import { login, AdminProfile } from '../api';

export default function LoginPage({ onLogin }: { onLogin: (p: AdminProfile) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, contextHolder] = message.useMessage();

  const finish = async ({ email, password }: { email: string; password: string }) => {
    setBusy(true);
    try {
      onLogin(await login(email, password));
    } catch (e: any) {
      msg.error(e.message);
    }
    setBusy(false);
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#141414' }}>
      {contextHolder}
      <Card title="🏋️ Workout Tracker — Admin" style={{ width: 380 }}>
        <Typography.Paragraph type="secondary">
          Internal admin dashboard. Separate from app accounts.
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={finish}>
          <Form.Item name="email" label="Email" rules={[{ required: true }]}>
            <Input placeholder="admin@workout.local" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            Log in
          </Button>
        </Form>
      </Card>
    </div>
  );
}
