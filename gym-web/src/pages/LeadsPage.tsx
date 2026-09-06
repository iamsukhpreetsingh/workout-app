// Leads — the gym portal inbox for public QR enquiries. Staff with
// leads.view see the list/details; leads.manage unlocks status changes,
// internal notes and QR regeneration; conversion back-links a member
// created through the NORMAL member flow (never automatic).
import React, { useCallback, useEffect, useState } from 'react';
import {
  App as AntApp, Button, Card, Descriptions, Drawer, DrawerProps, Empty, Form, Input,
  List, Modal, Select, Space, Tag, Timeline, Typography,
} from 'antd';
import { QrcodeOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import FilterBar from '../components/FilterBar';
import LeadQrCard from '../components/LeadQrCard';
import { useGymContext, hasPermission } from '../permissions';
import { listLeads, getLead, updateLeadStatus, addLeadNote, convertLead, GymLead } from '../api/leads';
import { GymMember, listMembers } from '../api/members';

const STATUSES = ['NEW', 'CONTACTED', 'TRIAL_SCHEDULED', 'TRIAL_COMPLETED',
  'JOINED', 'NOT_JOINED', 'NO_RESPONSE', 'FOLLOW_UP', 'CLOSED'];
const STATUS_COLOR: Record<string, string> = {
  NEW: 'blue', CONTACTED: 'gold', TRIAL_SCHEDULED: 'purple', TRIAL_COMPLETED: 'purple',
  JOINED: 'green', NOT_JOINED: 'red', NO_RESPONSE: 'default', FOLLOW_UP: 'orange', CLOSED: 'default',
};
const TYPES = ['ENQUIRY', 'TRIAL', 'VISITOR', 'MEMBERSHIP_ENQUIRY', 'GENERAL_ENQUIRY'];
const TYPE_LABEL: Record<string, string> = {
  ENQUIRY: 'Membership enquiry', TRIAL: 'Trial', VISITOR: 'Visitor',
  MEMBERSHIP_ENQUIRY: 'Membership enquiry', GENERAL_ENQUIRY: 'General enquiry',
};

const PAGE_SIZE = 30;

export default function LeadsPage() {
  const { message } = AntApp.useApp();
  const ctx = useGymContext();
  const canManage = hasPermission(ctx, 'leads.manage');
  const canConvert = canManage && hasPermission(ctx, 'members.create');

  const [status, setStatus] = useState<string | undefined>();
  const [type, setType] = useState<string | undefined>();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<GymLead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ctx?.gymId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await listLeads(ctx.gymId, { status, type, q: q.trim() || undefined, limit: PAGE_SIZE }));
    } catch (e: any) {
      setError(e.message || 'Could not load leads');
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId, status, type, q]);

  useEffect(() => {
    const t = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <PageContainer
      title="Leads"
      subtitle="Visitors, trial requests and enquiries submitted through your Lead QR poster"
      extra={
        canManage && (
          <Button icon={<QrcodeOutlined />} onClick={() => setQrOpen(true)}>Lead QR poster</Button>
        )
      }
    >
      <FilterBar
        searchPlaceholder="Search name, phone or email…"
        q={q}
        onQ={setQ}
        filter={{ placeholder: 'Status', value: status, onChange: setStatus,
          options: STATUSES.map((s) => ({ value: s, label: s })) }}
        secondFilter={{ placeholder: 'Type', value: type, onChange: setType,
          options: TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) }}
      />

      <div style={{ marginTop: 16 }}>
        {error ? (
          <Typography.Text type="danger">{error}</Typography.Text>
        ) : rows === null ? (
          <Typography.Text type="secondary">Loading…</Typography.Text>
        ) : rows.length === 0 ? (
          <Empty description="No leads yet — display your Lead QR poster and enquiries will appear here." />
        ) : (
          <List
            dataSource={rows}
            renderItem={(lead) => (
              <List.Item
                style={{ cursor: 'pointer', borderRadius: 10, padding: '12px 14px', marginBottom: 8,
                  border: '1px solid rgba(255,255,255,0.08)' }}
                onClick={() => setOpenId(lead.id)}
              >
                <div style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <Typography.Text strong style={{ fontSize: 14 }}>
                      {lead.full_name}
                      {lead.matched_member && !lead.converted_member_id && (
                        <Tag style={{ marginLeft: 8 }}>existing member?</Tag>
                      )}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12.5 }}>
                      {lead.phone}{lead.email ? ` · ${lead.email}` : ''}
                    </Typography.Text>
                  </div>
                  <Tag>{TYPE_LABEL[lead.enquiry_type] || lead.enquiry_type}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(lead.created_at).toLocaleString()}
                  </Typography.Text>
                  <Tag color={STATUS_COLOR[lead.status]}>{lead.status}</Tag>
                </div>
              </List.Item>
            )}
          />
        )}
      </div>

      <LeadDetailDrawer
        leadId={openId}
        onClose={() => setOpenId(null)}
        canManage={canManage}
        canConvert={canConvert}
        onChanged={() => { load(); }}
      />

      <Drawer
        title="Lead QR poster"
        width={isNarrow() ? '92%' : 380}
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        destroyOnClose
      >
        <LeadQrCard />
      </Drawer>
    </PageContainer>
  );
}

function isNarrow() {
  return typeof window !== 'undefined' && window.innerWidth < 640;
}

// ── detail drawer ────────────────────────────────────────────────────────

function LeadDetailDrawer({ leadId, onClose, canManage, canConvert, onChanged }: {
  leadId: string | null; onClose: () => void; canManage: boolean; canConvert: boolean; onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const ctx = useGymContext();
  const [lead, setLead] = useState<GymLead | null>(null);
  const [loading, setLoading] = useState(false);
  const [newStatus, setNewStatus] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);
  const [noteForm] = Form.useForm();
  const [addingNote, setAddingNote] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  useEffect(() => {
    if (!leadId || !ctx?.gymId) { setLead(null); return; }
    setLoading(true);
    getLead(ctx.gymId, leadId)
      .then(setLead)
      .catch(() => setLead(null))
      .finally(() => setLoading(false));
  }, [leadId, ctx?.gymId]);

  const saveStatus = async () => {
    if (!ctx?.gymId || !lead || !newStatus || newStatus === lead.status) return;
    setSavingStatus(true);
    try {
      const updated = await updateLeadStatus(ctx.gymId, lead.id, newStatus);
      setLead({ ...lead, ...updated });
      message.success(`Status updated to ${newStatus}`);
      onChanged();
    } catch (e: any) {
      message.error(e.message || 'Could not update status');
    } finally {
      setSavingStatus(false);
    }
  };

  const addNote = async (values: { note: string }) => {
    if (!ctx?.gymId || !lead) return;
    setAddingNote(true);
    try {
      const note = await addLeadNote(ctx.gymId, lead.id, values.note);
      setLead({ ...lead, notes: [{ ...note, created_by_name: null }, ...(lead.notes || [])] });
      noteForm.resetFields();
      message.success('Note added');
    } catch (e: any) {
      message.error(e.message || 'Could not add note');
    } finally {
      setAddingNote(false);
    }
  };

  const ACTION_LABEL: Record<string, string> = {
    'lead.status_changed': 'Status changed',
    'lead.note_added': 'Note added',
    'lead.converted': 'Converted to member',
  };

  return (
    <Drawer
      title={lead ? lead.full_name : 'Lead'}
      width={isNarrow() ? '94%' : 480}
      open={!!leadId}
      onClose={onClose}
      destroyOnClose
    >
      {loading || !lead ? (
        <Typography.Text type="secondary">Loading…</Typography.Text>
      ) : (
        <>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Phone">
              <a href={`tel:${lead.phone}`}>{lead.phone}</a>
            </Descriptions.Item>
            {lead.email && <Descriptions.Item label="Email">
              <a href={`mailto:${lead.email}`}>{lead.email}</a>
            </Descriptions.Item>}
            <Descriptions.Item label="Type">{TYPE_LABEL[lead.enquiry_type] || lead.enquiry_type}</Descriptions.Item>
            <Descriptions.Item label="Source">{lead.source === 'GYM_QR' ? 'Gym QR' : lead.source}</Descriptions.Item>
            <Descriptions.Item label="Submitted">{new Date(lead.created_at).toLocaleString()}</Descriptions.Item>
            <Descriptions.Item label="Status"><Tag color={STATUS_COLOR[lead.status]}>{lead.status}</Tag></Descriptions.Item>
            {lead.preferred_visit_on && (
              <Descriptions.Item label="Preferred visit">{lead.preferred_visit_on}</Descriptions.Item>
            )}
            {lead.message && <Descriptions.Item label="Message">{lead.message}</Descriptions.Item>}
            {lead.converted_member && (
              <Descriptions.Item label="Converted to">
                {lead.converted_member.name} ({lead.converted_member.member_code})
              </Descriptions.Item>
            )}
            {lead.matched_member && !lead.converted_member_id && (
              <Descriptions.Item label="Possible match">
                An existing member shares this phone number — verify before creating a new member.
              </Descriptions.Item>
            )}
          </Descriptions>

          {canManage && (
            <div style={{ marginTop: 16 }}>
              <Typography.Text strong>Update status</Typography.Text>
              <Space.Compact style={{ width: '100%', marginTop: 6 }}>
                <Select
                  style={{ width: '100%' }}
                  value={newStatus ?? lead.status}
                  onChange={setNewStatus}
                  options={STATUSES.map((s) => ({ value: s, label: s }))}
                />
                <Button type="primary" loading={savingStatus} onClick={saveStatus}
                  disabled={!newStatus || newStatus === lead.status}>
                  Save
                </Button>
              </Space.Compact>
              {canConvert && !lead.converted_member_id && (
                <Button style={{ marginTop: 10 }} onClick={() => setConvertOpen(true)}>
                  Mark as joined — link member…
                </Button>
              )}
              {lead.converted_member && (
                <Typography.Text type="success" style={{ display: 'block', marginTop: 10 }}>
                  Converted to member {lead.converted_member.member_code}
                </Typography.Text>
              )}
            </div>
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>Internal notes</Typography.Title>
          {canManage && (
            <Form form={noteForm} layout="vertical" onFinish={addNote} style={{ marginBottom: 12 }}>
              <Form.Item name="note" rules={[
                { required: true, message: 'Write a note first.' },
                { max: 500, message: 'Max 500 characters.' },
              ]} style={{ marginBottom: 8 }}>
                <Input.TextArea rows={2} placeholder="e.g. Called — coming tomorrow 6 PM for trial" maxLength={500} showCount />
              </Form.Item>
              <Button htmlType="submit" loading={addingNote} size="small">Add note</Button>
            </Form>
          )}
          {(lead.notes || []).length === 0 ? (
            <Typography.Text type="secondary">No notes yet.</Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={lead.notes}
              renderItem={(n) => (
                <List.Item style={{ padding: '6px 0' }}>
                  <div>
                    <Typography.Text style={{ fontSize: 13 }}>{n.note}</Typography.Text>
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                      {new Date(n.created_at).toLocaleString()}{n.created_by_name ? ` · ${n.created_by_name}` : ''}
                    </Typography.Text>
                  </div>
                </List.Item>
              )}
            />
          )}

          <Typography.Title level={5} style={{ marginTop: 24 }}>Activity</Typography.Title>
          {(lead.activity || []).length === 0 ? (
            <Typography.Text type="secondary">Lead submitted — activity will appear here.</Typography.Text>
          ) : (
            <Timeline
              items={(lead.activity || []).map((a) => ({
                children: (
                  <>
                    <Typography.Text style={{ fontSize: 12.5 }}>
                      {ACTION_LABEL[a.action] || a.action}
                      {a.action === 'lead.status_changed' && a.before?.status && a.after?.status && (
                        <Typography.Text type="secondary">: {a.before.status} → {a.after.status}</Typography.Text>
                      )}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                      {new Date(a.created_at).toLocaleString()}{a.actor_label ? ` · by ${a.actor_label}` : ''}
                    </Typography.Text>
                  </>
                ),
              }))}
            />
          )}
        </>
      )}

      <ConvertMemberModal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        lead={lead}
        onDone={(updated) => { setLead(updated); setConvertOpen(false); onChanged(); }}
      />
    </Drawer>
  );
}

function ConvertMemberModal({ open, onClose, lead, onDone }: {
  open: boolean; onClose: () => void; lead: GymLead | null; onDone: (lead: GymLead) => void;
}) {
  const { message } = AntApp.useApp();
  const ctx = useGymContext();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GymMember[] | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (query: string) => {
    if (!ctx?.gymId || !query.trim()) { setResults(null); return; }
    try {
      setResults(await searchMembersLocal(ctx.gymId, query.trim()));
    } catch {
      setResults([]);
    }
  }, [ctx?.gymId]);

  useEffect(() => {
    const t = setTimeout(() => search(q), 350);
    return () => clearTimeout(t);
  }, [q, search]);

  const convert = async (member: GymMember) => {
    if (!ctx?.gymId || !lead || busy) return;
    setBusy(true);
    try {
      const updated = await convertLead(ctx.gymId, lead.id, member.id);
      message.success(`Lead marked JOINED — linked to ${member.member_code}`);
      onDone(updated);
    } catch (e: any) {
      message.error(e.message || 'Could not link the member');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Link an existing member to this lead"
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
        Create the member through the normal Members flow first (or pick an existing one below).
        This marks the lead as JOINED and links it — it never creates a member by itself.
      </Typography.Paragraph>
      <Input placeholder="Search members by name…" value={q} onChange={(e) => setQ(e.target.value)} allowClear />
      <div style={{ marginTop: 12 }}>
        {results === null ? (
          <Typography.Text type="secondary">Type a name to search…</Typography.Text>
        ) : results.length === 0 ? (
          <Typography.Text type="secondary">No members found — create the member first from the Members page.</Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={results}
            renderItem={(m) => (
              <List.Item
                style={{ cursor: 'pointer' }}
                onClick={() => convert(m)}
                actions={[<Button key="pick" size="small" type="link" loading={busy}>Link</Button>]}
              >
                <Typography.Text>{m.first_name} {m.last_name || ''} <Typography.Text type="secondary">({m.member_code})</Typography.Text></Typography.Text>
              </List.Item>
            )}
          />
        )}
      </div>
    </Modal>
  );
}

// thin local wrapper so the modal stays self-contained
async function searchMembersLocal(gymId: string, q: string) {
  return listMembers(gymId, { q, limit: 8 });
}
