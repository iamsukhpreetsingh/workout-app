import React, { useEffect, useState } from 'react';
import { Card, Table, Tag, Button, Select, Space, Modal, Input, message, Typography } from 'antd';
import { api } from '../api';

export default function ContentPage() {
  const [reports, setReports] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [status, setStatus] = useState('open');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, contextHolder] = message.useMessage();

  const load = async () => {
    setReports(await api(`/content/reports?status=${status}`));
    setTags(await api('/content/tags'));
  };
  useEffect(() => { load(); }, [status]); // eslint-disable-line

  const resolve = async (id: string, s: string) => {
    await api(`/content/reports/${id}`, { method: 'PATCH', body: { status: s } });
    msg.success(`Report ${s}`);
    load();
  };

  const removeContent = async (type: string, id: string) => {
    await api(`/content/${type}/${id}`, { method: 'DELETE' });
    msg.success('Removed platform-wide (audited)');
    load();
  };

  const merge = async () => {
    try {
      const r = await api('/content/tags/merge', { method: 'POST', body: { from, to } });
      msg.success(`Merged — ${r.updated} rows updated`);
      setMergeOpen(false);
      load();
    } catch (e: any) { msg.error(e.message); }
  };

  const tagNames = tags.map((t) => t.tag);

  return (
    <div>
      {contextHolder}
      <Typography.Title level={4}>Content Moderation</Typography.Title>
      <Card size="small" title="Report queue" style={{ marginBottom: 16 }}>
        <Space style={{ marginBottom: 8 }}>
          <Select value={status} onChange={setStatus} style={{ width: 140 }} options={[
            { value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'dismissed', label: 'Dismissed' }, { value: 'all', label: 'All' },
          ]} />
        </Space>
        <Table
          size="small" rowKey="id" dataSource={reports} pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Type', dataIndex: 'content_type' },
            { title: 'Content', dataIndex: 'content_id', render: (v) => String(v).slice(0, 8) + '…' },
            { title: 'Reason', dataIndex: 'reason', ellipsis: true },
            { title: 'Reporter', dataIndex: 'reporter_name' },
            { title: 'Status', dataIndex: 'status', render: (s) => <Tag color={s === 'open' ? 'orange' : 'default'}>{s}</Tag> },
            {
              title: 'Actions',
              render: (_: any, r: any) =>
                r.status === 'open' ? (
                  <Space>
                    <Button size="small" danger onClick={() => removeContent(r.content_type === 'template' ? 'template' : 'recipe', r.content_id)}>Remove content</Button>
                    <Button size="small" onClick={() => resolve(r.id, 'dismissed')}>Dismiss</Button>
                    <Button size="small" onClick={() => resolve(r.id, 'resolved')}>Resolve</Button>
                  </Space>
                ) : null,
            },
          ]}
        />
      </Card>
      <Card
        size="small"
        title={`Tag vocabulary (${tags.length} in use)`}
        extra={<Button size="small" onClick={() => setMergeOpen(true)}>Merge duplicates</Button>}
      >
        <Table
          size="small" rowKey="tag" dataSource={tags} pagination={{ pageSize: 10 }}
          columns={[
            { title: 'Tag', dataIndex: 'tag', render: (t) => <Tag>{t}</Tag> },
            { title: 'Uses across platform', dataIndex: 'uses', sorter: (a: any, b: any) => a.uses - b.uses },
          ]}
        />
      </Card>
      <Modal open={mergeOpen} title="Merge duplicate tags" onCancel={() => setMergeOpen(false)} onOk={merge}>
        <Typography.Paragraph type="secondary">
          Rewrites every use of the source tag to the canonical value across recipes, templates, plans and item snapshots.
        </Typography.Paragraph>
        <Select showSearch value={from} onChange={setFrom} options={tagNames.map((t) => ({ value: t, label: t }))} placeholder="Duplicate tag (from)" style={{ width: '100%', marginBottom: 8 }} />
        <Select showSearch value={to} onChange={setTo} options={tagNames.map((t) => ({ value: t, label: t }))} placeholder="Canonical tag (to)" style={{ width: '100%' }} />
      </Modal>
    </div>
  );
}
