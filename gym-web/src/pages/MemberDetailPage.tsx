// Member detail — Overview tab is real (profile, edit, app-account
// linking); Membership / Payments / Attendance / Trainer / Documents are
// later-phase placeholders with their own sub-routes.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Descriptions, Tabs, Button, Tag, Drawer, Modal, Input, App as AntApp, Spin, Typography, Form,
} from 'antd';
import { EditOutlined, LinkOutlined, DisconnectOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useLocation, Navigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageContainer from '../components/PageContainer';
import StatusBadge from '../components/StatusBadge';
import { ErrorState, PermissionDenied, ComingSoon } from '../components/States';
import { MemberFormFields } from './MembersPage';
import { useGymContext, hasPermission } from '../permissions';
import { getMember, updateMember, linkMemberApp, unlinkMemberApp, GymMember } from '../api';

const MEMBER_TABS = ['overview', 'membership', 'payments', 'attendance', 'trainer', 'documents'];

export default function MemberDetailPage() {
  const { id } = useParams();
  const ctx = useGymContext();
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const [member, setMember] = useState<GymMember | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkEmail, setLinkEmail] = useState('');
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMember(await getMember(ctx!.gymId, id!));
    } catch (e: any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId, id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 24 }}><Spin /></div>;
  if (error) {
    return (
      <PageContainer title="Member" crumbs={[{ label: 'Home', to: '/' }, { label: 'Members', to: '/members' }, { label: 'Detail' }]}>
        <ErrorState error={error} onRetry={load} />
      </PageContainer>
    );
  }
  if (!member) return <Navigate to="/members" replace />;

  const name = [member.first_name, member.last_name].filter(Boolean).join(' ');
  const canManage = hasPermission(ctx, 'members.manage');
  const tab = location.pathname.split('/').filter(Boolean)[2] || 'overview';

  const submitEdit = async () => {
    try {
      const v = await form.validateFields();
      const updated = await updateMember(ctx!.gymId, member.id, {
        ...v,
        joined_at: v.joined_at ? v.joined_at.format('YYYY-MM-DD') : undefined,
      });
      setMember(updated);
      message.success('Member updated');
      setEditOpen(false);
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not update member');
    }
  };

  const submitLink = async () => {
    try {
      const updated = await linkMemberApp(ctx!.gymId, member.id, linkEmail.trim());
      setMember(updated);
      message.success('App account linked');
      setLinkOpen(false);
      setLinkEmail('');
    } catch (e: any) {
      message.error(e.message || 'Could not link app account');
    }
  };

  const confirmUnlink = () => {
    modal.confirm({
      title: 'Unlink the app account?',
      content: 'The member record and its history are kept — only the link to the app login is removed.',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const updated = await unlinkMemberApp(ctx!.gymId, member.id);
          setMember(updated);
          message.success('App account unlinked');
        } catch (e: any) {
          message.error(e.message || 'Could not unlink');
        }
      },
    });
  };

  const overview = (
    <>
      <Descriptions column={{ xs: 1, md: 2 }} bordered size="small">
        <Descriptions.Item label="Member code">{member.member_code}</Descriptions.Item>
        <Descriptions.Item label="Status"><StatusBadge status={member.status} /></Descriptions.Item>
        <Descriptions.Item label="Email">{member.email || '—'}</Descriptions.Item>
        <Descriptions.Item label="Phone">{member.phone || '—'}</Descriptions.Item>
        <Descriptions.Item label="Joined">{member.joined_at}</Descriptions.Item>
        <Descriptions.Item label="App account">
          {member.app_user_id
            ? <Tag color="blue">Linked</Tag>
            : <Tag>Not linked</Tag>}
        </Descriptions.Item>
        <Descriptions.Item label="Notes" span={2}>{member.notes || '—'}</Descriptions.Item>
      </Descriptions>
      {canManage && (
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            icon={<EditOutlined />}
            onClick={() => {
              form.setFieldsValue({
                ...member,
                joined_at: member.joined_at ? dayjs(member.joined_at) : undefined,
              });
              setEditOpen(true);
            }}
          >
            Edit
          </Button>
          {!member.app_user_id && (
            <Button icon={<LinkOutlined />} onClick={() => setLinkOpen(true)} disabled={!member.email}>
              Link app account
            </Button>
          )}
          {member.app_user_id && (
            <Button danger icon={<DisconnectOutlined />} onClick={confirmUnlink}>
              Unlink app account
            </Button>
          )}
          {!member.email && (
            <Typography.Text type="secondary">
              Add an email to link an app account.
            </Typography.Text>
          )}
        </div>
      )}

      <Drawer title="Edit member" width={420} open={editOpen} onClose={() => setEditOpen(false)}
        extra={<Button type="primary" onClick={submitEdit}>Save</Button>}>
        <MemberFormFields form={form} />
      </Drawer>
      <Modal
        title="Link app account"
        open={linkOpen}
        onOk={submitLink}
        onCancel={() => setLinkOpen(false)}
        okText="Link"
      >
        <Typography.Paragraph type="secondary">
          Matches the app account by EXACT email. The member record is linked, never duplicated.
        </Typography.Paragraph>
        <Input
          placeholder="member@email.com"
          value={linkEmail}
          onChange={(e) => setLinkEmail(e.target.value)}
        />
      </Modal>
    </>
  );

  const comingSoon = (what: string, phase: string, description: string) => (
    <ComingSoon phase={phase} title={what} description={description} />
  );

  return (
    <PageContainer
      title={name}
      subtitle={`Member ${member.member_code}`}
      crumbs={[
        { label: 'Home', to: '/' },
        { label: 'Members', to: '/members' },
        { label: name },
      ]}
      extra={<StatusBadge status={member.status} />}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => navigate(`/members/${member.id}${k === 'overview' ? '' : `/${k}`}`)}
        items={[
          { key: 'overview', label: 'Overview', children: overview },
          { key: 'membership', label: 'Membership', children: comingSoon(
              'Membership', 'Phase 1b',
              'Plan assignment, renewals, freeze/cancel and expiry tracking for this member arrive with the billing phase.') },
          { key: 'payments', label: 'Payments', children: comingSoon(
              'Payments', 'Phase 1b',
              'Recorded payments and receipts for this member arrive with the billing phase.') },
          { key: 'attendance', label: 'Attendance', children: comingSoon(
              'Attendance', 'Phase 1b',
              'Check-in/check-out history for this member arrives with the attendance phase.') },
          { key: 'trainer', label: 'Trainer', children: comingSoon(
              'Trainer assignment', 'Phase 2',
              'Assigning gym trainers to this member arrives with the coaching phase.') },
          { key: 'documents', label: 'Documents', children: comingSoon(
              'Documents', 'Phase 3',
              'Membership forms, ID documents and consent files arrive with the operations phase.') },
        ]}
      />
    </PageContainer>
  );
}

export { MEMBER_TABS };
