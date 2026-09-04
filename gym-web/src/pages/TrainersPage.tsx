// Trainers — real list (gym staff with the TRAINER role). Member
// assignments arrive with the coaching phase — the empty state says so.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PageContainer from '../components/PageContainer';
import DataTable from '../components/DataTable';
import FilterBar from '../components/FilterBar';
import StatusBadge from '../components/StatusBadge';
import { useGymContext } from '../permissions';
import { listStaff, listGymTrainerAssignments, StaffRow, TrainerAssignment } from '../api';

export default function TrainersPage() {
  const ctx = useGymContext();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<any>(null);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listStaff(ctx!.gymId));
    } catch (e: any) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [ctx?.gymId]);

  useEffect(() => { load(); }, [load]);

  const [assignments, setAssignments] = useState<TrainerAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(true);
  const [assignmentsError, setAssignmentsError] = useState<any>(null);
  // the tick is kept for symmetry with StaffPage's reload pattern; nothing
  // re-bumps it today (assignments reload only with the gym context)
  const [assignmentsTick] = useState(0);

  const loadAssignments = useCallback(async () => {
    setAssignmentsLoading(true);
    setAssignmentsError(null);
    try {
      setAssignments(await listGymTrainerAssignments(ctx!.gymId));
    } catch (e: any) {
      setAssignmentsError(e);
    } finally {
      setAssignmentsLoading(false);
    }
  }, [ctx?.gymId]);

  useEffect(() => { loadAssignments(); }, [loadAssignments, assignmentsTick]);

  const trainers = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => r.gym_role === 'TRAINER')
      .filter((r) => !needle || `${r.name} ${r.email}`.toLowerCase().includes(needle));
  }, [rows, q]);

  const columns = useMemo(() => [
    { title: 'Name', dataIndex: 'name' },
    { title: 'Email', dataIndex: 'email' },
    { title: 'Status', dataIndex: 'status', render: (s: string) => <StatusBadge status={s} /> },
    { title: 'Since', dataIndex: 'created_at', render: (v: string) => String(v).slice(0, 10) },
    { title: 'Assigned members', key: 'assigned', render: (_: any, r: StaffRow) => {
      if (assignmentsLoading) return '…';
      if (assignmentsError) return '—';
      const active = assignments.filter((a) => a.trainer_email === r.email && a.status === 'ACTIVE');
      return active.length ? `${active.length}` : '0';
    } },
  ], [assignments, assignmentsLoading, assignmentsError]);

  return (
    <PageContainer
      title="Trainers"
      subtitle="Gym trainers coach assigned members. Assignment management arrives with the coaching phase."
      crumbs={[{ label: 'Home', to: '/' }, { label: 'Trainers' }]}
    >
      <DataTable<StaffRow>
        columns={columns}
        rows={trainers}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={load}
        emptyTitle="No trainers yet"
        emptyDescription={q
          ? 'No trainers match the current search.'
          : 'Add a staff member with the TRAINER role, then assign members from their profile.'}
        page={0}
        pageSize={trainers.length || 1}
        hasNext={false}
        onPageChange={() => {}}
        toolbar={
          <FilterBar searchPlaceholder="Search trainers…" q={q} onQ={setQ} />
        }
      />
    </PageContainer>
  );
}
