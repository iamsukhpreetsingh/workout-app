import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar, View, Text, ActivityIndicator, AppState, Alert, TouchableOpacity } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { WorkoutProvider } from './src/store/WorkoutContext';
import { AppProvider, useApp } from './src/store/AppContext';
import { AuthProvider, useAuth } from './src/store/AuthContext';
import { NotificationProvider } from './src/store/NotificationContext';
import { setHapticsEnabled } from './src/lib/haptics';
import { syncPendingSessions, syncPendingMeasurements } from './src/lib/syncService';
import { getViewChoice, setViewChoice, clearViewChoice } from './src/lib/viewMode';
import { useColors } from './src/theme';
import { api } from './src/lib/api';
import * as SecureStore from 'expo-secure-store';
import IntakeFormScreen from './src/screens/IntakeFormScreen';
import LoginScreen from './src/screens/LoginScreen';
import SignupScreen from './src/screens/SignupScreen';
import ViewChoiceScreen from './src/screens/ViewChoiceScreen';
import HomeScreen from './src/screens/HomeScreen';
import WorkoutScreen from './src/screens/WorkoutScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SessionDetailScreen from './src/screens/SessionDetailScreen';
import PlansScreen from './src/screens/PlansScreen';
import PlanDetailScreen from './src/screens/PlanDetailScreen';
import PlanEditorScreen from './src/screens/PlanEditorScreen';
import ProgressScreen from './src/screens/ProgressScreen';
import ExerciseProgressScreen from './src/screens/ExerciseProgressScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import BodyScreen from './src/screens/BodyScreen';
import TrainerClientsScreen from './src/screens/TrainerClientsScreen';
import TrainerSettingsScreen from './src/screens/TrainerSettingsScreen';
import ClientDetailScreen from './src/screens/ClientDetailScreen';
import AssignWorkoutScreen from './src/screens/AssignWorkoutScreen';
import ClientAssignedDetailScreen from './src/screens/ClientAssignedDetailScreen';
import CoachingPlanBuilderScreen from './src/screens/CoachingPlanBuilderScreen';
import CoachingPlanDetailScreen from './src/screens/CoachingPlanDetailScreen';
import AssignedPlanDetailScreen from './src/screens/AssignedPlanDetailScreen';
import DietPlanBuilderScreen from './src/screens/DietPlanBuilderScreen';
import ClientDietPlanDetailScreen from './src/screens/ClientDietPlanDetailScreen';
import MyDishesScreen from './src/screens/MyDishesScreen';
import MealCatalogScreen from './src/screens/MealCatalogScreen';
import WorkoutTemplatesScreen from './src/screens/WorkoutTemplatesScreen';
import WorkoutTemplateEditorScreen from './src/screens/WorkoutTemplateEditorScreen';
import AssignWorkoutPickerScreen from './src/screens/AssignWorkoutPickerScreen';
import ActiveWorkoutMiniBar from './src/components/ActiveWorkoutMiniBar';
import NotificationCenterScreen from './src/screens/NotificationCenterScreen';
import TagManagerScreen from './src/screens/TagManagerScreen';
import SyncSettingsScreen from './src/screens/SyncSettingsScreen';
import { initConnectivityListener } from './src/lib/sync';
import { initSyncEngine } from './src/lib/syncEngine';
import { runBackfillIfNeeded } from './src/lib/backfill';
import { isRestoreNeeded } from './src/lib/restore';
import RestoreScreen from './src/screens/RestoreScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const TAB_ICONS = {
  Home: 'home',
  History: 'calendar',
  Plans: 'list',
  Progress: 'trending-up',
};

// ── USER VIEW ───────────────────────────────────────────────────────────
// The existing app shell. A trainer in User View uses it exactly like a
// personal account — the Clients tab now lives only in Trainer View.
function Tabs({ onSwitchView }) {
  const { colors } = useApp();
  const { user } = useAuth();
  const isTrainer = user?.role === 'trainer';
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
        title: route.name === 'Plans' ? 'Routines' : route.name,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Workout Tracker' }} />
      <Tab.Screen name="History" component={HistoryScreen} />
      <Tab.Screen name="Plans" component={PlansScreen} options={{ title: 'Routines' }} />
      <Tab.Screen name="Progress" component={ProgressScreen} />
    </Tab.Navigator>
  );
}

function AuthStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Signup" component={SignupScreen} />
    </Stack.Navigator>
  );
}

function MainStack({ onSwitchView }) {
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
      <Stack.Screen name="Main" options={{ headerShown: false }}>
        {(props) => <Tabs {...props} onSwitchView={onSwitchView} />}
      </Stack.Screen>
      <Stack.Screen name="SessionDetail" component={SessionDetailScreen} options={{ title: 'Workout' }} />
      <Stack.Screen name="PlanDetail" component={PlanDetailScreen} options={{ title: 'Routine' }} />
      <Stack.Screen name="PlanEditor" component={PlanEditorScreen} options={{ title: 'New Routine' }} />
      <Stack.Screen name="ExerciseProgress" component={ExerciseProgressScreen} options={{ title: 'Exercise' }} />
      <Stack.Screen name="Settings">
        {(props) => <SettingsScreen {...props} onSwitchView={isTrainer ? onSwitchView : undefined} />}
      </Stack.Screen>
      <Stack.Screen name="SyncSettings" component={SyncSettingsScreen} options={{ title: 'Data & Sync' }} />
      <Stack.Screen name="IntakeForm" component={IntakeFormScreen} options={{ title: 'Health Profile' }} />
      <Stack.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
      <Stack.Screen name="Body" component={BodyScreen} options={{ title: 'Body' }} />
      <Stack.Screen name="ClientDetail" component={ClientDetailScreen} options={{ title: 'Client' }} />
      <Stack.Screen name="AssignWorkout" component={AssignWorkoutScreen} options={{ title: 'Assign Workout' }} />
      <Stack.Screen name="ClientAssignedDetail" component={ClientAssignedDetailScreen} options={{ title: 'From Your Trainer' }} />
      <Stack.Screen name="NotificationCenter" component={NotificationCenterScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen name="DietPlanBuilder" component={DietPlanBuilderScreen} options={{ title: 'Diet Plan' }} />
      <Stack.Screen name="ClientDietPlanDetail" component={ClientDietPlanDetailScreen} options={{ title: 'Diet Plan' }} />
      <Stack.Screen name="MyDishes" component={MyDishesScreen} options={{ title: 'My Dishes' }} />
      <Stack.Screen name="SupplementPlanBuilder" component={CoachingPlanBuilderScreen} options={{ title: 'Supplement Plan' }} />
      <Stack.Screen name="CoachingPlanBuilder" component={CoachingPlanBuilderScreen} options={{ title: 'Plan' }} />
      <Stack.Screen name="CoachingPlanDetail" component={CoachingPlanDetailScreen} options={{ title: 'Plan' }} />
      <Stack.Screen name="AssignedPlanDetail" component={AssignedPlanDetailScreen} options={{ title: 'Assigned Plan' }} />
      {/* Expanded logging view for the active workout (mini-bar expands here) */}
      <Stack.Screen
        name="ActiveWorkout"
        component={WorkoutScreen}
        options={{ title: 'Active Workout', presentation: 'fullScreenModal', headerShown: false }}
      />
    </Stack.Navigator>
  );
}

// ── TRAINER VIEW ────────────────────────────────────────────────────────
// Deliberately minimal: Clients + Settings. The trainer accent (blue) is
// the active tab color, so the mode is distinguishable at a glance.
function TrainerTabs({ onSwitchView }) {
  const { colors } = useApp();
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
          <Ionicons
            name={
              route.name === 'Clients'
                ? 'people'
                : route.name === 'Workouts'
                ? 'barbell-outline'
                : route.name === 'Recipes'
                ? 'restaurant-outline'
                : 'settings-outline'
            }
            size={size || 22}
            color={color}
          />
        ),
      })}
    >
      <Tab.Screen name="Clients" component={TrainerClientsScreen} options={{ title: 'Clients' }} />
      <Tab.Screen name="Workouts" component={WorkoutTemplatesScreen} options={{ title: 'Workouts' }} />
      <Tab.Screen name="Recipes" component={MealCatalogScreen} options={{ title: 'Recipes' }} />
      <Tab.Screen name="TrainerSettings">
        {(props) => <TrainerSettingsScreen {...props} onSwitchView={onSwitchView} />}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

function TrainerStack({ onSwitchView }) {
  const { colors } = useApp();
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="TrainerMain" options={{ headerShown: false }}>
        {(props) => <TrainerTabs {...props} onSwitchView={onSwitchView} />}
      </Stack.Screen>
      <Stack.Screen name="ClientDetail" component={ClientDetailScreen} options={{ title: 'Client' }} />
      <Stack.Screen name="AssignWorkoutPicker" component={AssignWorkoutPickerScreen} options={{ title: 'Assign Workout' }} />
      <Stack.Screen name="AssignWorkout" component={AssignWorkoutScreen} options={{ title: 'Assign Workout' }} />
      <Stack.Screen name="WorkoutTemplateEditor" component={WorkoutTemplateEditorScreen} options={{ title: 'Template' }} />
      <Stack.Screen name="DietPlanBuilder" component={DietPlanBuilderScreen} options={{ title: 'Diet Plan' }} />
      <Stack.Screen name="SupplementPlanBuilder" component={CoachingPlanBuilderScreen} options={{ title: 'Supplement Plan' }} />
      <Stack.Screen name="AssignedPlanDetail" component={AssignedPlanDetailScreen} options={{ title: 'Assigned Plan' }} />
      <Stack.Screen name="CoachingPlanDetail" component={CoachingPlanDetailScreen} options={{ title: 'Plan' }} />
      <Stack.Screen name="NotificationCenter" component={NotificationCenterScreen} options={{ title: 'Notifications' }} />
      <Stack.Screen name="TagManager" component={TagManagerScreen} options={{ title: 'Manage Tags' }} />
    </Stack.Navigator>
  );
}

function Splash() {
  const colors = useColors();
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="barbell" size={44} color={colors.primary} />
      <ActivityIndicator color={colors.primary} style={{ marginTop: 18 }} />
    </View>
  );
}








// ── Intake-profile onboarding helpers ──────────────────────────────────
// A client with an ACTIVE trainer but no completed health profile gets the
// non-dismissible intake form (hard gate, rendered above the navigator).
// A client who already HAS a profile and connects to a NEW trainer gets a
// gentle one-time prompt instead — never a gate. Acknowledged trainer ids
// are kept in SecureStore so the prompt never repeats for the same trainer.
const INTAKE_ACK_KEY = 'intake_ack_trainers';

async function getAckedTrainers() {
  try {
    return JSON.parse((await SecureStore.getItemAsync(INTAKE_ACK_KEY)) || '[]');
  } catch {
    return [];
  }
}

async function ackTrainer(id) {
  if (!id) return;
  try {
    const acked = await getAckedTrainers();
    if (!acked.includes(id)) {
      acked.push(id);
      await SecureStore.setItemAsync(INTAKE_ACK_KEY, JSON.stringify(acked));
    }
  } catch {}
}







function AppContent() {
  const { colors, isDark, hapticsEnabled, loaded } = useApp();
  const { authStatus, user } = useAuth();

  // trainerView: null while reading the persisted choice; 'user'|'trainer'
  // once resolved; 'unset' → show the choice screen.
  const [trainerView, setTrainerView] = useState(null);
  const [restorePending, setRestorePending] = useState(false); // restore overlay (System 5)
  const isTrainer = user?.role === 'trainer';

  useEffect(() => {
    setHapticsEnabled(hapticsEnabled);
  }, [hapticsEnabled]);

  // Resolve the persisted view on (re)authentication; plain users bypass.
  useEffect(() => {
    if (authStatus !== 'authenticated' || !isTrainer) {
      setTrainerView(null);
      return;
    }
    let mounted = true;
    getViewChoice().then((v) => {
      if (mounted) setTrainerView(v === 'trainer' || v === 'user' ? v : 'unset');
    });
    return () => { mounted = false; };
  }, [authStatus, isTrainer]);





    // ── Intake-profile gate ──
  // null = no gate; 'gate' = non-dismissible form (active trainer, no
  // completed profile); 'edit' = review form opened from the gentle prompt.
  const [intakeGate, setIntakeGate] = useState(null);
  const gateTrainerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (authStatus !== 'authenticated' || isTrainer) return;
      try {
        const [assoc, profile] = await Promise.all([
          api('/client/trainer').catch(() => null),
          api('/client/intake-profile').catch(() => null),
        ]);
        if (cancelled) return;
        if (!assoc || assoc.status !== 'active') return setIntakeGate(null);
        const trainerId = assoc.trainer_id || (assoc.trainer && assoc.trainer.id) || null;
        gateTrainerRef.current = trainerId;
        if (!profile || !profile.completed_at) return setIntakeGate('gate');
        // profile already completed → gentle prompt only, once per new trainer
        setIntakeGate(null);
        if (trainerId) {
          const acked = await getAckedTrainers();
          if (cancelled || acked.includes(trainerId)) return;
          ackTrainer(trainerId);
          Alert.alert(
            'New trainer connected',
            'Your health profile helps your trainer keep your plans safe. Want to review it?',
            [
              { text: 'Not now', style: 'cancel' },
              { text: 'Review', onPress: () => setIntakeGate('edit') },
            ]
          );
        }
      } catch {
        if (!cancelled) setIntakeGate(null);
      }
    };
    check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [authStatus, isTrainer]);






  // Choosing/switching persists and remounts immediately.
  const chooseView = useCallback(
    (mode) => {
      setTrainerView(mode);
      setViewChoice(mode);
    },
    []
  );

  // // Invisible sync catch-up on foreground while authenticated.
  // useEffect(() => {
  //   if (authStatus !== 'authenticated') return;
  //   // Initialize connectivity listener for offline-first sync
  //   initConnectivityListener();
  //   syncPendingSessions();
  //   syncPendingMeasurements();
  //   const sub = AppState.addEventListener('change', (state) => {
  //     if (state === 'active') {
  //       syncPendingSessions();
  //       syncPendingMeasurements();
  //     }
  //   });
  //   return () => sub.remove();
  // }, [authStatus]);


    // Engine startup + trainer-facing pushes + restore gate + backfill.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    // unified engine: connectivity listener, crash reset, 10-min safety net
    initSyncEngine();
    // legacy shim + trainer-facing (redacted) pushes — mode-gated
    initConnectivityListener();
    syncPendingSessions();
    syncPendingMeasurements();

    // Restore gate (System 5): fresh install/cleared data → full restore
    // BEFORE the user enters the app. Runs before the backfill so restored
    // rows (synced=1) are never re-enqueued.
    (async () => {
      try {
        if (await isRestoreNeeded()) {
          setRestorePending(true); // overlay finish triggers the backfill
        } else {
          runBackfillIfNeeded().catch(() => {});
        }
      } catch {
        setRestorePending(true); // couldn't even check — overlay handles retry
      }
    })();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncPendingSessions();
        syncPendingMeasurements();
      }
    });
    return () => sub.remove();
  }, [authStatus]);

  const navTheme = useMemo(() => {
    const base = isDark ? { ...DarkTheme } : { ...DefaultTheme };
    return {
      ...base,
      colors: {
        ...base.colors,
        background: colors?.bg || '#000',
        card: colors?.card || '#1c1c1e',
        border: colors?.border || '#38383a',
        primary: colors?.primary || '#0a84ff',
        text: colors?.text || '#fff',
      },
    };
  }, [colors, isDark]);

  if (!loaded || !colors) return null;

  const showViewChoice = authStatus === 'authenticated' && isTrainer && trainerView === 'unset';
  const showTrainerNav = authStatus === 'authenticated' && isTrainer && trainerView === 'trainer';

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      {/* Hard auth gate: no unauthenticated path into the main app */}
      {authStatus === 'checking' && <Splash />}
      {authStatus === 'unauthenticated' && <AuthStack />}
      {showViewChoice && (
        <ViewChoiceScreen userName={user?.name} onChoose={chooseView} />
      )}
      {showTrainerNav && <TrainerStack onSwitchView={chooseView} />}
      {authStatus === 'authenticated' && (!isTrainer || trainerView === 'user') && (
        <>
          <MainStack onSwitchView={isTrainer ? chooseView : undefined} />
          <ActiveWorkoutMiniBar />
        </>
      )}
      {/* intake-profile gate / gentle-prompt review — rendered above nav */}
      {(intakeGate === 'gate' || intakeGate === 'edit') && (
        <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.bg, paddingTop: intakeGate === 'gate' ? 44 : 0 }}>
          {intakeGate === 'edit' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 12, paddingHorizontal: 16 }}>
              <TouchableOpacity onPress={() => setIntakeGate(null)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '800', marginLeft: 10 }}>Health Profile</Text>
            </View>
          )}
          <IntakeFormScreen
            route={{ params: { gate: intakeGate === 'gate' } }}
            navigation={{
              goBack: () => {
                if (intakeGate === 'gate') ackTrainer(gateTrainerRef.current);
                setIntakeGate(null);
              },
              setOptions: () => {},
            }}
          />
        </View>
      )}
      {/* restore-on-login gate — non-dismissible overlay above everything */}
      {restorePending && (
        <RestoreScreen
          onFinished={() => {
            setRestorePending(false);
            runBackfillIfNeeded().catch(() => {});
          }}
        />
      )}

    </NavigationContainer>
  );
}

// Expose the view-clearing logout through the auth context (Settings uses
// the context's logout; AuthProviderLogoutWrap injects the reset).
export default function App() {
  return (
    <AuthProvider>
      <NotificationProvider>
        <AppProvider>
          <WorkoutProvider>
            <AppContent />
          </WorkoutProvider>
        </AppProvider>
      </NotificationProvider>
    </AuthProvider>
  );
}
