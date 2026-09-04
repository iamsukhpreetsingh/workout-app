// Gym-owned workout content (Phase 11): versioned workouts with
// exercises-by-name, archive/restore/recommend, member assignments.
import { api } from './client';

export interface WorkoutExercise {
  id?: string;
  exercise_name: string;
  sets: number | null;
  reps: string | null;
  duration_minutes: number | null;
  order_index?: number;
  notes: string | null;
}

export interface WorkoutRow {
  id: string;
  gym_id: string;
  title: string;
  description: string | null;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  goal: string;
  estimated_duration_minutes: number | null;
  tags: string[];
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  recommended: boolean;
  version: number;
  exercise_count?: number;
  assigned_count?: number;
  saves_count?: number;
  exercises?: WorkoutExercise[];
}

export const listWorkouts = (gymId: string) =>
  api<WorkoutRow[]>(`/gym/${gymId}/workouts`);

export const getWorkout = (gymId: string, workoutId: string) =>
  api<WorkoutRow>(`/gym/${gymId}/workouts/${workoutId}`);

export const createWorkout = (gymId: string, body: Record<string, any>) =>
  api<WorkoutRow>(`/gym/${gymId}/workouts`, { method: 'POST', body });

export const updateWorkout = (gymId: string, workoutId: string, patch: Record<string, any>) =>
  api<WorkoutRow>(`/gym/${gymId}/workouts/${workoutId}`, { method: 'PATCH', body: patch });

export interface WorkoutAssignment {
  id: string;
  gym_id: string;
  workout_id: string;
  member_id: string;
  status: 'ACTIVE' | 'ENDED';
  end_reason: string | null;
  assigned_by_name?: string | null;
  workout_title: string;
  workout_version?: number;
  workout_status?: string;
  difficulty?: string;
  goal?: string;
  first_name?: string;
  last_name?: string;
  member_code?: string;
}

export const listMemberWorkoutAssignments = (gymId: string, memberId: string) =>
  api<WorkoutAssignment[]>(`/gym/${gymId}/members/${memberId}/workout-assignments`);

export const assignWorkout = (gymId: string, memberId: string, workoutId: string) =>
  api<WorkoutAssignment>(`/gym/${gymId}/members/${memberId}/workout-assignments`,
    { method: 'POST', body: { workout_id: workoutId } });

export const endWorkoutAssignment = (gymId: string, memberId: string, assignmentId: string, reason?: string) =>
  api<{ ok: boolean }>(`/gym/${gymId}/workout-assignments/${assignmentId}/end`,
    { method: 'POST', body: { reason } });

export const listAssignableWorkouts = (gymId: string) =>
  api<WorkoutRow[]>(`/gym/${gymId}/workouts?status=PUBLISHED`);
