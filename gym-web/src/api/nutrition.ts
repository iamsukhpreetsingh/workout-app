// Gym-owned nutrition content (Phase 12): versioned recipes / meal plans /
// diet recommendations with targets, archive/restore/recommend, member
// assignments.
import { api } from './client';

export interface NutritionItem {
  id: string;
  gym_id: string;
  kind: 'RECIPE' | 'MEAL_PLAN' | 'DIET_RECOMMENDATION';
  title: string;
  description: string | null;
  content: { entries: string[] };
  targets: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number } | null;
  tags: string[];
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  recommended: boolean;
  version: number;
  assigned_count?: number;
  saves_count?: number;
}

export const listNutrition = (gymId: string) =>
  api<NutritionItem[]>(`/gym/${gymId}/nutrition`);

export const createNutritionItem = (gymId: string, body: Record<string, any>) =>
  api<NutritionItem>(`/gym/${gymId}/nutrition`, { method: 'POST', body });

export const updateNutritionItem = (gymId: string, itemId: string, patch: Record<string, any>) =>
  api<NutritionItem>(`/gym/${gymId}/nutrition/${itemId}`, { method: 'PATCH', body: patch });

export interface NutritionAssignment {
  id: string;
  gym_id: string;
  item_id: string;
  member_id: string;
  status: 'ACTIVE' | 'ENDED';
  end_reason: string | null;
  assigned_by_name?: string | null;
  item_title: string;
  item_kind: string;
  item_version?: number;
  item_status?: string;
}

export const listMemberNutritionAssignments = (gymId: string, memberId: string) =>
  api<NutritionAssignment[]>(`/gym/${gymId}/members/${memberId}/nutrition-assignments`);

export const assignNutrition = (gymId: string, memberId: string, itemId: string) =>
  api<NutritionAssignment>(`/gym/${gymId}/members/${memberId}/nutrition-assignments`,
    { method: 'POST', body: { item_id: itemId } });

export const endNutritionAssignment = (gymId: string, memberId: string, assignmentId: string, reason?: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/nutrition-assignments/${assignmentId}/end`,
    { method: 'POST', body: { reason } });

export const listAssignableNutrition = (gymId: string) =>
  api<NutritionItem[]>(`/gym/${gymId}/nutrition?status=PUBLISHED`);
