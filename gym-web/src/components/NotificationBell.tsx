// Header notification bell: unread badge + recent-notifications dropdown.
// Polls the unread count (45s) and refreshes on open; rows deep-link via
// notificationHref and are marked read when opened.
import React, { useState } from 'react';
import { Badge, Button, Dropdown, List, Typography, theme } from 'antd';
import { BellOutlined, RightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { listStaffNotifications, markStaffNotificationsRead, markAllStaffNotificationsRead, StaffNotification } from '../api/staffNotifications';
import { notificationHref } from '../utils/notificationLinks';
import useStaffNotifications from '../hooks/useStaffNotifications';

const SEVERITY_COLOR: Record<string, string> = {
  INFO: '#8c8c8c', SUCCESS: '#52c41a', WARNING: '#faad14', CRITICAL: '#ff4d4f',
};

export default function NotificationBell({ gymId, enabled }: { gymId?: string | null; enabled: boolean }) {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { unread, refresh } = useStaffNotifications(gymId, enabled);
  const [recent, setRecent] = useState<StaffNotification[] | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    if (!gymId) return;
    try { setRecent(await listStaffNotifications(gymId, { limit: 8 })); } catch { setRecent([]); }
  };

  const markOne = async (n: StaffNotification) => {
    if (!gymId) return;
    try { await markStaffNotificationsRead(gymId, [n.id]); } catch { /* next poll fixes */ }
    setRecent((prev) => prev?.map((r) => (r.id === n.id ? { ...r, is_read: true } : r)) ?? prev);
    refresh();
  };

  const openNotification = async (n: StaffNotification) => {
    setOpen(false);
    if (!n.is_read && gymId) {
      try { await markStaffNotificationsRead(gymId, [n.id]); } catch { /* badge refreshes on next poll */ }
    }
    refresh();
    const href = notificationHref(n);
    if (href) navigate(href);
  };

  // AntD: without onClick-preventDefault the Dropdown closes on the first
  // inner click and the button's onClick never fires (mark-all/rows died)
  const panel = (
    <div
      onClick={(e) => e.preventDefault()}
      style={{ width: 360, maxWidth: '86vw', background: '#141414', borderRadius: 8, padding: 12 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text strong>Notifications</Typography.Text>
        <Button size="small" type="link" onClick={() => { setOpen(false); navigate('/notifications'); }}>
          View all <RightOutlined />
        </Button>
      </div>
      {recent === null ? (
        <Typography.Text type="secondary">Loading…</Typography.Text>
      ) : recent.length === 0 ? (
        <Typography.Text type="secondary">You're all caught up.</Typography.Text>
      ) : (
        <List
          size="small"
          dataSource={recent}
          renderItem={(n) => (
            <List.Item
              style={{ cursor: 'pointer', padding: '8px 4px', borderRadius: 8 }}
              onClick={() => openNotification(n)}
              actions={!n.is_read ? [
                <Button key="mr" size="small" type="text"
                  onClick={(e) => { e.stopPropagation(); markOne(n); }}>
                  Mark read
                </Button>,
              ] : undefined}
            >
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {!n.is_read && (
                    <Badge color={SEVERITY_COLOR[n.severity] || SEVERITY_COLOR.INFO} text={null} />
                  )}
                  <Typography.Text strong={!n.is_read} style={{ fontSize: 13 }}>{n.title}</Typography.Text>
                </div>
                <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }} ellipsis={{ rows: 2 }}>
                  {n.message}
                </Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {timeAgo(n.created_at)}
                </Typography.Text>
              </div>
            </List.Item>
          )}
        />
      )}
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 6, display: 'flex', justifyContent: 'space-between' }}>
        <Button size="small" type="text" onClick={async () => {
          if (!gymId) return;
          try { await markAllStaffNotificationsRead(gymId); } catch { /* refresh still runs */ }
          load(); refresh();
        }}>Mark all as read</Button>
      </div>
    </div>
  );

  return (
    <Dropdown
      trigger={['click']}
      open={open}
      onOpenChange={(o) => { setOpen(o); if (o) load(); }}
      dropdownRender={() => panel}
    >
      <Badge count={unread} size="small" offset={[-2, 2]}>
        <Button
          type="text"
          shape="circle"
          aria-label="Notifications"
          icon={<BellOutlined style={{ color: '#fff', fontSize: 17 }} />}
          style={{
            background: 'rgba(255,255,255,0.14)',
            border: '1px solid rgba(255,255,255,0.30)',
          }}
        />
      </Badge>
    </Dropdown>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
