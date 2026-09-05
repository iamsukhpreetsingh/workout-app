// Gym workout detail (Mobile M2) — the full view of ONE gym-provided
// workout (recommended or assigned), pushed from the Gym home sections.
//
// The gym workout data model is its own thing (gym_workouts +
// gym_workout_exercises: plain-text exercise names, sets, reps TEXT like
// "8-12"/"AMRAP", duration_minutes, notes) — so this screen renders that
// model directly instead of forcing it into the local plan model. The
// ACTIONS reuse the existing infrastructure end to end:
//   Start           → startGymWorkout() → START_WORKOUT → ACTIVE_WORKOUT
//                     (same live-session engine as personal routines)
//   Add to routines → gymWorkoutToPlanArgs() → createPlan() — a real
//                     local routine, editable in the standard Plan Editor
// The workout object arrives via route params (the /gym/my/content payload
// is self-contained — exercises are embedded, there is no detail endpoint).
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import { useWorkout } from '../store/WorkoutContext';
import { startGymWorkout, gymWorkoutToPlanArgs } from '../lib/startAssigned';
import { workoutMetaLine } from '../lib/gymContent';
import { createPlan } from '../services/routineService';
import { PLAN_DETAIL } from '../shared/constants/routes';

export default function GymWorkoutDetailScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const route = useRoute();
  const { workout, gymName, tag } = route.params || {};
  const { workout: activeWorkout, dispatch } = useWorkout();
  const [busy, setBusy] = useState(null); // 'start' | 'add' | null
  const [added, setAdded] = useState(false);

  const styles = makeStyles(colors);

  if (!workout) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="barbell-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>Workout unavailable.</Text>
        <Text style={styles.emptyBody}>It may have been removed by your gym.</Text>
      </View>
    );
  }

  const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
  const meta = workoutMetaLine(workout);
  const assigned = tag === 'Assigned';

  const guardActive = () => {
    if (activeWorkout) {
      Alert.alert('Workout in progress', 'Finish or discard your current workout first.');
      return true;
    }
    return false;
  };

  const start = async () => {
    if (busy || guardActive()) return;
    setBusy('start');
    try {
      await startGymWorkout(workout, { dispatch, navigation });
    } catch (e) {
      Alert.alert('Could not start workout', e?.message || 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const addToRoutines = async () => {
    if (busy || added) return;
    setBusy('add');
    try {
      const { name, notes, exercises: planExercises } = await gymWorkoutToPlanArgs(workout);
      const planId = await createPlan(name, notes, planExercises, []);
      setAdded(true);
      navigation.navigate(PLAN_DETAIL, { planId });
    } catch (e) {
      Alert.alert('Could not add to routines', e?.message || 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* header card */}
      <View style={styles.card}>
        <View style={styles.titleRow}>
          <View style={styles.titleWrap}>
            <Text style={styles.title}>{workout.title}</Text>
            <Text style={styles.meta}>{gymName ? `${gymName} · ` : ''}{meta || 'Gym program'}</Text>
          </View>
          <View style={[styles.tag, { backgroundColor: assigned ? `${colors.primary}22` : `${colors.textDim}22` }]}>
            <Text style={[styles.tagText, { color: assigned ? colors.primary : colors.textDim }]}>
              {assigned ? 'Assigned' : 'Recommended'}
            </Text>
          </View>
        </View>
        {workout.description ? (
          <Text style={styles.description}>{workout.description}</Text>
        ) : null}
        {(assigned && (workout.starts_on || workout.ends_on)) || workout.notes ? (
          <View style={styles.windowBox}>
            {assigned && (workout.starts_on || workout.ends_on) ? (
              <Text style={styles.windowText}>
                {workout.starts_on ? `From ${String(workout.starts_on).slice(0, 10)}` : ''}
                {workout.starts_on && workout.ends_on ? ' · ' : ''}
                {workout.ends_on ? `Until ${String(workout.ends_on).slice(0, 10)}` : ''}
              </Text>
            ) : null}
            {workout.notes ? (
              <Text style={styles.windowText}>&ldquo;{workout.notes}&rdquo;</Text>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* exercises — the gym data model rendered as-is */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Exercises</Text>
        {exercises.length === 0 ? (
          <Text style={styles.emptyHint}>No exercises in this workout yet.</Text>
        ) : (
          exercises.map((ex, i) => {
            const bits = [];
            if (ex.sets) bits.push(`${ex.sets} set${ex.sets > 1 ? 's' : ''}`);
            if (ex.reps) bits.push(`${ex.reps} reps`);
            if (ex.duration_minutes) bits.push(`${ex.duration_minutes} min`);
            return (
              <View
                key={`${i}-${ex.exercise_name || 'ex'}`}
                style={[styles.exRow, i === exercises.length - 1 && { borderBottomWidth: 0 }]}
              >
                <Text style={styles.exIndex}>{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.exName}>{ex.exercise_name || 'Unnamed exercise'}</Text>
                  {bits.length ? <Text style={styles.exMeta}>{bits.join(' · ')}</Text> : null}
                  {ex.notes ? <Text style={styles.exNotes}>{ex.notes}</Text> : null}
                </View>
              </View>
            );
          })
        )}
      </View>

      {/* actions — ride the existing workout/routine infrastructure */}
      <TouchableOpacity
        style={[styles.primaryBtn, (!exercises.length || busy) && { opacity: 0.5 }]}
        disabled={!exercises.length || !!busy}
        onPress={start}
        accessibilityRole="button"
        accessibilityLabel="Start this gym workout now"
      >
        {busy === 'start' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            <Ionicons name="play" size={16} color="#fff" />
            <Text style={styles.primaryBtnText}>Start Workout</Text>
          </>
        )}
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.secondaryBtn, (!exercises.length || busy) && { opacity: 0.5 }]}
        disabled={!exercises.length || !!busy}
        onPress={addToRoutines}
        accessibilityRole="button"
        accessibilityLabel="Add this gym workout to my routines"
      >
        {busy === 'add' ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <>
            <Ionicons name={added ? 'checkmark' : 'add-circle-outline'} size={16} color={colors.primary} />
            <Text style={[styles.secondaryBtnText, added && { color: colors.primary }]}>
              {added ? 'Added to My Routines' : 'Add to My Routines'}
            </Text>
          </>
        )}
      </TouchableOpacity>
      <Text style={styles.hint}>
        Starting uses your usual rest timer and logs a normal session. Adding creates an editable copy in your routines.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
  emptyBody: { color: colors.textDim, fontSize: 13, marginTop: spacing.sm, textAlign: 'center', lineHeight: 19 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titleWrap: { flex: 1 },
  title: { color: colors.text, fontSize: 18, fontWeight: '800', lineHeight: 23 },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 3, textTransform: 'capitalize' },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  tagText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  description: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: spacing.sm },
  windowBox: { marginTop: spacing.sm, gap: 2 },
  windowText: { color: colors.textDim, fontSize: 11 },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3, marginBottom: spacing.sm },
  exRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  exIndex: {
    color: colors.textDim, fontSize: 12, fontWeight: '800', width: 18,
    paddingTop: 2, fontVariant: ['tabular-nums'],
  },
  exName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  exMeta: { color: colors.primary, fontSize: 11, marginTop: 2, fontVariant: ['tabular-nums'] },
  exNotes: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  emptyHint: { color: colors.textDim, fontSize: 12 },
  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: 12, padding: 14,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  secondaryBtn: {
    borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12, padding: 13,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, marginTop: spacing.sm,
  },
  secondaryBtnText: { color: colors.primary, fontWeight: '800', fontSize: 14 },
  hint: { color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: spacing.md, lineHeight: 16 },
});
