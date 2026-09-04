// Unified content assignments (Phase 13) — ONE API surface for assigning
// gym-owned content (WORKOUT | NUTRITION) to gym members, with start/end
// dates, notes and computed lifecycle status. Works for members with or
// without an app account (app_user_id NULL is first-class).
import { api } from './client';

export type ContentType = 'WORKOUT' | 'NUTRITION';
export type EffectiveStatus = 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'ENDED';

export interface ContentAssignment {
  id: string;
  gym_id: string;
  content_type: ContentType;
  workout_id: string | null;
  item_id: string | null;
  member_id: string;
  status: 'ACTIVE' | 'ENDED';          // physical status
  starts_on: string;                   // 'YYYY-MM-DD', inclusive, gym-local
  ends_on: string | null;              // inclusive — after this date: EXPIRED
  notes: string | null;
  assigned_version: number;            // content version when assigned
  end_reason: string | null;
  ended_on: string | null;
  effective_status: EffectiveStatus;   // computed: SCHEDULED/ACTIVE/EXPIRED/ENDED
  content_updated: boolean;            // current content version > assigned_version
  // member
  first_name?: string;
  last_name?: string;
  member_code?: string;
  app_user_id?: string | null;
  member_status?: string;
  assigned_by_name?: string | null;
  // workout-side fields (WORKOUT rows)
  workout_title?: string | null;
  workout_version?: number;
  workout_status?: string;
  difficulty?: string;
  goal?: string;
  // nutrition-side fields (NUTRITION rows)
  item_title?: string | null;
  item_kind?: string;
  item_version?: number;
  item_status?: string;
  // unified
  content_title: string;
  created_at: string;
}

export interface AssignPayload {
  member_id: string;
  content_type: ContentType;
  workout_id?: string;
  item_id?: string;
  starts_on?: string;                  // default: today in the gym's timezone
  ends_on?: string | null;
  notes?: string | null;
}

export interface AssignmentListParams {
  member_id?: string;
  content_type?: ContentType;
  content_id?: string;
  effective_status?: EffectiveStatus;
  q?: string;
  limit?: number;
  offset?: number;
}

// OWNER/ADMIN (members.manage) or TRAINER (assignments.manage, roster-scoped
// server-side) may create/edit/end. Lists additionally allow members.view /
// assigned_members.view — trainers are auto-scoped to their roster.
export const assignContent = (gymId: string, body: AssignPayload) =>
  api<ContentAssignment>(`/gym/${gymId}/assignments`, { method: 'POST', body });

export const listAssignments = (gymId: string, params: AssignmentListParams = {}) => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();
  return api<ContentAssignment[]>(`/gym/${gymId}/assignments${query ? `?${query}` : ''}`);
};

export const listMemberAssignments = (gymId: string, memberId: string, contentType?: ContentType) => {
  const query = contentType ? `?content_type=${contentType}` : '';
  return api<ContentAssignment[]>(`/gym/${gymId}/members/${memberId}/assignments${query}`);
};

// Edit window/notes of an ACTIVE assignment (extends end date to revive an
// EXPIRED one). ENDED rows are immutable.
export const updateAssignment = (gymId: string, assignmentId: string, patch: {
  starts_on?: string; ends_on?: string | null; notes?: string | null;
}) =>
  api<ContentAssignment>(`/gym/${gymId}/assignments/${assignmentId}`, { method: 'PATCH', body: patch });

export const endAssignment = (gymId: string, assignmentId: string, reason?: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/assignments/${assignmentId}/end`, { method: 'POST', body: { reason } });
