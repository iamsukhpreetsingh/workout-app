import React, { useState } from 'react';
import { Card, Form, Input, Button, Tabs, Typography, App as AntApp } from 'antd';
import { login, signup, UserProfile } from '../api';

interface Props {
  onLogin: (user: UserProfile) => void;
}

export default function LoginPage({ onLogin }: Props) {
  const { message } = AntApp.useApp();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [busy, setBusy] = useState(false);

  const finish = async (values: any) => {
    setBusy(true);
    try {
      const user = mode === 'login'
        ? await login(values.email, values.password)
        : await signup(values.name, values.email, values.password);
      onLogin(user);
    } catch (e: any) {
      message.error(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <Card style={{ width: '100%', maxWidth: 400 }}>
        <Typography.Title level={3} style={{ marginTop: 0 }}>
          Gym Portal
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          Create and manage your gym. Your gym role applies only inside your gym — your
          personal fitness account stays exactly as it is.
        </Typography.Paragraph>
        <Tabs
          activeKey={mode}
          onChange={(k) => setMode(k as 'login' | 'signup')}
          items={[
            { key: 'login', label: 'Sign in' },
            { key: 'signup', label: 'Create account' },
          ]}
        />
        <Form layout="vertical" onFinish={finish} disabled={busy}>
          {mode === 'signup' && (
            <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name is required' }]}>
              <Input placeholder="Your name" />
            </Form.Item>
          )}
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Email is required' },
              { type: 'email', message: 'Enter a valid email' },
            ]}
          >
            <Input placeholder="you@example.com" autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[
              { required: true, message: 'Password is required' },
              ...(mode === 'signup'
                ? [{ min: 8, message: 'At least 8 characters' }]
                : []),
            ]}
          >
            <Input.Password
              placeholder={mode === 'signup' ? 'At least 8 characters' : 'Password'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </Form>
      </Card>
    </div>
  );
}
