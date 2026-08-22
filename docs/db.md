# Database Schema Documentation (`src/db/`)

This document describes the SQLite database schema used in the app for local storage.

---

## db.js

**Purpose**: Main database initialization and migration management.

**Tables Created**:

### exercises
Seed exercise library (~38 exercises).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| name | TEXT | Exercise name |
| muscle | TEXT | Primary muscle group |
| category | TEXT | Category (compound/isolation) |
| equipment | TEXT | Required equipment |

### workout_sessions
Completed workout sessions.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| name | TEXT | Session name |
| start_time | INTEGER | Unix timestamp |
| end_time | INTEGER | Unix timestamp |
| duration_sec | INTEGER | Duration in seconds |
| notes | TEXT | Session notes |
| plan_id | INTEGER | Source routine ID |
| synced | INTEGER | 0=pending, 1=synced |
| sync_attempted_at | TEXT | Last sync attempt |
| source_assigned_plan_id | INTEGER | Assigned plan source |
| local_session_id | TEXT | Unique local ID |
| user_id | INTEGER | Owner user ID |

### session_exercises
Exercises within a session.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| session_id | INTEGER | FK to workout_sessions |
| exercise_id | INTEGER | FK to exercises |
| position | INTEGER | Order in session |
| rest_seconds | INTEGER | Rest time configured |
| notes | TEXT | Exercise notes |

### sets
Individual sets within a session exercise.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| session_exercise_id | INTEGER | FK to session_exercises |
| weight | REAL | Weight lifted |
| reps | INTEGER | Repetitions |
| is_warmup | INTEGER | 0=working, 1=warmup |
| position | INTEGER | Set order |
| set_type | TEXT | working/warmup/drop/failure |
| completed | INTEGER | 0=incomplete, 1=complete |
| rpe | REAL | Rate of perceived exertion |
| local_set_id | TEXT | Unique local ID |

### workout_plans
User-created workout routines/templates.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| name | TEXT | Plan name |
| notes | TEXT | Plan notes |
| created_at | INTEGER | Unix timestamp |
| user_id | INTEGER | Owner user ID |
| tags | TEXT | JSON array of tags |
| synced | INTEGER | Sync status |

### plan_exercises
Exercises within a workout plan.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| plan_id | INTEGER | FK to workout_plans |
| exercise_id | INTEGER | FK to exercises |
| position | INTEGER | Order in plan |
| target_sets | INTEGER | Target number of sets |
| rest_seconds | INTEGER | Rest time |
| group_id | INTEGER | Superset group ID |

### body_metrics
Body weight and measurement logs.

| Column | Type | Description |
|--------|------|-------------|
| date | TEXT | Date (YYYY-MM-DD) |
| metric_type | TEXT | weight/waist/chest/hips/arms/thighs/neck/body_fat |
| value | REAL | Metric value |
| unit | TEXT | Unit of measurement |
| synced | INTEGER | Sync status |

### user_settings
User preferences and app settings.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | INTEGER | 1 | Always 1 (singleton) |
| weight_unit | TEXT | kg | kg or lb |
| length_unit | TEXT | cm | cm or in |
| default_rest | INTEGER | 90 | Default rest seconds |
| rpe_enabled | INTEGER | 1 | RPE tracking on/off |
| bar_weight | REAL | 20 | Barbell weight |
| plates | TEXT | JSON | Available plates |
| streak_tolerance | INTEGER | 1 | Days allowed without workout |
| theme_mode | TEXT | system | light/dark/system |
| haptics_enabled | INTEGER | 1 | Haptic feedback on/off |

### progress_photos
Progress photos stored locally.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| date | TEXT | Photo date |
| uri | TEXT | Local file URI |
| type | TEXT | front/back/side |

### pins
Pinned workout plans for quick access.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| plan_id | INTEGER | FK to workout_plans |
| user_id | INTEGER | Owner user ID |

### active_workout
Currently active workout (for crash recovery).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| session_id | INTEGER | FK to workout_sessions |
| start_time | INTEGER | Unix timestamp |
| exercise_order | TEXT | JSON array of exercise IDs |

### personal_records
Tracked personal records.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| exercise_id | INTEGER | FK to exercises |
| record_type | TEXT | max_weight/max_reps/max_volume/estimated_1rm |
| value | REAL | Record value |
| set_id | INTEGER | FK to sets |
| achieved_at | INTEGER | Unix timestamp |

### sync_settings
Sync configuration.

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | INTEGER | 1 | Always 1 |
| sync_mode | TEXT | auto | auto/manual/local |
| sync_enabled | INTEGER | 1 | 0=disabled |
| last_synced_at | INTEGER | NULL | Last sync timestamp |

### sync_queue
Pending sync operations queue.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| operation_id | TEXT | Unique operation ID |
| entity_type | TEXT | session/measurement/workout_plan |
| entity_id | TEXT | Entity ID |
| operation | TEXT | CREATE/UPDATE/DELETE |
| payload | TEXT | JSON payload |
| created_at | INTEGER | Unix timestamp |
| updated_at | INTEGER | Unix timestamp |
| status | TEXT | PENDING/SYNCING/COMPLETED/FAILED |
| last_error | TEXT | Error message if failed |
| retry_count | INTEGER | Number of retry attempts |

---

## queries.js

**Purpose**: SQL query helpers for database operations.

**Key Functions**:

### Session Queries
- `createSession(name, planId)` - Create new workout session
- `getSession(id)` - Get session by ID
- `getRecentSessions(limit)` - Get recent sessions
- `deleteSession(id)` - Delete session and related data

### Exercise Queries
- `addExerciseToSession(sessionId, exerciseId)` - Add exercise to session
- `getSessionExercises(sessionId)` - Get all exercises in session
- `removeExerciseFromSession(sessionExerciseId)` - Remove exercise

### Set Queries
- `addSet(sessionExerciseId, weight, reps)` - Add set
- `updateSet(id, updates)` - Update set data
- `deleteSet(id)` - Delete set

### Plan Queries
- `createPlan(name, notes)` - Create workout plan
- `getPlans()` - Get all user plans
- `getPlan(id)` - Get plan by ID
- `updatePlan(id, data)` - Update plan
- `deletePlan(id)` - Delete plan

### Sync Queries
- `getUnsyncedSessionIds()` - Get sessions pending sync
- `markSessionsSynced(ids)` - Mark sessions as synced
- `getSessionSyncAggregate(id)` - Get session data for sync

---

## body.js

**Purpose**: Body metrics (weight, measurements) data access.

**Key Functions**:
- `addBodyMetric(date, metricType, value, unit)` - Add measurement
- `getBodyMetrics(type, range)` - Get measurements
- `getUnsyncedMeasurements()` - Get measurements pending sync
- `markMeasurementsSynced(entries)` - Mark as synced

---

## pr.js

**Purpose**: Personal records tracking and detection.

**Key Functions**:
- `checkForPR(sessionExerciseId, set)` - Check if set is a PR
- `getPRs(exerciseId)` - Get all PRs for exercise
- `getAllPRs()` - Get all PRs

**PR Types**:
- `max_weight` - Heaviest weight lifted
- `max_reps` - Most reps at a weight
- `max_volume` - Highest volume (weight × reps)
- `estimated_1rm` - Highest estimated 1RM

---

## photos.js

**Purpose**: Progress photo management.

**Key Functions**:
- `addPhoto(date, uri, type)` - Add progress photo
- `getPhotos()` - Get all photos
- `deletePhoto(id)` - Delete photo
- `comparePhotos(id1, id2)` - Get two photos for comparison

---

## pins.js

**Purpose**: Pinned plans for quick access.

**Key Functions**:
- `pinPlan(planId)` - Pin a plan
- `unpinPlan(planId)` - Unpin a plan
- `getPinnedPlans()` - Get all pinned plans

---

## settings.js

**Purpose**: User settings management.

**Key Functions**:
- `getSettings()` - Get all settings
- `updateSetting(key, value)` - Update single setting
- `getSetting(key)` - Get single setting

---

## userId.js

**Purpose**: Current user ID management.

**Key Functions**:
- `setCurrentUserId(id)` - Set current user
- `getCurrentUserId()` - Get current user