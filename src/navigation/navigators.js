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
import PlanEditorScreen from '../screens/PlanEditorScreen';
import ProgressScreen from '../screens/ProgressScreen';
import ExerciseProgressScreen from '../screens/ExerciseProgressScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ProfileScreen from '../screens/ProfileScreen';
import BodyScreen from '../screens/BodyScreen';
import ProgressPhotosScreen from '../screens/ProgressPhotosScreen';
import TrainerProgressPhotosScreen from '../screens/TrainerProgressPhotosScreen';
import TrainerClientsScreen from '../screens/TrainerClientsScreen';
import TrainerSettingsScreen from '../screens/TrainerSettingsScreen';
import ClientDetailScreen from '../screens/ClientDetailScreen';
import AssignWorkoutScreen from '../screens/AssignWorkoutScreen';
import ClientAssignedDetailScreen from '../screens/ClientAssignedDetailScreen';
import CoachingPlanBuilderScreen from '../screens/CoachingPlanBuilderScreen';
import CoachingPlanDetailScreen from '../screens/CoachingPlanDetailScreen';
import AssignedPlanDetailScreen from '../screens/AssignedPlanDetailScreen';
import DietPlanBuilderScreen from '../screens/DietPlanBuilderScreen';
import ClientDietPlanDetailScreen from '../screens/ClientDietPlanDetailScreen';
import MyDishesScreen from '../screens/MyDishesScreen';
import MealCatalogScreen from '../screens/MealCatalogScreen';
import WorkoutTemplatesScreen from '../screens/WorkoutTemplatesScreen';
import WorkoutTemplateEditorScreen from '../screens/WorkoutTemplateEditorScreen';
import AssignWorkoutPickerScreen from '../screens/AssignWorkoutPickerScreen';
import ActiveWorkoutMiniBar from '../components/ActiveWorkoutMiniBar';
import NotificationCenterScreen from '../screens/NotificationCenterScreen';
import TagManagerScreen from '../screens/TagManagerScreen';
import SyncSettingsScreen from '../screens/SyncSettingsScreen';
import DietHomeScreen from '../features/diet/screens/DietHomeScreen';
import DietTrendsScreen from '../features/diet/screens/DietTrendsScreen';
import BuildDishScreen from '../features/diet/screens/BuildDishScreen';

import {
  LOGIN,
  SIGNUP,
  FORGOT_PASSWORD,
  RESET_PASSWORD,
  TAB_HOME,
  TAB_DIET,
  DIET_TRENDS,
  BUILD_DISH,
  TAB_HISTORY,
  TAB_PLANS,
  TAB_PROGRESS,
  MAIN_TABS,
  SESSION_DETAIL,
  PLAN_DETAIL,
  PLAN_EDITOR,
  EXERCISE_PROGRESS,
  SETTINGS,
  SYNC_SETTINGS,
  INTAKE_FORM,
  PROFILE,
  BODY,
  PROGRESS_PHOTOS,
  TRAINER_PROGRESS_PHOTOS,
  CLIENT_DETAIL,
  ASSIGN_WORKOUT,
  CLIENT_ASSIGNED_DETAIL,
  NOTIFICATION_CENTER,
  DIET_PLAN_BUILDER,
  CLIENT_DIET_PLAN_DETAIL,
  MY_DISHES,
  SUPPLEMENT_PLAN_BUILDER,
  COACHING_PLAN_BUILDER,
  COACHING_PLAN_DETAIL,
  ASSIGNED_PLAN_DETAIL,
  ACTIVE_WORKOUT,
  TRAINER_TABS,
  TAB_CLIENTS,
  TAB_WORKOUTS,
  TAB_RECIPES,
  TRAINER_SETTINGS,
  ASSIGN_WORKOUT_PICKER,
  WORKOUT_TEMPLATE_EDITOR,
  TAG_MANAGER,
} from '../shared/constants/routes';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TAB_ICONS = {
  [TAB_HOME]: 'home',
  [TAB_DIET]: 'nutrition',
  [TAB_HISTORY]: 'calendar',
  [TAB_PLANS]: 'list',
  [TAB_PROGRESS]: 'trending-up',
};

// ── USER VIEW ───────────────────────────────────────────────────────────
// The existing app shell. A trainer in User View uses it exactly like a
// personal account — the Clients tab now lives only in Trainer View.
export function Tabs() {
  const { colors } = useApp();
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '800' },
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TAB_ICONS[route.name] || 'ellipse'} size={size || 22} color={color} />
        ),
        title: route.name === TAB_PLANS ? 'Routines' : route.name,
      })}
    >
      <Tab.Screen name={TAB_HOME} component={HomeScreen} options={{ title: 'Workout Tracker' }} />
      <Tab.Screen name={TAB_DIET} component={DietHomeScreen} />
      <Tab.Screen name={TAB_HISTORY} component={HistoryScreen} />
      <Tab.Screen name={TAB_PLANS} component={PlansScreen} options={{ title: 'Routines' }} />
      <Tab.Screen name={TAB_PROGRESS} component={ProgressScreen} />
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
  const { user } = useAuth();
  const isTrainer = user?.role === 'trainer';
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name={MAIN_TABS} options={{ headerShown: false }}>
        {(props) => <Tabs {...props} />}
      </Stack.Screen>
      <Stack.Screen name={SESSION_DETAIL} component={SessionDetailScreen} options={{ title: 'Workout' }} />
      <Stack.Screen name={PLAN_DETAIL} component={PlanDetailScreen} options={{ title: 'Routine' }} />
      <Stack.Screen name={PLAN_EDITOR} component={PlanEditorScreen} options={{ title: 'New Routine' }} />
      <Stack.Screen name={EXERCISE_PROGRESS} component={ExerciseProgressScreen} options={{ title: 'Exercise' }} />
      <Stack.Screen name={SETTINGS}>
        {(props) => <SettingsScreen {...props} onSwitchView={isTrainer ? onSwitchView : undefined} />}
      </Stack.Screen>
      <Stack.Screen name={SYNC_SETTINGS} component={SyncSettingsScreen} options={{ title: 'Data & Sync' }} />
      <Stack.Screen name={INTAKE_FORM} component={IntakeFormScreen} options={{ title: 'Health Profile' }} />
      <Stack.Screen name={PROFILE} component={ProfileScreen} options={{ title: 'Profile' }} />
      <Stack.Screen name={BODY} component={BodyScreen} options={{ title: 'Body' }} />
      <Stack.Screen name={PROGRESS_PHOTOS} component={ProgressPhotosScreen} options={{ title: 'Progress Photos' }} />
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
      <Stack.Screen name={DIET_TRENDS} component={DietTrendsScreen} options={{ title: 'Nutrition Trends' }} />
      <Stack.Screen name={BUILD_DISH} component={BuildDishScreen} options={{ title: 'Build a Dish' }} />
      <Stack.Screen
        name={CLIENT_DIET_PLAN_DETAIL}
        component={ClientDietPlanDetailScreen}
        options={{ title: 'Diet Plan' }}
      />
      <Stack.Screen name={MY_DISHES} component={MyDishesScreen} options={{ title: 'My Dishes' }} />
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
      {/* Expanded logging view for the active workout (mini-bar expands here) */}
      <Stack.Screen
        name={ACTIVE_WORKOUT}
        component={WorkoutScreen}
        options={{ title: 'Active Workout', presentation: 'fullScreenModal', headerShown: false }}
      />
    </Stack.Navigator>
  );
}

// ── TRAINER VIEW ────────────────────────────────────────────────────────
// Deliberately minimal: Clients + Settings. The trainer accent (blue) is
// the active tab color, so the mode is distinguishable at a glance.
export function TrainerTabs({ onSwitchView }) {
  const { colors } = useApp();
  const TRAINER_TAB_ICONS = {
    [TAB_CLIENTS]: 'people',
    [TAB_WORKOUTS]: 'barbell-outline',
    [TAB_RECIPES]: 'restaurant-outline',
    [TRAINER_SETTINGS]: 'settings-outline',
  };
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '800' },
        headerShadowVisible: false,
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.textDim,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TRAINER_TAB_ICONS[route.name] || 'settings-outline'} size={size || 22} color={color} />
        ),
      })}
    >
      <Tab.Screen name={TAB_CLIENTS} component={TrainerClientsScreen} options={{ title: 'Clients' }} />
      <Tab.Screen name={TAB_WORKOUTS} component={WorkoutTemplatesScreen} options={{ title: 'Workouts' }} />
      <Tab.Screen name={TAB_RECIPES} component={MealCatalogScreen} options={{ title: 'Recipes' }} />
      <Tab.Screen name={TRAINER_SETTINGS}>
        {(props) => <TrainerSettingsScreen {...props} onSwitchView={onSwitchView} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

export function TrainerStack({ onSwitchView }) {
  const { colors } = useApp();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name={TRAINER_TABS} options={{ headerShown: false }}>
        {(props) => <TrainerTabs {...props} onSwitchView={onSwitchView} />}
      </Stack.Screen>
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
    </Stack.Navigator>
  );
}

// Mini-bar floats above the user-view stack while a workout is active.
export { ActiveWorkoutMiniBar };