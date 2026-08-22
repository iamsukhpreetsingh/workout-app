# Workout Tracker - Code Documentation

This documentation provides a comprehensive overview of each code file in the project, explaining what it does, its purpose, and how it connects to other parts of the system.

## Project Overview

A **Hevy-style workout tracking app** built with:
- **Frontend**: React Native (Expo SDK 51) with local SQLite database
- **Backend**: Node.js/Express with PostgreSQL
- **Architecture**: Offline-first with cloud sync capabilities

## Directory Structure

```
workout-tracker/
├── App.js                    # Main app entry point
├── src/
│   ├── screens/              # All app screens (34 screens)
│   ├── components/           # Reusable UI components
│   ├── store/                # React Context providers
│   ├── db/                   # SQLite database layer
│   ├── lib/                  # Utilities and services
│   └── seed/                 # Initial data
├── backend/
│   ├── src/
│   │   ├── routes/           # API endpoints
│   │   ├── data/             # Database access layer
│   │   ├── middleware/       # Auth middleware
│   │   └── db/               # PostgreSQL pool
│   └── migrations/           # SQL migrations
└── docs/
    ├── screens.md            # Screen-by-screen documentation
    ├── lib.md                # Library services documentation
    ├── db.md                 # Database schema documentation
    └── backend.md            # Backend API documentation
```

## Quick Links

- **[Screens Documentation](screens.md)** - All 34 screens explained
- **[Library Services](lib.md)** - API, sync, notifications, etc.
- **[Database Schema](db.md)** - SQLite tables and migrations
- **[Backend API](backend.md)** - All API endpoints
- **[Components](components.md)** - Reusable UI components
- **[Store/Context](store.md)** - React Context providers

## Key Features

1. **Live Workout Tracking** - Timer, sets, reps, weight, RPE
2. **Routines** - Reusable workout templates
3. **Progress Analytics** - Charts, streaks, PRs
4. **Body Tracking** - Weight, measurements, photos
5. **Trainer System** - Client management, assignments
6. **Diet/Meal Plans** - Nutrition tracking
7. **Cloud Sync** - Offline-first with server backup

## Configuration

- **API URL**: `http://13.126.205.202:4000` (production)
- **Local DB**: SQLite with 22+ migrations
- **Auth**: JWT (30 min access, 30 day refresh)