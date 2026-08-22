# Store/Context Documentation (`src/store/`)

This file documents React Context providers used for state management.

---

## AuthContext.js

**Purpose**: Authentication state management - handles user login/logout and session.

**State**:
```javascript
{
  user: { id, email, name, role } | null,
  authStatus: 'checking' | 'authenticated' | 'unauthenticated'
}
```

**Functions**:
- `login(email, password)` - Authenticate user
- `signup(email, password, name, role)` - Register new user
- `logout()` - Clear session and logout
- `refreshSession()` - Attempt silent refresh

**Key Features**:
- JWT token storage in SecureStore
- Automatic token refresh on 401
- Calls `pullFromCloud()` on login to restore data
- Triggers sync on session restore

**Usage**:
```javascript
const { user, authStatus, login, logout } = useContext(AuthContext);
```

---

## AppContext.js

**Purpose**: App-wide settings and preferences.

**State**:
```javascript
{
  theme: 'light' | 'dark' | 'system',
  colors: { primary, background, surface, text, ... },
  hapticsEnabled: boolean,
  weightUnit: 'kg' | 'lb',
  lengthUnit: 'cm' | 'in'
}
```

**Functions**:
- `setTheme(theme)` - Change theme
- `toggleHaptics()` - Toggle haptic feedback
- `setWeightUnit(unit)` - Set weight unit
- `setLengthUnit(unit)` - Set length unit

**Usage**:
```javascript
const { theme, colors, hapticsEnabled } = useContext(AppContext);
```

---

## WorkoutContext.js

**Purpose**: Active workout state management.

**State**:
```javascript
{
  activeSession: {
    id: number,
    startTime: number,
    name: string,
    exercises: [{
      id: number,
      exerciseId: number,
      sets: [{
        weight: number,
        reps: number,
        completed: boolean,
        rpe: number
      }]
    }]
  } | null,
  isResting: boolean,
  restTimeRemaining: number
}
```

**Functions**:
- `startWorkout(planId?)` - Start new workout (empty or from plan)
- `addExercise(exerciseId)` - Add exercise to session
- `addSet(exerciseIndex, weight, reps)` - Add set
- `updateSet(exerciseIndex, setIndex, updates)` - Update set
- `deleteSet(exerciseIndex, setIndex)` - Delete set
- `removeExercise(exerciseIndex)` - Remove exercise
- `startRest(duration)` - Start rest timer
- `skipRest()` - Skip rest timer
- `finishWorkout(notes)` - Save and finish workout
- `discardWorkout()` - Discard without saving

**Key Features**:
- Persists active workout to SQLite for crash recovery
- Auto-starts rest timer after completing set
- Pre-fills previous performance when adding exercise

**Usage**:
```javascript
const { activeSession, startWorkout, addSet, finishWorkout } = useContext(WorkoutContext);
```

---

## NotificationContext.js

**Purpose**: Push notification management.

**State**:
```javascript
{
  notifications: [...],
  unreadCount: number
}
```

**Functions**:
- `fetchNotifications()` - Load notifications
- `markAsRead(id)` - Mark notification read
- `clearAll()` - Clear all notifications

**Usage**:
```javascript
const { notifications, unreadCount, markAsRead } = useContext(NotificationContext);
```

---

## Context Provider Setup

All contexts are combined in App.js:

```javascript
function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <NotificationProvider>
          <WorkoutProvider>
            <MainNavigator />
          </WorkoutProvider>
        </NotificationProvider>
      </AppProvider>
    </AuthProvider>
  );
}
```

---

## State Flow

1. **AuthContext** loads first - checks for stored tokens
2. If authenticated, pulls data from cloud
3. **AppContext** provides theme and settings throughout app
4. **WorkoutContext** manages live workout state
5. **NotificationContext** handles push notifications