// Member detail — Overview is real (profile, edit, app-connection card with
// invite / cancel-invite / link / unlink, membership card with leave /
// reactivate). Membership, Payments, Attendance, Trainer, Workouts,
// Nutrition, Documents and Activity tabs are later-phase placeholders with
// their own sub-routes. Everything here works with appUserId = NULL.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Descriptions, Tabs, Button, Drawer, Modal, Input, App as AntApp, Spin,
  Typography, Card, Space, Popconfirm, Form, Tag, Select,
} from 'antd';
import {
  EditOutlined, LinkOutlined, DisconnectOutlined, UserAddOutlined,
  PlayCircleOutlined, UserDeleteOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams, useLocation, Navigate } from 'react-router-dom';
import dayjs from 'dayjs';
import PageContainer from '../components/PageContainer';
import StatusBadge from '../components/StatusBadge';
import { ErrorState, ComingSoon } from '../components/States';
import { MemberFormFields, memberFormToPayload, AppConnectionTag } from './MembersPage';
import MemberMembershipTab from '../components/MemberMembershipTab';
import MemberTrainerTab from '../components/MemberTrainerTab';
import MemberPaymentsTab from '../components/MemberPaymentsTab';
import MemberAttendanceTab from '../components/MemberAttendanceTab';
import MemberWorkoutsTab from '../components/MemberWorkoutsTab';
import MemberNutritionTab from '../components/MemberNutritionTab';
import { useGymContext, hasPermission } from '../permissions';
import {
  getMember, updateMember, linkMemberApp, unlinkMemberApp,
  cancelMember, reactivateMember, inviteMemberApp, cancelMemberInvite,
  listBranches, setMemberBranches, transferMemberBranch, memberBranchHistory,
  Branch, BranchTransfer, GymMember,
} from '../api';

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
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [branchOptions, setBranchOptions] = useState<Branch[]>([]);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchPrimary, setBranchPrimary] = useState<string | undefined>(undefined);
  const [branchAllowed, setBranchAllowed] = useState<string[]>([]);
  const [transferTo, setTransferTo] = useState<string | undefined>(undefined);
  const [transferReason, setTransferReason] = useState('');
  const [transfers, setTransfers] = useState<BranchTransfer[]>([]);

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

  // Phase 16: branch options + transfer history for the branch card
  React.useEffect(() => {
    if (!ctx?.gymId || !id) return;
    listBranches(ctx.gymId).then(setBranchOptions).catch(() => setBranchOptions([]));
    memberBranchHistory(ctx.gymId, id).then(setTransfers).catch(() => setTransfers([]));
  }, [ctx?.gymId, id]);

  const openBranchEditor = () => {
    setBranchPrimary(member?.primary_branch_id || undefined);
    setBranchAllowed(((member?.allowed_branch_ids as string[]) || []).filter(Boolean));
    setTransferTo(undefined);
    setTransferReason('');
    setBranchOpen(true);
  };

  const saveBranches = async () => {
    try {
      await setMemberBranches(ctx!.gymId, member!.id, {
        primary_branch_id: branchPrimary || null,
        allowed_branch_ids: branchAllowed,
      });
      message.success('Branch setup saved');
      setBranchOpen(false);
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not save the branch setup');
    }
  };

  const doTransfer = async () => {
    if (!transferTo) {
      message.warning('Pick the branch to transfer to');
      return;
    }
    try {
      await transferMemberBranch(ctx!.gymId, member!.id,
        { to_branch_id: transferTo, reason: transferReason.trim() || undefined });
      message.success('Member transferred — the move is recorded in the branch history');
      setBranchOpen(false);
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not transfer the member');
    }
  };

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
      const updated = await updateMember(ctx!.gymId, member.id, memberFormToPayload(v));
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

  const doInvite = async () => {
    try {
      const result = await inviteMemberApp(ctx!.gymId, member.id);
      setInviteCode(result.invite_code);
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not create invitation');
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title="Profile">
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="Member ID">{member.member_code}</Descriptions.Item>
          <Descriptions.Item label="Phone">{member.phone || '—'}</Descriptions.Item>
          <Descriptions.Item label="Email">{member.email || '—'}</Descriptions.Item>
          <Descriptions.Item label="Date of birth">{member.date_of_birth || '—'}</Descriptions.Item>
          <Descriptions.Item label="Gender">{member.gender || '—'}</Descriptions.Item>
          <Descriptions.Item label="Joined">{member.joined_at}</Descriptions.Item>
          <Descriptions.Item label="Emergency contact">
            {member.emergency_contact_name
              ? `${member.emergency_contact_name}${member.emergency_contact_phone ? ` · ${member.emergency_contact_phone}` : ''}`
              : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Notes">{member.notes || '—'}</Descriptions.Item>
        </Descriptions>
        {canManage && (
          <Button
            icon={<EditOutlined />}
            style={{ marginTop: 12 }}
            onClick={() => {
              form.setFieldsValue({
                ...member,
                joined_at: member.joined_at ? dayjs(member.joined_at) : undefined,
                date_of_birth: member.date_of_birth ? dayjs(member.date_of_birth) : undefined,
              });
              setEditOpen(true);
            }}
          >
            Edit details
          </Button>
        )}
      </Card>

      <Card
        size="small"
        title="Branch"
        extra={canManage && (
          <Button icon={<EditOutlined />} size="small" onClick={openBranchEditor}>
            Edit branches
          </Button>
        )}
      >
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="Primary branch">
            {(() => {
              const b = branchOptions.find((x) => x.id === member.primary_branch_id);
              if (!member.primary_branch_id) {
                return <Tag>All locations (no branch)</Tag>;
              }
              return <Tag color="blue">{b?.name || member.branch || 'Unknown'}</Tag>;
            })()}
          </Descriptions.Item>
          <Descriptions.Item label="Allowed branches">
            {(member.allowed_branch_ids || []).length ? (
              (member.allowed_branch_ids as string[]).map((bid) => {
                const b = branchOptions.find((x) => x.id === bid);
                return <Tag key={bid}>{b?.name || 'Branch'}</Tag>;
              })
            ) : member.primary_branch_id ? (
              <Typography.Text type="secondary">Primary only</Typography.Text>
            ) : (
              <Typography.Text type="secondary">All branches (legacy)</Typography.Text>
            )}
          </Descriptions.Item>
          {transfers.length > 0 && (
            <Descriptions.Item label="Transfer history" span={2}>
              {transfers.map((t) => (
                <div key={t.id} style={{ fontSize: 12 }}>
                  {String(t.created_at).slice(0, 10)}:{' '}
                  {t.from_branch_name || '—'} → {t.to_branch_name || '—'}
                  {t.reason ? ` · ${t.reason}` : ''}
                </div>
              ))}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Modal
        title="Branch setup"
        open={branchOpen}
        onCancel={() => setBranchOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setBranchOpen(false)}>Cancel</Button>,
          <Button key="save" type="primary" onClick={saveBranches}>Save</Button>,
        ]}
        destroyOnClose
      >
        <Typography.Paragraph type="secondary">
          The primary branch is the member's home. Allowed branches grant
          multi-club check-in. No primary = all branches (legacy behavior).
        </Typography.Paragraph>
        <Typography.Text strong>Primary branch</Typography.Text>
        <Select
          style={{ width: '100%', marginTop: 4, marginBottom: 16 }}
          allowClear
          placeholder="No primary branch (all locations)"
          value={branchPrimary}
          onChange={setBranchPrimary}
          options={branchOptions.filter((b) => b.status === 'ACTIVE').map((b) => ({
            value: b.id, label: b.name,
          }))}
        />
        <Typography.Text strong>Allowed branches (multi-club access)</Typography.Text>
        <Select
          mode="multiple"
          style={{ width: '100%', marginTop: 4 }}
          placeholder="Additional branches this member may use…"
          value={branchAllowed}
          onChange={setBranchAllowed}
          options={branchOptions
            .filter((b) => b.id !== branchPrimary)
            .map((b) => ({ value: b.id, label: b.name }))}
        />
        <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <Typography.Text strong>Transfer to another branch</Typography.Text>
          <Select
            style={{ width: '100%', marginTop: 4, marginBottom: 8 }}
            allowClear
            placeholder="Pick a branch…"
            value={transferTo}
            onChange={setTransferTo}
            options={branchOptions
              .filter((b) => b.status === 'ACTIVE' && b.id !== branchPrimary)
              .map((b) => ({ value: b.id, label: b.name }))}
          />
          <Input
            placeholder="Reason (optional) — e.g. moved cities"
            value={transferReason}
            onChange={(e) => setTransferReason(e.target.value)}
          />
          <Button style={{ marginTop: 8 }} onClick={doTransfer}>
            Transfer & record history
          </Button>
        </div>
      </Modal>

      <Card size="small" title="Membership">
        <Space wrap align="center">
          <StatusBadge status={member.status} />
          {canManage && member.status === 'ACTIVE' && (
            <Popconfirm
              title="Mark this member as having left?"
              description="The record and its history are kept — the membership becomes CANCELLED."
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                try {
                  setMember(await cancelMember(ctx!.gymId, member.id));
                  message.success('Membership cancelled');
                } catch (e: any) { message.error(e.message || 'Could not cancel'); }
              }}
            >
              <Button danger icon={<UserDeleteOutlined />}>Member left</Button>
            </Popconfirm>
          )}
          {canManage && member.status !== 'ACTIVE' && (
            <Button icon={<PlayCircleOutlined />} onClick={async () => {
              try {
                setMember(await reactivateMember(ctx!.gymId, member.id));
                message.success('Membership reactivated');
              } catch (e: any) { message.error(e.message || 'Could not reactivate'); }
            }}>
              Reactivate
            </Button>
          )}
        </Space>
      </Card>

      <Card size="small" title="App connection">
        <Space wrap align="center">
          <AppConnectionTag connection={member.app_connection} />
          {canManage && member.app_connection === 'NOT_CONNECTED' && (
            <>
              <Button icon={<UserAddOutlined />} onClick={doInvite} disabled={!member.email}>
                Invite to app
              </Button>
              <Button icon={<LinkOutlined />} onClick={() => setLinkOpen(true)} disabled={!member.email}>
                Link app account
              </Button>
            </>
          )}
          {canManage && member.app_connection === 'INVITATION_PENDING' && (
            <>
              <Button icon={<UserAddOutlined />} onClick={doInvite}>Re-invite</Button>
              <Button danger icon={<DisconnectOutlined />} onClick={async () => {
                try {
                  await cancelMemberInvite(ctx!.gymId, member.id);
                  message.success('Invitation withdrawn');
                  await load();
                } catch (e: any) { message.error(e.message || 'Could not withdraw'); }
              }}>
                Withdraw invite
              </Button>
            </>
          )}
          {canManage && member.app_connection === 'CONNECTED' && (
            <Button danger icon={<DisconnectOutlined />} onClick={confirmUnlink}>
              Unlink app account
            </Button>
          )}
          {canManage && !member.email && member.app_connection !== 'CONNECTED' && (
            <Typography.Text type="secondary">
              Add an email to invite or link an app account.
            </Typography.Text>
          )}
        </Space>
        {member.app_connection === 'INVITATION_PENDING' && member.app_invite_sent_at && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Invited {String(member.app_invite_sent_at).slice(0, 10)}
          </Typography.Paragraph>
        )}
      </Card>

      <Drawer title="Edit member" width={440} open={editOpen} onClose={() => setEditOpen(false)}
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
        <Input placeholder="member@email.com" value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} />
      </Modal>

      <Modal
        title="Invitation created"
        open={!!inviteCode}
        onOk={() => setInviteCode(null)}
        onCancel={() => setInviteCode(null)}
        okText="Done"
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Typography.Paragraph type="secondary">
          Share this one-time code with the member. It is shown only once — for privacy, only its
          hash is stored.{member.email ? ` An email was attempted to ${member.email} if SMTP is configured.` : ''}
        </Typography.Paragraph>
        <Typography.Paragraph copyable style={{ fontSize: 16, marginBottom: 0 }}>
          {inviteCode}
        </Typography.Paragraph>
      </Modal>
    </div>
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
      extra={<Space><StatusBadge status={member.status} /><AppConnectionTag connection={member.app_connection} /></Space>}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => navigate(`/members/${member.id}${k === 'overview' ? '' : `/${k}`}`)}
        items={[
          { key: 'overview', label: 'Overview', children: overview },
          { key: 'membership', label: 'Membership', children: <MemberMembershipTab memberId={member.id} /> },
          { key: 'payments', label: 'Payments', children: <MemberPaymentsTab memberId={member.id} /> },
          { key: 'attendance', label: 'Attendance', children: <MemberAttendanceTab memberId={member.id} /> },
          { key: 'trainer', label: 'Trainer', children: <MemberTrainerTab memberId={member.id} /> },
          { key: 'workouts', label: 'Workouts', children: <MemberWorkoutsTab memberId={member.id} /> },
          { key: 'nutrition', label: 'Nutrition', children: <MemberNutritionTab memberId={member.id} /> },
          { key: 'documents', label: 'Documents', children: comingSoon(
              'Documents', 'Phase 3',
              'Membership forms, ID documents and consent files arrive with the operations phase.') },
          { key: 'activity', label: 'Activity', children: comingSoon(
              'Activity', 'Phase 1b',
              'A timeline of this member\u2019s memberships, payments and visits arrives with later phases.') },
        ]}
      />
    </PageContainer>
  );
}
