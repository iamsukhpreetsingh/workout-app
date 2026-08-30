import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getPlan, saveBackfilledSession } from '../services/routineService';
import { useColors } from '../theme';
import LoadError from '../shared/components/LoadError';

const NUMS = { fontVariant: ['tabular-nums'] };
const TYPE_META = { working: 'W', warmup: 'WU', dropset: 'DS', failure: 'F' };
const TYPE_CYCLE = { working: 'warmup', warmup: 'dropset', dropset: 'failure', failure: 'working' };

const pad = (n) => String(n).padStart(2, '0');
const toDateString = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MAX_DAYS_BACK = 365;

// Historical workout logging: log a past session against a routine's
// structure, saved with the CHOSEN DATE as its start_time so it lands in
// History on that date, syncs with the correct performed_at, and counts
// toward PRs/streaks like any session. Date is constrained to PAST dates
// only (the diet system's future-lock rule, applied to workouts).
export default function BackfillWorkoutScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { planId } = route.params || {};
  const [plan, setPlan] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [dateStr, setDateStr] = useState(toDateString(new Date())); // default today
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [exercises, setExercises] = useState([]); // [{exerciseId, name, muscleGroup, skipped, sets:[{weight,reps,type}]}]
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getPlan(planId)
      .then((p) => {
        if (!p) { setLoadError(true); return; }
        setPlan(p);
        setName(p.name);
        setExercises(
          (p.exercises || []).map((ex) => ({
            exerciseId: ex.exercise_id,
            name: ex.name,
            muscleGroup: ex.muscle_group,
            groupId: ex.group_id,
            restSeconds: ex.rest_seconds,
            skipped: false,
            sets: Array.from({ length: ex.target_sets || 3 }, () => ({
              weight: '', reps: '', type: 'working',
            })),
          }))
        );
        setLoadError(false);
      })
      .catch((e) => {
        console.warn('[BackfillWorkoutScreen] load failed:', e?.message || e);
        setLoadError(true);
      });
  }, [planId, retryTick]);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: 'Log Past Workout' });
  }, [navigation]);

  const todayStr = toDateString(new Date());
  const minDate = toDateString(new Date(Date.now() - MAX_DAYS_BACK * 86400000));
  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr <= todayStr && dateStr >= minDate;

  const shiftDateField = (days) => {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() + days);
    const next = toDateString(d);
    if (next > todayStr) return; // never into the future
    setDateStr(next);
  };

  const updateSet = (exIdx, setIdx, field, value) =>
    setExercises((prev) =>
      prev.map((ex, i) =>
        i === exIdx
          ? { ...ex, sets: ex.sets.map((s, j) => (j === setIdx ? { ...s, [field]: value } : s)) }
          : ex
      )
    );

  const cycleType = (exIdx, setIdx) => {
    const cur = exercises[exIdx].sets[setIdx].type || 'working';
    updateSet(exIdx, setIdx, 'type', TYPE_CYCLE[cur] || 'working');
  };

  const addSet = (exIdx) =>
    setExercises((prev) =>
      prev.map((ex, i) =>
        i === exIdx ? { ...ex, sets: [...ex.sets, { weight: '', reps: '', type: 'working' }] } : ex
      )
    );

  const removeSet = (exIdx, setIdx) =>
    setExercises((prev) =>
      prev.map((ex, i) =>
        i === exIdx ? { ...ex, sets: ex.sets.filter((_, j) => j !== setIdx) } : ex
      )
    );

  const toggleSkip = (exIdx) =>
    setExercises((prev) => prev.map((ex, i) => (i === exIdx ? { ...ex, skipped: !ex.skipped } : ex)));

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return Alert.alert('Name required', 'Give this workout a name.');
    if (!dateValid) return Alert.alert('Invalid date', 'Pick a valid past date (YYYY-MM-DD).');

    const loggedExercises = exercises.filter((ex) => !ex.skipped);
    const hasAnySet = loggedExercises.some((ex) =>
      ex.sets.some((s) => parseFloat(s.weight) > 0 || parseInt(s.reps, 10) > 0)
    );
    if (!hasAnySet) {
      return Alert.alert(
        'Nothing logged',
        'Enter at least one set with weight or reps, or go back.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => navigation.goBack() },
        ]
      );
    }

    // Noon of the chosen date — sorts correctly within the day, avoids
    // timezone midnight edge cases, and is honest ("time unknown").
    const startTime = new Date(`${dateStr}T12:00:00`).getTime();

    setBusy(true);
    try {
      await saveBackfilledSession({
        name: name.trim(),
        startTime,
        notes: notes.trim() || null,
        planId,
        exercises: loggedExercises.map((ex) => ({
          exerciseId: ex.exerciseId,
          restSeconds: ex.restSeconds,
          groupId: ex.groupId,
          sets: ex.sets
            .filter((s) => parseFloat(s.weight) > 0 || parseInt(s.reps, 10) > 0)
            .map((s) => ({
              weight: parseFloat(s.weight) || 0,
              reps: parseInt(s.reps, 10) || 0,
              setType: s.type || 'working',
              completed: 1,
            })),
        })),
      });
      Alert.alert('Saved', `Workout logged for ${dateStr}.`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert('Could not save', e?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !plan) {
    return <LoadError onRetry={() => setRetryTick((t) => t + 1)} />;
  }

  if (!plan) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <Text style={styles.dim}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      {/* date picker — manual YYYY-MM-DD entry + day nudges, past only */}
      <Text style={styles.label}>WORKOUT DATE</Text>
      <View style={styles.dateRow}>
        <TouchableOpacity style={styles.dateBtn} onPress={() => shiftDateField(-1)}>
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <TextInput
          style={[styles.dateInput, !dateValid && styles.dateInvalid]}
          value={dateStr}
          onChangeText={setDateStr}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textDim}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
        />
        <TouchableOpacity
          style={[styles.dateBtn, dateStr >= todayStr && { opacity: 0.3 }]}
          disabled={dateStr >= todayStr}
          onPress={() => shiftDateField(1)}
        >
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>
      <Text style={styles.dateHint}>
        {dateStr === todayStr ? 'Today' : new Date(`${dateStr}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Workout name"
        placeholderTextColor={colors.textDim}
        value={name}
        onChangeText={setName}
      />
      <TextInput
        style={[styles.input, { minHeight: 52 }]}
        placeholder="Notes (optional)"
        placeholderTextColor={colors.textDim}
        value={notes}
        onChangeText={setNotes}
        multiline
      />

      {exercises.map((ex, i) => (
        <View key={`${ex.exerciseId}-${i}`} style={[styles.exCard, ex.skipped && styles.exSkipped]}>
          <View style={styles.exHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.exName} numberOfLines={1}>{ex.name}</Text>
              <Text style={styles.exGroup}>{ex.muscleGroup}</Text>
            </View>
            <TouchableOpacity
              style={[styles.skipBtn, ex.skipped && styles.skipBtnOn]}
              onPress={() => toggleSkip(i)}
            >
              <Text style={[styles.skipBtnText, ex.skipped && { color: '#fff' }]}>
                {ex.skipped ? 'Skipped' : 'Skip'}
              </Text>
            </TouchableOpacity>
          </View>

          {!ex.skipped && (
            <View>
              <View style={styles.setHeader}>
                <Text style={styles.setHeaderLabel}>TYPE</Text>
                <Text style={styles.setHeaderLabel}>WEIGHT</Text>
                <Text style={styles.setHeaderLabel}>REPS</Text>
                <Text style={styles.setHeaderLabel} />
              </View>
              {ex.sets.map((s, j) => (
                <View key={j} style={styles.setRow}>
                  <TouchableOpacity style={styles.typeChip} onPress={() => cycleType(i, j)}>
                    <Text style={styles.typeChipText}>{TYPE_META[s.type] || 'W'}</Text>
                  </TouchableOpacity>
                  <TextInput
                    style={styles.setInput}
                    keyboardType="numeric"
                    value={s.weight}
                    onChangeText={(v) => updateSet(i, j, 'weight', v)}
                    placeholder="—"
                    placeholderTextColor={colors.textDim}
                  />
                  <TextInput
                    style={styles.setInput}
                    keyboardType="numeric"
                    value={s.reps}
                    onChangeText={(v) => updateSet(i, j, 'reps', v)}
                    placeholder="—"
                    placeholderTextColor={colors.textDim}
                  />
                  <TouchableOpacity
                    onPress={() => removeSet(i, j)}
                    style={{ padding: 4 }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close" size={14} color={colors.textDim} />
                  </TouchableOpacity>
                </View>
              ))}
              <TouchableOpacity style={styles.addSetBtn} onPress={() => addSet(i)}>
                <Text style={styles.addSetText}>+ Add Set</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ))}

      <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={busy}>
        <Text style={styles.saveBtnText}>{busy ? 'Saving…' : `Save Workout for ${dateStr}`}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    dim: { color: colors.textDim, padding: 16 },
    label: {
      color: colors.textDim, fontSize: 11, fontWeight: '800',
      letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6,
    },
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dateBtn: {
      width: 38, height: 38, borderRadius: 10, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    dateInput: {
      flex: 1, backgroundColor: colors.cardLight, color: colors.text,
      borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
      fontSize: 16, textAlign: 'center', fontWeight: '700',
    },
    dateInvalid: { borderWidth: 1.5, borderColor: colors.red },
    dateHint: { color: colors.textDim, fontSize: 12, marginTop: 6, marginBottom: 14, textAlign: 'center' },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 13, marginBottom: 10, fontSize: 15,
    },
    exCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginTop: 12,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    exSkipped: { opacity: 0.45 },
    exHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
    exName: { color: colors.text, fontWeight: '700', fontSize: 15 },
    exGroup: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    skipBtn: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 5,
    },
    skipBtnOn: { backgroundColor: colors.textDim, borderColor: colors.textDim },
    skipBtnText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    setHeader: { flexDirection: 'row', marginBottom: 4 },
    setHeaderLabel: { color: colors.textDim, fontSize: 11, flex: 1, textAlign: 'center' },
    setRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3 },
    typeChip: {
      backgroundColor: colors.cardLight, borderRadius: 6, width: 38,
      alignItems: 'center', paddingVertical: 7, marginHorizontal: 2,
    },
    typeChipText: { color: colors.text, fontSize: 11, fontWeight: '700' },
    setInput: {
      flex: 1, backgroundColor: colors.cardLight, color: colors.text,
      borderRadius: 6, paddingHorizontal: 10, paddingVertical: 7,
      marginHorizontal: 4, textAlign: 'center', fontSize: 14,
    },
    addSetBtn: {
      marginTop: 6, padding: 8, alignItems: 'center',
      borderRadius: 8, backgroundColor: colors.cardLight,
    },
    addSetText: { color: colors.primary, fontWeight: '600', fontSize: 12 },
    saveBtn: {
      backgroundColor: colors.primary, borderRadius: 14, padding: 16,
      alignItems: 'center', marginTop: 20,
    },
    saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  });