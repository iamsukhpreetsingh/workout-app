import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { fetchAndCacheTrainerContent } from '../lib/trainerCache';
import { useWorkout, groupLabels } from '../store/WorkoutContext';
import { startAssignedPlan } from '../lib/startAssigned';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

// Client-facing read-only view of a trainer-assigned workout — Routine
// Detail's layout, plus a Start Workout that feeds the normal live session.
export default function ClientAssignedDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { planId } = route.params || {};
  const { workout, dispatch } = useWorkout();
  const [plan, setPlan] = useState(null);

  const load = useCallback(async () => {
    try {
      // fetch-through cache: opens offline from the cached assigned-plans
      // copy (incl. swap alternatives) instead of erroring out
      const plans = await fetchAndCacheTrainerContent(
        'trainer:assigned-workouts',
        () => api('/client/assigned-plans')
      );
      setPlan(plans.find((p) => p.id === planId) || null);
    } catch (e) {
      Alert.alert('Could not load plan', e.message || 'Please try again.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }, [planId, navigation]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: plan?.name || 'From Your Trainer' });
  }, [navigation, plan?.name]);

  if (!plan) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  // Resolve each assigned exercise (matched by plain-text name) to a local
  // SQLite exercise row — creating a custom one if the client doesn't have
  // it yet — so the live session and logging work like any routine.
  const startAssigned = () =>
    startAssignedPlan(plan, { dispatch, navigation }).catch((e) =>
      Alert.alert('Could not start workout', e.message || 'Please try again.')
    );

  const labels = groupLabels((plan.exercises || []).map((e) => ({ groupId: e.group_id })));

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <View style={styles.coachBanner}>
        <Ionicons name="fitness" size={15} color={colors.blue} />
        <Text style={styles.coachText}>Assigned by {plan.trainer_name || 'your trainer'}</Text>
      </View>

      <Text style={styles.name}>{plan.name}</Text>
      <Text style={styles.sub}>
        {plan.exercises.length} exercises ·{' '}
        {new Date(plan.created_at).toLocaleDateString(undefined, {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })}
      </Text>
      {plan.notes ? <Text style={styles.notes}>{plan.notes}</Text> : null}

      {(plan.exercises || []).map((ex, i) => {
        const firstInGroup = ex.group_id && plan.exercises[i - 1]?.group_id !== ex.group_id;
        return (
          <View
            key={ex.id}
            style={[styles.row, ex.group_id && styles.groupedRow, firstInGroup && styles.groupFirst]}
          >
            {firstInGroup && <Text style={styles.groupLabel}>Superset {labels[ex.group_id]}</Text>}
            <View style={styles.rowInner}>
              <View style={styles.idxBadge}>
                <Text style={[styles.idxText, NUMS]}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.exName}>{ex.exercise_name}</Text>
                <View style={styles.exMetaRow}>
                  <Text style={[styles.exSets, NUMS]}>{ex.target_sets}</Text>
                  <Text style={styles.exSetsUnit}>
                    sets{ex.target_reps ? ` · ${ex.target_reps} reps` : ''}
                  </Text>
                </View>
                {ex.target_weight_note ? (
                  <Text style={styles.exHint}>{ex.target_weight_note}</Text>
                ) : null}
                {ex.notes ? <Text style={styles.exHint}>{ex.notes}</Text> : null}
                {/* configured swap alternatives — same chip treatment as
                    PlanDetailScreen (My Routines) so both plan views read
                    identically; values come straight from the assigned-plan
                    payload (server attaches alternatives per exercise) */}
                {(ex.alternatives || []).length > 0 && (
                  <View style={styles.altWrap}>
                    {ex.alternatives.map((alt, j) => (
                      <View key={j} style={styles.altChip}>
                        <Ionicons name="swap-horizontal" size={10} color={colors.blue} />
                        <Text style={styles.altText}>
                          {typeof alt === 'string'
                            ? alt
                            : alt.alternative_exercise_name ?? alt.name}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
              {ex.rest_seconds ? (
                <View style={styles.restChip}>
                  <Ionicons name="time-outline" size={12} color={colors.textDim} />
                  <Text style={[styles.restText, NUMS]}>{ex.rest_seconds}s</Text>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}

      <TouchableOpacity style={styles.startBtn} onPress={startAssigned}>
        <Ionicons name="play" size={18} color="#fff" />
        <Text style={styles.startBtnText}>Start Workout</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    coachBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 10, paddingVertical: 5, marginBottom: 12,
    },
    coachText: { color: colors.blue, fontWeight: '700', fontSize: 12 },
    name: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
    sub: { color: colors.textDim, marginTop: 4, fontSize: 13 },
    notes: { color: colors.textDim, marginTop: 8, marginBottom: 8, fontSize: 13, fontStyle: 'italic' },

    row: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginTop: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12,
      shadowRadius: 8, elevation: 2,
    },
    groupedRow: {
      backgroundColor: colors.cardLight, borderLeftWidth: 3, borderLeftColor: colors.blue,
      borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
    },
    groupFirst: { marginTop: 12 },
    groupLabel: { color: colors.blue, fontWeight: '700', fontSize: 12, marginBottom: 6 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    idxBadge: {
      width: 28, height: 28, borderRadius: 9, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
    exName: { color: colors.text, fontWeight: '700', fontSize: 15 },
    exMetaRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 2 },
    exSets: { color: colors.text, fontSize: 13, fontWeight: '800' },
    exSetsUnit: { color: colors.textDim, fontSize: 11 },
    exHint: { color: colors.textDim, fontSize: 11, marginTop: 2, fontStyle: 'italic' },
    // identical to PlanDetailScreen's alternative chips — one visual
    // language for "this exercise has swap options" across plan views
    altWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
    altChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      backgroundColor: colors.cardLight,
      borderRadius: 7,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    altText: { color: colors.blue, fontSize: 11, fontWeight: '600' },
    restChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.cardLight,
      borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5,
    },
    restText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },

    startBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      backgroundColor: colors.primary, borderRadius: 14, padding: 16, marginTop: 24,
      shadowColor: colors.primary, shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
    },
    startBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  });
