// PageContainer — standard page scaffold (title, description, actions).
import React from 'react';
import { Typography, Space, Breadcrumb } from 'antd';
import { Link } from 'react-router-dom';

interface Crumb {
  label: string;
  to?: string;
}

export default function PageContainer({ title, subtitle, extra, crumbs, children }: {
  title: string;
  subtitle?: string;
  extra?: React.ReactNode;
  crumbs?: Crumb[];
  children: React.ReactNode;
}) {
  return (
    <div style={{ padding: 24 }}>
      {crumbs && crumbs.length > 0 && (
        <Breadcrumb
          style={{ marginBottom: 8 }}
          items={crumbs.map((c, i) => ({
            key: i,
            title: c.to ? <Link to={c.to}>{c.label}</Link> : c.label,
          }))}
        />
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <Typography.Title level={3} style={{ margin: 0 }}>{title}</Typography.Title>
          {subtitle && <Typography.Text type="secondary">{subtitle}</Typography.Text>}
        </div>
        {extra && <Space wrap>{extra}</Space>}
      </div>
      {children}
    </div>
  );
}
