# Backend API Documentation

This document describes all API endpoints in the backend server.

---

## Base URL
```
http://13.126.205.202:4000
```

---

## Authentication Endpoints (`/auth`)

### POST /auth/login
Login with email and password.

**Request**:
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1...",
  "refreshToken": "eyJhbGciOiJIUzI1...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "John Doe",
    "role": "user"
  }
}
```

### POST /auth/signup
Register new user.

**Request**:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "John Doe",
  "role": "user"
}
```

**Response**: Same as login.

### POST /auth/refresh
Refresh access token using refresh token.

**Request**:
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1..."
}
```

**Response**:
```json
{
  "accessToken": "eyJhbGciOiJIUzI1...",
  "refreshToken": "eyJhbGciOiJIUzI1..."
}
```

---

## User Endpoints

### GET /me
Get current user profile.

**Response**:
```json
{
  "id": 1,
  "email": "user@example.com",
  "name": "John Doe",
  "role": "user"
}
```

---

## Client Endpoints (`/client`)

### Session Endpoints

#### POST /client/session-summaries
Sync workout session summaries to server.

**Request**: Array of session objects
```json
[
  {
    "local_session_id": "1234567890",
    "name": "Push Day",
    "performed_at": "2024-01-15T10:00:00Z",
    "duration_seconds": 3600,
    "notes": "Great workout",
    "plan_id": 5
  }
]
```

#### GET /client/sessions
Get user's workout sessions.

#### GET /client/sessions/:id
Get single session details.

---

### Measurement Endpoints

#### POST /client/measurements
Sync body measurements to server.

**Request**:
```json
[
  {
    "date": "2024-01-15",
    "metric_type": "weight",
    "value": 75.5,
    "unit": "kg"
  }
]
```

#### GET /client/measurements
Get user's body measurements.

---

### Workout Template Endpoints

#### POST /client/workout-templates
Save workout templates to server.

**Request**:
```json
[
  {
    "local_plan_id": "123",
    "name": "Push Day",
    "notes": "Chest and triceps",
    "exercises": [
      { "exercise_id": 1, "target_sets": 4, "rest_seconds": 90 },
      { "exercise_id": 2, "target_sets": 3, "rest_seconds": 120 }
    ],
    "tags": ["push", "strength"]
  }
]
```

#### GET /client/workout-templates
Get user's workout templates.

#### DELETE /client/workout-templates/:localId
Delete a workout template.

---

### Sync Endpoints

#### GET /client/sync/pull
**Full data restore** - Get all user data for initial login or restore.

**Response**:
```json
{
  "sessions": [...],
  "workout_templates": [...],
  "measurements": [...],
  "session_details": {...},
  "pulled_at": "2024-01-15T10:00:00Z"
}
```

**Note**: Currently only returns sessions, workout_templates, measurements, and session_details. Missing: diet_plans, supplement_plans, user_settings.

---

### Diet Plan Endpoints

#### GET /client/diet-plans
Get user's diet plans (created by user or assigned by trainer).

#### POST /client/diet-plans
Create a diet plan.

**Request**:
```json
{
  "name": "Weight Loss Plan",
  "notes": "Low calorie",
  "days": [
    {
      "day_label": "Day 1",
      "meals": [
        {
          "meal_type": "breakfast",
          "items": [
            { "name": "Oatmeal", "calories": 300, "protein_g": 10, "carbs_g": 50, "fat_g": 5 }
          ]
        }
      ]
    }
  ],
  "daily_calorie_target": 2000,
  "daily_protein_target": 150,
  "daily_carbs_target": 200,
  "daily_fat_target": 65
}
```

#### GET /client/diet-plans/:planId
Get diet plan details.

#### PATCH /client/diet-plans/:planId
Update diet plan.

#### DELETE /client/diet-plans/:planId
Delete diet plan.

#### POST /client/diet-plans/:planId/checkins
Log diet adherence check-in.

**Request**:
```json
{
  "date": "2024-01-15",
  "followed": true,
  "note": "Stayed on plan"
}
```

#### GET /client/diet-plans/:planId/checkins
Get check-in history.

---

### Supplement Plan Endpoints

#### GET /client/supplement-plans
Get user's supplement plans.

#### POST /client/supplement-plans
Create supplement plan.

**Request**:
```json
{
  "name": "Pre-workout Stack",
  "items": [
    { "name": "Creatine", "dosage": "5g", "timing": "daily" },
    { "name": "Caffeine", "dosage": "200mg", "timing": "pre-workout" }
  ]
}
```

#### GET /client/supplement-plans/:planId
Get supplement plan details.

#### PATCH /client/supplement-plans/:planId
Update supplement plan.

#### DELETE /client/supplement-plans/:planId
Delete supplement plan.

#### POST /client/supplement-plans/:planId/checkins
Log supplement adherence.

**Request**:
```json
{
  "date": "2024-01-15",
  "taken": true
}
```

---

### Meal/Dish Endpoints

#### GET /client/dishes
Get user's custom dishes.

#### POST /client/dishes
Create custom dish.

#### DELETE /client/dishes/:id
Delete dish.

---

## Trainer Endpoints (`/trainer`)

### GET /trainer/clients
Get trainer's clients.

### GET /trainer/clients/:clientId
Get client details.

### POST /trainer/clients/:clientId/workouts
Assign workout to client.

**Request**:
```json
{
  "templateId": 5,
  "dueDate": "2024-01-20",
  "notes": "Complete by Friday"
}
```

### DELETE /trainer/clients/:clientId/workouts/:assignmentId
Remove assigned workout.

### POST /trainer/clients/:clientId/diet-plans
Assign diet plan to client.

### POST /trainer/clients/:clientId/supplement-plans
Assign supplement plan to client.

### GET /trainer/clients/:clientId/progress
Get client progress overview.

### GET /trainer/invite
Generate invite code for clients.

### POST /trainer/invite/use
Use invite code (client side).

---

## Tag Endpoints (`/tags`)

### GET /tags
Get all tags (trainer only).

### GET /tags/workout
Get workout tags.

### GET /tags/recipe
Get recipe/food tags.

### POST /tags
Create new tag.

**Request**:
```json
{
  "name": "strength",
  "type": "workout"
}
```

### PATCH /tags/:id
Update tag.

### DELETE /tags/:id
Delete tag.

---

## Notification Endpoints (`/notifications`)

### GET /notifications
Get user's notifications.

### PATCH /notifications/:id/read
Mark notification as read.

### DELETE /notifications/clear
Clear all notifications.

---

## Middleware

### requireAuth
Verifies JWT token is present and valid.

### requireRole(role)
Verifies user has required role (user/trainer).

---

## Response Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 401 | Unauthorized |
| 403 | Forbidden |
| 404 | Not Found |
| 500 | Server Error |

---

## Known Issues (from code review)

1. **Sync incomplete**: `/client/sync/pull` only restores sessions, workout_templates, measurements, and session_details. Missing:
   - Diet plans
   - Supplement plans
   - User settings

2. **Workout templates not syncing**: The `syncPending()` function that syncs workout templates is not being called in App.js - only `syncPendingSessions()` is called.

3. **Local-only storage**: Data is stored in local SQLite and deleted when app is uninstalled. True cloud backup is not fully implemented.