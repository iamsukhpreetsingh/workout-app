// Member's Attendance tab — ✓/− calendar (Sep 2 ✓ / Sep 1 - …), the
// member's QR card (works even for members with no app account), and
// front-desk/backdate actions.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Tag, Tooltip, Typography, App as AntApp, Popconfirm, DatePicker, Space,
} from 'antd';
import { QrcodeOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import StatusBadge from './StatusBadge';
import { ErrorState } from './States';
import { useGymContext, hasPermission } from '../permissions';
import {
  getMemberAttendanceHistory, getMemberQr, rotateMemberQr, markAttendance,
  MemberDay, MemberQr, AttendanceSource,
} from '../api';

const SOURCE_LABELS: Record<string, string> = {
  QR_CHECK_IN: 'QR scan',
  FRONT_DESK: 'Front desk',
  WORKOUT_COMPLETION: 'Workout completion',
  ADMIN_MANUAL: 'Manual',
};

// deterministic color for the QR placeholder blocks
function tokenColor(ch: string) {
  const n = parseInt(ch, 16);
  return ['#E8481F', '#1C1917', '#5856D6', '#16A34A', '#D97706'][n % 5];
}

export default function MemberAttendanceTab({ memberId }: { memberId: string }) {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [history, setHistory] = useState<MemberDay[] | null>(null);
  const [qr, setQr] = useState<MemberQr | null>(null);
  const [error, setError] = useState<any>(null);
  const [backdate, setBackdate] = useState<dayjs.Dayjs | null>(null);
  const canManage = hasPermission(ctx, 'attendance.manage');
  const canCheckIn = hasPermission(ctx, 'checkin.manage');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [h, q] = await Promise.all([
        getMemberAttendanceHistory(ctx!.gymId, memberId),
        getMemberQr(ctx!.gymId, memberId),
      ]);
      setHistory(h);
      setQr(q);
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, memberId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState error={error} onRetry={load} />;
  if (!history || !qr) return <Typography.Text type="secondary">Loading…</Typography.Text>;

  const recent = history.slice(0, 21);
  const presentCount = history.filter((d) => d.present).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title={<><QrcodeOutlined /> Member QR card</>}
        extra={
          canManage && (
            <Popconfirm title="Re-issue this QR? The old code stops working." okText="Rotate"
              onConfirm={async () => {
                try {
                  setQr(await rotateMemberQr(ctx!.gymId, memberId));
                  message.success('QR re-issued — the old code no longer works');
                } catch (e: any) { message.error(e.message || 'Could not rotate'); }
              }}>
              <Button size="small">Re-issue</Button>
            </Popconfirm>
          )
        }>
        <Space align="center" size="large" wrap>
          {/* QR placeholder grid: visual identity without an external QR lib.
              A real printer renders the token as a QR — scanning feeds the
              token back through /attendance/scan. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 10px)', gap: 2 }}>
            {qr.qr_token.slice(0, 100).split('').map((ch, i) => (
              <div key={i} style={{ width: 10, height: 10, borderRadius: 2, background: tokenColor(ch) }} />
            ))}
          </div>
          <div>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {[...Array(0)]}
              {qr.member_code}
            </Typography.Text>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 4, maxWidth: 260 }}>
              This QR identifies the member at the front desk — it works whether or not they use the app.
            </Typography.Paragraph>
            <Typography.Text type="secondary" copyable style={{ fontSize: 11 }}>
              {qr.qr_token}
            </Typography.Text>
          </div>
        </Space>
      </Card>

      <Card size="small" title="Attendance history" extra={
        <Space>
          <Typography.Text type="secondary">{presentCount} of {history.length} days</Typography.Text>
          {canCheckIn && (
            <Button size="small" onClick={async () => {
              try {
                const r = await markAttendance(ctx!.gymId, memberId);
                message.success(r.duplicate ? 'Already marked today' : 'Marked present');
                load();
              } catch (e: any) { message.error(e.message || 'Could not mark'); }
            }}>Mark present today</Button>
          )}
          {canManage && (
            <Popconfirm
              title={backdate ? `Record attendance on ${backdate.format('YYYY-MM-DD')}?` : 'Pick a date first'}
              disabled={!backdate}
              onConfirm={async () => {
                if (!backdate) return;
                try {
                  await (await import('../api')).backdateAttendance(ctx!.gymId, memberId, backdate.format('YYYY-MM-DD'));
                  message.success('Backdated attendance recorded');
                  setBackdate(null);
                  load();
                } catch (e: any) { message.error(e.message || 'Could not backdate'); }
              }}>
              <DatePicker
                size="small"
                value={backdate}
                onChange={setBackdate}
                disabledDate={(d) => d.isAfter(dayjs(), 'day') || d.isBefore(dayjs().subtract(90, 'day'))}
                placeholder="Backdate…"
                allowClear
              />
            </Popconfirm>
          )}
        </Space>
      }>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {recent.map((d) => (
            <Tooltip key={d.date} title={`${d.date}${d.present ? ` — ${SOURCE_LABELS[d.source as AttendanceSource] || d.source}` : ' — absent'}`}>
              <div style={{
                width: 64, padding: '4px 0', textAlign: 'center', borderRadius: 6,
                border: `1px solid ${d.date === dayjs().format('YYYY-MM-DD') ? '#E8481F' : 'transparent'}`,
                background: d.present ? '#16A34A18' : 'transparent',
              }}>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{dayjs(d.date).format('DD MMM')}</div>
                <div style={{ fontSize: 14 }}>{d.present ? '✓' : '−'}</div>
              </div>
            </Tooltip>
          ))}
        </div>
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12 }}>
          ✓ = visited · − = no visit · last {recent.length} days shown (of {history.length})
        </Typography.Text>
      </Card>
    </div>
  );
}
