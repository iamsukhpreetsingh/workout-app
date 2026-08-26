// Admin API client: attaches the admin access token, performs one silent
// refresh on 401, and holds the logged-in admin's profile.
const BASE = '/admin';

let accessToken: string | null = localStorage.getItem('admin_access');
let refreshToken: string | null = localStorage.getItem('admin_refresh');

export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
}

let profile: AdminProfile | null = null;

export function getProfile() {
  return profile;
}

export function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem('admin_access', access);
  localStorage.setItem('admin_refresh', refresh);
}

export function clearSession() {
  accessToken = null;
  refreshToken = null;
  profile = null;
  localStorage.removeItem('admin_access');
  localStorage.removeItem('admin_refresh');
}

export async function login(email: string, password: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Login failed');
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  profile = data.admin;
  return data.admin as AdminProfile;
}

async function tryRefresh() {
  if (!refreshToken) return false;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setTokens(data.accessToken, data.refreshToken);
  profile = data.admin;
  return true;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  const call = () =>
    fetch(`${BASE}${path}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  let res = await call();
  if (res.status === 401 && (await tryRefresh())) {
    res = await call();
  }
  if (res.status === 401) {
    clearSession();
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function logout() {
  if (refreshToken) {
    await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  }
  clearSession();
}

// restore profile on page reload
export async function restoreProfile() {
  if (!accessToken) return null;
  try {
    profile = await api<AdminProfile>('/me');
    return profile;
  } catch {
    return null;
  }
}

// ════════════════════ Relationships (Phase 5) ════════════════════════
export interface RelationshipRow {
  id: string;
  status: string;
  trainer_name: string;
  trainer_email: string;
  client_name: string;
  client_email: string;
  created_at: string;
  archived_at: string | null;
  purge_at: string | null;
  days_until_purge: number;
  restore_preference?: string | null;
}
export interface PendingCount {
  pending?: number;
  active?: number;
  archived?: number;
  revoked?: number;
  reactivation_awaiting: number;
}
export interface PurgeRun {
  id: string;
  ran_at: string;
  rows_purged: number;
  relationships_purged: number;
  errors: string | null;
}
export const getRelationships = (params: { status?: string; purgeWithinDays?: number; reactivationAwaiting?: boolean; limit?: number; offset?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.purgeWithinDays != null) qs.set('purgeWithinDays', String(params.purgeWithinDays));
  if (params.reactivationAwaiting) qs.set('reactivationAwaiting', '1');
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<{ page: number; limit: number; relationships: RelationshipRow[] }>(`/relationships?${qs}`);
};
export const getRelationshipsPendingCount = () => api<PendingCount>('/relationships/pending-count');
export const extendPurge = (id: string, days: number) =>
  api<RelationshipRow>(`/relationships/${id}/extend-purge`, { method: 'POST', body: { days } });
export const forceRevoke = (id: string) =>
  api<RelationshipRow>(`/relationships/${id}/force-revoke`, { method: 'POST' });
export const restoreRelationship = (id: string) =>
  api<RelationshipRow>(`/relationships/${id}/restore`, { method: 'POST' });
export const getPurgeRuns = () => api<PurgeRun[]>('/purge-runs');
export const runPurgeJob = () => api<any>('/purge-runs/run', { method: 'POST' });

// ════════════════════ Intake Profiles (Phase 8, sensitive) ═══════════
export interface IntakeProfileMeta {
  id: string;
  client_id: string;
  client_name: string;
  client_email: string;
  completed_at: string | null;
  has_trainer: boolean;
  has_allergens: boolean;
  has_goals: boolean;
  has_injuries: boolean;
  has_medical: boolean;
  trainers: { name: string; email: string }[] | null;
  flagged_at: string | null;
  flag_reason: string | null;
}
export interface IntakeCompletionStats {
  clients_with_active_trainer: number;
  trained_clients_completed: number;
  total_profiles: number;
  completed_profiles: number;
  incomplete_profiles: number;
  completion_rate_pct: number;
}
export const getIntakeProfiles = (params: { limit?: number; offset?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  return api<{ total: number; limit: number; offset: number; profiles: IntakeProfileMeta[] }>(`/intake-profiles?${qs}`);
};
// FULL health data — every successful call is audit-logged server-side.
export const getIntakeProfileDetail = (id: string) => api<any>(`/intake-profiles/${id}`);
export const flagIntakeProfile = (id: string, reason: string) =>
  api<{ ok: boolean; flagged: boolean }>(`/intake-profiles/${id}/flag`, { method: 'POST', body: { reason } });
export const getIntakeCompletionStats = () => api<IntakeCompletionStats>('/intake-profiles-stats/completion');

// ════════════════════ Progression (Phase 9) ══════════════════════════
export interface ProgressionFormula {
  key: string;
  displayName: string;
  description: string;
  paramSchema: { key: string; label: string; type: string; default: any }[];
}
export interface FormulaUsage {
  breakdown: { formula_key: string; users: number; last_updated: string; known: boolean }[];
  unknownRows: number;
  unknownKeys: string[];
  totals: { explicitSettingsRows: number; implicitDefaultUsers: number; appDefaultKey: string };
}
export interface ProgressionOverride {
  id: string;
  trainer_id: string;
  client_id: string;
  formula_key: string;
  params: any;
  updated_at: string;
  trainer_name: string;
  trainer_email: string;
  client_name: string;
  client_email: string;
}
export const getProgressionFormulas = () =>
  api<{ sourceFile: string; count: number; formulas: ProgressionFormula[] }>('/progression/formulas');
export const getProgressionUsage = () => api<FormulaUsage>('/progression/formulas/usage');
export const getProgressionOverrides = (params: { page?: number; limit?: number; trainerId?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.page != null) qs.set('page', String(params.page));
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.trainerId) qs.set('trainer_id', params.trainerId);
  return api<{ page: number; limit: number; total: number; overrides: ProgressionOverride[] }>(`/progression/overrides?${qs}`);
};
export const deleteProgressionOverride = (id: string) =>
  api<{ ok: boolean }>(`/progression/overrides/${id}`, { method: 'DELETE' });

// ════════════════════ Workout content (Phase 6) ══════════════════════
export interface ExerciseRow {
  id: string;
  name: string;
  category: string | null;
  body_part: string | null;
  equipment: string | null;
  muscle_group: string | null;
  is_official: boolean;
  updated_at: string;
}
export const getExercises = (params: { q?: string; bodyPart?: string; equipment?: string; page?: number; pageSize?: number; sort?: string; order?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.bodyPart) qs.set('body_part', params.bodyPart);
  if (params.equipment) qs.set('equipment', params.equipment);
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize));
  if (params.sort) qs.set('sort', params.sort);
  if (params.order) qs.set('order', params.order);
  return api<{ page: number; limit: number; total: number; exercises: ExerciseRow[] }>(`/workout/exercises?${qs}`);
};
export const patchExercise = (id: string, body: Record<string, any>) =>
  api<ExerciseRow>(`/workout/exercises/${id}`, { method: 'PATCH', body });
export interface CustomExerciseRow {
  id: string;
  user_id: string;
  owner_name: string;
  owner_email: string;
  name: string;
  muscle_group: string | null;
  equipment: string | null;
  body_part: string | null;
  created_at: string;
}
export interface CustomExerciseDuplicate {
  normalized_name: string;
  occurrences: number;
  owners: { id: string; user_id: string; owner_name: string; owner_email: string; name: string }[];
}
export const getCustomExercises = (params: { q?: string; userId?: string; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.userId) qs.set('user_id', params.userId);
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('limit', String(params.pageSize));
  return api<{ page: number; limit: number; exercises: CustomExerciseRow[]; potential_duplicates: CustomExerciseDuplicate[] }>(`/workout/custom-exercises?${qs}`);
};
export interface TemplateRow {
  id: string;
  trainer_id: string;
  trainer_name: string;
  trainer_email: string;
  name: string;
  tags: string[] | null;
  exercise_count: number;
  reuse_count: number;
  created_at: string;
}
export const getTemplates = (params: { trainerId?: string; tag?: string; minExercises?: number; q?: string; page?: number; pageSize?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.trainerId) qs.set('trainer_id', params.trainerId);
  if (params.tag) qs.set('tag', params.tag);
  if (params.minExercises != null) qs.set('min_exercises', String(params.minExercises));
  if (params.q) qs.set('q', params.q);
  if (params.page != null) qs.set('page', String(params.page));
  if (params.pageSize != null) qs.set('limit', String(params.pageSize));
  return api<{ page: number; limit: number; templates: TemplateRow[] }>(`/workout/templates?${qs}`);
};
export const getAssignedPlanDetail = (id: string) => api<any>(`/workout/assigned-plans/${id}`);
export interface SubstitutionTotals {
  substitutions: number;
  affected_sessions: number;
  clients_substituting: number;
}
export const getSubstitutionsAudit = (minCount = 1) =>
  api<{ totals: SubstitutionTotals; pairs: { original: string; swapped_to: string; times_used: number; distinct_clients: number; last_substituted_at: string }[] }>(
    `/workout/substitutions-audit?min_count=${minCount}`
  );
export interface SupersetIntegrity {
  total_orphans: number;
  parents_affected: number;
  groups: { parent_type: string; parent_id: string; parent_name: string; orphaned_exercises: { exercise_row_id: string; exercise_name: string; order_index: number; group_id: string }[] }[];
}
export const getSupersetIntegrity = () => api<SupersetIntegrity>('/workout/superset-integrity');
export interface ContentHealth {
  most_used: TemplateRow[];
  least_used: TemplateRow[];
}
export const getWorkoutContentHealth = () => api<ContentHealth>('/workout/content-health');

// ════════════════════ Nutrition (Phase 7) ════════════════════════════
export interface MealCatalogItem {
  id: string;
  name: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  tags: string[] | null;
  allergens: string[] | null;
  difficulty: string | null;
  plan_usage_count: number;
  trainer_id: string;
  trainer_name: string;
  trainer_email: string;
  created_at: string;
}
export const getMealCatalog = () => api<MealCatalogItem[]>('/nutrition/meal-catalog');
export interface RecipeRow extends Omit<MealCatalogItem, 'trainer_id' | 'trainer_name' | 'trainer_email' | 'plan_usage_count'> {
  author_id: string;
  author_name: string;
  author_email: string;
  author_role: string;
}
export const getRecipes = () => api<RecipeRow[]>('/nutrition/recipes');
export interface TagVocabRow {
  source_table: string;
  tag: string;
  usage_count: number;
}
export const getTagVocabulary = () => api<TagVocabRow[]>('/nutrition/tag-vocabulary');
export interface AllergenConsistency {
  mealCatalogValues: { allergen: string; count: number }[];
  intakeValues: { allergen: string; count: number }[];
  unmatched: { value: string; count: number; sources: string[]; nearMatches: string[] }[];
  nearDuplicateClusters: { source_table: string; values: string[] }[];
}
// Returns actual client health data — support/super_admin only.
export const getAllergenConsistency = () => api<AllergenConsistency>('/nutrition/allergen-consistency');
export const getDietPlanDetail = (id: string) => api<any>(`/nutrition/diet-plans/${id}`);
export const getSupplementPlanDetail = (id: string) => api<any>(`/nutrition/supplement-plans/${id}`);

// ═══════════════ Notifications volume / delivery (Phase 10) ══════════
export interface NotificationVolume {
  days: number;
  types: string[];
  series: { date: string; counts: Record<string, number>; total: number }[];
  grandTotal: number;
}
export const getNotificationVolume = (days = 30) => api<NotificationVolume>(`/notifications/volume?days=${days}`);
export interface DeliveryStats {
  totals: { delivered: number; failed: number; total: number };
  recentFailures: { id: string; user_email: string | null; token: string; error_detail: string | null; created_at: string }[];
}
export const getDeliveryStats = () => api<DeliveryStats>('/notifications/delivery-stats');

// ════════════════════ Sync / Restore health (Phase 11) ═══════════════
export interface SyncOverview {
  reportingUsers: number;
  reportingUsersLast24h: number;
  totalPending: number;
  totalFailed: number;
  byEntityType: Record<string, { pending: number; failed: number }>;
}
export const getSyncOverview = () => api<SyncOverview>('/sync/overview');
export interface SyncFailingRow {
  user_id: string;
  user_email: string;
  reported_at: string;
  app_version: string | null;
  entity_type: string;
  entity_id: string;
  operation: string | null;
  attempts: number;
  last_error: string | null;
}
export const getSyncFailing = (params: { sort?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.sort) qs.set('sort', params.sort);
  if (params.limit != null) qs.set('limit', String(params.limit));
  return api<SyncFailingRow[]>(`/sync/failing?${qs}`);
};
export interface RestoreStats {
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  inProgress: number;
  avgSuccessDurationMs: number | null;
  avgStepMs: { step: string; samples: number; avg_ms: number }[];
  recentFailures: { id: string; user_email: string | null; started_at: string; failed_step: string | null; duration_ms: number | null }[];
}
export const getRestoreStats = () => api<RestoreStats>('/restore/stats');
export interface PhotoStorageStats {
  total_photos: number;
  users_with_photos: number;
  earliest_upload: string | null;
  latest_upload: string | null;
  uploads_last_7d: number;
  note: string;
}
export const getPhotoStorage = () => api<PhotoStorageStats>('/storage/photos');
export const retryFailedSync = (dryRun: boolean) =>
  api<any>('/sync/retry-failed', { method: 'POST', body: { dryRun } });

// ════════════════════ Analytics (Phase 12) ═══════════════════════════
export interface ConversionFunnel {
  windowDays: number;
  signedUp: number;
  withCompletedIntake: { count: number; pct: number | null };
  withFirstWorkout: { count: number; pct: number | null };
  throughBoth: { count: number; pct: number | null };
}
export const getConversionFunnel = (days = 90) => api<ConversionFunnel>(`/analytics/conversion-funnel?days=${days}`);
export interface CoachingAnalytics {
  trainers: {
    avg_active_clients_per_trainer: number;
    max_active_clients: number;
    avg_archived_share: number;
    median_archived_share: number;
    trainers_with_no_relationships: number;
    trainers_total: number;
  };
  timeToFirstAssignment: { measuredRelationships: number; avgHours: number | null; avgDays: number | null };
  dietAdherence30d: { yes: number; total: number; rate: number | null };
  supplementAdherence30d: { yes: number; total: number; rate: number | null };
}
export const getCoachingAnalytics = () => api<CoachingAnalytics>('/analytics/coaching');
export interface AnalyticsContentHealth {
  templates: { mostUsed: { id: string; name: string; times_assigned: number }[]; leastUsed: { id: string; name: string; times_assigned: number }[]; neverAssigned: number; total: number };
  dishes: { mostUsed: { id: string; name: string; has_recipe_url: boolean; times_used_in_plans: number }[]; leastUsed: { id: string; name: string; has_recipe_url: boolean; times_used_in_plans: number }[]; total: number };
}
export const getAnalyticsContentHealth = () => api<AnalyticsContentHealth>('/analytics/content-health');
export interface FeatureAdoption {
  progressionFormula: { configuredUsers: number; customFormulaUsers: number; defaultFormulaUsers: number; pctCustomAmongConfigured: number | null };
  exerciseSubstitution: { syncedExerciseRows: number; swappedRows: number; pctSwapped: number | null; sessionsWithSwaps: number };
  dietSwaps: { dietPlanUsers: number; everSwappedUsers: number; pctEverSwapped: number | null };
}
export const getFeatureAdoption = () => api<FeatureAdoption>('/analytics/feature-adoption');

// ═══════════════ Users extras (impersonation / reset / sync) ═════════
export const getUserSyncOverview = (userId: string) =>
  api<any>(`/users-sync-overview?userId=${encodeURIComponent(userId)}`);
export const resetUserPassword = (id: string) =>
  api<{ ok: boolean; tempPassword: string; user: { id: string; name: string; email: string }; revokedRefreshTokens: number; warning: string }>(
    `/users/${id}/password-reset`, { method: 'POST' }
  );
export interface ImpersonationResponse {
  token: string;
  user: ImpersonatedUserApi;
  expiresInSeconds: number;
  readOnly: boolean;
}
interface ImpersonatedUserApi {
  id: string;
  name: string;
  email: string;
  role: string;
}
export const impersonateUser = (id: string) =>
  api<ImpersonationResponse>(`/users/${id}/impersonate`, { method: 'POST' });
