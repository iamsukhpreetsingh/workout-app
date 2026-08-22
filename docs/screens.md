# Screens Documentation (`src/screens/`)

This file documents all 34 screens in the app, their purpose, and navigation flow.

## Authentication Screens

### LoginScreen.js
- **Purpose**: User login with email/password
- **Route**: `/login`
- **Features**: Email/password fields, login button, navigation to signup

### SignupScreen.js
- **Purpose**: New user registration
- **Route**: `/signup`
- **Features**: Name, email, password fields, role selection (user/trainer)

### ViewChoiceScreen.js
- **Purpose**: Choose between User and Trainer views
- **Route**: `/view-choice`
- **Features**: Two large buttons to select view mode

---

## Main Tab Screens

### HomeScreen.js
- **Purpose**: Main dashboard showing workout overview
- **Tab**: Home
- **Features**: 
  - Current streak display
  - Quick start workout button
  - Recent workouts list
  - Weekly stats summary
  - Triggers sync on pull-to-refresh

### HistoryScreen.js
- **Purpose**: Browse past workout sessions
- **Tab**: History
- **Features**:
  - List of all completed sessions
  - Date grouping
  - Session summary (duration, volume, exercise count)
  - PR badges on sessions with personal records
  - Navigate to session detail

### PlansScreen.js
- **Purpose**: Manage workout routines/templates
- **Tab**: Routines
- **Features**:
  - List of user-created routines
  - Create new routine button
  - Start routine directly
  - Edit/delete routines

### ProgressScreen.js
- **Purpose**: View workout progress and analytics
- **Tab**: Progress
- **Features**:
  - Volume charts (weekly/monthly)
  - Consistency heatmap (calendar)
  - Streak counter
  - Per-exercise progress links
  - Body metrics link

---

## Workout Screens

### WorkoutScreen.js
- **Purpose**: Active workout session
- **Route**: `/workout` or `/workout/:planId`
- **Features**:
  - Live timer (elapsed time)
  - Add exercises from library
  - Log sets with weight/reps
  - RPE input per set
  - Rest timer (auto-starts after set)
  - Superset grouping
  - Notes per exercise
  - Session notes
  - Save/discard workout
  - Previous performance pre-fill

### SessionDetailScreen.js
- **Purpose**: View completed session details
- **Route**: `/session/:sessionId`
- **Features**:
  - Full session breakdown
  - All exercises and sets
  - Edit set types retroactively
  - Delete session
  - PR badges display

### PlanDetailScreen.js
- **Purpose**: View routine details before starting
- **Route**: `/plan/:planId`
- **Features**:
  - Exercise list in routine
  - Target sets per exercise
  - Rest times
  - Superset groups
  - Start workout button

### PlanEditorScreen.js
- **Purpose**: Create/edit workout routine
- **Route**: `/plan/new` or `/plan/:planId/edit`
- **Features**:
  - Add/remove exercises
  - Set target sets per exercise
  - Set rest times
  - Create supersets
  - Add notes

---

## Exercise & Analytics Screens

### ExerciseProgressScreen.js
- **Purpose**: Detailed progress for single exercise
- **Route**: `/exercise/:exerciseId/progress`
- **Features**:
  - Estimated 1RM chart (Epley formula)
  - Max weight achieved
  - Total volume over time
  - RPE trend chart
  - Per-session set history
  - PR badges

### BodyScreen.js
- **Purpose**: Body metrics tracking
- **Route**: `/body`
- **Features**:
  - Body weight log
  - Measurement log (waist, chest, hips, arms, etc.)
  - Body fat percentage
  - Trend charts
  - Date picker for past entries

---

## Template Screens

### WorkoutTemplatesScreen.js
- **Purpose**: Browse all workout templates
- **Route**: `/templates`
- **Features**:
  - List of saved templates
  - Filter by tags
  - Create new template

### WorkoutTemplateEditorScreen.js
- **Purpose**: Edit workout template
- **Route**: `/template/:templateId/edit`
- **Features**:
  - Template name/notes
  - Add exercises
  - Configure sets/rest
  - Save template

---

## Diet & Meal Screens

### MealCatalogScreen.js
- **Purpose**: Browse food/meal catalog
- **Route**: `/meals`
- **Features**:
  - Search meals
  - Categories
  - Nutrition info (calories, protein, carbs, fat)
  - Add custom dishes

### MyDishesScreen.js
- **Purpose**: User-created dishes
- **Route**: `/my-dishes`
- **Features**:
  - List of custom dishes
  - Create/edit dish
  - Nutrition info

### DietPlanBuilderScreen.js
- **Purpose**: Create diet plan
- **Route**: `/diet-plan/new`
- **Features**:
  - Plan name
  - Add days and meals
  - Assign meals from catalog
  - Set calorie/macro targets
  - Save plan

---

## Trainer Screens

### TrainerClientsScreen.js
- **Purpose**: List trainer's clients
- **Tab**: Clients (Trainer view)
- **Features**:
  - Client list with stats
  - Add new client
  - Navigate to client detail

### ClientDetailScreen.js
- **Purpose**: View client profile and progress
- **Route**: `/client/:clientId`
- **Features**:
  - Client info
  - Assigned workouts
  - Assigned diet plans
  - Progress overview
  - Check-in history

### AssignWorkoutScreen.js
- **Purpose**: Assign workout to client
- **Route**: `/assign-workout/:clientId`
- **Features**:
  - Select workout template
  - Set due date
  - Add notes
  - Send assignment

### AssignWorkoutPickerScreen.js
- **Purpose**: Pick workout to assign
- **Route**: `/assign-workout-picker/:clientId`
- **Features**:
  - Browse available templates
  - Search
  - Select and assign

### TrainerSettingsScreen.js
- **Purpose**: Trainer settings and invite
- **Tab**: Settings (Trainer view)
- **Features**:
  - Generate client invite code
  - Share invite link
  - Notification preferences

---

## Coaching Plan Screens

### CoachingPlanBuilderScreen.js
- **Purpose**: Build diet/supplement coaching plan
- **Route**: `/coaching-plan/new`
- **Features**:
  - Select plan type (diet/supplement)
  - Add days and meals
  - Set targets
  - Save and assign to client

### CoachingPlanDetailScreen.js
- **Purpose**: View coaching plan details
- **Route**: `/coaching-plan/:planId`
- **Features**:
  - Plan overview
  - Days and meals
  - Nutrition targets
  - Edit option

### AssignedPlanDetailScreen.js
- **Purpose**: View assigned plan (as client)
- **Route**: `/assigned-plan/:planId`
- **Features**:
  - Plan details
  - Check-in button
  - Mark as followed/not followed

### ClientDietPlanDetailScreen.js
- **Purpose**: View client's diet plan (as trainer)
- **Route**: `/client-diet-plan/:planId`
- **Features**:
  - Plan overview
  - Client check-in history
  - Edit plan

### ClientAssignedDetailScreen.js
- **Purpose**: View assigned plan (as client)
- **Route**: `/client-assigned/:planId`
- **Features**:
  - View assigned plan
  - Check-in

---

## Settings Screens

### SettingsScreen.js
- **Purpose**: User settings
- **Tab**: Settings (User view)
- **Features**:
  - Units (kg/lb, cm/in)
  - Default rest time
  - RPE toggle
  - Bar weight
  - Plate inventory
  - Streak tolerance
  - Theme mode
  - View switch (User/Trainer)
  - Backup/sync settings link

### ProfileScreen.js
- **Purpose**: User profile
- **Route**: `/profile`
- **Features**:
  - User info
  - Edit profile
  - Logout

### SyncSettingsScreen.js
- **Purpose**: Sync and backup settings
- **Route**: `/sync-settings`
- **Features**:
  - Sync mode (auto/manual/local)
  - Manual sync button
  - Pull from cloud
  - Last sync timestamp
  - Pending items count

### NotificationCenterScreen.js
- **Purpose**: View all notifications
- **Route**: `/notifications`
- **Features**:
  - List of notifications
  - Mark as read
  - Clear all

### TagManagerScreen.js
- **Purpose**: Manage tags for organization
- **Route**: `/tags`
- **Features**:
  - List tags
  - Create new tag
  - Delete tag
  - Tag types (workout, recipe)

---

## Screen Navigation Flow

```
App Entry
    │
    ├─► LoginScreen → SignupScreen → ViewChoiceScreen
    │
    └─► Main App (authenticated)
            │
            ├─► User View
            │   ├─► HomeScreen (Tab)
            │   ├─► HistoryScreen (Tab)
            │   ├─► PlansScreen (Tab)
            │   ├─► ProgressScreen (Tab)
            │   │
            │   ├─► WorkoutScreen
            │   ├─► SessionDetailScreen
            │   ├─► PlanDetailScreen / PlanEditorScreen
            │   ├─► ExerciseProgressScreen
            │   ├─► BodyScreen
            │   ├─► MealCatalogScreen / MyDishesScreen
            │   ├─► DietPlanBuilderScreen
            │   ├─► AssignedPlanDetailScreen
            │   ├─► SettingsScreen
            │   ├─► ProfileScreen
            │   ├─► SyncSettingsScreen
            │   ├─► NotificationCenterScreen
            │   └─► TagManagerScreen
            │
            └─► Trainer View
                ├─► TrainerClientsScreen (Tab)
                ├─► AssignWorkoutScreen
                ├─► ClientDetailScreen
                ├─► CoachingPlanBuilderScreen
                ├─► CoachingPlanDetailScreen
                ├─► ClientDietPlanDetailScreen
                ├─► TrainerSettingsScreen (Tab)
                └─► (All User screens accessible)
```