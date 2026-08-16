import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as KeepAwake from 'expo-keep-awake';
import { useWorkout, groupLabels, elapsedSeconds } from '../store/WorkoutContext';
import { saveSession, createPlan } from '../db/queries';
import { getSettings, updateSettings } from '../db/settings';
import ExercisePicker from '../components/ExercisePicker';
import RestTimerBar from '../components/RestTimerBar';
import RestEditorModal from '../components/RestEditorModal';
import PlateSheet from '../components/PlateSheet';
import PRToast from '../components/PRToast';
import { evaluatePR } from '../db/pr';
import { queueSessionForSync } from '../lib/syncService';
import { useColors } from '../theme';
import { lightImpact, success as hapticSuccess } from '../lib/haptics';

const RPE_OPTIONS = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
const TYPE_META = {
  working: { label: 'W', full: 'Working' },
  warmup: { label: 'WU', full: 'Warm-up' },
  dropset: { label: 'DS', full: 'Drop set' },
  failure: { label: 'F', full: 'Failure' },
};

// Expanded logging view for the active workout (opened from the mini-bar).
export default function WorkoutScreen({ navigation }) {
  const colors = useColors();
  const { workout, dispatch } = useWorkout();
  const [tick, setTick] = useState(0);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [settings, setSettings] = useState(null);
  const [restEditKey, setRestEditKey] = useState(null);
  const [plateForKey, setPlateForKey] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [prToast, setPrToast] = useState(null);
  const [notesKey, setNotesKey] = useState(null); // exercise with open notes editor
  const sessionBest = useRef({});
  const restoredRef = useRef(false);

  const styles = makeStyles(colors);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setSettings(s);
      if (!restoredRef.current && s.rest_timer_ends_at) {
        restoredRef.current = true;
        if (s.rest_timer_ends_at > Date.now()) {
          dispatch({
            type: 'START_REST',
            id: s.rest_timer_ends_at,
            endsAt: s.rest_timer_ends_at,
            total: s.rest_timer_total,
            label: s.rest_timer_label,
          });
        } else {
          updateSettings({ rest_timer_ends_at: null, rest_timer_total: null, rest_timer_label: null });
        }
      }
    })();
  }, []);

  // Live timer refresh; elapsed is always recomputed from startTime (+pause
  // accounting) so it survives app kills and pauses correctly.
  useEffect(() => {
    if (!workout) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [!!workout]);

  // Keep the screen awake only while a workout is in progress
  useEffect(() => {
    if (workout && !workout.pausedAt) {
      KeepAwake.activateKeepAwake();
      return () => KeepAwake.deactivateKeepAwake();
    }
  }, [!!workout, workout?.pausedAt]);

  if (!workout) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>No active workout.</Text>
        <TouchableOpacity style={styles.startBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.startBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const paused = !!workout.pausedAt;
  const elapsed = elapsedSeconds(workout); // recomputed each render via `tick`

  const finish = () => {
    const hasAnySet = workout.exercises.some((e) =>
      e.sets.some((s) => s.completed && (parseFloat(s.weight) > 0 || parseInt(s.reps, 10) > 0))
    );
    if (!hasAnySet) {
      Alert.alert('No sets logged', 'Mark at least one set done before finishing.', [
        { text: 'Discard workout', style: 'destructive', onPress: () => dispatch({ type: 'CLEAR_WORKOUT' }) },
        { text: 'Keep logging' },
      ]);
      return;
    }
    const persistSession = async () => {
      const endTime = Date.now();
      const sessionId = await saveSession({
        name: workout.name,
        start_time: workout.startTime,
        end_time: endTime,
        duration_sec: elapsedSeconds(workout, endTime),
        notes: workout.notes,
        plan_id: workout.planId,
        sourceAssignedPlanId: workout.sourceAssignedPlanId || null,
        exercises: workout.exercises.map((e) => ({
          exerciseId: e.exerciseId,
          restSeconds: e.restSeconds,
          groupId: e.groupId,
          notes: e.notes || null,
          sets: e.sets
            .filter((s) => parseFloat(s.weight) > 0 || parseInt(s.reps, 10) > 0)
            .map((s) => ({
              weight: parseFloat(s.weight) || 0,
              reps: parseInt(s.reps, 10) || 0,
              rpe: s.rpe ?? null,
              setType: s.type || 'working',
              completed: s.completed ? 1 : 0,
            })),
        })),
      });
      return sessionId;
    };

    const afterSave = () => {
      dispatch({ type: 'SKIP_REST' });
      dispatch({ type: 'CLEAR_WORKOUT' });
      sessionBest.current = {};
      navigation.goBack();
    };

    const saveAsRoutine = async () => {
      // Empty-started workout only: also create a reusable routine using
      // the exercises/order/sets actually performed. Returns the sessionId
      // so trySave can queue the background summary sync.
      const sessionId = await persistSession();
      await createPlan(workout.name, null, workout.exercises.map((e) => ({
        exerciseId: e.exerciseId,
        targetSets: Math.max(1, e.sets.filter((s) => s.completed).length || e.sets.length),
        restSeconds: e.restSeconds,
        groupId: e.groupId,
      })));
      return sessionId;
    };

    const discardWorkout = () => {
      dispatch({ type: 'SKIP_REST' });
      dispatch({ type: 'CLEAR_WORKOUT' });
      sessionBest.current = {};
    };

    const trySave = (saveFn) =>
      saveFn()
        .then((sessionId) => {
          // invisible background sync — never blocks or surfaces errors
          if (sessionId) queueSessionForSync(sessionId);
          afterSave();
        })
        .catch((err) => {
          Alert.alert('Could not save workout', String(err.message || err));
        });

    // Routine-started workouts save exactly as before; empty-started ones
    // get the one-tap "also save as routine?" choice in the same dialog.
    if (workout.planId) {
      Alert.alert('Finish workout', 'Save this session?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: () => trySave(persistSession) },
        { text: 'Discard', style: 'destructive', onPress: discardWorkout },
      ]);
    } else {
      // Android allows 3 alert buttons — keep the choice one-tap by letting
      // the back gesture/swipe serve as cancel.
      Alert.alert(
        'Finish workout',
        `Save "${workout.name}"?`,
        [
          { text: 'Discard', style: 'destructive', onPress: discardWorkout },
          { text: 'One-time Only', onPress: () => trySave(persistSession) },
          { text: 'Save as Routine', onPress: () => trySave(saveAsRoutine) },
        ]
      );
    }
  };

  const restart = () =>
    Alert.alert(
      'Restart workout',
      'This discards all logged sets in this session and resets the timer. The exercise list is kept. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          style: 'destructive',
          onPress: () => {
            sessionBest.current = {};
            dispatch({ type: 'RESTART_WORKOUT' });
          },
        },
      ]
    );

  // Volume counts only sets the user marked done (and never warm-ups)
  const doneSets = workout.exercises.reduce(
    (n, e) => n + e.sets.filter((s) => s.completed).length,
    0
  );
  const totalVolume = workout.exercises.reduce(
    (n, e) =>
      n +
      e.sets
        .filter((s) => s.completed && s.type !== 'warmup')
        .reduce((m, s) => m + (parseFloat(s.weight) || 0) * (parseInt(s.reps, 10) || 0), 0),
    0
  );

  const labels = groupLabels(workout.exercises);
  const rpeEnabled = settings ? settings.rpe_enabled === 1 : true;

  const toggleSelect = (key) => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const linkSelected = () => {
    if (selected.length < 2) {
      Alert.alert('Superset', 'Select at least 2 exercises to link.');
      return;
    }
    dispatch({ type: 'LINK_SUPERSET', exerciseKeys: selected });
    setSelected([]);
    setSelectMode(false);
  };

  const restEditEx = workout.exercises.find((e) => e.key === restEditKey);
  const notesEx = workout.exercises.find((e) => e.key === notesKey);
  const plateSet = (() => {
    for (const e of workout.exercises) {
      const s = e.sets.find((x) => x.key === plateForKey);
      if (s) return s;
    }
    return null;
  })();

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View style={styles.topBarRow}>
          <TouchableOpacity style={styles.topIcon} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-down" size={24} color={colors.textDim} />
          </TouchableOpacity>
          <TextInput
            style={styles.nameInput}
            value={workout.name}
            onChangeText={(name) => dispatch({ type: 'SET_NAME', name })}
          />
          <TouchableOpacity
            style={styles.topIcon}
            onPress={() => {
              lightImpact();
              dispatch({ type: paused ? 'RESUME_WORKOUT' : 'PAUSE_WORKOUT' });
            }}
          >
            <Ionicons
              name={paused ? 'play' : 'pause'}
              size={22}
              color={paused ? colors.green : colors.text}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.topIcon} onPress={restart}>
            <Ionicons name="refresh" size={20} color={colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.topIcon} onPress={finish}>
            <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
          </TouchableOpacity>
        </View>
        <View style={styles.statsRow}>
          <Text style={[styles.timer, paused && { color: colors.textDim }]}>
            {paused ? 'PAUSED · ' : ''}{fmtClock(elapsed)}
          </Text>
          <Text style={styles.miniStat}>
            {workout.exercises.length} exercises · {doneSets} sets done · {Math.round(totalVolume)} vol
          </Text>
        </View>
      </View>

      <View style={styles.selectBar}>
        <TouchableOpacity
          onPress={() => {
            setSelectMode((v) => !v);
            setSelected([]);
          }}
        >
          <Text style={[styles.selectBtn, selectMode && styles.selectBtnActive]}>
            {selectMode ? 'Cancel superset' : 'Superset'}
          </Text>
        </TouchableOpacity>
        {selectMode && (
          <TouchableOpacity onPress={linkSelected}>
            <Text style={styles.selectBtn}>Link ({selected.length})</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={workout.exercises}
        keyExtractor={(item) => item.key}
        ListFooterComponent={
          <TouchableOpacity style={styles.addExercise} onPress={() => setPickerVisible(true)}>
            <Text style={styles.addExerciseText}>+ Add Exercise</Text>
          </TouchableOpacity>
        }
        renderItem={({ item, index }) => {
          const groupLabel = item.groupId ? `Superset ${labels[item.groupId]}` : null;
          const firstInGroup = item.groupId && workout.exercises[index - 1]?.groupId !== item.groupId;
          const restAfterRound = item.groupId
            ? workout.groups?.[item.groupId]?.restAfterRound ?? true
            : null;
          return (
            <View
              style={[
                styles.exerciseCard,
                item.groupId && styles.groupedCard,
                selectMode && selected.includes(item.key) && styles.selectedCard,
              ]}
            >
              {firstInGroup && (
                <View style={styles.groupHeader}>
                  <Text style={styles.groupLabel}>{groupLabel}</Text>
                  <TouchableOpacity
                    onPress={() => dispatch({ type: 'TOGGLE_GROUP_REST', groupId: item.groupId })}
                  >
                    <Text style={styles.groupToggle}>
                      {restAfterRound ? 'Rest after round: on' : 'Rest after round: off'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
              <View style={styles.exerciseHeader}>
                {selectMode ? (
                  <TouchableOpacity style={styles.selectCheck} onPress={() => toggleSelect(item.key)}>
                    <Ionicons
                      name={selected.includes(item.key) ? 'checkbox' : 'square-outline'}
                      size={20}
                      color={colors.primary}
                    />
                    <Text style={styles.exerciseName}>{item.name}</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.exerciseName}>{item.name}</Text>
                )}
                {!selectMode && (
                  <View style={styles.headerActions}>
                    {/* Per-exercise note: outline when empty, filled when set */}
                    <TouchableOpacity
                      onPress={() => setNotesKey(notesKey === item.key ? null : item.key)}
                    >
                      <Ionicons
                        name={item.notes ? 'chatbox' : 'chatbox-outline'}
                        size={16}
                        color={item.notes ? colors.orange : colors.textDim}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setRestEditKey(item.key)}>
                      <Text style={styles.headerAction}>{item.restSeconds}s</Text>
                    </TouchableOpacity>
                    {item.groupId && (
                      <TouchableOpacity
                        onPress={() => dispatch({ type: 'UNLINK_EXERCISE', exerciseKey: item.key })}
                      >
                        <Text style={styles.headerAction}>Unlink</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      onPress={() =>
                        Alert.alert('Remove exercise', `Remove ${item.name}?`, [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Remove',
                            style: 'destructive',
                            onPress: () => dispatch({ type: 'REMOVE_EXERCISE', key: item.key }),
                          },
                        ])
                      }
                    >
                      <Ionicons name="close" size={16} color={colors.textDim} />
                    </TouchableOpacity>
                  </View>
                )}
              </View>

              {/* inline per-exercise notes editor */}
              {notesKey === item.key && (
                <TextInput
                  style={styles.exNotesInput}
                  placeholder="Note for this exercise (e.g. left shoulder felt tight)"
                  placeholderTextColor={colors.textDim}
                  value={item.notes || ''}
                  onChangeText={(notes) =>
                    dispatch({ type: 'SET_EXERCISE_NOTES', exerciseKey: item.key, notes })
                  }
                  multiline
                />
              )}

              <View style={styles.setHeader}>
                <Text style={styles.setHeaderLabel}>TYPE</Text>
                <Text style={styles.setHeaderLabel}>LAST</Text>
                <Text style={styles.setHeaderLabel}>WEIGHT</Text>
                <Text style={styles.setHeaderLabel}>REPS</Text>
                <Text style={styles.setHeaderLabel}>DONE</Text>
                <Text style={styles.setHeaderLabel} />
              </View>

              {item.sets.map((set) => {
                const hasValues = parseFloat(set.weight) > 0 || parseInt(set.reps, 10) > 0;
                return (
                  <View key={set.key}>
                    <View
                      style={[
                        styles.setRow,
                        set.type === 'warmup' && styles.warmupRow,
                        set.completed && set.type !== 'warmup' && styles.setRowDone,
                      ]}
                    >
                      <TouchableOpacity
                        style={styles.typeChip}
                        onPress={() =>
                          dispatch({ type: 'TOGGLE_SET_TYPE', exerciseKey: item.key, setKey: set.key })
                        }
                      >
                        <Text style={[styles.typeChipText, set.type === 'warmup' && styles.warmupText]}>
                          {TYPE_META[set.type]?.label || 'W'}
                        </Text>
                      </TouchableOpacity>
                      {/* Previous performance as faded placeholder values —
                          tap to quick-fill empty fields with last session */}
                      <TouchableOpacity
                        style={styles.lastCell}
                        onPress={() =>
                          set.prev && dispatch({ type: 'FILL_FROM_PREV', exerciseKey: item.key, setKey: set.key })
                        }
                      >
                        {set.prev && (set.prev.weight > 0 || set.prev.reps > 0) ? (
                          <Text style={styles.lastText}>
                            {set.prev.weight}×{set.prev.reps}
                          </Text>
                        ) : (
                          <Text style={styles.lastTextDim}>—</Text>
                        )}
                      </TouchableOpacity>
                      <TextInput
                        style={[styles.setInput, set.type === 'warmup' && styles.warmupText]}
                        keyboardType="numeric"
                        value={set.weight}
                        placeholder={set.prev && set.prev.weight > 0 ? String(set.prev.weight) : ''}
                        placeholderTextColor={colors.textDim}
                        onChangeText={(weight) =>
                          dispatch({ type: 'UPDATE_SET', exerciseKey: item.key, setKey: set.key, field: 'weight', value: weight })
                        }
                      />
                      <TextInput
                        style={[styles.setInput, set.type === 'warmup' && styles.warmupText]}
                        keyboardType="numeric"
                        value={set.reps}
                        placeholder={set.prev && set.prev.reps > 0 ? String(set.prev.reps) : ''}
                        placeholderTextColor={colors.textDim}
                        onChangeText={(reps) =>
                          dispatch({ type: 'UPDATE_SET', exerciseKey: item.key, setKey: set.key, field: 'reps', value: reps })
                        }
                      />
                      {/* Bidirectional done toggle: un-marking removes the
                          set from volume/PRs again */}
                      <TouchableOpacity
                        style={styles.doneBtn}
                        onPress={async () => {
                          if (set.completed) {
                            lightImpact();
                            dispatch({ type: 'UNCOMPLETE_SET', exerciseKey: item.key, setKey: set.key });
                            return;
                          }
                          if (hasValues) {
                            dispatch({ type: 'COMPLETE_SET', exerciseKey: item.key, setKey: set.key });
                            const w = parseFloat(set.weight) || 0;
                            const r = parseInt(set.reps, 10) || 0;
                            if (w > 0 && r > 0 && set.type !== 'warmup') {
                              const prs = await evaluatePR(item.exerciseId, w, r);
                              const newPRs = prs.filter((pr) => {
                                const bk = `${item.exerciseId}:${pr.type}:${pr.secondary}`;
                                if (sessionBest.current[bk] == null || pr.newValue > sessionBest.current[bk]) {
                                  sessionBest.current[bk] = pr.newValue;
                                  return true;
                                }
                                return false;
                              });
                              if (newPRs.length > 0) {
                                hapticSuccess();
                                setPrToast(newPRs);
                              } else {
                                lightImpact();
                              }
                            } else {
                              lightImpact();
                            }
                          }
                        }}
                      >
                        <Ionicons
                          name={set.completed ? 'checkmark-circle' : 'ellipse-outline'}
                          size={20}
                          color={set.completed ? colors.green : colors.textDim}
                        />
                      </TouchableOpacity>
                      {set.prev && hasValues && (
                        <View style={styles.deltaContainer}>
                          {(() => {
                            const currW = parseFloat(set.weight) || 0;
                            const currR = parseInt(set.reps, 10) || 0;
                            const prevW = set.prev.weight || 0;
                            const prevR = set.prev.reps || 0;
                            const wDiff = currW - prevW;
                            const rDiff = currR - prevR;
                            if (wDiff === 0 && rDiff === 0) return null;
                            return (
                              <>
                                {wDiff !== 0 && (
                                  <Text style={[styles.deltaText, wDiff > 0 ? styles.deltaUp : styles.deltaDown]}>
                                    {wDiff > 0 ? '+' : ''}{Math.round(wDiff)}
                                  </Text>
                                )}
                                {rDiff !== 0 && (
                                  <Text style={[styles.deltaTextSmall, rDiff > 0 ? styles.deltaUp : styles.deltaDown]}>
                                    {rDiff > 0 ? '+' : ''}{rDiff}r
                                  </Text>
                                )}
                              </>
                            );
                          })()}
                        </View>
                      )}
                      <View style={styles.setActions}>
                        <TouchableOpacity onPress={() => setPlateForKey(set.key)}>
                          <Ionicons name="grid-outline" size={16} color={colors.blue} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() =>
                            item.sets.length > 1
                              ? dispatch({ type: 'REMOVE_SET', exerciseKey: item.key, setKey: set.key })
                              : dispatch({ type: 'REMOVE_EXERCISE', key: item.key })
                          }
                        >
                          <Ionicons name="close" size={16} color={colors.textDim} />
                        </TouchableOpacity>
                      </View>
                    </View>
                    {rpeEnabled && set.completed && (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rpeRow}>
                        <Text style={styles.rpeLabel}>RPE</Text>
                        {RPE_OPTIONS.map((r) => (
                          <TouchableOpacity
                            key={r}
                            onPress={() =>
                              dispatch({
                                type: 'UPDATE_SET',
                                exerciseKey: item.key,
                                setKey: set.key,
                                field: 'rpe',
                                value: set.rpe === r ? null : r,
                              })
                            }
                          >
                            <Text style={[styles.rpeChip, set.rpe === r && styles.rpeChipOn]}>{r}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    )}
                  </View>
                );
              })}

              <View style={styles.setActionsRow}>
                <TouchableOpacity
                  style={styles.addSetBtn}
                  onPress={() => dispatch({ type: 'ADD_SET', exerciseKey: item.key })}
                >
                  <Text style={styles.addSetText}>+ Add Set</Text>
                </TouchableOpacity>
                {item.sets.length > 0 && (
                  <TouchableOpacity
                    style={styles.dupBtn}
                    onPress={() => dispatch({ type: 'DUPLICATE_SET', exerciseKey: item.key })}
                  >
                    <Text style={styles.dupText}>+ Dup</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }}
      />

      <TextInput
        style={styles.notes}
        placeholder="Notes (workout feeling, PRs, etc.)"
        placeholderTextColor={colors.textDim}
        value={workout.notes}
        onChangeText={(notes) => dispatch({ type: 'SET_NOTES', notes })}
        multiline
      />

      <TouchableOpacity style={styles.finishBtn} onPress={finish}>
        <Text style={styles.finishBtnText}>Finish Workout</Text>
      </TouchableOpacity>

      <RestTimerBar
        timer={workout.restTimer}
        onAdjust={(delta) => dispatch({ type: 'ADJUST_REST', delta })}
        onSkip={() => dispatch({ type: 'SKIP_REST' })}
      />

      <ExercisePicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPick={(exercise, history, best) =>
          dispatch({
            type: 'ADD_EXERCISE',
            exercise,
            previousSets: history,
            bestWeight: best?.weight || 0,
            bestReps: best?.reps || 0,
            defaultRest: settings?.default_rest_seconds,
          })
        }
      />

      <RestEditorModal
        visible={!!restEditEx}
        exerciseName={restEditEx?.name}
        initial={restEditEx?.restSeconds}
        onClose={() => setRestEditKey(null)}
        onSave={(seconds) => dispatch({ type: 'SET_REST_SECONDS', exerciseKey: restEditKey, seconds })}
      />

      <PlateSheet
        visible={!!plateSet}
        weight={plateSet?.weight}
        unit={settings?.unit || 'kg'}
        barWeight={settings?.bar_weight ?? 20}
        plates={settings?.plates || [20, 15, 10, 5, 2.5, 1.25]}
        onClose={() => setPlateForKey(null)}
      />

      {prToast && (
        <PRToast visible prs={prToast} onDismiss={() => setPrToast(null)} />
      )}
    </View>
  );
}

const fmtClock = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    emptyWrap: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    emptyText: { color: colors.textDim, marginBottom: 16 },
    startBtn: { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
    startBtnText: { color: '#fff', fontWeight: '700' },
    topBar: { padding: 16, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
    topBarRow: { flexDirection: 'row', alignItems: 'center' },
    topIcon: { padding: 6 },
    nameInput: { color: colors.text, fontSize: 22, fontWeight: '800', flex: 1, marginLeft: 4 },
    statsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
    timer: { color: colors.primary, fontSize: 16, fontWeight: '700', marginRight: 12 },
    miniStat: { color: colors.textDim, fontSize: 13 },
    selectBar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 6,
    },
    selectBtn: { color: colors.blue, fontWeight: '600', fontSize: 13 },
    selectBtnActive: { color: colors.primary },
    exerciseCard: { backgroundColor: colors.card, borderRadius: 12, marginHorizontal: 16, marginTop: 14, padding: 14 },
    groupedCard: { backgroundColor: colors.cardLight, borderLeftWidth: 3, borderLeftColor: colors.blue },
    selectedCard: { borderWidth: 2, borderColor: colors.primary },
    groupHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
    groupLabel: { color: colors.blue, fontWeight: '700', fontSize: 12 },
    groupToggle: { color: colors.textDim, fontSize: 11 },
    exerciseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    exerciseName: { color: colors.text, fontSize: 16, fontWeight: '700', flex: 1 },
    headerActions: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    headerAction: { color: colors.textDim, fontSize: 12 },
    exNotesInput: {
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 8,
      padding: 10,
      marginBottom: 8,
      minHeight: 44,
    },
    selectCheck: { flexDirection: 'row', alignItems: 'center', flex: 1 },
    setHeader: { flexDirection: 'row', marginBottom: 4 },
    setHeaderLabel: { color: colors.textDim, fontSize: 11, flex: 1, textAlign: 'center' },
    setRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderRadius: 6, position: 'relative' },
    setRowDone: { backgroundColor: 'rgba(52,199,89,0.10)' },
    warmupRow: { opacity: 0.55 },
    typeChip: {
      backgroundColor: colors.cardLight,
      borderRadius: 6,
      width: 34,
      alignItems: 'center',
      paddingVertical: 6,
      marginHorizontal: 2,
    },
    typeChipText: { color: colors.text, fontSize: 11, fontWeight: '700' },
    warmupText: { color: colors.textDim },
    lastCell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    lastText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
    lastTextDim: { color: colors.textDim, fontSize: 12 },
    setInput: {
      flex: 1,
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginHorizontal: 4,
      textAlign: 'center',
      fontSize: 14,
    },
    doneBtn: { flex: 1, alignItems: 'center' },
    setActions: { flex: 1, flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center' },
    rpeRow: { flexDirection: 'row', paddingVertical: 4, maxHeight: 40 },
    rpeLabel: { color: colors.textDim, fontSize: 11, alignSelf: 'center', marginRight: 8 },
    rpeChip: {
      color: colors.textDim,
      fontSize: 12,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 8,
      backgroundColor: colors.cardLight,
      marginRight: 6,
      overflow: 'hidden',
    },
    rpeChipOn: { color: '#fff', backgroundColor: colors.primary },
    addSetBtn: { flex: 1, marginTop: 8, padding: 8, alignItems: 'center', borderRadius: 8, backgroundColor: colors.cardLight },
    addSetText: { color: colors.primary, fontWeight: '600' },
    setActionsRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
    dupBtn: { marginTop: 8, padding: 8, paddingHorizontal: 12, alignItems: 'center', borderRadius: 8, backgroundColor: colors.cardLight },
    dupText: { color: colors.blue, fontWeight: '600', fontSize: 13 },
    addExercise: {
      margin: 16,
      padding: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.primary,
      borderStyle: 'dashed',
      alignItems: 'center',
    },
    addExerciseText: { color: colors.primary, fontWeight: '700' },
    notes: {
      margin: 16,
      marginTop: 0,
      backgroundColor: colors.card,
      color: colors.text,
      borderRadius: 10,
      padding: 12,
      minHeight: 60,
    },
    finishBtn: { backgroundColor: colors.primary, margin: 16, marginTop: 0, padding: 16, borderRadius: 12, alignItems: 'center' },
    finishBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
    deltaContainer: { position: 'absolute', right: 4, top: -14, flexDirection: 'row', gap: 4 },
    deltaText: { fontSize: 10, fontWeight: '700' },
    deltaTextSmall: { fontSize: 9, fontWeight: '600' },
    deltaUp: { color: colors.green },
    deltaDown: { color: colors.orange },
  });
