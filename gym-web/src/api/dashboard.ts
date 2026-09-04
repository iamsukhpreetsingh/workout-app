// Gym business dashboard (Phase 15): ONE aggregated payload from
// GET /gym/:gymId/dashboard — every number is computed in SQL by the
// backend over ALL gym members (app-connected or not), on the gym's own
// calendar. The portal only renders; it never re-aggregates.
import { api } from './client';

export interface DashboardMembers {
  total: number;
  active: number;
  pending: number;
  frozen: number;
  expired: number;
  cancelled: number;
  expiring_soon_7d: number;
}

export interface DashboardAppAdoption {
  // Total = Connected + Not Connected (non-CANCELLED base);
  // invitation_pending is a SUBSET of not_connected
  total: number;
  connected: number;
  not_connected: number;
  invitation_pending: number;
}

export interface DashboardFinancial {
  currency: string;
  collected_cents: number;        // receipts − refunds (net), all time
  refunded_cents: number;
  collected_month_cents: number;  // net collected this calendar month
  outstanding_cents: number;      // charges − net paid (open, > 0 only)
  overdue_cents: number;          // the past-due slice of outstanding
  open_charges: number;
  overdue_charges: number;
}

export interface DashboardAttendance {
  today: number;
  week: number;   // last 7 gym-local days incl today
  month: number;  // gym-local calendar month to date
  peak_hours: { hour: number; visits: number }[]; // 24 buckets, gym-local clock
  peak_hour: number | null;
  peak_window_days: number;
  inactive_7d: number;           // no visit in the last 7 days (incl. never)
  inactive_window_days: number;
}

export interface DashboardTrainers {
  total: number;                 // active TRAINER staff
  assigned_members: number;      // distinct members with an ACTIVE assignment
  unassigned_members: number;    // member base − assigned
  members_per_trainer: number;   // 1-decimal average load
}

export interface DashboardBranchRow {
  branch: string;
  members: number;
  active: number;
}

export interface GymDashboard {
  members: DashboardMembers;
  app_adoption: DashboardAppAdoption;
  financial: DashboardFinancial;
  attendance: DashboardAttendance;
  trainers: DashboardTrainers;
  branches: DashboardBranchRow[];
  generated_at: string;
  as_of_local: string;           // "YYYY-MM-DD HH:mm" in the gym's timezone
}

export const getDashboard = (gymId: string) =>
  api<GymDashboard>(`/gym/${gymId}/dashboard`);
