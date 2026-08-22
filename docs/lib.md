# Library Services Documentation (`src/lib/`)

This directory contains all utility functions, API wrappers, and services used throughout the app.

## Files Overview

| File | Purpose |
|------|---------|
| [api.js](#apijs) | HTTP client wrapper with JWT auth |
| [config.js](#configjs) | App configuration constants |
| [sync.js](#syncjs) | Offline-first sync service |
| [syncService.js](#syncservicejs) | Session sync to backend |
| [notifications.js](#notificationsjs) | Rest timer notifications |
| [notificationApi.js](#notificationapijs) | Push notification API |
| [haptics.js](#hapticsjs) | Haptic feedback wrapper |
| [plates.js](#platesjs) | Plate calculator math |
| [stats.js](#statsjs) | Volume calculations |
| [streakCalc.js](#streakcalcjs) | Streak calculation logic |
| [streaks.js](#streaksjs) | Streak data access |
| [units.js](#unitsjs) | Unit conversion (kg/lb, cm/in) |
| [viewMode.js](#viewmodejs) | User/Trainer view mode |
| [share.js](#sharejs) | Workout sharing |
| [startAssigned.js](#startassignedjs) | Start assigned workouts |
| [tagsApi.js](#tagsapijs) | Tag management API |
| [volumeWarnings.js](#volumewarningsjs) | Volume warning logic |

---

## api.js

**Purpose**: HTTP client wrapper that handles authentication and token refresh.

**Key Functions**:
- `registerTokenHooks(hooks)` - Register token get/set callbacks
- `api(path, options)` - Make authenticated API request
- `tryRefresh()` - Attempt to refresh JWT token
- `ApiError` - Custom error class for API failures

**Features**:
- Attaches JWT Bearer token to all requests
- Automatic token refresh on 401 (single attempt)
- JSON request/response handling
- Error handling with status codes

**Usage**:
```javascript
import { api } from './lib/api';

// GET request
const user = await api('/me');

// POST request
const result = await api('/endpoint', { 
  method: 'POST', 
  body: { key: 'value' } 
});
```

---

## config.js

**Purpose**: App configuration constants.

**Contents**:
- `API_URL` - Backend server URL
- Other app-wide settings

---

## sync.js

**Purpose**: Offline-first sync service for cloud backup and restore.

**Key Functions**:
- `initConnectivityListener()` - Monitor network state
- `getSyncSettings()` - Get current sync configuration
- `setSyncMode(mode)` - Set sync mode (auto/manual/local)
- `addToSyncQueue(entityType, entityId, operation, payload)` - Queue item for sync
- `syncPending()` - Process pending sync queue
- `pullFromCloud()` - Restore data from server on login

**Sync Modes**:
- `auto` - Automatically sync when online
- `manual` - User triggers sync manually
- `local` - Local only, no cloud sync

**Entity Types**:
- `SESSION` - Workout sessions
- `SESSION_DETAIL` - Session exercise details
- `MEASUREMENT` - Body measurements
- `WORKOUT_PLAN` - Workout templates/routines
- `USER_SETTINGS` - User preferences

**Note**: Currently only syncs sessions, measurements, and workout plans. Diet plans and user settings are NOT synced.

---

## syncService.js

**Purpose**: Background sync of workout sessions to the backend.

**Key Functions**:
- `queueSessionForSync(sessionId)` - Queue a session for sync (fire-and-forget)
- `syncPendingSessions()` - Batch sync all pending sessions
- `syncPendingMeasurements()` - Batch sync body measurements

**Flow**:
1. When session is saved, `queueSessionForSync()` is called
2. Immediately attempts sync if online
3. On app foreground, `syncPendingSessions()` catches up
4. Sessions sent to `/client/session-summaries`
5. Details sent to `/client/session-exercise-details`

---

## notifications.js

**Purpose**: Local notifications for rest timer.

**Key Functions**:
- `scheduleTimerNotification(delaySeconds, exerciseName)` - Schedule notification
- `cancelTimerNotification()` - Cancel pending notification
- `cancelAllNotifications()` - Clear all scheduled notifications

---

## notificationApi.js

**Purpose**: Push notification registration and handling.

---

## haptics.js

**Purpose**: Haptic feedback wrapper using expo-haptics.

**Key Functions**:
- `light()` - Light haptic
- `medium()` - Medium haptic  
- `heavy()` - Heavy haptic
- `success()` - Success notification haptic
- `warning()` - Warning notification haptic
- `error()` - Error notification haptic

---

## plates.js

**Purpose**: Plate calculator math for weight loading.

**Key Functions**:
- `calculatePlates(targetWeight, barWeight, availablePlates)` - Calculate plates per side
- Returns array of plates needed, or null if impossible

**Example**:
```javascript
const plates = calculatePlates(60, 20, [25, 20, 15, 10, 5, 2.5]);
// Returns plates per side: [20, 20] for 60kg with 20kg bar
```

---

## stats.js

**Purpose**: Volume and workout statistics calculations.

---

## streakCalc.js

**Purpose**: Streak calculation logic.

**Key Functions**:
- `calculateStreak(workoutDates, tolerance)` - Calculate current streak
- Returns streak count and dates

---

## streaks.js

**Purpose**: Streak data access from database.

---

## units.js

**Purpose**: Unit conversion utilities.

**Key Functions**:
- `kgToLb(kg)` - Kilograms to pounds
- `lbToKg(lb)` - Pounds to kilograms
- `cmToIn(cm)` - Centimeters to inches
- `inToCm(in)` - Inches to centimeters

---

## viewMode.js

**Purpose**: Manage user/trainer view mode switching.

**Key Functions**:
- `getViewMode()` - Get current view mode
- `setViewMode(mode)` - Set view mode
- `clearViewChoice()` - Clear saved preference

---

## share.js

**Purpose**: Workout sharing functionality.

---

## startAssigned.js

**Purpose**: Start a trainer-assigned workout.

**Key Functions**:
- `startAssignedWorkout(assignmentId)` - Begin assigned workout

---

## tagsApi.js

**Purpose**: Tag management API wrapper.

**Key Functions**:
- `fetchTags()` - Get all tags
- `createTag(name, type)` - Create new tag
- `deleteTag(id)` - Delete tag

---

## volumeWarnings.js

**Purpose**: Volume change warning logic.

**Key Functions**:
- `checkVolumeWarning(currentVolume, previousVolume, threshold)` - Check if warning needed