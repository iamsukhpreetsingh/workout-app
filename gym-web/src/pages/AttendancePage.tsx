// Attendance — front-desk dashboard (Phase 10): QR scan, search-and-mark,
// today's check-ins, stats (today/week/month, peak hours), inactive
// members. Works for members with or without an app account.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Card, Row, Col, Statistic, Input, Button, List, Tag, Typography, Space,
  App as AntApp, Alert, Spin, Tooltip,
} from 'antd';
import {
  QrcodeOutlined, SearchOutlined, CheckCircleOutlined, ClockCircleOutlined,
  UserDeleteOutlined, ReloadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import PageContainer from '../components/PageContainer';
import { useGymContext } from '../permissions';
import {
  scanQr, markAttendance, listAttendance, getAttendanceStats, searchMembers, deleteAttendance,
  AttendanceRecord, AttendanceStats, GymMember,
} from '../api';

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export default function AttendancePage() {
  const ctx = useGymContext();
  const { message } = AntApp.useApp();
  const [qrValue, setQrValue] = useState('');
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [records, setRecords] = useState<AttendanceRecord[] | null>(null);
  const [recordsDate, setRecordsDate] = useState<string>(dayjs().format('YYYY-MM-DD'));
  const [stats, setStats] = useState<AttendanceStats | null>(null);
  const [error, setError] = useState<any>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, s] = await Promise.all([
        listAttendance(ctx!.gymId, { date: recordsDate }),
        getAttendanceStats(ctx!.gymId),
      ]);
      setRecords(r);
      setStats(s);
    } catch (e: any) {
      setError(e);
    }
  }, [ctx?.gymId, recordsDate]);

  useEffect(() => { load(); }, [load]);

  const doScan = async () => {
    const token = qrValue.trim();
    if (!token) return;
    setSearching(true);
    try {
      const r = await scanQr(ctx!.gymId, token);
      message.success(
        r.duplicate
          ? `${r.member.name} — already checked in today (${r.attendance.source})`
          : `Welcome, ${r.member.name}!`
      );
      if (r.warning) message.warning(r.warning);
      setQrValue('');
      load();
    } catch (e: any) {
      message.error(e.message || 'Invalid QR code');
    } finally {
      setSearching(false);
    }
  };

  // front desk searches by member code/name, then marks present
  const searchAndMark = async () => {
    if (!search.trim()) return;
    setSearching(true);
    try {
      const members = await searchMembers(ctx!.gymId, search.trim(), 1);
      if (!Array.isArray(members) || !members.length) {
        message.error('No member found');
        return;
      }
      const m = members[0] as GymMember;
      const r = await markAttendance(ctx!.gymId, m.id);
      message.success(r.duplicate
        ? `${m.first_name} was already marked present today`
        : `${m.first_name} marked present`);
      if (r.warning) message.warning(r.warning);
      setSearch('');
      load();
    } catch (e: any) {
      message.error(e.message || 'Could not mark attendance');
    } finally {
      setSearching(false);
    }
  };

  const maxPeak = stats?.peak_hours?.length ? Math.max(...stats.peak_hours.map((h) => h.count)) : 1;
  const canCorrect = ctx!.permissions.includes('attendance.manage');

  return (
    <PageContainer
      title="Attendance"
      subtitle="One visit = one record. QR scans, front desk and workout completions all collapse onto the member's day."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Attendance' }]}
      extra={<Button icon={<ReloadOutlined />} onClick={load}>Refresh</Button>}
    >
      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card size="small" title={<><QrcodeOutlined /> QR check-in</>}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="Scan or paste the member's QR token…"
                value={qrValue}
                onChange={(e) => setQrValue(e.target.value)}
                onPressEnter={doScan}
                disabled={searching}
              />
              <Button type="primary" loading={searching} onClick={doScan}>Check in</Button>
            </Space.Compact>
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              Expired, frozen or cancelled memberships are rejected here. Invalid codes and codes
              from other gyms look identical.
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title={<><SearchOutlined /> Search & mark present</>}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="Search member by name or code…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onPressEnter={searchAndMark}
                disabled={searching}
              />
              <Button type="primary" loading={searching} onClick={searchAndMark}>Mark present</Button>
            </Space.Compact>
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
              Desk discretion — works for expired memberships (with a warning), never for members who left.
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} md={4}><Card size="small"><Statistic title="Today" value={stats?.today_count ?? '…'} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="This week" value={stats?.week_count ?? '…'} /></Card></Col>
        <Col xs={12} md={4}><Card size="small"><Statistic title="This month" value={stats?.month_count ?? '…'} /></Card></Col>
        <Col xs={24} md={12}>
          <Card size="small" title={<><ClockCircleOutlined /> Peak hours (30 days)</>}>
            {stats?.peak_hours?.length ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 60 }}>
                {stats.peak_hours.map((h) => (
                  <Tooltip key={h.hour} title={`${h.hour}:00 — ${h.count} check-ins`}>
                    <div style={{
                      width: 26, height: `${Math.max(10, (h.count / maxPeak) * 100)}%`,
                      background: '#E8481F', borderRadius: 4,
                      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
                      color: '#fff', fontSize: 10,
                    }}>{h.hour}</div>
                  </Tooltip>
                ))}
              </div>
            ) : <Typography.Text type="secondary">No data yet</Typography.Text>}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} md={14}>
          <Card size="small" title="Check-ins" extra={
            <Input type="date" size="small" style={{ width: 160 }} value={recordsDate}
              onChange={(e) => setRecordsDate(e.target.value)} />
          }>
            {error && <Alert type="error" showIcon message="Could not load attendance" description={error.message}
              action={<Button icon={<ReloadOutlined />} onClick={load}>Retry</Button>} style={{ marginBottom: 12 }} />}
            {!records ? <Spin /> : records.length === 0 ? (
              <Typography.Text type="secondary">No check-ins on this day.</Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={records}
                renderItem={(r) => (
                  <List.Item>
                    <Space style={{ flex: 1 }}>
                      <CheckCircleOutlined style={{ color: '#16A34A' }} />
                      <Typography.Text strong>{[r.first_name, r.last_name].filter(Boolean).join(' ')}</Typography.Text>
                      <Tag>{r.member_code}</Tag>
                    </Space>
                    <Space>
                      <Typography.Text type="secondary">{dayjs(r.check_in_at).format('HH:mm')}</Typography.Text>
                      <Tag color={r.source === 'QR_CHECK_IN' ? 'blue' : r.source === 'WORKOUT_COMPLETION' ? 'purple' : 'default'}>
                        {r.source.replace(/_/g, ' ')}
                      </Tag>
                      {r.time_corrected && <Tag color="orange">time corrected</Tag>}
                      {canCorrect && (
                        <Button size="small" danger type="text"
                          onClick={async () => {
                            try {
                              await deleteAttendance(ctx!.gymId, r.id);
                              message.success('Record removed');
                              load();
                            } catch (e: any) { message.error(e.message || 'Could not remove'); }
                          }}>remove</Button>
                      )}
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} md={10}>
          <Card size="small" title={<><UserDeleteOutlined /> Inactive members (14+ days)</>}>
            {!stats ? <Spin /> : stats.inactive_members?.length ? (
              <List
                size="small"
                dataSource={stats.inactive_members}
                renderItem={(m) => (
                  <List.Item>
                    <Typography.Text>
                      {[m.first_name, m.last_name].filter(Boolean).join(' ')} <Tag>{m.member_code}</Tag>
                    </Typography.Text>
                    <Typography.Text type={m.last_visit ? 'warning' : 'secondary'}>
                      {m.last_visit ? `last visit ${m.last_visit}` : 'never visited'}
                    </Typography.Text>
                  </List.Item>
                )}
              />
            ) : (
              <Typography.Text type="secondary">Everyone is active — nothing to chase.</Typography.Text>
            )}
          </Card>
        </Col>
      </Row>
      <div style={{ display: 'none' }}>{HOURS.length}</div>
    </PageContainer>
  );
}
