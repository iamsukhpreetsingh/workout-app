// Central route-name registry — every navigator registration and
// navigation.navigate()/dispatch() call should reference these constants
// instead of inline strings.

// Auth stack
export const LOGIN = 'Login';
export const SIGNUP = 'Signup';
export const FORGOT_PASSWORD = 'ForgotPassword';
export const RESET_PASSWORD = 'ResetPassword';

// User-view tabs
export const TAB_HOME = 'Home';
export const TAB_DIET = 'Diet';
export const HISTORY = 'History';
export const TAB_PLANS = 'Plans';
export const TAB_PROGRESS = 'Progress';
export const TAB_PROFILE = 'Profile';
export const EDIT_PROFILE = 'EditProfile';
export const MAIN_TABS = 'Main';

// User-view stack screens
export const DIET_TRENDS = 'DietTrends';
export const BUILD_DISH = 'BuildDish';
export const SESSION_DETAIL = 'SessionDetail';
export const PLAN_DETAIL = 'PlanDetail';
export const PLAN_EDITOR = 'PlanEditor';
export const EXERCISE_PROGRESS = 'ExerciseProgress';
export const SETTINGS = 'Settings';
export const SYNC_SETTINGS = 'SyncSettings';
export const INTAKE_FORM = 'IntakeForm';
export const PROFILE = 'Profile';
export const CLIENT_DETAIL = 'ClientDetail';
export const ASSIGN_WORKOUT = 'AssignWorkout';
export const CLIENT_ASSIGNED_DETAIL = 'ClientAssignedDetail';
export const NOTIFICATION_CENTER = 'NotificationCenter';
export const DIET_PLAN_BUILDER = 'DietPlanBuilder';
export const CLIENT_DIET_PLAN_DETAIL = 'ClientDietPlanDetail';
export const MY_DISHES = 'MyDishes';
// Gym home — pushed from MyGymCard (Profile tab) via the shared detail pool
export const GYM_HOME = 'GymMain';
export const GYM_CLASSES = 'GymClasses';
export const GYM_DOCUMENTS = 'GymDocuments';
// M3 — full document viewer (tap a document card in GymDocuments)
export const GYM_DOCUMENT_VIEW = 'GymDocumentView';
// M2 — gym program content detail screens (pool)
export const GYM_WORKOUT_DETAIL = 'GymWorkoutDetail';
export const GYM_NUTRITION_DETAIL = 'GymNutritionDetail';
// M5 — gym member home dashboard entry points (pool): full lists for the
// "Gym Recommended" card on the gym home
export const GYM_WORKOUTS = 'GymWorkouts';
export const GYM_NUTRITION = 'GymNutrition';
// M6 — attendance experience (pool): month-by-month ✓/− history and the
// M9 — member-facing payments: dues, history, receipts
export const GYM_PAYMENTS = 'GymPayments';
// member QR check-in (scan the gym's posted poster code)
export const GYM_ATTENDANCE = 'GymAttendance';
export const GYM_CHECK_IN = 'GymCheckIn';
export const SUPPLEMENT_PLAN_BUILDER = 'SupplementPlanBuilder';
export const COACHING_PLAN_BUILDER = 'CoachingPlanBuilder';
export const COACHING_PLAN_DETAIL = 'CoachingPlanDetail';
export const ASSIGNED_PLAN_DETAIL = 'AssignedPlanDetail';
export const ACTIVE_WORKOUT = 'ActiveWorkout';
export const BACKFILL_WORKOUT = 'BackfillWorkout';
export const PROGRESS_PHOTOS = 'ProgressPhotos';
export const TRAINER_PROGRESS_PHOTOS = 'TrainerProgressPhotos';


// Trainer view
export const TRAINER_TABS = 'TrainerMain';
export const TAB_CLIENTS = 'Clients';
export const TAB_WORKOUTS = 'Workouts';
export const TAB_RECIPES = 'Recipes';
export const ASSIGN_WORKOUT_PICKER = 'AssignWorkoutPicker';
export const WORKOUT_TEMPLATE_EDITOR = 'WorkoutTemplateEditor';
export const TAG_MANAGER = 'TagManager';
