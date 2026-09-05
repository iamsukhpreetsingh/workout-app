// AnnouncementsPage (Phase 14) — gym staff surface for announcements:
// create DRAFT/SCHEDULED (audience ALL / SPECIFIC members / branch label),
// edit before send, publish now, cancel, trigger the due dispatcher, and
// inspect the per-recipient delivery ledger (the honest record of what
// actually went out on IN_APP / PUSH / EMAIL).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, DatePicker, Drawer, Form, Input, Modal, Popconfirm,
  Radio, Select, Space, Table, Tag, Typography,
} from 'antd';
import {
  EditOutlined, ReloadOutlined, SendOutlined, StopOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import {
  Announcement, AnnouncementDetail, AudienceType, cancelAnnouncement,
  createAnnouncement, dispatchDueAnnouncements, getAnnouncement,
  listAnnouncements, publishAnnouncement, updateAnnouncement,
} from '../api/announcements';
import { GymMember, searchMembers } from '../api/members';

const STATUS_COLORS: Record<string, string> = {
  DRAFT: 'default', SCHEDULED: 'blue', SENT: 'green', CANCELLED: 'red',
  QUEUED: 'gold', FAILED: 'red', SKIPPED: 'orange',
};

const CHANNEL_LABELS: Record<string, string> = {
  IN_APP: 'In-app', PUSH: 'Push', EMAIL: 'Email',
};

interface FormValues {
  title: string;
  body: string;
  audience_type: AudienceType;
  audience_member_ids?: string[];
  audience_branch?: string;
  scheduled_for?: any; // dayjs or null
}

export default function AnnouncementsPage({ gymId }: { gymId: string }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [detail, setDetail] = useState<AnnouncementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [memberOptions, setMemberOptions] = useState<GymMember[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [form] = Form.useForm<FormValues>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listAnnouncements(gymId));
    } catch (e: any) {
      setError(e.message || 'Could not load announcements');
    } finally {
      setLoading(false);
    }
  }, [gymId]);

  useEffect(() => { load(); }, [load]);

  // member picker options (search-as-you-type; backend gym-scoped)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const found = await searchMembers(gymId, memberSearch || ' ', 20);
        if (alive) setMemberOptions(found);
      } catch { /* picker stays as-is on failure */ }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [gymId, memberSearch]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ audience_type: 'ALL_ACTIVE_MEMBERS' });
    setEditorOpen(true);
  };

  const openEdit = (a: Announcement) => {
    setEditing(a);
    form.setFieldsValue({
      title: a.title,
      body: a.body,
      audience_type: a.audience_type,
      audience_member_ids: a.audience_member_ids || [],
      audience_branch: a.audience_branch || undefined,
      scheduled_for: a.scheduled_for_local || undefined,
    });
    setEditorOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const payload: any = {
      title: v.title,
      body: v.body,
      audience_type: v.audience_type,
    };
    if (v.audience_type === 'SPECIFIC_MEMBERS') payload.audience_member_ids = v.audience_member_ids;
    if (v.audience_type === 'SPECIFIC_BRANCH') payload.audience_branch = v.audience_branch;
    if (v.scheduled_for) payload.scheduled_for = v.scheduled_for.format('YYYY-MM-DD HH:mm');
    try {
      if (editing) {
        await updateAnnouncement(gymId, editing.id, payload);
        message.success('Announcement updated');
      } else {
        const created = await createAnnouncement(gymId, payload);
        message.success(created.status === 'SCHEDULED'
          ? 'Announcement scheduled — it dispatches automatically at its due time'
          : 'Draft created');
      }
      setEditorOpen(false);
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not save the announcement');
    }
  };

  const publish = async (a: Announcement) => {
    try {
      const out = await publishAnnouncement(gymId, a.id);
      message.success(`Sent — ${out.delivery_summary?.sent ?? 0} delivered, ${out.delivery_summary?.skipped ?? 0} skipped`);
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not send');
    }
  };

  const cancel = async (a: Announcement) => {
    try {
      await cancelAnnouncement(gymId, a.id);
      message.success('Announcement cancelled');
      await load();
    } catch (e: any) {
      message.error(e.message || 'Could not cancel');
    }
  };

  const dispatchDue = async () => {
    try {
      const out = await dispatchDueAnnouncements(gymId);
      message.success(out.dispatched + out.rescued > 0
        ? `Dispatched ${out.dispatched} scheduled, finished ${out.rescued} interrupted`
        : 'Nothing due right now');
      await load();
    } catch (e: any) {
      message.error(e.message || 'Dispatch failed');
    }
  };

  const openDetail = async (a: Announcement) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await getAnnouncement(gymId, a.id));
    } catch (e: any) {
      message.error(e.message || 'Could not load the delivery ledger');
    } finally {
      setDetailLoading(false);
    }
  };

  const audienceText = useCallback((a: Announcement) => {
    if (a.audience_type === 'SPECIFIC_BRANCH') return `Branch: ${a.audience_branch}`;
    if (a.audience_type === 'SPECIFIC_MEMBERS') {
      const n = Array.isArray(a.audience_member_ids) ? a.audience_member_ids.length : 0;
      return `${n} selected member${n === 1 ? '' : 's'}`;
    }
    return `All active members${a.current_audience_size != null ? ` (${a.current_audience_size})` : ''}`;
  }, []);

  const columns = useMemo(() => [
    {
      title: 'Title', dataIndex: 'title', key: 'title',
      render: (_: any, a: Announcement) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{a.title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {audienceText(a)} · by {a.created_by_name || '—'}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Status', dataIndex: 'status', key: 'status', width: 120,
      render: (s: string) => <Tag color={STATUS_COLORS[s]}>{s}</Tag>,
    },
    {
      title: 'When', key: 'when', width: 170,
      render: (_: any, a: Announcement) => (
        a.status === 'SENT'
          ? (a.published_at_local || '—')
          : a.status === 'SCHEDULED'
            ? (a.scheduled_for_local || '—')
            : '—'
      ),
    },
    {
      title: 'Delivered', key: 'counts', width: 180,
      render: (_: any, a: Announcement) => (
        <Space size={4} wrap>
          <Tag color="green">✓ {a.sent_count ?? 0}</Tag>
          <Tag color="orange">skip {a.skipped_count ?? 0}</Tag>
          {(a.failed_count ?? 0) > 0 && <Tag color="red">fail {a.failed_count}</Tag>}
          {(a.queued_count ?? 0) > 0 && <Tag color="gold">q {a.queued_count}</Tag>}
        </Space>
      ),
    },
    {
      title: 'Actions', key: 'actions', width: 260,
      render: (_: any, a: Announcement) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => openDetail(a)}>Ledger</Button>
          {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && (
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(a)}>Edit</Button>
          )}
          {a.status === 'DRAFT' && (
            <Popconfirm title="Resolve the audience now and send?" onConfirm={() => publish(a)}>
              <Button size="small" type="link" icon={<SendOutlined />}>Send now</Button>
            </Popconfirm>
          )}
          {(a.status === 'DRAFT' || a.status === 'SCHEDULED') && (
            <Popconfirm title="Cancel this announcement?" onConfirm={() => cancel(a)}>
              <Button size="small" type="link" danger icon={<StopOutlined />}>Cancel</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [audienceText, rows]);

  return (
    <PageContainer
      title="Communications"
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Communications' }]}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>
          <Popconfirm title="Send every SCHEDULED announcement whose time has passed?" onConfirm={dispatchDue}>
            <Button icon={<ThunderboltOutlined />}>Dispatch due</Button>
          </Popconfirm>
          <Button type="primary" onClick={openCreate}>New announcement</Button>
        </Space>
      }
    >
      {error && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={error}
          action={<Button onClick={load}>Retry</Button>} />
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rows}
        columns={columns as any}
        locale={{ emptyText: 'No announcements yet — create one to reach your members (app inbox for connected members, email for the rest).' }}
        scroll={{ x: 900 }}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
      />

      <Modal
        open={editorOpen}
        title={editing ? 'Edit announcement' : 'New announcement'}
        onCancel={() => setEditorOpen(false)}
        onOk={submit}
        okText={editing ? 'Save' : 'Create'}
        destroyOnClose
        width={640}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="Title" rules={[
            { required: true, message: 'Title is required' },
            { max: 200, message: 'Max 200 characters' },
          ]}>
            <Input placeholder="Gym closure on Sunday" maxLength={200} />
          </Form.Item>
          <Form.Item name="body" label="Message" rules={[
            { required: true, message: 'Message is required' },
            { max: 5000, message: 'Max 5000 characters' },
          ]}>
            <Input.TextArea rows={4} placeholder="The gym will be closed this Sunday for maintenance." maxLength={5000} showCount />
          </Form.Item>
          <Form.Item name="audience_type" label="Audience">
            <Radio.Group>
              <Radio value="ALL_ACTIVE_MEMBERS">All active members</Radio>
              <Radio value="SPECIFIC_MEMBERS">Specific members</Radio>
              <Radio value="SPECIFIC_BRANCH">Branch</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(p, c) => p.audience_type !== c.audience_type}>
            {({ getFieldValue }) => getFieldValue('audience_type') === 'SPECIFIC_MEMBERS' ? (
              <Form.Item name="audience_member_ids" label="Members" rules={[
                { required: true, message: 'Pick at least one member' },
              ]}>
                <Select
                  mode="multiple"
                  showSearch
                  filterOption={false}
                  placeholder="Search members by name / code / phone"
                  onSearch={setMemberSearch}
                  options={memberOptions.map((m) => ({
                    value: m.id,
                    label: `${m.first_name}${m.last_name ? ` ${m.last_name}` : ''} · ${m.member_code}`,
                  }))}
                />
              </Form.Item>
            ) : getFieldValue('audience_type') === 'SPECIFIC_BRANCH' ? (
              <Form.Item name="audience_branch" label="Branch label" rules={[
                { required: true, message: 'Branch label is required' },
              ]}>
                <Input placeholder="North Wing" maxLength={120} />
              </Form.Item>
            ) : null}
          </Form.Item>
          <Form.Item
            name="scheduled_for"
            label="Schedule (gym-local time)"
            extra="Leave empty to keep it as a draft. Scheduled announcements dispatch automatically when due."
          >
            <DatePicker showTime={{ format: 'HH:mm' }} format="YYYY-MM-DD HH:mm" style={{ width: 240 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={!!detail || detailLoading}
        width={720}
        onClose={() => setDetail(null)}
        title={detail ? `Delivery ledger — ${detail.title}` : 'Delivery ledger'}
      >
        {detail && (
          <>
            <Space size={8} wrap style={{ marginBottom: 12 }}>
              <Tag color={STATUS_COLORS[detail.status]}>{detail.status}</Tag>
              <Typography.Text type="secondary">{audienceText(detail)}</Typography.Text>
              {detail.body && (
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  {detail.body}
                </Typography.Paragraph>
              )}
            </Space>
            <Table
              rowKey="id"
              size="small"
              dataSource={detail.deliveries}
              pagination={{ pageSize: 15, hideOnSinglePage: true }}
              scroll={{ x: 700 }}
              columns={[
                {
                  title: 'Member', key: 'member',
                  render: (_: any, d: any) => `${d.first_name}${d.last_name ? ` ${d.last_name}` : ''} · ${d.member_code}`,
                },
                { title: 'Channel', dataIndex: 'channel', width: 90,
                  render: (c: string) => CHANNEL_LABELS[c] || c },
                { title: 'Status', dataIndex: 'status', width: 100,
                  render: (s: string) => <Tag color={STATUS_COLORS[s]}>{s}</Tag> },
                { title: 'Detail', dataIndex: 'detail', ellipsis: true },
                { title: 'Sent at', dataIndex: 'sent_at', width: 160,
                  render: (v: string | null) => (v ? new Date(v).toLocaleString() : '—') },
              ] as any}
            />
          </>
        )}
      </Drawer>
    </PageContainer>
  );
}
