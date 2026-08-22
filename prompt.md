- EXERCISE POPULATION IN DATABASE.

```The
The exercise list is populated from: 
1. src/seed/exercises.js - Contains the seed data (SEED_EXERCISES array with ~40 exercises)
2. src/db/db.js - Initializes the SQLite database and seeds the exercises on first launch (lines 146-150):
   const count = await db.getFirstAsync('SELECT COUNT(*) AS c FROM exercises');
   if (count.c === 0) {
   for (const ex of SEED_EXERCISES) {
   await db.runAsync('INSERT OR IGNORE INTO exercises (name, muscle_group) VALUES (?, ?)', [ex.name, ex.muscle_group]);
   }
   }
3. src/db/queries.js - Has functions to get exercises from DB:

- getAllExercises() - Returns all exercises sorted by muscle group
- addCustomExercise(name, muscleGroup) - Adds custom user exercises

4. src/components/ExercisePicker.js - The UI component that displays and filters exercises in the app



Here's how exercises are rendered in the frontend:
Flow:
1. src/components/ExercisePicker.js - The UI modal component
- Line 73: Calls listExercises() to load exercises from SQLite
- Lines 159-173: Renders a FlatList with exercise items
- Each row shows: muscle icon + exercise name + muscle group
- Has search (line 81-85) and muscle group filter (lines 151-157)
- Can add custom exercises (lines 94-100)
2. src/db/queries.js:9 - listExercises() function:
export async function listExercises() {
  return db.getAllAsync('SELECT * FROM exercises ORDER BY muscle_group, name');
}
3. src/components/MuscleIcon.js - Renders the muscle group icon next to each exercise
4. Data flow:
SQLite (exercises table) 
     ↓ listExercises()
ExercisePicker state 
     ↓ filtered by search/group
FlatList renders items
The exercises are stored locally in SQLite (seeded from src/seed/exercises.js on first launch), not fetched from the cloud.
```
