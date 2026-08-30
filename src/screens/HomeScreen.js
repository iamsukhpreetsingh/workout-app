import React, { useCallback, useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, Modal, StyleSheet, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useWorkout, elapsedSeconds, formatDuration } from '../store/WorkoutContext';
import { listPlans, getPlan, listSessions } from '../db/queries';
import { getSettings } from '../db/settings';
import { calculateStreak } from '../lib/streaks';
import { useColors } from '../theme';
import { useHeaderActions } from '../components/HeaderActions';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { fetchAndCacheTrainerContent } from '../lib/trainerCache';
import { listPins, removePin, removeStalePins, MAX_PINNED_ROUTINES } from '../db/pins';
// import { startAssignedPlan } from '../lib/startAssigned';
import { NotificationBell } from '../components/NotificationBell';
import { fmtVolume } from '../shared/utils/format';
import { getSyncStatus, addSyncListener, initConnectivityListener, syncPending, getSyncSettings } from '../lib/sync';
// import { ACTIVE_WORKOUT, MAIN_TABS, NOTIFICATION_CENTER, PLAN_DETAIL, PROFILE, SESSION_DETAIL, SETTINGS, TAB_HISTORY } from '../shared/constants/routes';
import { ACTIVE_WORKOUT, CLIENT_ASSIGNED_DETAIL, HISTORY, NOTIFICATION_CENTER, PLAN_DETAIL, SESSION_DETAIL, SETTINGS } from '../shared/constants/routes';
const NUMS = { fontVariant: ['tabular-nums'] };

function smartWorkoutName() {
  const day = new Date().toLocaleDateString(undefined, { weekday: 'long' });
  return `${day} Workout`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5 || h >= 22) return 'Late night session';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function chunkPairs(items) {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push([items[i], items[i + 1]].filter(Boolean));
  return rows;
}

function PinnedGridCard({ item, styles, colors, onStart, onUnpin }) {
  const fromTrainer = item.source === 'trainer';
  return (
    <TouchableOpacity
      style={[styles.pinCard, fromTrainer && styles.pinCardTrainer]}
      activeOpacity={0.8}
      onPress={() => onStart(item)}
      onLongPress={() => onUnpin(item)}
    >
      {fromTrainer && <View style={styles.pinTrainerStripe} />}
      <View style={{ flex: 1 }}>
        <Text style={styles.pinName} numberOfLines={1}>
          {item.name}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {fromTrainer && <Ionicons name="fitness" size={10} color={colors.blue} />}
          {fromTrainer && <Text style={styles.pinTrainerTag}>Trainer</Text>}
          <Text style={[styles.pinMeta, NUMS]}>{item.exerciseCount} ex</Text>
        </View>
      </View>
      {/* <Ionicons name="play-circle" size={22} color={fromTrainer ? colors.blue : colors.primary} /> */}
            <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </TouchableOpacity>
  );
}

export default function HomeScreen({ navigation }) {
  const { workout, dispatch } = useWorkout();
  const colors = useColors();
  const styles = makeStyles(colors);
  const [plans, setPlans] = useState([]);
  const [recent, setRecent] = useState([]);
  const [defaultRest, setDefaultRest] = useState(90);
  const [streak, setStreak] = useState({ current: 0, longest: 0 });
  const [pickerVisible, setPickerVisible] = useState(false);
  const [assignedPlans, setAssignedPlans] = useState([]);
  const [pinnedItems, setPinnedItems] = useState([]);
  const { user } = useAuth();
  const [emptyName, setEmptyName] = useState(smartWorkoutName());
  const [syncStatus, setSyncStatus] = useState({ status: 'synced', pending_count: 0, isConnected: true });
  
  // Initialize sync and track status
  useEffect(() => {
    initConnectivityListener();
    getSyncStatus().then(setSyncStatus);
    const unsubscribe = addSyncListener((status) => {
      // if (status.type === 'SYNC_START' || status.type === 'SYNC_COMPLETE' || 
      //     status.type === 'CONNECTIVITY' || status.type === 'QUEUE_CHANGED') {
          if (status.type === 'SYNC_START' || status.type === 'SYNC_COMPLETE' ||
          status.type === 'CONNECTIVITY' || status.type === 'QUEUE_CHANGED' ||
          status.type === 'SETTINGS_CHANGED') {
        getSyncStatus().then(setSyncStatus);
      }
    });
    return unsubscribe;
  }, []);
  
  const handleManualSync = async () => {
    const result = await syncPending();
    if (result.skipped) {
      Alert.alert('Sync', result.reason === 'local_only' ? 'Sync is disabled (Local Only mode)' : 'No internet connection');
    }
  };

  // Contextual greeting; shared notification + settings actions (all screens)
  useHeaderActions(navigation);
  React.useLayoutEffect(() => {
    navigation.setOptions({ title: greeting() });
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      async function load() {
        const [p, s, st, settings] = await Promise.all([
          listPlans(),
          listSessions(),
          calculateStreak(),
          getSettings(),
        ]);
        if (mounted) {
          setPlans(p);
          setRecent(s.slice(0, 7)); // Home shows at most 7; full list lives in History
          setStreak(st);
          setDefaultRest(settings.default_rest_seconds);
        }
      }
      load();
      return () => { mounted = false; };
    }, [])
  );

  // Trainer-assigned workouts — own effect keyed on the resolved role so the
  // auth-restore timing can't leave it behind a stale closure. Runs on every
  // Home focus. Non-fatal so Home never breaks on it.
  const isClient = user?.role === 'user' || user?.role === 'trainer';
  useFocusEffect(
    useCallback(() => {
      if (!isClient) {
        setAssignedPlans([]);
        return;
      }
      let mounted = true;
      // fetch-through cache: server first, cached copy when offline — same
      // fallback PlansScreen uses, so pinned workouts survive offline
      fetchAndCacheTrainerContent('trainer:assigned-workouts', () => api('/client/assigned-plans'))
        .then((plans) => { if (mounted) setAssignedPlans(plans || []); })
        .catch((e) => {
          if (mounted) setAssignedPlans([]);
          console.warn('assigned-plans fetch failed:', e.message || e);
        });
      return () => { mounted = false; };
    }, [isClient])
  );

  // Resolve pinned routines into startable cards, and silently drop pins
  // whose source routine was deleted / revoked / archived since last load.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      (async () => {
        const [pins, myPlans, assigned] = await Promise.all([
          listPins(),
          listPlans(),
          // cached fallback keeps pinned assigned workouts resolvable offline
          isClient
            ? fetchAndCacheTrainerContent('trainer:assigned-workouts', () => api('/client/assigned-plans')).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (!mounted) return;
        await removeStalePins(myPlans.map((p) => p.id), assigned.map((a) => a.id));
        const validPins = await listPins();
        const planById = new Map(myPlans.map((p) => [String(p.id), p]));
        const assignedById = new Map(assigned.map((a) => [String(a.id), a]));
        setPinnedItems(
          validPins
            .map((pin) => {
              if (pin.source_type === 'self') {
                const plan = planById.get(pin.routine_ref_id);
                return plan
                  ? { key: `self:${plan.id}`, source: 'self', id: plan.id, name: plan.name, exerciseCount: plan.exerciseCount }
                  : null;
              }
              const ap = assignedById.get(pin.routine_ref_id);
              return ap
                ? { key: `trainer_assigned:${ap.id}`, source: 'trainer', id: ap.id, name: ap.name, exerciseCount: ap.exercises?.length ?? 0, plan: ap }
                : null;
            })
            .filter(Boolean)
            .slice(0, MAX_PINNED_ROUTINES)
        );
      })();
      return () => { mounted = false; };
    }, [isClient])
  );


    // Pinned cards open the DETAIL screen (preview first, Start from there) —
  // consistent with every other plan list in the app. If a workout is
  // already in progress, a tap continues it instead (same as the main CTA).
  const openPinned = (item) => {
  // Only continue the active workout if this pinned routine
  // is the same routine that is currently in progress.
  if (workout && String(workout.planId) === String(item.id)) {
    navigation.navigate(ACTIVE_WORKOUT);
    return;
  }

  // Otherwise open the tapped routine's detail screen.
  navigation.navigate(
    item.source === 'self' ? PLAN_DETAIL : CLIENT_ASSIGNED_DETAIL,
    { planId: item.id }
  );
};

  const unpinFromHome = (item) =>
    Alert.alert('Unpin routine', `Remove "${item.name}" from your pinned strip?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unpin',
        style: 'destructive',
        onPress: async () => {
          await removePin(item.source === 'self' ? 'self' : 'trainer_assigned', item.id);
          setPinnedItems((prev) => prev.filter((p) => p.key !== item.key));
        },
      },
    ]);

  const beginWorkout = (name, planId, planExercises) => {
    dispatch({ type: 'START_WORKOUT', name, planId, planExercises, defaultRest });
    // first launch of a new session opens straight into the logging UI
    navigation.navigate(ACTIVE_WORKOUT);
  };

  const startEmpty = () =>
    beginWorkout(emptyName.trim() || smartWorkoutName(), null, []);

  const onStartPress = () => {
    if (workout) {
      navigation.navigate(ACTIVE_WORKOUT);
      return;
    }
    // Choice, not an immediate empty start
    setPickerVisible(true);
  };

  const startFromRoutineList = async (item) => {
    setPickerVisible(false);
    const plan = await getPlan(item.id);
    beginWorkout(plan.name, plan.id, plan.exercises);
  };

  const doneSets = workout
    ? workout.exercises.reduce((n, e) => n + e.sets.filter((s) => s.completed).length, 0)
    : 0;

  const horizontalRoutines = plans.length > 3;

  return (
    <View style={styles.container}>
      <FlatList
        data={[]}
        keyExtractor={() => 'static'}
        renderItem={null}
        ListHeaderComponent={
          <View>
            {/* ── Zone 1: signature CTA ─────────────────────────────── */}
            <TouchableOpacity activeOpacity={0.85} onPress={onStartPress} style={styles.cta}>
              <View style={styles.ctaGlow} />
              <View style={styles.ctaRing}>
                <Ionicons name={workout ? 'play' : 'barbell'} size={28} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.ctaTitle}>
                  {workout ? 'Continue Workout' : 'Start Workout'}
                </Text>
                <Text style={styles.ctaSub}>
                  {workout
                    ? `${formatDuration(elapsedSeconds(workout))} · ${doneSets} sets done`
                    : 'Empty session or a routine'}
                </Text>
              </View>
              <View style={styles.ctaGo}>
                <Ionicons name="arrow-forward" size={18} color={colors.primary} />
              </View>
            </TouchableOpacity>

            {/* Local Only echo — subtle, always visible while active */}
            {syncStatus.sync_mode === 'local' && (
              <View style={styles.localOnlyEcho}>
                <Ionicons name="lock-closed" size={11} color={colors.textDim} />
                <Text style={styles.localOnlyEchoText}>Local Only — not backed up</Text>
              </View>
            )}


            {/* ── Zone 2: quiet streak pip ──────────────────────────── */}
            {streak.current > 0 && (
              <View style={styles.streakPip}>
                <View style={styles.streakFlame}>
                  <Ionicons name="flame" size={13} color={colors.bg} />
                </View>
                <Text style={[styles.streakNum, NUMS]}>{streak.current}</Text>
                <Text style={styles.streakWord}>day streak</Text>
                <Text style={[styles.streakBest, NUMS]}>best {streak.longest}</Text>
              </View>
            )}

            {/* ── Pinned: curated quick-start strip (omitted when empty) */}
            {pinnedItems.length > 0 && (
              <View>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionHeader}>Pinned</Text>
                </View>
                {/* 2 × 3 grid (cap is MAX_PINNED_ROUTINES = 6) */}
                {chunkPairs(pinnedItems).map(([a, b]) => (
                  <View key={a.key} style={styles.pinRow}>
                    <PinnedGridCard item={a} styles={styles} colors={colors} onStart={openPinned} onUnpin={unpinFromHome} />
                    {b ? (
                      <PinnedGridCard item={b} styles={styles} colors={colors} onStart={openPinned} onUnpin={unpinFromHome} />
                    ) : (
                      <View style={{ flex: 1 }} />
                    )}
                  </View>
                ))}
              </View>
            )}

            {/* ── Zone 4: Recent workouts ───────────────────────────── */}
            {recent.length > 0 && (
              <>
                <View style={styles.sectionHeaderRow}>
                  <Text style={styles.sectionHeader}>Recent Workouts</Text>
                  <TouchableOpacity
                    onPress={() => navigation.navigate(HISTORY)}
                  >
                    <Text style={styles.seeAll}>see all</Text>
                  </TouchableOpacity>
                </View>
                {recent.map((s) => {
                  const fromTrainer = !!s.source_assigned_plan_id;
                  return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.recentRow, fromTrainer && styles.recentRowTrainer]}
                    onPress={() => navigation.navigate(SESSION_DETAIL, { sessionId: s.id })}
                  >
                    {fromTrainer && <View style={styles.trainerStripe} />}
                    <View style={styles.dateBlock}>
                      <Text style={[styles.dateDay, NUMS]}>
                        {new Date(s.start_time).getDate()}
                      </Text>
                      <Text style={styles.dateMon}>
                        {new Date(s.start_time).toLocaleDateString(undefined, { month: 'short' })}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.recentName} numberOfLines={1}>
                        {s.name}
                      </Text>
                      {fromTrainer ? (
                        <View style={styles.trainerTagRow}>
                          <Ionicons name="fitness" size={11} color={colors.blue} />
                          <Text style={styles.trainerTag}>Trainer</Text>
                        </View>
                      ) : null}
                      <Text style={[styles.recentMeta, NUMS]}>
                        {s.exerciseCount} ex · {s.totalSets || 0} sets · {fmtVolume(s.totalVolume)} vol
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                  </TouchableOpacity>
                  );
                })}
              </>
            )}
          </View>
        }
        contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
        style={{ flex: 1 }}
      />

      {/* Start-choice sheet (unchanged behavior) */}
      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setPickerVisible(false)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Start Workout</Text>
            <TextInput
              style={styles.nameField}
              value={emptyName}
              onChangeText={setEmptyName}
              placeholder="Workout name"
              placeholderTextColor={colors.textDim}
              maxLength={60}
            />
            <TouchableOpacity
              style={styles.choiceBtn}
              onPress={() => { setPickerVisible(false); startEmpty(); }}
            >
              <Ionicons name="barbell-outline" size={20} color={colors.primary} />
              <Text style={styles.choiceText}>Start Empty Workout</Text>
            </TouchableOpacity>
            <Text style={styles.sheetDivider}>or choose a routine</Text>
            {plans.length === 0 && (
              <Text style={styles.dim}>No routines yet — create one in the Routines tab.</Text>
            )}
            <FlatList
              data={plans}
              keyExtractor={(p) => String(p.id)}
              style={{ maxHeight: 260 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.sheetRoutineRow}
                  onPress={() => startFromRoutineList(item)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sheetPlanName}>{item.name}</Text>
                    <Text style={styles.sheetPlanSub}>{item.exerciseCount} exercises</Text>
                  </View>
                  <Ionicons name="play-circle" size={22} color={colors.primary} />
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setPickerVisible(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// Routine card — taps ALWAYS go to the detail screen for preview; sessions
// only start from the main CTA sheet or the detail screen's own action.
function RoutineCard({ item, styles, colors, navigation, horizontal }) {
  return (
    <TouchableOpacity
      style={[styles.routineCard, horizontal && styles.routineCardWide]}
      activeOpacity={0.8}
      onPress={() => navigation.navigate(PLAN_DETAIL, { planId: item.id })}
    >
      <View style={styles.routineAccent} />
      <View style={{ flex: 1 }}>
        <Text style={styles.routineName} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={[styles.routineMeta, NUMS]}>{item.exerciseCount} exercises</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </TouchableOpacity>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    headerIcon: { padding: 8 },

    // ── CTA: charcoal slab + ember glow (the signature element)
    cta: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 24,
      padding: 20,
      gap: 16,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.35,
      shadowRadius: 18,
      elevation: 8,
      overflow: 'hidden',
    },
    ctaGlow: {
      position: 'absolute',
      top: -70,
      right: -50,
      width: 200,
      height: 200,
      borderRadius: 100,
      backgroundColor: colors.primary,
      opacity: 0.16,
    },
    ctaRing: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.cardLight,
      borderWidth: 2,
      borderColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctaTitle: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
    ctaSub: { color: colors.textDim, fontSize: 13, marginTop: 3 },
    ctaGo: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // ── Streak pip: quiet, current > best
    streakPip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      alignSelf: 'flex-start',
      marginTop: 18,
      paddingLeft: 4,
    },
    streakFlame: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.yellow,
      alignItems: 'center',
      justifyContent: 'center',
    },
    streakNum: { color: colors.text, fontSize: 19, fontWeight: '800' },
    streakWord: { color: colors.textDim, fontSize: 13, marginRight: 8 },
    streakBest: { color: colors.textDim, fontSize: 11, opacity: 0.7 },
        localOnlyEcho: {
      flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
      marginTop: 10, paddingLeft: 4,
    },
    localOnlyEchoText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },

    // ── Section headers
    sectionHeaderRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginTop: 34,
      marginBottom: 12,
    },
    sectionHeader: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '800',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    seeAll: { color: colors.primary, fontSize: 13, fontWeight: '600' },
    dim: { color: colors.textDim, fontSize: 13 },

    // ── Routine cards: ember accent bar, tight rhythm
    routineCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 14,
      paddingVertical: 14,
      paddingRight: 14,
      paddingLeft: 0,
      marginBottom: 8,
      gap: 12,
      alignSelf: 'stretch',
    },
    routineCardWide: { width: 190, marginBottom: 0, flex: 0 },
    // Trainer-assigned: same card family, blue accent + coach framing
    assignedCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 14,
      paddingVertical: 14,
      paddingRight: 14,
      paddingLeft: 0,
      marginBottom: 8,
      gap: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 2,
    },
    assignedAccent: {
      alignSelf: 'stretch',
      width: 4,
      borderRadius: 2,
      backgroundColor: colors.blue,
      opacity: 0.9,
    },
    assignedMeta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    routineAccent: {
      alignSelf: 'stretch',
      width: 4,
      borderRadius: 2,
      backgroundColor: colors.primary,
      opacity: 0.9,
    },
    routineName: { color: colors.text, fontSize: 15, fontWeight: '700' },
    routineMeta: { color: colors.textDim, fontSize: 12, marginTop: 2 },

    // ── Recent: date block + denser metadata
    // Pinned strip — compact horizontal cards, same design tokens
    pinRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    pinCard: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 12,
      paddingLeft: 14,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 2,
    },
    pinCardTrainer: {
      borderLeftWidth: 3,
      borderLeftColor: colors.blue,
      borderTopLeftRadius: 4,
      borderBottomLeftRadius: 4,
    },
    pinTrainerStripe: { display: 'none' },
    pinName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    pinMeta: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    pinTrainerTag: { color: colors.blue, fontSize: 9, fontWeight: '800', letterSpacing: 0.5, marginTop: 2 },
    recentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingLeft: 12,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
    },
    recentRowTrainer: {
      borderLeftWidth: 3,
      borderLeftColor: colors.blue,
      borderTopLeftRadius: 4,
      borderBottomLeftRadius: 4,
    },
    trainerStripe: { display: 'none' },
    trainerTagRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    trainerTag: { color: colors.blue, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
    dateBlock: {
      width: 46,
      height: 46,
      borderRadius: 12,
      backgroundColor: colors.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dateDay: { color: colors.text, fontSize: 17, fontWeight: '800', lineHeight: 18 },
    dateMon: { color: colors.textDim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
    recentName: { color: colors.text, fontSize: 15, fontWeight: '700' },
    recentMeta: { color: colors.textDim, fontSize: 12, marginTop: 2 },

    // ── Choice sheet
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
    sheet: { backgroundColor: colors.card, borderRadius: 18, padding: 20 },
    sheetTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 14 },
    nameField: {
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 12,
      fontSize: 15,
      fontWeight: '600',
    },
    choiceBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderRadius: 10,
      padding: 14,
      marginBottom: 10,
      backgroundColor: colors.cardLight,
    },
    choiceText: { color: colors.text, fontWeight: '700', fontSize: 15 },
    sheetDivider: { color: colors.textDim, fontSize: 12, marginBottom: 10 },
    sheetRoutineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
      backgroundColor: colors.cardLight,
    },
    sheetPlanName: { color: colors.text, fontSize: 15, fontWeight: '700' },
    sheetPlanSub: { color: colors.textDim, fontSize: 12, marginTop: 3 },
    cancelBtn: { borderRadius: 10, padding: 12, alignItems: 'center', marginTop: 10, backgroundColor: colors.cardLight },
    cancelText: { color: colors.textDim, fontWeight: '700' },
  });
