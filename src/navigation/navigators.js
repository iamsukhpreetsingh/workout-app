import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { useApp } from '../store/AppContext';
import { useAuth } from '../store/AuthContext';

// Screens
import IntakeFormScreen from '../screens/IntakeFormScreen';
import LoginScreen from '../screens/LoginScreen';
import SignupScreen from '../screens/SignupScreen';
import ForgotPasswordScreen from '../screens/ForgotPasswordScreen';
import ResetPasswordScreen from '../screens/ResetPasswordScreen';
import ViewChoiceScreen from '../screens/ViewChoiceScreen';
import HomeScreen from '../screens/HomeScreen';
import WorkoutScreen from '../features/workouts/screens/WorkoutScreen';
import HistoryScreen from '../screens/HistoryScreen';
import SessionDetailScreen from '../screens/SessionDetailScreen';
import PlansScreen from '../screens/PlansScreen';
import PlanDetailScreen from '../screens/PlanDetailScreen';
import BackfillWorkoutScreen from '../screens/BackfillWorkoutScreen';
import PlanEditorScreen from '../screens/PlanEditorScreen';
import ProgressScreen from '../screens/ProgressScreen';
import ExerciseProgressScreen from '../screens/ExerciseProgressScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ProgressPhotosScreen from '../screens/ProgressPhotosScreen';
import TrainerProgressPhotosScreen from '../screens/TrainerProgressPhotosScreen';
import TrainerClientsScreen from '../screens/TrainerClientsScreen';
import ClientDetailScreen from '../screens/ClientDetailScreen';
import AssignWorkoutScreen from '../screens/AssignWorkoutScreen';
import ClientAssignedDetailScreen from '../screens/ClientAssignedDetailScreen';
import CoachingPlanBuilderScreen from '../screens/CoachingPlanBuilderScreen';
import CoachingPlanDetailScreen from '../screens/CoachingPlanDetailScreen';
import AssignedPlanDetailScreen from '../screens/AssignedPlanDetailScreen';
import DietPlanBuilderScreen from '../screens/DietPlanBuilderScreen';
import ClientDietPlanDetailScreen from '../screens/ClientDietPlanDetailScreen';
import MyDishesScreen from '../screens/MyDishesScreen';
import GymClassesScreen from '../screens/GymClassesScreen';
import GymDocumentsScreen from '../screens/GymDocumentsScreen';
import GymPaymentsScreen from '../screens/GymPaymentsScreen';
import GymDocumentViewScreen from '../screens/GymDocumentViewScreen';
import GymHomeScreen from '../screens/GymHomeScreen';
import GymWorkoutsScreen from '../screens/GymWorkoutsScreen';
import GymNutritionScreen from '../screens/GymNutritionScreen';
import GymAttendanceScreen from '../screens/GymAttendanceScreen';
import GymCheckInScreen from '../screens/GymCheckInScreen';
import GymWorkoutDetailScreen from '../screens/GymWorkoutDetailScreen';
import GymNutritionDetailScreen from '../screens/GymNutritionDetailScreen';
import MealCatalogScreen from '../screens/MealCatalogScreen';
import WorkoutTemplatesScreen from '../screens/WorkoutTemplatesScreen';
import WorkoutTemplateEditorScreen from '../screens/WorkoutTemplateEditorScreen';
import AssignWorkoutPickerScreen from '../screens/AssignWorkoutPickerScreen';
import ActiveWorkoutMiniBar from '../components/ActiveWorkoutMiniBar';
import HeaderActions from '../components/HeaderActions';
import NotificationCenterScreen from '../screens/NotificationCenterScreen';
import TagManagerScreen from '../screens/TagManagerScreen';
import SyncSettingsScreen from '../screens/SyncSettingsScreen';
import DietHomeScreen from '../features/diet/screens/DietHomeScreen';
import DietTrendsScreen from '../features/diet/screens/DietTrendsScreen';
import BuildDishScreen from '../features/diet/screens/BuildDishScreen';
import EditProfileScreen from '../screens/EditProfileScreen';

import {
  LOGIN,
  SIGNUP,
  FORGOT_PASSWORD,
  RESET_PASSWORD,
  TAB_HOME,
  TAB_DIET,
  TAB_PROFILE,
  DIET_TRENDS,
  BUILD_DISH,
  EDIT_PROFILE,
  HISTORY,
  TAB_PLANS,
  TAB_PROGRESS,
  GYM_HOME,
  MAIN_TABS,
  SESSION_DETAIL,
  PLAN_DETAIL,
  PLAN_EDITOR,
  EXERCISE_PROGRESS,
  SETTINGS,
  SYNC_SETTINGS,
  INTAKE_FORM,
  PROFILE,
  PROGRESS_PHOTOS,
  TRAINER_PROGRESS_PHOTOS,
  CLIENT_DETAIL,
  ASSIGN_WORKOUT,
  CLIENT_ASSIGNED_DETAIL,
  NOTIFICATION_CENTER,
  DIET_PLAN_BUILDER,
  CLIENT_DIET_PLAN_DETAIL,
  MY_DISHES,
  GYM_CLASSES,
  GYM_DOCUMENTS,
  GYM_PAYMENTS,
  GYM_DOCUMENT_VIEW,
  GYM_WORKOUT_DETAIL,
  GYM_NUTRITION_DETAIL,
  GYM_WORKOUTS,
  GYM_NUTRITION,
  GYM_ATTENDANCE,
  GYM_CHECK_IN,
  SUPPLEMENT_PLAN_BUILDER,
  COACHING_PLAN_BUILDER,
  COACHING_PLAN_DETAIL,
  ASSIGNED_PLAN_DETAIL,
  ACTIVE_WORKOUT,
  TRAINER_TABS,
  TAB_CLIENTS,
  TAB_WORKOUTS,
  TAB_RECIPES,
  ASSIGN_WORKOUT_PICKER,
  WORKOUT_TEMPLATE_EDITOR,
  BACKFILL_WORKOUT,
  TAG_MANAGER,
} from '../shared/constants/routes';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// ── shared detail-screen pool ───────────────────────────────────────────
// Every non-tab screen, registered in EACH tab's stack so the bottom
// navigation stays visible on detail screens (persistent shell, §1/§2).
// Immersive/modal screens (ACTIVE_WORKOUT live workout) stay at the ROOT
// stack above the tabs — the deliberate exception (§3).
// Render function (NOT a component): React Navigation only accepts Screen/
// Group/Fragment as direct navigator children, so the pool must expand into
// actual <Stack.Screen> elements rather than being rendered as one component.
function SettingsScreenWrapper({ onSwitchView, ...props }) {
  const { user } = useAuth();
  const isTrainer = user?.role === 'trainer';
  return <SettingsScreen {...props} onSwitchView={isTrainer ? onSwitchView : undefined} />;
}

function renderDetailScreens(onSwitchView) {
  return (
    <>
      <Stack.Screen name={SESSION_DETAIL} component={SessionDetailScreen} options={{ title: 'Workout' }} />
      <Stack.Screen name={PLAN_DETAIL} component={PlanDetailScreen} options={{ title: 'Routine' }} />
      <Stack.Screen name={BACKFILL_WORKOUT} component={BackfillWorkoutScreen} options={{ title: 'Log Past Workout' }} />
      <Stack.Screen name={PLAN_EDITOR} component={PlanEditorScreen} options={{ title: 'New Routine' }} />
      <Stack.Screen name={EXERCISE_PROGRESS} component={ExerciseProgressScreen} options={{ title: 'Exercise' }} />
      <Stack.Screen name={SETTINGS}>
        {(props) => <SettingsScreenWrapper {...props} onSwitchView={onSwitchView} />}
      </Stack.Screen>
      <Stack.Screen name={SYNC_SETTINGS} component={SyncSettingsScreen} options={{ title: 'Data & Sync' }} />
      <Stack.Screen name={INTAKE_FORM} component={IntakeFormScreen} options={{ title: 'Health Profile' }} />
      <Stack.Screen name={PROGRESS_PHOTOS} component={ProgressPhotosScreen} options={{ title: 'Progress Photos' }} />
      <Stack.Screen name={EDIT_PROFILE} component={EditProfileScreen} options={{ title: 'Edit Profile' }} />
      <Stack.Screen name={CLIENT_DETAIL} component={ClientDetailScreen} options={{ title: 'Client' }} />
      <Stack.Screen name={ASSIGN_WORKOUT} component={AssignWorkoutScreen} options={{ title: 'Assign Workout' }} />
      <Stack.Screen
        name={CLIENT_ASSIGNED_DETAIL}
        component={ClientAssignedDetailScreen}
        options={{ title: 'From Your Trainer' }}
      />
      <Stack.Screen
        name={NOTIFICATION_CENTER}
        component={NotificationCenterScreen}
        options={{ title: 'Notifications' }}
      />
      <Stack.Screen name={DIET_PLAN_BUILDER} component={DietPlanBuilderScreen} options={{ title: 'Diet Plan' }} />
      <Stack.Screen name={HISTORY} component={HistoryScreen} options={{ title: 'History' }} />
      <Stack.Screen name={DIET_TRENDS} component={DietTrendsScreen} options={{ title: 'Nutrition Trends' }} />
      <Stack.Screen name={BUILD_DISH} component={BuildDishScreen} options={{ title: 'Build a Dish' }} />
      <Stack.Screen
        name={CLIENT_DIET_PLAN_DETAIL}
        component={ClientDietPlanDetailScreen}
        options={{ title: 'Diet Plan' }}
      />
      <Stack.Screen name={MY_DISHES} component={MyDishesScreen} options={{ title: 'My Dishes' }} />
      <Stack.Screen name={GYM_CLASSES} component={GymClassesScreen} options={{ title: 'Gym Classes' }} />
      <Stack.Screen name={GYM_DOCUMENTS} component={GymDocumentsScreen} options={{ title: 'My Documents' }} />
      <Stack.Screen name={GYM_PAYMENTS} component={GymPaymentsScreen} options={{ title: 'Gym Payments' }} />
      {/* M3 — document viewer: PDF (iOS in-app / Android system viewer) + images,
          so members can read a waiver before signing and re-open signed copies */}
      <Stack.Screen name={GYM_DOCUMENT_VIEW} component={GymDocumentViewScreen} options={{ title: 'Document' }} />
      {/* Gym home (Mobile M1.1): a POOL screen pushed from MyGymCard on the
          Profile tab — NOT a tab. The bottom bar must stay a static 5-tab
          shell: conditionally inserting/removing a Tab.Screen after the
          navigator has mounted corrupts React Navigation state (the tab
          flickers and stops responding). The pool pattern gives every tab
          stack a GymMain route, so navigate(GYM_HOME) always resolves with
          the bar still visible. */}
      <Stack.Screen name={GYM_HOME} component={GymHomeScreen} options={{ title: 'My Gym' }} />
      {/* M2 — gym program content, reusable from the gym home and the diet strip */}
      <Stack.Screen name={GYM_WORKOUT_DETAIL} component={GymWorkoutDetailScreen} options={{ title: 'Gym Workout' }} />
      <Stack.Screen name={GYM_NUTRITION_DETAIL} component={GymNutritionDetailScreen} options={{ title: 'Gym Nutrition' }} />
      {/* M5 — member home "Gym Recommended" entry points: full lists for the
          ACTIVE gym (the dashboard card only shows counts + these links) */}
      <Stack.Screen name={GYM_WORKOUTS} component={GymWorkoutsScreen} options={{ title: 'Gym Workouts' }} />
      <Stack.Screen name={GYM_NUTRITION} component={GymNutritionScreen} options={{ title: 'Gym Nutrition' }} />
      {/* M6 — attendance experience: month-by-month ✓/− history + the QR
          check-in (member scans the gym's posted poster code) */}
      <Stack.Screen name={GYM_ATTENDANCE} component={GymAttendanceScreen} options={{ title: 'Attendance' }} />
      <Stack.Screen name={GYM_CHECK_IN} component={GymCheckInScreen} options={{ title: 'Check In' }} />
      <Stack.Screen
        name={SUPPLEMENT_PLAN_BUILDER}
        component={CoachingPlanBuilderScreen}
        options={{ title: 'Supplement Plan' }}
      />
      <Stack.Screen
        name={COACHING_PLAN_BUILDER}
        component={CoachingPlanBuilderScreen}
        options={{ title: 'Plan' }}
      />
      <Stack.Screen
        name={COACHING_PLAN_DETAIL}
        component={CoachingPlanDetailScreen}
        options={{ title: 'Plan' }}
      />
      <Stack.Screen
        name={ASSIGNED_PLAN_DETAIL}
        component={AssignedPlanDetailScreen}
        options={{ title: 'Assigned Plan' }}
      />
    </>
  );
}

// per-tab stack factory — every tab gets the full detail pool so any
// navigation target resolves inside the active tab (bottom bar persists)
function TabStack({ children, onSwitchView }) {
  const { colors } = useApp();
  return (
    <Stack.Navigator
      screenOptions={({ navigation }) => ({
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
        // THE persistent top-bar pair — defaults onto EVERY screen in every
        // tab, including pushed detail screens; screens with a contextual
        // action override this and merge via useHeaderActions(extra)
        headerRight: () => <HeaderActions navigation={navigation} />,
      })}
    >
      {children}
      {renderDetailScreens(onSwitchView)}
    </Stack.Navigator>
  );
}

// Bug 2: selecting a main bottom-navigation tab must open that section's
// ROOT screen. Without this, each tab's stack kept its last pushed screen
// (e.g. Diet -> Settings -> Home -> Diet reopened Settings). Implemented as
// a tabPress listener per tab: if the tab's stack has depth > 1, prevent the
// default (which preserves history) and navigate to the stack's first route
// (navigate pops the pushed screens). Back navigation and in-page tab state
// are unaffected.
const tabResetListeners = (rootName) => ({
  route,
  navigation,
}) => ({
  tabPress: (e) => {
    if ((route.state?.index ?? 0) > 0) {
      e.preventDefault();
      navigation.navigate(route.name, { screen: rootName });
    }
  },
});

const TAB_ICONS = {
  [TAB_HOME]: 'home',
  [TAB_DIET]: 'nutrition',
  [TAB_PLANS]: 'list',
  [TAB_PROGRESS]: 'trending-up',
  [TAB_PROFILE]: 'person',
};

// ── USER VIEW ───────────────────────────────────────────────────────────
// Persistent navigation shell: each tab owns a stack containing the shared
// detail pool, so pushed screens keep the bottom bar visible. Only the live
// workout (full-screen modal) and authentication sit above the shell.
export function Tabs({ onSwitchView }) {
  const { colors } = useApp();
  // Mobile M1.1: the bar is EXACTLY the 5 tabs below, always, for every
  // user. The gym experience lives under Profile → MyGymCard → GymMain
  // (shared detail pool), so nothing async can ever reshape the navigator.
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TAB_ICONS[route.name] || 'ellipse'} size={size || 22} color={color} />
        ),
        title: route.name === TAB_PLANS ? 'Workout Routines' : route.name,
      })}
    >
      <Tab.Screen name={TAB_HOME} listeners={tabResetListeners("HomeMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="HomeMain" component={HomeScreen} options={{ title: 'Workout Tracker' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_DIET} listeners={tabResetListeners("DietMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="DietMain" component={DietHomeScreen} options={{ title: 'Diet' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_PLANS} listeners={tabResetListeners("PlansMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="PlansMain" component={PlansScreen} options={{ title: 'Workout Routines' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_PROGRESS} listeners={tabResetListeners("ProgressMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="ProgressMain" component={ProgressScreen} options={{ title: 'Progress' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_PROFILE} listeners={tabResetListeners("ProfileMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="ProfileMain">
              {(props) => <ProfileScreen {...props} onSwitchView={onSwitchView} />}
            </Stack.Screen>
          </TabStack>
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name={LOGIN} component={LoginScreen} />
      <Stack.Screen name={SIGNUP} component={SignupScreen} />
      <Stack.Screen name={FORGOT_PASSWORD} component={ForgotPasswordScreen} />
      <Stack.Screen name={RESET_PASSWORD} component={ResetPasswordScreen} />
    </Stack.Navigator>
  );
}

export function MainStack({ onSwitchView }) {
  const { colors } = useApp();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name={MAIN_TABS} options={{ headerShown: false }}>
        {(props) => <Tabs {...props} onSwitchView={onSwitchView} />}
      </Stack.Screen>
      {/* deliberate immersive exception: the live workout is a full-screen
          modal — no tab bar during workout execution (§3) */}
      <Stack.Screen
        name={ACTIVE_WORKOUT}
        component={WorkoutScreen}
        options={{ title: 'Active Workout', presentation: 'fullScreenModal', headerShown: false }}
      />
    </Stack.Navigator>
  );
}

// ── TRAINER VIEW ────────────────────────────────────────────────────────
// Same persistent-shell pattern. Trainer accent (blue) distinguishes the
// mode at a glance.
export function TrainerTabs({ onSwitchView }) {
  const { colors } = useApp();
  const TRAINER_TAB_ICONS = {
    [TAB_CLIENTS]: 'people',
    [TAB_WORKOUTS]: 'barbell-outline',
    [TAB_RECIPES]: 'restaurant-outline',
    [TAB_PROFILE]: 'person',
  };
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TRAINER_TAB_ICONS[route.name] || 'settings-outline'} size={size || 22} color={color} />
        ),
      })}
    >
      <Tab.Screen name={TAB_CLIENTS} listeners={tabResetListeners("ClientsMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="ClientsMain" component={TrainerClientsScreen} options={{ title: 'Clients' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_WORKOUTS} listeners={tabResetListeners("TrainerWorkoutsMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="TrainerWorkoutsMain" component={WorkoutTemplatesScreen} options={{ title: 'Workouts' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_RECIPES} listeners={tabResetListeners("RecipesMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="RecipesMain" component={MealCatalogScreen} options={{ title: 'Recipes' }} />
          </TabStack>
        )}
      </Tab.Screen>
      <Tab.Screen name={TAB_PROFILE} listeners={tabResetListeners("TrainerProfileMain")}>
        {() => (
          <TabStack onSwitchView={onSwitchView}>
            <Stack.Screen name="TrainerProfileMain">
              {(props) => <ProfileScreen {...props} inTrainerView onSwitchView={onSwitchView} />}
            </Stack.Screen>
          </TabStack>
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export function TrainerStack({ onSwitchView }) {
  const { colors } = useApp();
  return (
    <Stack.Navigator
      screenOptions={({ navigation }) => ({
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
        headerRight: () => <HeaderActions navigation={navigation} />,
      })}
    >
      <Stack.Screen name={TRAINER_TABS} options={{ headerShown: false }}>
        {(props) => <TrainerTabs {...props} onSwitchView={onSwitchView} />}
      </Stack.Screen>
      {/* trainer detail flows are hierarchical client drills — they push on
          the trainer root (existing behavior: tab bar hides during a client
          drill, which reads as "inside this client's workspace") */}
      <Stack.Screen name={CLIENT_DETAIL} component={ClientDetailScreen} options={{ title: 'Client' }} />
      <Stack.Screen name={TRAINER_PROGRESS_PHOTOS} component={TrainerProgressPhotosScreen} options={{ title: 'Progress Photos' }} />
      <Stack.Screen
        name={ASSIGN_WORKOUT_PICKER}
        component={AssignWorkoutPickerScreen}
        options={{ title: 'Assign Workout' }}
      />
      <Stack.Screen name={ASSIGN_WORKOUT} component={AssignWorkoutScreen} options={{ title: 'Assign Workout' }} />
      <Stack.Screen
        name={WORKOUT_TEMPLATE_EDITOR}
        component={WorkoutTemplateEditorScreen}
        options={{ title: 'Template' }}
      />
      <Stack.Screen name={DIET_PLAN_BUILDER} component={DietPlanBuilderScreen} options={{ title: 'Diet Plan' }} />
      <Stack.Screen
        name={SUPPLEMENT_PLAN_BUILDER}
        component={CoachingPlanBuilderScreen}
        options={{ title: 'Supplement Plan' }}
      />
      <Stack.Screen
        name={ASSIGNED_PLAN_DETAIL}
        component={AssignedPlanDetailScreen}
        options={{ title: 'Assigned Plan' }}
      />
      <Stack.Screen
        name={COACHING_PLAN_DETAIL}
        component={CoachingPlanDetailScreen}
        options={{ title: 'Plan' }}
      />
      <Stack.Screen
        name={NOTIFICATION_CENTER}
        component={NotificationCenterScreen}
        options={{ title: 'Notifications' }}
      />
      <Stack.Screen name={TAG_MANAGER} component={TagManagerScreen} options={{ title: 'Manage Tags' }} />
      {/* top-bar gear/data-sync resolve inside trainer view as well */}
      <Stack.Screen name={SETTINGS} component={SettingsScreen} options={{ title: 'Settings' }} />
      <Stack.Screen name={SYNC_SETTINGS} component={SyncSettingsScreen} options={{ title: 'Data & Sync' }} />
    </Stack.Navigator>
  );
}

// Mini-bar floats above the user-view stack while a workout is active.
export { ActiveWorkoutMiniBar };