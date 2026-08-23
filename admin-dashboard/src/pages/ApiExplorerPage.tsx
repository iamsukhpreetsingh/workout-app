import React, { useEffect, useMemo, useState } from 'react';
import { Card, Table, Tag, Typography, Input, Button, Modal, Select, Space, message } from 'antd';
import { api } from '../api';

// ── The SECOND auto-discovery surface. This list comes live from
// GET /admin/api-registry, which reads the backend's registerRoute()
// metadata — new endpoints appear here automatically.

const METHOD_COLORS: Record<string, string> = { GET: 'green', POST: 'orange', PATCH: 'blue', PUT: 'geekblue', DELETE: 'red' };

interface RouteMeta { method: string; path: string; fullPath: string; description: string; requiresAuth: boolean; allowedRoles: string[]; category: string }

export default function ApiExplorerPage() {
  const [routes, setRoutes] = useState<RouteMeta[]>([]);
  const [filter, setFilter] = useState('');
  const [trying, setTrying] = useState<RouteMeta | null>(null);

  useEffect(() => { api('/api-registry').then(setRoutes).catch(() => {}); }, []);

  const byCategory = useMemo(() => {
    const f = filter.toLowerCase();
    const groups: Record<string, RouteMeta[]> = {};
    for (const r of routes) {
      if (f && !(`${r.method} ${r.fullPath} ${r.description}`.toLowerCase().includes(f))) continue;
      (groups[r.category] = groups[r.category] || []).push(r);
    }
    return groups;
  }, [routes, filter]);

  return (
    <div>
      <Typography.Title level={4}>API Explorer ({routes.length} endpoints)</Typography.Title>
      <Typography.Paragraph type="secondary">
        Live from the backend's route registry — endpoints registered with <code>registerRoute()</code> appear here automatically.
        GET endpoints offer a read-only "Try it"; mutating endpoints are documentation-only.
      </Typography.Paragraph>
      <Input.Search placeholder="Search method / path / description" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 360, marginBottom: 16 }} />
      {Object.entries(byCategory).map(([cat, rs]) => (
        <Card key={cat} size="small" title={cat} style={{ marginBottom: 12 }}>
          <Table
            size="small"
            pagination={false}
            rowKey={(r) => r.method + r.path}
            dataSource={rs}
            columns={[
              { title: 'Method', dataIndex: 'method', width: 90, render: (m) => <Tag color={METHOD_COLORS[m]}>{m}</Tag> },
              { title: 'Path', dataIndex: 'fullPath' },
              { title: 'Description', dataIndex: 'description', ellipsis: true },
              { title: 'Roles', dataIndex: 'allowedRoles', render: (roles: string[]) => (roles || []).map((r) => <Tag key={r}>{r}</Tag>) },
              {
                title: '',
                width: 90,
                render: (_: any, r: RouteMeta) =>
                  r.method === 'GET' ? <Button size="small" onClick={() => setTrying(r)}>Try it</Button> : <Typography.Text type="secondary" style={{ fontSize: 11 }}>docs only</Typography.Text>,
              },
            ]}
          />
        </Card>
      ))}
      {trying && <TryIt route={trying} onClose={() => setTrying(null)} />}
    </div>
  );
}

function TryIt({ route, onClose }: { route: RouteMeta; onClose: () => void }) {
  const [params, setParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState<string>('');
  const [msg, contextHolder] = message.useMessage();

  const pathParams = [...route.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]);

  const execute = async () => {
    let path = route.path;
    for (const [k, v] of Object.entries(params)) path = path.replace(`:${k}`, encodeURIComponent(v));
    const qs = query.trim() ? (query.trim().startsWith('?') ? query.trim() : `?${query.trim()}`) : '';
    try {
      const data = await api(`${path}${qs}`);
      setResponse(JSON.stringify(data, null, 2).slice(0, 5000));
    } catch (e: any) {
      msg.error(e.message);
      setResponse(`ERROR: ${e.message}`);
    }
  };

  return (
    <Modal open title={`Try it — GET ${route.path}`} onCancel={onClose} footer={null} width={720}>
      {contextHolder}
      {pathParams.length > 0 && (
        <Space wrap style={{ marginBottom: 12 }}>
          {pathParams.map((p) => (
            <Input key={p} placeholder={p} value={params[p] || ''} onChange={(e) => setParams({ ...params, [p]: e.target.value })} style={{ width: 220 }} />
          ))}
        </Space>
      )}
      <Input placeholder="?query=params" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
      <Button type="primary" onClick={execute} block>Execute as my admin session</Button>
      {response && (
        <pre style={{ marginTop: 12, background: '#111', padding: 12, borderRadius: 8, maxHeight: 380, overflow: 'auto', fontSize: 12 }}>
          {response}
        </pre>
      )}
    </Modal>
  );
}
