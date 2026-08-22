# Components Documentation (`src/components/`)

This file documents all reusable UI components in the app.

---

## Active Workout Components

### ActiveWorkoutMiniBar.js
- **Purpose**: Persistent mini player showing active workout
- **Location**: Bottom of screen during active workout
- **Features**:
  - Shows elapsed time
  - Exercise count
  - Tap to expand to full workout screen

### RestTimerBar.js
- **Purpose**: Rest timer display during workout
- **Features**:
  - Countdown display (mm:ss)
  - Skip button
  - -15s / +15s adjustment buttons

### RestEditorModal.js
- **Purpose**: Edit rest time setting
- **Features**:
  - Set default rest time
  - Per-exercise rest override

---

## Charts & Analytics

### CalendarHeatmap.js
- **Purpose**: GitHub-style consistency heatmap
- **Location**: Progress screen
- **Features**:
  - Month-by-month calendar
  - Color intensity based on workout volume
  - Tap day for details

### LineChart.js
- **Purpose**: Line chart for progress data
- **Uses**: react-native-svg
- **Features**:
  - Smooth line rendering
  - Touch to see data points

### BarChart.js
- **Purpose**: Bar chart for volume/stats
- **Features**:
  - Vertical bars
  - Labels support

---

## Workout Components

### ExercisePicker.js
- **Purpose**: Exercise selection modal
- **Features**:
  - Search exercises
  - Filter by muscle group
  - Filter by equipment
  - Show recently used
  - Create custom exercise option

### PlateSheet.js
- **Purpose**: Plate calculator bottom sheet
- **Features**:
  - Shows plates needed per side
  - Handles kg and lb
  - Customizable bar weight
  - Customizable plate inventory

### PRToast.js
- **Purpose**: Personal record celebration
- **Features**:
  - Animated toast on PR
  - Haptic feedback
  - Shows PR type and value

---

## Form Components

### CapsuleDropdown.js
- **Purpose**: Capsule-style dropdown selector
- **Features**:
  - iOS-style picker
  - Multiple options support

### TagEditorModal.js
- **Purpose**: Edit tags for workouts/exercises
- **Features**:
  - Add/remove tags
  - Create new tags
  - Tag type selection

### ClientTagSelector.js
- **Purpose**: Tag selector for trainers
- **Features**:
  - Select from existing tags
  - Filter by tag type

---

## Meal/Diet Components

### DishForm.js
- **Purpose**: Create/edit custom dish
- **Features**:
  - Dish name
  - Nutrition info (calories, protein, carbs, fat)
  - Serving size

### CatalogSearch.js
- **Purpose**: Search meal catalog
- **Features**:
  - Text search
  - Category filters
  - Results display

---

## Navigation Components

### HeaderActions.js
- **Purpose**: Header action buttons
- **Features**:
  - Add button
  - Edit button
  - Filter button

### NotificationBell.js
- **Purpose**: Notification indicator
- **Features**:
  - Shows unread count
  - Tap to go to notifications

---

## Utility Components

### MuscleIcon.js
- **Purpose**: Muscle group icon display
- **Features**:
  - Visual icon for muscle groups
  - Used in exercise picker

---

## Usage Examples

### Using ExercisePicker
```javascript
import ExercisePicker from './components/ExercisePicker';

function MyScreen() {
  const [showPicker, setShowPicker] = useState(false);
  
  return (
    <>
      <Button title="Add Exercise" onPress={() => setShowPicker(true)} />
      <ExercisePicker 
        visible={showPicker}
        onSelect={(exercise) => {
          // Handle selection
          setShowPicker(false);
        }}
        onClose={() => setShowPicker(false)}
      />
    </>
  );
}
```

### Using PlateSheet
```javascript
import PlateSheet from './components/PlateSheet';

function SetInput({ weight, onWeightChange }) {
  const [showPlates, setShowPlates] = useState(false);
  
  return (
    <>
      <TextInput 
        value={weight} 
        onChangeText={onWeightChange}
        onFocus={() => setShowPlates(true)}
      />
      <PlateSheet
        visible={showPlates}
        weight={parseFloat(weight)}
        onClose={() => setShowPlates(false)}
      />
    </>
  );
}
```

### Using CalendarHeatmap
```javascript
import CalendarHeatmap from './components/CalendarHeatmap';

function ProgressScreen() {
  const [workoutDays, setWorkoutDays] = useState({});
  
  return (
    <CalendarHeatmap 
      data={workoutDays}
      onDayPress={(date) => console.log(date)}
    />
  );
}
```