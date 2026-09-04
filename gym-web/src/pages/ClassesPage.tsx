// Classes (Phase 17) — the schedule: create class instances (type, trainer,
// branch, room, date, times, capacity), take bookings (front desk books any
// member, app or not), run the waitlist (FIFO promotion when a seat frees)
// and mark attendance / no-shows. Cancelling a class cascades to every live
// booking. Requires classes.manage (OWNER, ADMIN).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Drawer, Form, Input, InputNumber, Select, App as AntApp, Popconfirm,
  Table, Alert, Tag, Space, Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons';
import PageContainer from '../components/PageContainer';
import StatusBadge from '../components/StatusBadge';
import { useGymContext, hasPermission } from '../permissions';
import {
  listClasses, getClass, createClass, updateClass, cancelClass,
  bookMember, cancelBooking, setAttendance,
  listMembers, listStaff, listBranches,
  GymClass, ClassBooking, ClassPayload,
} from '../api';

const STATUS_COLOR: Record<string, string> = {
  BOOKED: 'green',
  ATTENDED: 'blue',
  WAITLISTED: 'gold',
  NO_SHOW: 'red',
  CANCELLED: 'default',
};

const hhmm = (t: string | null | undefined) => (t ? String(t).slice(0, 5) : '—');

function ClassForm({ form, trainers, branches }: {
  form: any;
  trainers: { id: string; name: string }[];
  branches: { id: string; name: string }[];
}) {
  return (
    <Form form={form} layout="vertical">
      <Form.Item name="class_type" label="Class type" rules={[{ required: true, message: 'Class type is required' }]}>
        <Input placeholder="Yoga" maxLength={80} />
      </Form.Item>
      <Form.Item name="trainer_staff_id" label="Trainer">
        <Select
          allowClear
          placeholder="TBA"
          options={trainers.map((t) => ({ value: t.id, label: t.name }))}
        />
      </Form.Item>
      <Form.Item name="branch_id" label="Branch">
        <Select
          allowClear
          placeholder="All branches"
          options={branches.map((b) => ({ value: b.id, label: b.name }))}
        />
      </Form.Item>
      <Form.Item name="class_date" label="Date" rules={[{ required: true, message: 'Date is required' }]}>
        <Input type="date" />
      </Form.Item>
      <Form.Item label="Start / End time" required style={{ marginBottom: 0 }}>
        <Input.Group compact>
          <Form.Item
            name="start_time" noStyle
            rules={[{ required: true, message: 'Start time is required' }]}
          >
            <Input type="time" style={{ width: '48%' }} />
          </Form.Item>
          <Form.Item
            name="end_time" noStyle
            rules={[{ required: true, message: 'End time is required' }]}
          >
            <Input type="time" style={{ width: '52%' }} />
          </Form.Item>
        </Input.Group>
      </Form.Item>
      <Form.Item name="capacity" label="Capacity" initialValue={20}
        rules={[{ required: true, message: 'Capacity is required' }]}>
        <InputNumber min={1} max={500} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name="room" label="Room">
        <Input placeholder="Studio A" maxLength={80} />
      </Form.Item>
      <Form.Item name="notes" label="Notes">
        <Input.TextArea rows={2} maxLength={500} placeholder="What to bring, intensity, …" />
      </Form.Item>
    </Form>
  );
}

export default function ClassesPage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<GymClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState<'SCHEDULED' | 'CANCELLED' | 'ALL'>('SCHEDULED');

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<GymClass | null>(null);
  const [form] = Form.useForm();
  const [trainers, setTrainers] = useState<{ id: string; name: string }[]>([]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);

  const [sheetClass, setSheetClass] = useState<GymClass | null>(null);
  const [sheetBookings, setSheetBookings] = useState<ClassBooking[]>([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [memberOptions, setMemberOptions] = useState<{ id: string; label: string }[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [pickedMember, setPickedMember] = useState<string | undefined>(undefined);

  const canManage = hasPermission(ctx, 'classes.manage');
  const gymId = ctx?.gymId ?? null;

  const load = useCallback(async () => {
    if (!gymId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await listClasses(gymId, { status: statusFilter, limit: 200 }));
    } catch (e: any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [gymId, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const openCreate = async () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ capacity: 20 });
    setFormOpen(true);
    if (gymId) {
      try {
        const [staff, brs] = await Promise.all([listStaff(gymId), listBranches(gymId)]);
        setTrainers(staff.filter((s) => s.gym_role === 'TRAINER' && s.status === 'ACTIVE')
          .map((s) => ({ id: s.id, name: s.name || s.email || s.id })));
        setBranches(brs.filter((b) => b.status === 'ACTIVE').map((b) => ({ id: b.id, name: b.name })));
      } catch { /* selects stay empty; the fields are optional */ }
    }
  };

  const openEdit = async (c: GymClass) => {
    setEditing(c);
    form.setFieldsValue({
      class_type: c.class_type,
      trainer_staff_id: c.trainer_staff_id || undefined,
      branch_id: c.branch_id || undefined,
      room: c.room || undefined,
      class_date: c.class_date,
      start_time: hhmm(c.start_time),
      end_time: hhmm(c.end_time),
      capacity: c.capacity,
      notes: c.notes || undefined,
    });
    setFormOpen(true);
    if (gymId) {
      try {
        const [staff, brs] = await Promise.all([listStaff(gymId), listBranches(gymId)]);
        setTrainers(staff.filter((s) => s.gym_role === 'TRAINER' && s.status === 'ACTIVE')
          .map((s) => ({ id: s.id, name: s.name || s.email || s.id })));
        setBranches(brs.filter((b) => b.status === 'ACTIVE').map((b) => ({ id: b.id, name: b.name })));
      } catch { /* optional selects */ }
    }
  };

  const submit = async () => {
    try {
      const v = await form.validateFields();
      const payload: ClassPayload = {
        class_type: v.class_type,
        trainer_staff_id: v.trainer_staff_id || null,
        branch_id: v.branch_id || null,
        room: v.room || null,
        class_date: v.class_date,
        start_time: v.start_time,
        end_time: v.end_time,
        capacity: v.capacity,
        notes: v.notes || null,
      };
      if (editing) {
        await updateClass(gymId!, editing.id, payload);
        message.success('Class updated');
      } else {
        await createClass(gymId!, payload);
        message.success('Class created');
      }
      setFormOpen(false);
      load();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e.message || 'Could not save the class');
    }
  };

  const doCancelClass = async (c: GymClass) => {
    try {
      await cancelClass(gymId!, c.id);
      message.success(`"${c.class_type}" cancelled — every live booking was released`);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not cancel the class');
    }
  };

  const openSheet = async (c: GymClass) => {
    setSheetClass(c);
    setSheetBookings([]);
    setPickedMember(undefined);
    setMemberSearch('');
    setSheetLoading(true);
    try {
      if (gymId) {
        const detail = await getClass(gymId, c.id);
        setSheetClass(detail);
        setSheetBookings(detail.bookings || []);
        const members = await listMembers(gymId, { limit: 20 });
        setMemberOptions((members as any).map((m: any) => ({
          id: m.id,
          label: `${m.first_name || ''} ${m.last_name || ''} · ${m.member_code}`.trim(),
        })));
      }
    } catch (e: any) {
      message.error(e.message || 'Could not load the booking sheet');
    } finally {
      setSheetLoading(false);
    }
  };

  const reloadSheet = async (classId: string) => {
    if (!gymId) return;
    const detail = await getClass(gymId, classId);
    setSheetClass(detail);
    setSheetBookings(detail.bookings || []);
  };

  const searchMembers = async (q: string) => {
    setMemberSearch(q);
    if (!gymId) return;
    try {
      const members = await listMembers(gymId, { q: q || undefined, limit: 20 });
      setMemberOptions((members as any).map((m: any) => ({
        id: m.id,
        label: `${m.first_name || ''} ${m.last_name || ''} · ${m.member_code}`.trim(),
      })));
    } catch { /* keep old options */ }
  };

  const doBook = async () => {
    if (!pickedMember || !sheetClass) return;
    try {
      const r = await bookMember(gymId!, sheetClass.id, pickedMember);
      message.success(
        r.status === 'WAITLISTED'
          ? `Class is full — member waitlisted (position ${r.waitlist_position})`
          : `Booked — ${r.spots_left} spot(s) left`,
      );
      setPickedMember(undefined);
      await reloadSheet(sheetClass.id);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not book the member');
    }
  };

  const doCancelBooking = async (b: ClassBooking) => {
    try {
      const r = await cancelBooking(gymId!, sheetClass!.id, b.id);
      message.success(r.promoted > 0 ? 'Booking cancelled — the first waitlisted member was promoted' : 'Booking cancelled');
      await reloadSheet(sheetClass!.id);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not cancel the booking');
    }
  };

  const doAttendance = async (b: ClassBooking, attendance: 'ATTENDED' | 'NO_SHOW' | 'BOOKED') => {
    try {
      const r = await setAttendance(gymId!, sheetClass!.id, b.id, attendance);
      if (attendance === 'NO_SHOW' && r.promoted > 0) {
        message.success('Marked as no-show — the seat went to the first waitlisted member');
      } else if (attendance === 'BOOKED') {
        message.success('Booking restored');
      } else {
        message.success(`Marked ${attendance.toLowerCase().replace('_', ' ')}`);
      }
      await reloadSheet(sheetClass!.id);
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not update attendance');
    }
  };

  const columns = useMemo(() => [
    { title: 'Date', dataIndex: 'class_date', width: 110 },
    { title: 'Time', key: 'time', width: 110, render: (_: any, c: GymClass) => `${hhmm(c.start_time)}–${hhmm(c.end_time)}` },
    { title: 'Class', key: 'class', render: (_: any, c: GymClass) => (
      <div>
        <div style={{ fontWeight: 600 }}>
          {c.class_type} {c.status === 'CANCELLED' && <Tag color="red">cancelled</Tag>}
        </div>
        {c.room && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{c.room}</div>}
      </div>
    ) },
    { title: 'Trainer', dataIndex: 'trainer_name', width: 140, render: (v: string | null) => v || 'TBA' },
    { title: 'Branch', dataIndex: 'branch_name', width: 120, render: (v: string | null) => v || 'All' },
    { title: 'Bookings', key: 'bookings', width: 110, render: (_: any, c: GymClass) => (
      <span>{c.booked_count ?? 0} / {c.capacity}</span>
    ) },
    { title: 'Waitlist', dataIndex: 'waitlist_count', width: 90, render: (v: number) => (v ? <Tag color="gold">{v} waiting</Tag> : '—') },
    { title: 'Status', dataIndex: 'status', width: 110,
      render: (s: string) => <StatusBadge status={s === 'SCHEDULED' ? 'ACTIVE' : 'CANCELLED'} /> },
    { title: '', key: 'actions', width: canManage ? 290 : 120, render: (_: any, c: GymClass) => (
      <span>
        <Button size="small" icon={<TeamOutlined />} style={{ marginRight: 8 }} onClick={() => openSheet(c)}>Bookings</Button>
        {canManage && c.status === 'SCHEDULED' && (
          <>
            <Button size="small" style={{ marginRight: 8 }} onClick={() => openEdit(c)}>Edit</Button>
            <Popconfirm
              title={`Cancel "${c.class_type}"?`}
              description="Every live booking will be released. This cannot be undone."
              onConfirm={() => doCancelClass(c)}
            >
              <Button size="small" danger>Cancel</Button>
            </Popconfirm>
          </>
        )}
      </span>
    ) },
  ], [canManage, gymId]);

  const bookingColumns = [
    { title: 'Member', key: 'member', render: (_: any, b: ClassBooking) => (
      <span>
        {[b.first_name, b.last_name].filter(Boolean).join(' ') || b.member_code}
        <span style={{ color: 'rgba(255,255,255,0.45)', marginLeft: 8 }}>{b.member_code}</span>
      </span>
    ) },
    { title: 'Status', dataIndex: 'status', width: 150, render: (s: string, b: ClassBooking) => (
      <Tag color={STATUS_COLOR[s] || 'default'}>
        {s === 'WAITLISTED' && b.waitlist_position ? `#${b.waitlist_position} waitlisted` : s.replace('_', ' ').toLowerCase()}
      </Tag>
    ) },
    { title: 'Source', dataIndex: 'source', width: 80 },
    { title: '', key: 'actions', width: canManage ? 260 : 0, render: (_: any, b: ClassBooking) => {
      if (!canManage) return null;
      if (b.status === 'BOOKED') {
        return (
          <Space>
            <Button size="small" onClick={() => doAttendance(b, 'ATTENDED')}>Attended</Button>
            <Button size="small" danger onClick={() => doAttendance(b, 'NO_SHOW')}>No-show</Button>
            <Popconfirm title="Cancel this booking?" description="The seat goes to the first waitlisted member." onConfirm={() => doCancelBooking(b)}>
              <Button size="small" type="text" danger>Cancel</Button>
            </Popconfirm>
          </Space>
        );
      }
      if (b.status === 'WAITLISTED') {
        return <Button size="small" onClick={() => doCancelBooking(b)}>Leave waitlist</Button>;
      }
      if (b.status === 'NO_SHOW' || b.status === 'ATTENDED') {
        return <Button size="small" onClick={() => doAttendance(b, 'BOOKED')}>Undo</Button>;
      }
      return null;
    } },
  ];

  return (
    <PageContainer
      title="Classes"
      subtitle="The schedule. Bookings are first-come; when a class is full the next members join a FIFO waitlist and are promoted in order as seats free up."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Classes' }]}
      extra={canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>New class</Button> : null}
    >
      <div style={{ marginBottom: 16 }}>
        <Select
          value={statusFilter}
          style={{ width: 180 }}
          onChange={(v) => setStatusFilter(v)}
          options={[
            { value: 'SCHEDULED', label: 'Scheduled' },
            { value: 'CANCELLED', label: 'Cancelled' },
            { value: 'ALL', label: 'All' },
          ]}
        />
      </div>
      {error ? (
        <Alert
          type="error" showIcon
          message="Could not load classes"
          description={error?.message}
          action={<Button icon={<ReloadOutlined />} onClick={load}>Retry</Button>}
        />
      ) : (
        <Table<GymClass>
          columns={columns as any}
          dataSource={rows}
          rowKey={(c) => c.id}
          loading={loading}
          pagination={false}
          locale={{ emptyText: 'No classes on the schedule yet. Create the first one — members see it in the app under Gym → Classes.' }}
        />
      )}

      <Drawer
        title={editing ? `Edit ${editing.class_type}` : 'New class'}
        width={430}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        extra={canManage ? <Button type="primary" onClick={submit}>{editing ? 'Save' : 'Create'}</Button> : null}
      >
        <ClassForm form={form} trainers={trainers} branches={branches} />
      </Drawer>

      <Drawer
        title={sheetClass ? `${sheetClass.class_type} — ${sheetClass.class_date} ${hhmm(sheetClass.start_time)}` : 'Bookings'}
        width={640}
        open={!!sheetClass}
        onClose={() => setSheetClass(null)}
      >
        {sheetClass && (
          <>
            {canManage && sheetClass.status === 'SCHEDULED' && (
              <Space.Compact block style={{ marginBottom: 16 }}>
                <Select
                  showSearch
                  value={pickedMember}
                  onSearch={searchMembers}
                  searchValue={memberSearch}
                  filterOption={false}
                  style={{ flex: 1 }}
                  placeholder="Book a member — search by name / code (works without an app account)"
                  onChange={setPickedMember}
                  options={memberOptions.map((m) => ({ value: m.id, label: m.label }))}
                />
                <Button type="primary" onClick={doBook} disabled={!pickedMember}>Book</Button>
              </Space.Compact>
            )}
            {sheetClass.status === 'CANCELLED' && (
              <Alert type="warning" showIcon style={{ marginBottom: 16 }}
                message="This class was cancelled — all live bookings were released." />
            )}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {sheetClass.booked_count ?? 0} of {sheetClass.capacity} seats held
              {sheetClass.waitlist_count ? ` · ${sheetClass.waitlist_count} on the waitlist` : ''}
              {' · '}cancelling a seat promotes the first waitlisted member (FIFO)
            </Typography.Paragraph>
            <Table<ClassBooking>
              columns={bookingColumns as any}
              dataSource={sheetBookings}
              rowKey={(b) => b.id}
              loading={sheetLoading}
              pagination={false}
              size="small"
              locale={{ emptyText: 'No bookings yet.' }}
            />
          </>
        )}
      </Drawer>
    </PageContainer>
  );
}
