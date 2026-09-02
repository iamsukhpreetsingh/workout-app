// Shared page states: empty, error (incl. network failure), permission
// denied, and the "arrives in a later phase" placeholder. Every list page
// composes these through DataTable; every route guard can render
// PermissionDenied directly.
import React from 'react';
import { Alert, Button, Empty, Result, Typography } from 'antd';
import {
  ReloadOutlined, StopOutlined, ClockCircleOutlined, WifiOutlined,
} from '@ant-design/icons';

export function EmptyState({ title, description, action }: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Empty
      style={{ padding: '40px 0' }}
      description={
        <>
          <Typography.Text strong>{title}</Typography.Text>
          {description && (
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {description}
            </Typography.Paragraph>
          )}
        </>
      }
    >
      {action}
    </Empty>
  );
}

export function isNetworkError(e: any): boolean {
  return e instanceof TypeError || /failed to fetch|network/i.test(String(e?.message || ''));
}

export function ErrorState({ error, onRetry }: { error: any; onRetry?: () => void }) {
  const network = isNetworkError(error);
  return (
    <Alert
      type="error"
      showIcon
      icon={<WifiOutlined spin={false} />}
      message={network ? 'Network error' : 'Something went wrong'}
      description={network
        ? 'Could not reach the server. Check your connection and try again.'
        : String(error?.message || error || 'Unexpected error')}
      action={onRetry && (
        <Button icon={<ReloadOutlined />} onClick={onRetry}>Retry</Button>
      )}
      style={{ margin: '16px 0' }}
    />
  );
}

export function PermissionDenied({ permission }: { permission: string }) {
  return (
    <Result
      icon={<StopOutlined style={{ color: '#faad14' }} />}
      title="Permission denied"
      subTitle={`Your gym role does not include "${permission}". Ask the gym owner if you need access.`}
    />
  );
}

// Placeholder for a section that belongs to a later phase of the Gym
// Management System. Deliberately has NO fake data and NO dead CTAs.
export function ComingSoon({ phase, title, description }: {
  phase: string;
  title: string;
  description: string;
}) {
  return (
    <Empty
      style={{ padding: '48px 0' }}
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div style={{ maxWidth: 460, margin: '0 auto' }}>
          <Typography.Text strong style={{ fontSize: 16 }}>
            <ClockCircleOutlined style={{ marginRight: 8 }} />
            {title} — coming in {phase}
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
            {description}
          </Typography.Paragraph>
        </div>
      }
    />
  );
}
