// Member's Documents tab (Phase 18) — waivers, membership agreements, ID
// verification, medical clearances. Files are uploaded from the desk and
// streamed back through authorized endpoints only; the storage layer is
// never visible here. Works identically for members with and without app
// accounts — a member who leaves keeps their file (retention) but accepts
// no new paperwork.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Table, Tag, Modal, Form, Input, Select, DatePicker, Upload,
  Typography, App as AntApp, Space, Tooltip, Alert,
} from 'antd';
import {
  UploadOutlined, DownloadOutlined, FileTextOutlined, FileDoneOutlined,
  StopOutlined, AuditOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  DOCUMENT_CATEGORIES, MAX_DOCUMENT_MB, listMemberDocuments, uploadMemberDocument,
  authorizeMemberDocument, revokeMemberDocument, downloadMemberDocument,
  getMemberDocument, validateDocumentFile, fileToBase64,
  MemberDocument, MemberDocumentsResult,
} from '../api';

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'gold',
  AUTHORIZED: 'green',
  EXPIRED: 'volcano',
  REPLACED: 'default',
  REVOKED: 'red',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function MemberDocumentsTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [result, setResult] = useState<MemberDocumentsResult | null>(null);
  const [error, setError] = useState<any>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [signTarget, setSignTarget] = useState<MemberDocument | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MemberDocument | null>(null);
  const [historyTarget, setHistoryTarget] = useState<MemberDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [form] = Form.useForm();
  const [signForm] = Form.useForm();
  const [revokeForm] = Form.useForm();

  const canManage = hasPermission(ctx, 'documents.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      setResult(await listMemberDocuments(ctx!.gymId, memberId));
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!result) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const { member, documents } = result;

  const submitUpload = async () => {
    try {
      const v = await form.validateFields();
      if (!file) { message.warning('Pick a PDF, PNG or JPEG file first'); return; }
      const problem = validateDocumentFile(file);
      if (problem) { message.error(problem); return; }
      setBusy(true);
      const contentBase64 = await fileToBase64(file);
      await uploadMemberDocument(ctx!.gymId, memberId, {
        category: v.category,
        title: v.title || null,
        expires_at: v.expires_at ? v.expires_at.format('YYYY-MM-DD') : null,
        filename: file.name,
        content_type: file.type,
        content_base64: contentBase64,
      });
      message.success('Document uploaded — the previous live copy of this category was superseded');
      setUploadOpen(false); setFile(null); form.resetFields();
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const submitSign = async () => {
    if (!signTarget) return;
    try {
      const v = await signForm.validateFields();
      await authorizeMemberDocument(ctx!.gymId, memberId, signTarget.id, v.signature_name);
      message.success('Signature recorded — document authorized');
      setSignTarget(null); signForm.resetFields();
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not record the signature');
    }
  };

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    try {
      const v = await revokeForm.validateFields();
      await revokeMemberDocument(ctx!.gymId, memberId, revokeTarget.id, v.reason || undefined);
      message.success('Document revoked — history retained');
      setRevokeTarget(null); revokeForm.resetFields();
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not revoke the document');
    }
  };

  const doDownload = async (doc: MemberDocument) => {
    try {
      await downloadMemberDocument(doc);
    } catch (e: any) {
      message.error(e.message || 'Download failed');
    }
  };

  const openHistory = async (doc: MemberDocument) => {
    try {
      setHistoryTarget(await getMemberDocument(ctx!.gymId, memberId, doc.id));
    } catch (e: any) {
      message.error(e.message || 'Could not load the access log');
    }
  };

  const statusTag = (doc: MemberDocument) => (
    <Space size={4}>
      <Tag color={STATUS_COLORS[doc.effective_status] || 'default'}>{doc.effective_status}</Tag>
      {!doc.is_live && doc.status !== doc.effective_status && (
        <Tag color={STATUS_COLORS[doc.status] || 'default'}>{doc.status}</Tag>
      )}
    </Space>
  );

  const columns = [
    {
      title: 'Document', key: 'doc',
      render: (_: any, doc: MemberDocument) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong={doc.is_live} delete={doc.status === 'REPLACED' || doc.status === 'REVOKED'}>
            {doc.title || doc.category_label}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {doc.category_label} · {doc.original_filename} · {formatBytes(doc.file_size)}
          </Typography.Text>
        </Space>
      ),
    },
    { title: 'Status', key: 'status', width: 170, render: (_: any, doc: MemberDocument) => statusTag(doc) },
    {
      title: 'Signature', key: 'sig', width: 170,
      render: (_: any, doc: MemberDocument) => doc.authorized_signature
        ? <Tooltip title={dayjs(doc.authorized_at).format('YYYY-MM-DD HH:mm')}><Typography.Text style={{ fontSize: 12 }}>“{doc.authorized_signature}”</Typography.Text></Tooltip>
        : <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>,
    },
    {
      title: 'Expires', key: 'exp', width: 110,
      render: (_: any, doc: MemberDocument) => doc.expires_at
        ? <Typography.Text type={doc.expired ? 'danger' : undefined} style={{ fontSize: 12 }}>
            {dayjs(doc.expires_at).format('YYYY-MM-DD')}
          </Typography.Text>
        : <Typography.Text type="secondary" style={{ fontSize: 12 }}>never</Typography.Text>,
    },
    {
      title: 'Uploaded', key: 'up', width: 150,
      render: (_: any, doc: MemberDocument) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {doc.uploaded_via === 'APP' ? 'App' : 'Desk'} · {dayjs(doc.created_at).format('YYYY-MM-DD')}
        </Typography.Text>
      ),
    },
    {
      title: 'Actions', key: 'act', width: 230, align: 'right' as const,
      render: (_: any, doc: MemberDocument) => (
        <Space size={4} wrap>
          <Tooltip title="Download (access is logged)">
            <Button size="small" icon={<DownloadOutlined />} onClick={() => doDownload(doc)} />
          </Tooltip>
          {canManage && doc.status === 'PENDING' && !doc.expired && member.paperwork_allowed && (
            <Button size="small" icon={<FileDoneOutlined />}
              onClick={() => { signForm.resetFields(); setSignTarget(doc); }}>
              Record signature
            </Button>
          )}
          {canManage && doc.is_live && (
            <Button size="small" danger icon={<StopOutlined />}
              onClick={() => { revokeForm.resetFields(); setRevokeTarget(doc); }}>
              Revoke
            </Button>
          )}
          <Tooltip title="Access log (who downloaded)">
            <Button size="small" icon={<AuditOutlined />} onClick={() => openHistory(doc)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <Card size="small" title="Documents & waivers" extra={canManage && (
      <Button type="primary" icon={<UploadOutlined />} onClick={() => { form.resetFields(); setFile(null); setUploadOpen(true); }}>
        Upload document
      </Button>
    )}>
      {!canManage && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message="Read-only" description="Downloading is available, but managing documents requires the documents.manage permission (OWNER, ADMIN, FRONT_DESK)." />
      )}
      {canManage && !member.paperwork_allowed && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={`Membership is ${member.status.toLowerCase()} — documents are retained and downloadable, but no new paperwork can be added or signed.`} />
      )}
      <Table
        rowKey="id" size="small" columns={columns} dataSource={documents}
        pagination={documents.length > 10 ? { pageSize: 10 } : false}
        locale={{ emptyText: 'No documents on file yet.' }}
        scroll={{ x: 700 }}
      />

      <Modal
        title="Upload document" open={uploadOpen} onCancel={() => setUploadOpen(false)}
        onOk={submitUpload} okText="Upload" confirmLoading={busy} okButtonProps={{ disabled: !file }}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ category: 'WAIVER' }}>
          <Form.Item name="category" label="Category" rules={[{ required: true }]}>
            <Select options={DOCUMENT_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))} />
          </Form.Item>
          <Form.Item name="title" label="Title (optional)">
            <Input maxLength={120} placeholder="e.g. Liability Waiver 2026" />
          </Form.Item>
          <Form.Item name="expires_at" label="Expires on (optional)">
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d && d.isBefore(dayjs(), 'day')} />
          </Form.Item>
          <Form.Item label="File (PDF, PNG or JPEG — max 8MB)" required>
            <Upload.Dragger
              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
              maxCount={1} onRemove={() => setFile(null)}
              fileList={file ? [{ uid: 'f', name: file.name } as any] : []}
              beforeUpload={(f: any) => { setFile(f as unknown as File); return false; }}
            >
              <p className="ant-upload-drag-icon"><FileTextOutlined /></p>
              <p className="ant-upload-text">Click or drag a file here</p>
              <p className="ant-upload-hint">The server re-validates size, type and magic bytes — renamed or forged files are rejected.</p>
            </Upload.Dragger>
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Uploading supersedes the current live document of the same category (it is kept as history, marked REPLACED).
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title="Record signature (signed on paper)" open={!!signTarget} onCancel={() => setSignTarget(null)}
        onOk={submitSign} okText="Authorize" destroyOnClose
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={signTarget?.title || signTarget?.category_label}
          description="Enter the name as signed on the paper copy. The typed name is retained on the document as the signature of record." />
        <Form form={signForm} layout="vertical">
          <Form.Item name="signature_name" label="Signature name" rules={[{ required: true, message: 'The signature name is required' }]}>
            <Input maxLength={80} placeholder="Member's legal name" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Revoke document" open={!!revokeTarget} onCancel={() => setRevokeTarget(null)}
        onOk={submitRevoke} okText="Revoke" okButtonProps={{ danger: true }} destroyOnClose
      >
        <Alert type="warning" showIcon style={{ marginBottom: 12 }}
          message={revokeTarget?.title || revokeTarget?.category_label}
          description="The member app stops serving this document immediately. The row is kept for the audit trail." />
        <Form form={revokeForm} layout="vertical">
          <Form.Item name="reason" label="Reason (optional)">
            <Input maxLength={300} placeholder="e.g. wrong member's scan" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Access log" open={!!historyTarget} onCancel={() => setHistoryTarget(null)}
        footer={null} destroyOnClose
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          Last 20 downloads of this document — staff and member reads are all recorded.
        </Typography.Paragraph>
        <Table
          rowKey={(r: any, i) => String(i)} size="small"
          dataSource={(historyTarget?.download_history as any[]) || []}
          columns={[
            { title: 'Who', render: (_: any, r: any) => r.actor_kind === 'STAFF' ? `Staff (${r.actor_label || 'gym'})` : 'Member (app)' },
            { title: 'IP', dataIndex: 'ip', render: (ip: string) => ip || '—' },
            { title: 'When', dataIndex: 'created_at', render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
          ]}
          pagination={false}
          locale={{ emptyText: 'Never downloaded.' }}
        />
      </Modal>
    </Card>
  );
}
