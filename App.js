import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar, View, Text, ActivityIndicator, AppState, Alert, TouchableOpacity } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
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
import {
  AuthStack,
  MainStack,
  TrainerStack,
  ActiveWorkoutMiniBar,
} from './src/navigation/navigators';
import { initConnectivityListener } from './src/lib/sync';
import { initSyncEngine, resyncQueueForCurrentUser, processQueue } from './src/lib/syncEngine';
import { fetchAndCacheProgressionSetting } from './src/lib/progression';
import { runBackfillIfNeeded } from './src/lib/backfill';
import { isRestoreNeeded } from './src/lib/restore';
import RestoreScreen from './src/screens/RestoreScreen';
import ViewChoiceScreen from './src/screens/ViewChoiceScreen';
import IntakeFormScreen from './src/screens/IntakeFormScreen';
import { getLocalOnlyReminderState, markLocalOnlyReminderShown, hasUnsyncedBackupData } from './src/lib/localOnly';
import { getSyncSettings, setSyncMode } from './src/lib/sync';

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

  // Engine startup + trainer-facing pushes + restore gate + backfill.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    // unified engine: connectivity listener, crash reset, 10-min safety net
    initSyncEngine();
        // rebuild the sync queue from ONLY this account's unsynced data —
    // another account's pending items are never uploaded or failed under
    // the wrong user
    resyncQueueForCurrentUser();
        // progression: cache the resolved formula setting for offline suggestions
    fetchAndCacheProgressionSetting().catch(() => {});
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


        // System 7 #3: 14-day periodic Local Only reminder (once per session at
    // most, dismissible, non-blocking)
    (async () => {
      try {
        const settings = await getSyncSettings();
        if (settings.sync_mode !== 'local') return;
        const state = await getLocalOnlyReminderState();
        if (!state.due) return;
        markLocalOnlyReminderShown();
        Alert.alert(
          'Reminder',
          'your data is still Local Only and not backed up. [Switch to Automatic] [Dismiss]',
          [
            { text: 'Dismiss', style: 'cancel' },
            { text: 'Switch to Automatic', onPress: () => setSyncMode('auto') },
          ]
        );
      } catch {}
    })();


    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        syncPendingSessions();
        syncPendingMeasurements();
        processQueue(); // unified engine — auto mode runs on foreground (spec)
        fetchAndCacheProgressionSetting().catch(() => {}); // refresh resolved formula
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
            gate={intakeGate === 'gate'}
            onClose={() => {
              if (intakeGate === 'gate') ackTrainer(gateTrainerRef.current);
              setIntakeGate(null);
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
