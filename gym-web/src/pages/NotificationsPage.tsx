// Staff Notification Center — the full inbox behind the header bell.
// Recipient-scoped (the server filters by the authenticated user), filterable
// by read state / category / severity, searchable (indexed title/message),
// offset-paginated (25 per page), with mark-read + mark-all-read and deep
// links to the underlying entity. One page for every notification type —
// new backend types appear here without UI changes.
import React, { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Badge, Button, List, Tabs, Tag, Typography } from 'antd';
import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import FilterBar from '../components/FilterBar';
import { useGymContext } from '../permissions';
import { hasPermission } from '../permissions';
import {
  listStaffNotifications, markStaffNotificationsRead, markAllStaffNotificationsRead,
  StaffNotification,
} from '../api/staffNotifications';
import { notificationHref } from '../utils/notificationLinks';

const PAGE_SIZE = 25;

// categories mirror the backend registry (extensible — unknown categories
// coming from future types still render fine)
const CATEGORIES = ['MEMBER', 'MEMBERSHIP', 'PAYMENT', 'ATTENDANCE', 'TRAINER',
  'WORKOUT', 'NUTRITION', 'CLASS', 'DOCUMENT', 'SYSTEM', 'SECURITY'];
const SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'CRITICAL'];
const SEVERITY_COLOR: Record<string, string> = {
  INFO: 'default', SUCCESS: 'green', WARNING: 'gold', CRITICAL: 'red',
};

export default function NotificationsPage() {
  const { message } = AntApp.useApp();
  const ctx = useGymContext();
  const navigate = useNavigate();

  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [category, setCategory] = useState<string | undefined>();
  const [severity, setSeverity] = useState<string | undefined>();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState(''); // debounced search
  const [rows, setRows] = useState<StaffNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (offset = 0, append = false) => {
    if (!ctx?.gymId) return;
    setLoading(true);
    if (!append) setError(null);
    try {
      const fresh = await listStaffNotifications(ctx.gymId, {
        unread: tab === 'unread' || undefined,
        category, severity, q: q.trim() || undefined,
        limit: PAGE_SIZE, offset,
      });
      setRows((prev) => (append && prev ? [...prev, ...fresh] : fresh));
    } catch (e: any) {
      setError(e.message || 'Could not load notifications');
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId, tab, category, severity, q]);

  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 400);
    return () => clearTimeout(t);
  }, [qInput]);
  useEffect(() => { load(0); }, [load]);

  const openRow = async (n: StaffNotification) => {
    if (busyId) return;
    setBusyId(n.id);
    try {
      if (!n.is_read && ctx?.gymId) {
        await markStaffNotificationsRead(ctx.gymId, [n.id]);
        setRows((prev) => prev?.map((r) => (r.id === n.id ? { ...r, is_read: true } : r)) ?? prev);
      }
    } catch { /* navigation proceeds regardless — read state catches up */ }
    setBusyId(null);
    const href = notificationHref(n);
    if (href) navigate(href);
  };

  const markOne = async (n: StaffNotification) => {
    if (!ctx?.gymId || n.is_read) return;
    try {
      await markStaffNotificationsRead(ctx.gymId, [n.id]);
      setRows((prev) => prev?.map((r) => (r.id === n.id ? { ...r, is_read: true } : r)) ?? prev);
    } catch (e: any) {
      message.error(e.message || 'Could not mark as read');
    }
  };

  const markAll = async () => {
    if (!ctx?.gymId) return;
    try {
      const { marked } = await markAllStaffNotificationsRead(ctx.gymId);
      message.info(marked ? `${marked} notification${marked === 1 ? '' : 's'} marked as read` : 'No unread notifications');
      load(0);
    } catch (e: any) {
      message.error(e.message || 'Could not mark as read');
    }
  };

  const canSeeStaff = hasPermission(ctx, 'staff.manage');
  const hasMore = (rows?.length || 0) >= PAGE_SIZE && (rows?.length || 0) % PAGE_SIZE === 0;

  return (
    <PageContainer
      title="Notifications"
      extra={
        <>
          <Button icon={<ReloadOutlined />} onClick={() => load(0)} loading={loading} />
          <Button onClick={markAll} disabled={!rows?.some((r) => !r.is_read)}>Mark all as read</Button>
        </>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={(v) => setTab(v as 'all' | 'unread')}
        items={[
          { key: 'all', label: 'All' },
          { key: 'unread', label: 'Unread' },
        ]}
        style={{ marginBottom: 8 }}
      />
      <FilterBar
        searchPlaceholder="Search notifications…"
        q={qInput}
        onQ={setQInput}
        filter={{
          placeholder: 'Category',
          value: category,
          onChange: (v) => setCategory(v),
          options: CATEGORIES.map((c) => ({ value: c, label: c })),
        }}
        secondFilter={{
          placeholder: 'Severity',
          value: severity,
          onChange: (v) => setSeverity(v),
          options: SEVERITIES.map((s) => ({ value: s, label: s })),
        }}
      />
      {error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : rows === null ? (
        <Typography.Text type="secondary">Loading…</Typography.Text>
      ) : rows.length === 0 ? (
        <Typography.Text type="secondary">
          {tab === 'unread' ? 'No unread notifications.' : "You're all caught up."}
          {category && ' — no notifications in this category either.'}
        </Typography.Text>
      ) : (
        <>
          <List
            dataSource={rows}
            renderItem={(n) => <NotificationRow n={n} onOpen={openRow} onMarkRead={markOne} busy={busyId === n.id} canSeeStaff={canSeeStaff} />}
          />
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Button onClick={() => load(rows!.length, true)} loading={loading}>Load more</Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}

function NotificationRow({ n, onOpen, onMarkRead, busy, canSeeStaff }: {
  n: StaffNotification; onOpen: (n: StaffNotification) => void;
  onMarkRead: (n: StaffNotification) => void; busy: boolean; canSeeStaff: boolean;
}) {
  const href = notificationHref(n);
  const staffOnly = (n.entity_type === 'STAFF' || n.entity_type === 'SECURITY') && !canSeeStaff;
  const clickable = !!href && !staffOnly;
  return (
    <List.Item
      style={{
        cursor: clickable ? 'pointer' : 'default',
        borderRadius: 10, padding: '12px 14px', marginBottom: 8,
        background: n.is_read ? 'transparent' : 'rgba(250, 173, 20, 0.06)',
        border: `1px solid ${n.is_read ? 'rgba(255,255,255,0.08)' : 'rgba(250, 173, 20, 0.35)'}`,
      }}
      onClick={clickable ? () => onOpen(n) : undefined}
      actions={[
        ...(!n.is_read ? [<Button key="mr" size="small" type="text"
          onClick={(e) => { e.stopPropagation(); onMarkRead(n); }}>Mark read</Button>] : []),
        ...(clickable ? [<Button key="open" size="small" type="text">View</Button>] : []),
      ]}
    >
      <div style={{ width: '100%' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {!n.is_read && <Badge status="warning" />}
          <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}>{n.category}</Tag>
          <Tag color={SEVERITY_COLOR[n.severity]} style={{ fontSize: 10, marginInlineEnd: 0 }}>
            {n.severity}
          </Tag>
          <Typography.Text strong={!n.is_read} style={{ fontSize: 13.5 }}>{n.title}</Typography.Text>
        </div>
        <Typography.Paragraph style={{ margin: '4px 0 2px', fontSize: 12.5 }} type={n.is_read ? 'secondary' : undefined}>
          {n.message}
        </Typography.Paragraph>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {n.member_name && (
            <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
              {n.member_name}{n.member_code ? ` · ${n.member_code}` : ''}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>{timeAgo(n.created_at)}</Typography.Text>
          {n.is_read && n.read_at && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              <CheckOutlined /> read
            </Typography.Text>
          )}
          {!clickable && n.member_id && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              linked member record
            </Typography.Text>
          )}
        </div>
      </div>
    </List.Item>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
