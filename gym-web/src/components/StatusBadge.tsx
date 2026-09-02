// StatusBadge — one place that knows what every lifecycle status LOOKS like
// (members, staff, gyms). Pages never hardcode colors.
import React from 'react';
import { Tag } from 'antd';

const COLORS: Record<string, string> = {
  // shared
  ACTIVE: 'green',
  INACTIVE: 'orange',
  SUSPENDED: 'red',
  REMOVED: 'red',
  // member lifecycle
  PENDING: 'blue',
  FROZEN: 'gold',
  EXPIRED: 'default',
  CANCELLED: 'red',
};

export default function StatusBadge({ status }: { status: string }) {
  if (!status) return null;
  return <Tag color={COLORS[status] || 'default'}>{status}</Tag>;
}
