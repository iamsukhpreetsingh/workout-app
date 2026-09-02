// Public invitation landing page — NO authentication required to VIEW; the
// one-time code in the URL is itself the credential. Two flows per spec:
//   Scenario 1: the person already has an app account → sign in (with the
//     invited email) and tap Accept. The backend verifies the email match.
//   Scenario 2: no app account → Create your account form; the backend
//     creates the User AND links the existing GymMember atomically.
import React, { useEffect, useState } from 'react';
import {
  Card, Typography, Button, Tag, Form, Input, App as AntApp, Spin, Result, Space, Divider,
} from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  getInvitation, acceptInvitationByToken, declineInvitationByToken, registerViaInvitation,
  InvitationPreview, hasAccessToken, api, UserProfile,
} from '../api';

const STATE_MESSAGES: Record<string, { title: string; icon: React.ReactNode }> = {
  EXPIRED: { title: 'This invitation has expired', icon: <ClockCircleOutlined style={{ color: '#faad14' }} /> },
  CANCELLED: { title: 'This invitation was cancelled by the gym', icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} /> },
  DECLINED: { title: 'This invitation was declined', icon: <CloseCircleOutlined style={{ color: '#ff4d4f' }} /> },
  ACCEPTED: { title: 'This invitation was already accepted', icon: <CheckCircleOutlined style={{ color: '#16A34A' }} /> },
};

export default function InviteLandingPage({ token }: { token: string }) {
  const { message } = AntApp.useApp();
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [mode, setMode] = useState<'decide' | 'register'>('decide');
  const [registering, setRegistering] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [myEmail, setMyEmail] = useState<string | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    (async () => {
      try {
        setInvitation(await getInvitation(token));
      } catch (e: any) {
        if (String(e.message).includes('not found') || String(e.message).includes('404')) setNotFound(true);
        else setNotFound(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // if the visitor is signed in, resolve their account email to decide
  // whether the Accept button applies to them
  useEffect(() => {
    if (!hasAccessToken()) return;
    (async () => {
      try {
        const profile = await api<UserProfile>('/auth/me');
        setMyEmail(profile?.email || null);
      } catch { /* stay anonymous */ }
    })();
  }, []);

  if (loading) {
    return <Center><Spin size="large" /></Center>;
  }

  if (notFound || !invitation) {
    return (
      <Center>
        <Card style={{ width: 420 }}>
          <Result
            icon={<CloseCircleOutlined style={{ color: '#ff4d4f' }} />}
            title="Invitation not found"
            subTitle="Check the link or code, or ask your gym to send a new invitation."
            extra={<Link to="/"><Button>Go to portal</Button></Link>}
          />
        </Card>
      </Center>
    );
  }

  const terminal = STATE_MESSAGES[invitation.status];
  if (terminal && !accepted) {
    return (
      <Center>
        <Card style={{ width: 420 }}>
          <Result icon={terminal.icon} title={terminal.title}
            subTitle={`${invitation.gymName} — ${invitation.memberName} (${invitation.email})`} />
        </Card>
      </Center>
    );
  }

  if (accepted) {
    return (
      <Center>
        <Card style={{ width: 440 }}>
          <Result
            status="success"
            title={`You're connected to ${invitation.gymName}`}
            subTitle="Your app account is now linked to your gym membership. Open the fitness app to see your gym."
            extra={<Link to="/"><Button type="primary">Open the portal</Button></Link>}
          />
        </Card>
      </Center>
    );
  }

  const emailMatches = myEmail != null &&
    myEmail.toLowerCase() === invitation.email.toLowerCase();

  const doAccept = async () => {
    try {
      await acceptInvitationByToken(token);
      setAccepted(true);
    } catch (e: any) {
      message.error(e.message || 'Could not accept the invitation');
    }
  };

  const doDecline = async () => {
    try {
      await declineInvitationByToken(token);
      message.info('Invitation declined');
      await refetchInvitation();
    } catch (e: any) {
      message.error(e.message || 'Could not decline');
    }
  };

  const refetchInvitation = async () => {
    try { setInvitation(await getInvitation(token)); } catch { /* ignore */ }
  };

  const doRegister = async () => {
    setRegistering(true);
    try {
      const v = await form.validateFields();
      await registerViaInvitation(token, v.name, v.password);
      setAccepted(true);
    } catch (e: any) {
      message.error(e.message || 'Could not create the account');
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Center>
      <Card style={{ width: 440 }}>
        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            Join {invitation.gymName}
          </Typography.Title>
          <Typography.Text type="secondary">
            Create your account to connect your gym membership.
          </Typography.Text>
        </div>
        <Typography.Paragraph style={{ textAlign: 'center' }}>
          <Tag color="blue">{invitation.memberName}</Tag>
          <Tag>{invitation.email}</Tag>
        </Typography.Paragraph>

        {mode === 'decide' && (
          <>
            {hasAccessToken() ? (
              emailMatches ? (
                <Button type="primary" size="large" block icon={<CheckCircleOutlined />} onClick={doAccept}>
                  Accept invitation
                </Button>
              ) : (
                <Typography.Paragraph type="warning" style={{ textAlign: 'center' }}>
                  You are signed in with a different account. Sign in as {invitation.email} to accept.
                </Typography.Paragraph>
              )
            ) : (
              <>
                <Button type="primary" size="large" block onClick={() => setMode('register')}>
                  Create Account
                </Button>
                <Divider plain style={{ color: 'rgba(255,255,255,0.4)' }}>or</Divider>
                <Typography.Paragraph style={{ textAlign: 'center', marginBottom: 8 }}>
                  Already use the fitness app? Sign in with <b>{invitation.email}</b>, then open this link again.
                </Typography.Paragraph>
                <Link to="/"><Button block>Go to sign in</Button></Link>
              </>
            )}
            <Divider />
            <Button type="text" danger block onClick={doDecline}>
              Decline this invitation
            </Button>
          </>
        )}

        {mode === 'register' && (
          <Form form={form} layout="vertical" onFinish={doRegister}>
            <Form.Item name="name" label="Your name" rules={[{ required: true, message: 'Name is required' }]}>
              <Input placeholder="Aman Kumar" />
            </Form.Item>
            <Form.Item label="Email">
              <Input value={invitation.email} disabled />
            </Form.Item>
            <Form.Item
              name="password"
              label="Password"
              rules={[
                { required: true, message: 'Password is required' },
                { min: 8, message: 'At least 8 characters' },
              ]}
            >
              <Input.Password placeholder="At least 8 characters" autoComplete="new-password" />
            </Form.Item>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button type="primary" htmlType="submit" block loading={registering}>
                Create account & connect
              </Button>
              <Button block disabled={registering} onClick={() => setMode('decide')}>Back</Button>
            </Space>
          </Form>
        )}
      </Card>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {children}
    </div>
  );
}
